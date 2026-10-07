// Notification dispatcher (Supabase Edge Function, Deno).
// Run every minute (Supabase scheduled function / pg_cron + pg_net):
//   1. run_periodic_jobs(): expire waitlist offers, queue rebooking reminders, daily snapshots
//   2. claim due notifications from the outbox (FOR UPDATE SKIP LOCKED — safe to run concurrently)
//   3. render the shop's template (or the platform default) and deliver through a channel adapter
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL, RESEND_API_KEY (email), EMAIL_FROM.
// Adding SMS / WhatsApp / push = adding an adapter below; the outbox schema already supports them.
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
        from: Deno.env.get('EMAIL_FROM') ?? 'BarberNGo <bookings@barberngo.app>',
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
  // sms / whatsapp / push: add adapters here (e.g. Twilio, Meta Cloud API, FCM/APNs).
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
