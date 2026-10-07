import { requireUser } from "@/lib/auth";
import { EXPENSE_CATEGORIES, money } from "@/lib/format";
import { resolveRange } from "@/lib/ranges";
import { barberFinances } from "@/lib/stats";
import { formatDateLong, todayInTz } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { BarChart } from "@/components/charts";
import { RangeTabs } from "@/components/range-tabs";
import { Stat } from "@/components/ui";
import { addExpense, deleteExpense } from "../actions";

export default async function FinancesPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { user, shop } = await requireUser();
  const today = todayInTz(shop.timezone);
  const range = resolveRange((await searchParams).range, today);
  const f = barberFinances(user.id, range.from, range.to);
  const m = (c: number | null) => money(c, shop.currency);
  const tickEvery = Math.ceil(f.daily.length / 8);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">My money</h1>
          <p className="muted">
            Only you see this{user.share_earnings ? " (you share your totals with the owner)" : ""}. Nothing here is connected to a bank — it&apos;s what you log when you finish a cut.
          </p>
        </div>
        <RangeTabs active={range.key} />
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Earned (cuts + tips)" value={m(f.revenueCents + f.tipsCents)} hint={`${m(f.tipsCents)} in tips`} />
        <Stat label="Expenses" value={m(f.expensesCents)} />
        <Stat label="Net" value={m(f.netCents)} />
        <Stat label="Clients served" value={String(f.completed)} hint={`avg ticket ${m(f.avgTicketCents)}`} />
      </div>

      <BarChart
        title="Earnings per day"
        format={m}
        bars={f.daily.map((d, i) => ({
          label: formatDateLong(d.date),
          value: d.cents,
          tooltip: `${formatDateLong(d.date)}: ${m(d.cents)} · ${d.cuts} client${d.cuts === 1 ? "" : "s"}`,
          tick: i % tickEvery === 0 ? d.date.slice(5).replace("-", "/") : "",
        }))}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="h2">By service</h2>
          <table className="mt-3 w-full text-sm tabular-nums">
            <tbody>
              {f.byService.map((s) => (
                <tr key={s.name} className="border-t border-line first:border-0">
                  <td className="py-2">{s.name}</td>
                  <td className="py-2 text-right text-ink-2">{s.count}×</td>
                  <td className="py-2 text-right font-medium">{m(s.cents)}</td>
                </tr>
              ))}
              {f.byService.length === 0 && <tr><td className="py-2 text-ink-3">No completed cuts in this range.</td></tr>}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2 className="h2">By payment method</h2>
          <table className="mt-3 w-full text-sm tabular-nums">
            <tbody>
              {f.byMethod.map((p) => (
                <tr key={p.method} className="border-t border-line first:border-0">
                  <td className="py-2 capitalize">{p.method}</td>
                  <td className="py-2 text-right text-ink-2">{p.count}×</td>
                  <td className="py-2 text-right font-medium">{m(p.cents)}</td>
                </tr>
              ))}
              {f.byMethod.length === 0 && <tr><td className="py-2 text-ink-3">—</td></tr>}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card">
        <h2 className="h2">Expenses</h2>
        <ActionForm action={addExpense} resetOnSuccess className="mt-3 grid gap-3 sm:grid-cols-[9rem_8rem_10rem_1fr_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="ex-date">Date</label>
            <input className="input" id="ex-date" name="date" type="date" defaultValue={today} required />
          </div>
          <div>
            <label className="label" htmlFor="ex-amount">Amount</label>
            <input className="input" id="ex-amount" name="amount" inputMode="decimal" required />
          </div>
          <div>
            <label className="label" htmlFor="ex-cat">Category</label>
            <select className="input" id="ex-cat" name="category">
              {EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ex-note">Note</label>
            <input className="input" id="ex-note" name="note" />
          </div>
          <SubmitButton>Add</SubmitButton>
        </ActionForm>
        <ul className="mt-4 divide-y divide-line">
          {f.expenses.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                <span className="text-ink-2">{e.date}</span> · {e.category}
                {e.note && <span className="text-ink-3"> · {e.note}</span>}
              </span>
              <span className="flex items-center gap-3">
                <b className="tabular-nums">{m(e.amount_cents)}</b>
                <form action={deleteExpense.bind(null, e.id)}>
                  <button className="text-xs text-ink-3 hover:text-bad" aria-label="Delete expense">✕</button>
                </form>
              </span>
            </li>
          ))}
          {f.expenses.length === 0 && <li className="py-2 text-sm text-ink-3">No expenses in this range.</li>}
        </ul>
      </section>
    </div>
  );
}
