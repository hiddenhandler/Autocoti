// Notification dispatcher (Supabase Edge Function, Deno).
// Run every minute (Supabase scheduled function / pg_cron + pg_net):
//   1. run_periodic_jobs(): expire waitlist offers, queue rebooking reminders, daily snapshots
//   2. claim due notifications from the outbox (FOR UPDATE SKIP LOCKED — safe to run concurrently)
//   3. render the shop's template (or the platform default) and deliver through a channel adapter
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL, RESEND_API_KEY (email), EMAIL_FROM,
//      TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM (SMS), TWILIO_WHATSAPP_FROM (WhatsApp sender, e.g. +14155238886),
//      SMS_DEFAULT_COUNTRY_CODE (e.g. 1 for US/DR, prepended to 10-digit local numbers).
// Push = adding an adapter below; the outbox schema already supports it.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { json } from '../_shared/http.ts'

type Notification = {
  id: string
  shop_id: string
  event: string
  channel: 'email' | 'sms' | 'push' | 'whatsapp' | 'in_app'
  to_address: string | null
  payload: Record<string, unknown>
}

type Rendered = { subject: string; text: string }
type Adapter = (n: Notification, msg: Rendered) => Promise<{ ok: boolean; ref?: string; error?: string; skip?: boolean }>

const APP_URL = (Deno.env.get('APP_URL') ?? '').replace(/\/$/, '')

export function render(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const v = payload[key]
    if (v === null || v === undefined) return ''
    const s = String(v)
    return key.endsWith('_url') && s.startsWith('/') ? `${APP_URL}${s}` : s
  })
}

const adapters: Partial<Record<Notification['channel'], Adapter>> = {
  email: async (n, msg) => {
    const key = Deno.env.get('RESEND_API_KEY')
    if (!key) return { ok: false, skip: true, error: 'No email provider configured (RESEND_API_KEY)' }
    if (!n.to_address) return { ok: false, skip: true, error: 'No recipient address' }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: Deno.env.get('EMAIL_FROM') ?? 'BarberNGo <bookings@barberngo.com>',
        to: [n.to_address],
        subject: msg.subject,
        text: msg.text,
        headers: { 'X-Entity-Ref-ID': n.id },
      }),
    })
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${await res.text()}` }
    const body = (await res.json()) as { id?: string }
    return { ok: true, ref: body.id }
  },
  sms: (n, msg) => twilio(n, msg.text, Deno.env.get('TWILIO_SMS_FROM'), ''),
  whatsapp: (n, msg) => twilio(n, msg.text, Deno.env.get('TWILIO_WHATSAPP_FROM'), 'whatsapp:'),
  // push: add an FCM/APNs adapter here.
}

/** E.164 from the digits stored on the client (they're normalised to digits, optional leading +). */
export function toE164(raw: string, defaultCountry = Deno.env.get('SMS_DEFAULT_COUNTRY_CODE') ?? '1'): string | null {
  const digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits.length >= 9 ? digits : null
  if (digits.length === 10) return `+${defaultCountry}${digits}`
  if (digits.length >= 11) return `+${digits}`
  return null
}

async function twilio(n: Notification, body: string, from: string | undefined, prefix: '' | 'whatsapp:') {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID')
  const token = Deno.env.get('TWILIO_AUTH_TOKEN')
  if (!sid || !token || !from) return { ok: false, skip: true, error: `No ${prefix ? 'WhatsApp' : 'SMS'} provider configured (TWILIO_*)` }
  const to = n.to_address ? toE164(n.to_address) : null
  if (!to) return { ok: false, skip: true, error: 'No valid phone number' }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: `${prefix}${to}`, From: `${prefix}${from}`, Body: body.slice(0, 1500) }),
  })
  if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${await res.text()}` }
  const out = (await res.json()) as { sid?: string }
  return { ok: true, ref: out.sid }
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  if (auth !== `Bearer ${serviceKey}`) return json({ error: 'FORBIDDEN' }, 403)
  const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } })

  const { data: jobs, error: jobsErr } = await db.rpc('run_periodic_jobs')
  if (jobsErr) console.error('periodic jobs failed', jobsErr)

  const { data: due, error } = await db.rpc('claim_due_notifications', { p_limit: 100 })
  if (error) return json({ error: error.message }, 500)

  const templateCache = new Map<string, { subject: string | null; body: string } | null>()
  const results = { sent: 0, failed: 0, skipped: 0 }

  for (const n of (due ?? []) as Notification[]) {
    const key = `${n.shop_id}|${n.event}|${n.channel}`
    if (!templateCache.has(key)) {
      const { data: t } = await db.rpc('notification_template', { p_shop_id: n.shop_id, p_event: n.event, p_channel: n.channel })
      templateCache.set(key, t?.id ? t : null)
    }
    const tpl = templateCache.get(key)
    const adapter = adapters[n.channel]
    if (!tpl || !adapter) {
      await db.from('notifications').update({ status: 'skipped', last_error: !tpl ? 'No template' : `No ${n.channel} adapter` }).eq('id', n.id)
      results.skipped++
      continue
    }
    const msg = { subject: render(tpl.subject ?? '', n.payload), text: render(tpl.body, n.payload) }
    try {
      const r = await adapter(n, msg)
      if (r.skip) {
        await db.from('notifications').update({ status: 'skipped', last_error: r.error }).eq('id', n.id)
        results.skipped++
      } else {
        await db.rpc('complete_notification', { p_id: n.id, p_ok: r.ok, p_error: r.error ?? null, p_provider_ref: r.ref ?? null })
        r.ok ? results.sent++ : results.failed++
      }
    } catch (e) {
      await db.rpc('complete_notification', { p_id: n.id, p_ok: false, p_error: String(e) })
      results.failed++
    }
  }
  return json({ jobs, ...results })
})
