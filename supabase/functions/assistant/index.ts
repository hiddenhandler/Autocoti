// AI business assistant (Supabase Edge Function, Deno).
//
// Claude answers owner questions ONLY from shop data it fetches through tools.
// Every tool calls a Postgres RPC with the caller's own JWT, so RLS and the
// permission checks inside the RPCs apply exactly as in the app: a barber
// asking about another barber's money gets nothing, and numbers are never
// invented — if a tool returns nothing, the model has nothing to quote.
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY (set by Supabase).
import Anthropic from 'npm:@anthropic-ai/sdk@^0.110.0'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/http.ts'

const MODEL = 'claude-opus-5-5'
const MAX_TURNS = 6

const SYSTEM = `You are the business analyst inside BarberNGo, a barbershop management app.
You answer the shop owner's questions about their business.

Rules:
- Use the tools to fetch data before answering. Every number you state must come from a tool result in this conversation. Never estimate, extrapolate or invent figures. If the data needed isn't available, say what is missing.
- Money values from tools are integer cents; present them as currency (e.g. 12345 -> $123.45) using the shop currency.
- Dates are local to the shop timezone. "Last month" means the previous calendar month; "this month" means month to date.
- Be concise: lead with the direct answer in one or two sentences, then at most a few supporting bullet points. When explaining a change ("why was revenue lower"), compare against the previous period and name the concrete drivers you see in the data (visits, average ticket, no-shows, cancellations, utilization, barber availability).
- If a tool returns FORBIDDEN or hides a value (null), tell the user they don't have access to that data rather than guessing.`

type ToolInput = Record<string, unknown>

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_shop_analytics',
    description:
      'Full analytics report for a date range (inclusive local dates): revenue (net service revenue, tips, refunds, by service, by payment method), bookings (totals, cancellations, no-shows, walk-ins, peak hours/days), cut time (actual vs booked minutes by barber/service/weekday/hour), chair utilization with a weekday×hour heatmap, per-barber performance, client counts (new/returning/health), reviews, and the same core metrics for the immediately preceding period of equal length under "previous". Optionally restrict to one barber.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (shop local)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (shop local), inclusive' },
        barber_id: { type: ['string', 'null'], description: 'Barber UUID to filter by, or null for the whole shop' },
      },
      required: ['from', 'to', 'barber_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'list_clients',
    description:
      'Client list with retention data: visits, last visit, next appointment, total spent, usual visit cadence in days, days since last visit, and health (NEW, ACTIVE, AT_RISK, LOST). Use health "DUE" for clients overdue for their next cut. Returns at most 200 rows.',
    input_schema: {
      type: 'object',
      properties: {
        health: { type: ['string', 'null'], enum: ['NEW', 'ACTIVE', 'AT_RISK', 'LOST', 'DUE', null] },
        search: { type: ['string', 'null'], description: 'Optional name/phone/email filter' },
        sort: { type: 'string', enum: ['last_visit', 'visits', 'spent', 'name'] },
      },
      required: ['health', 'search', 'sort'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'list_barbers',
    description: 'The shop’s barbers with their ids, names, titles and status.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'NOT_AUTHENTICATED' }, 401)
  if (!Deno.env.get('ANTHROPIC_API_KEY')) return json({ error: 'AI_NOT_CONFIGURED' }, 501)

  const { shop_id, question, history } = (await req.json()) as {
    shop_id: string
    question: string
    history?: { role: 'user' | 'assistant'; content: string }[]
  }
  if (!shop_id || !question || question.length > 2000) return json({ error: 'INVALID_REQUEST' }, 400)

  // Supabase client acting AS THE CALLER (their JWT) so RLS applies.
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  })

  const { data: workspaces, error: wsErr } = await db.rpc('my_workspaces')
  if (wsErr) return json({ error: wsErr.message }, 401)
  const ws = (workspaces as { shop_id: string; shop_name: string; timezone: string; permissions: string[]; role: string }[]).find((w) => w.shop_id === shop_id)
  if (!ws || !(ws.role === 'owner' || ws.permissions.includes('reports.shop'))) return json({ error: 'FORBIDDEN' }, 403)
  const { data: features } = await db.rpc('shop_features', { p_shop_id: shop_id })
  if (!(features as Record<string, unknown>)?.ai_insights) return json({ error: 'PLAN_UPGRADE_REQUIRED' }, 402)
  const { data: settings } = await db.from('shop_settings').select('currency').eq('shop_id', shop_id).single()

  async function runTool(name: string, input: ToolInput): Promise<{ content: string; is_error?: boolean }> {
    if (name === 'get_shop_analytics') {
      const { data, error } = await db.rpc('shop_analytics', { p_shop_id: shop_id, p_from: input.from, p_to: input.to, p_barber_id: input.barber_id ?? null })
      if (error) return { content: error.message, is_error: true }
      // The heatmap is large; summarise to the busiest/quietest cells to keep context lean.
      const a = data as Record<string, unknown> & { heatmap: { dow: number; hour: number; utilization: number | null }[] }
      const sorted = [...(a.heatmap ?? [])].filter((c) => c.utilization !== null).sort((x, y) => (y.utilization ?? 0) - (x.utilization ?? 0))
      return { content: JSON.stringify({ ...a, heatmap: { busiest: sorted.slice(0, 12), quietest: sorted.slice(-8) } }) }
    }
    if (name === 'list_clients') {
      const { data, error } = await db.rpc('list_clients', { p_shop_id: shop_id, p_search: input.search ?? null, p_health: input.health ?? null, p_limit: 200, p_offset: 0, p_sort: input.sort ?? 'last_visit' })
      if (error) return { content: error.message, is_error: true }
      return { content: JSON.stringify(data) }
    }
    if (name === 'list_barbers') {
      const { data, error } = await db.from('barbers').select('id, display_name, title, status').eq('shop_id', shop_id).is('deleted_at', null)
      if (error) return { content: error.message, is_error: true }
      return { content: JSON.stringify(data) }
    }
    return { content: `Unknown tool ${name}`, is_error: true }
  }

  const client = new Anthropic()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: ws.timezone })
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...(history ?? []).slice(-6).map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: `Shop: ${ws.shop_name}. Timezone: ${ws.timezone}. Currency: ${settings?.currency ?? 'USD'}. Today: ${today}.\n\nQuestion: ${question}`,
    },
  ]

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOLS,
        output_config: { effort: 'medium' },
        // Re-run declined requests on Anthropic's recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages,
      } as Anthropic.Beta.MessageCreateParamsNonStreaming)

      if (response.stop_reason === 'refusal') {
        return json({ answer: "I can't help with that question.", refused: true })
      }
      // Append the full content (thinking blocks included, unchanged).
      messages.push({ role: 'assistant', content: response.content })

      if (response.stop_reason !== 'tool_use') {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()
        return json({ answer: text || 'No answer.', model: response.model })
      }

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      const results = await Promise.all(
        toolUses.map(async (t) => {
          const r = await runTool(t.name, t.input as ToolInput)
          return { type: 'tool_result' as const, tool_use_id: t.id, content: r.content, is_error: r.is_error }
        }),
      )
      // All tool results go back in a single user message.
      messages.push({ role: 'user', content: results })
    }
    return json({ answer: 'That question needed more steps than allowed. Try narrowing it down.' })
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'AI_RATE_LIMITED' }, 429)
    if (err instanceof Anthropic.APIError) return json({ error: `AI_ERROR_${err.status}` }, 502)
    throw err
  }
})
