import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Lightbulb, Send, Sparkles, TrendingDown, TrendingUp, AlertTriangle, Info } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useAnalytics, useBarbers } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { addDays, todayInTz } from '@/lib/time'
import { generateInsights, type InsightKind } from '@/lib/insights'
import { composeAnswer, parseQuestion, SUGGESTED_QUESTIONS, type Answer } from '@/lib/assistant'
import type { Analytics, ClientRow } from '@/lib/types'
import { Badge, Button, Card, CardHeader, cx, EmptyState, Input, PageHeader, Skeleton, Spinner } from '@/components/ui'
import { friendlyError } from '@/lib/errors'

const KIND: Record<InsightKind, { icon: typeof Lightbulb; tone: string; label: string }> = {
  opportunity: { icon: Lightbulb, tone: 'bg-accent-soft text-accent', label: 'Opportunity' },
  warning: { icon: AlertTriangle, tone: 'bg-warning/14 text-warning', label: 'Watch' },
  win: { icon: TrendingUp, tone: 'bg-success/12 text-success', label: 'Win' },
  info: { icon: Info, tone: 'bg-info/12 text-info', label: 'Note' },
}

export default function Insights() {
  const { ws } = useWorkspace()
  const today = todayInTz(ws.timezone)
  const { data: a, isLoading } = useAnalytics(ws.shop_id, addDays(today, -29), today)
  const { data: a90 } = useAnalytics(ws.shop_id, addDays(today, -89), today)
  const insights = useMemo(() => {
    const seen = new Set<string>()
    return [...(a ? generateInsights(a) : []), ...(a90 ? generateInsights(a90) : [])].filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
  }, [a, a90])

  return (
    <div>
      <PageHeader eyebrow="Intelligence" title="Insights" subtitle="Recommendations computed from your real bookings, timer data and payments." />
      <div className="grid gap-6 xl:grid-cols-[1fr_440px]">
        <div className="space-y-3">
          {isLoading ? <Skeleton className="h-64" /> : insights.length === 0 ? (
            <Card><EmptyState icon={<Sparkles className="size-6" />} title="Not enough history yet" body="Insights appear once there's enough data to be confident — usually after a couple of weeks of bookings and at least 10 timed cuts." /></Card>
          ) : insights.map((i) => {
            const k = KIND[i.kind]
            return (
              <Card key={i.id} className="flex gap-4 p-5">
                <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', k.tone)}><k.icon className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-semibold leading-snug">{i.title}</h3>
                    <Badge>{k.label}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted">{i.detail}</p>
                  {i.recommendation && <p className="mt-2 text-sm"><span className="font-semibold">Recommendation: </span>{i.recommendation}</p>}
                  {i.action && <Link to={i.action.to} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline">{i.action.label} <ArrowRight className="size-3.5" /></Link>}
                </div>
              </Card>
            )
          })}
        </div>
        <Assistant />
      </div>
    </div>
  )
}

interface Msg {
  role: 'user' | 'assistant'
  text: string
  answer?: Answer
  source?: 'data' | 'ai'
}

function Assistant() {
  const { ws, hasFeature } = useWorkspace()
  const qc = useQueryClient()
  const { data: barbers } = useBarbers(ws.shop_id, { includeArchived: true })
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const ai = hasFeature('ai_insights')

  async function ask(question: string) {
    if (!question.trim() || busy) return
    setQ('')
    setMsgs((m) => [...m, { role: 'user', text: question }])
    setBusy(true)
    try {
      const parsed = parseQuestion(question, ws.timezone, (barbers ?? []).map((b) => ({ id: b.id, name: b.display_name })))
      let reply: Msg
      if (parsed.intent !== 'unknown' || !ai) {
        // Deterministic path: fetch exactly the data the question needs.
        const [analytics, clients] = await Promise.all([
          parsed.intent === 'lapsed_clients' ? Promise.resolve(null) : qc.fetchQuery({
            queryKey: ['analytics', ws.shop_id, parsed.from, parsed.to, parsed.intent.startsWith('barber') ? null : parsed.barberId],
            queryFn: () => rpc<Analytics>('shop_analytics', { p_shop_id: ws.shop_id, p_from: parsed.from, p_to: parsed.to, p_barber_id: parsed.intent.startsWith('barber') ? null : parsed.barberId }),
          }),
          parsed.needsClients ? rpc<ClientRow[]>('list_clients', { p_shop_id: ws.shop_id, p_limit: 500, p_sort: 'last_visit' }) : Promise.resolve(undefined),
        ])
        const answer = composeAnswer(parsed, analytics, clients)
        reply = { role: 'assistant', text: answer.text, answer, source: 'data' }
      } else {
        // Open-ended: Claude, restricted to the same data tools (see supabase/functions/assistant).
        const { data, error } = await supabase.functions.invoke('assistant', {
          body: { shop_id: ws.shop_id, question, history: msgs.slice(-6).map((m) => ({ role: m.role, content: m.text })) },
        })
        if (error || data?.error) throw new Error(data?.error === 'AI_NOT_CONFIGURED' ? 'The AI assistant is not configured for this shop yet.' : data?.error ?? error?.message)
        reply = { role: 'assistant', text: data.answer, source: 'ai' }
      }
      setMsgs((m) => [...m, reply])
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: friendlyError(e) }])
    } finally {
      setBusy(false)
      setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    }
  }

  return (
    <Card className="flex h-[calc(100dvh-220px)] min-h-[520px] flex-col xl:sticky xl:top-8">
      <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent" /> Ask your shop</span>} subtitle="Answers use your real numbers — never estimates." />
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {msgs.length === 0 && (
          <div className="space-y-2">
            {SUGGESTED_QUESTIONS.map((s) => (
              <button key={s} onClick={() => ask(s)} className="block w-full rounded-xl border border-line px-3.5 py-2.5 text-left text-sm transition hover:border-accent hover:bg-accent-soft">{s}</button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cx('animate-rise', m.role === 'user' ? 'flex justify-end' : '')}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-accent-ink">{m.text}</div>
            ) : (
              <div className="max-w-[95%] text-sm">
                <p className="whitespace-pre-line leading-relaxed">{m.text}</p>
                {!!m.answer?.facts.length && (
                  <dl className="mt-3 divide-y divide-line rounded-xl border border-line">
                    {m.answer.facts.map((f) => <div key={f.label} className="flex justify-between gap-3 px-3 py-2"><dt className="text-muted">{f.label}</dt><dd className="font-medium tnum">{f.value}</dd></div>)}
                  </dl>
                )}
                {!!m.answer?.list?.length && (
                  <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
                    {m.answer.list.map((l) => (
                      <li key={l.title + l.sub}>{l.href ? <Link to={l.href} className="block px-3 py-2 hover:bg-surface-2"><div className="font-medium">{l.title}</div><div className="text-xs text-muted">{l.sub}</div></Link> : <div className="px-3 py-2">{l.title}</div>}</li>
                    ))}
                  </ul>
                )}
                {m.answer?.followUps && <div className="mt-2 flex flex-wrap gap-1.5">{m.answer.followUps.map((f) => <button key={f} onClick={() => ask(f)} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:text-ink">{f}</button>)}</div>}
                {m.source && <div className="mt-1.5 text-[11px] text-faint">{m.source === 'ai' ? 'AI answer · based on tool-fetched shop data' : 'From your shop data'}</div>}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-sm text-muted"><Spinner className="size-4" /> Looking at your numbers…</div>}
        <div ref={end} />
      </div>
      <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); ask(q) }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="How much did Carlos earn last month?" aria-label="Ask a question" />
        <Button type="submit" aria-label="Send" disabled={!q.trim() || busy}><Send className="size-4" /></Button>
      </form>
      {!ai && <p className="px-4 pb-3 text-[11px] text-muted"><TrendingDown className="mr-1 inline size-3" />Open-ended AI answers are on the Pro plan; common questions work on every plan.</p>}
    </Card>
  )
}
