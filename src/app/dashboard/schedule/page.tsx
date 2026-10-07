import { requireUser } from "@/lib/auth";
import { getDb, type TimeOff, type WorkingHours } from "@/lib/db";
import { formatDateLong, formatTime, minutesToHHMM, nowInTz, todayInTz, WEEKDAYS } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { addTimeOff, deleteTimeOff, saveHours } from "../actions";

// Monday-first, the way most barbers think about the week.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export default async function SchedulePage() {
  const { user, shop } = await requireUser();
  const db = getDb();
  const hours = db
    .prepare("SELECT * FROM working_hours WHERE barber_id = ? ORDER BY weekday, start_min")
    .all(user.id) as WorkingHours[];
  const timeOff = db
    .prepare("SELECT * FROM time_off WHERE barber_id = ? AND end_at >= ? ORDER BY start_at")
    .all(user.id, nowInTz(shop.timezone)) as TimeOff[];
  const today = todayInTz(shop.timezone);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="h1">Working hours</h1>
        <p className="muted">Clients can only book inside these hours. Add a second shift to leave a lunch break.</p>
      </header>

      <ActionForm action={saveHours} className="card space-y-1">
        {ORDER.map((wd) => {
          const shifts = hours.filter((h) => h.weekday === wd);
          const [a, b] = shifts;
          return (
            <div key={wd} className="grid grid-cols-[7rem_1fr] items-center gap-3 border-b border-line py-2 last:border-0 sm:grid-cols-[8rem_1fr_1fr]">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" name={`on-${wd}`} defaultChecked={shifts.length > 0} className="accent-[var(--accent)]" />
                {WEEKDAYS[wd]}
              </label>
              <div className="flex items-center gap-1.5">
                <input aria-label={`${WEEKDAYS[wd]} start`} className="input py-1.5" type="time" name={`start-${wd}`} defaultValue={a ? minutesToHHMM(a.start_min) : "10:00"} />
                <span className="text-ink-3">–</span>
                <input aria-label={`${WEEKDAYS[wd]} end`} className="input py-1.5" type="time" name={`end-${wd}`} defaultValue={a ? minutesToHHMM(a.end_min) : "19:00"} />
              </div>
              <div className="col-start-2 flex items-center gap-1.5 sm:col-start-3">
                <input aria-label={`${WEEKDAYS[wd]} second shift start`} className="input py-1.5" type="time" name={`start2-${wd}`} defaultValue={b ? minutesToHHMM(b.start_min) : ""} />
                <span className="text-ink-3">–</span>
                <input aria-label={`${WEEKDAYS[wd]} second shift end`} className="input py-1.5" type="time" name={`end2-${wd}`} defaultValue={b ? minutesToHHMM(b.end_min) : ""} />
              </div>
            </div>
          );
        })}
        <div className="pt-3">
          <SubmitButton>Save hours</SubmitButton>
        </div>
      </ActionForm>

      <section className="card">
        <h2 className="h2">Time off</h2>
        <p className="muted">Vacation, appointments, a long lunch — these times disappear from your booking page.</p>
        <ActionForm action={addTimeOff} resetOnSuccess className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="to-from">From</label>
            <input className="input" id="to-from" name="from" type="date" min={today} defaultValue={today} required />
          </div>
          <div>
            <label className="label" htmlFor="to-to">To</label>
            <input className="input" id="to-to" name="to" type="date" min={today} defaultValue={today} />
          </div>
          <div>
            <label className="label" htmlFor="to-reason">Reason (only you see it)</label>
            <input className="input" id="to-reason" name="reason" placeholder="Vacation" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="allDay" defaultChecked className="accent-[var(--accent)]" /> All day
          </label>
          <div className="flex items-center gap-1.5">
            <input aria-label="Start time" className="input" type="time" name="startTime" defaultValue="13:00" />
            <span className="text-ink-3">–</span>
            <input aria-label="End time" className="input" type="time" name="endTime" defaultValue="15:00" />
          </div>
          <SubmitButton>Block time</SubmitButton>
        </ActionForm>

        <ul className="mt-4 divide-y divide-line">
          {timeOff.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                <b>{formatDateLong(t.start_at.slice(0, 10))}</b> {formatTime(t.start_at)} → {t.end_at.slice(0, 10) !== t.start_at.slice(0, 10) && `${formatDateLong(t.end_at.slice(0, 10))} `}
                {formatTime(t.end_at)}
                {t.reason && <span className="text-ink-3"> · {t.reason}</span>}
              </span>
              <form action={deleteTimeOff.bind(null, t.id)}>
                <button className="btn-ghost btn-sm">Remove</button>
              </form>
            </li>
          ))}
          {timeOff.length === 0 && <li className="py-2 text-sm text-ink-3">No upcoming time off.</li>}
        </ul>
      </section>
    </div>
  );
}
