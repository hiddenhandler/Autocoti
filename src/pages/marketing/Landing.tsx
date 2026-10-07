import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight, BarChart3, CalendarClock, Check, CreditCard, DoorOpen, Gauge, ListOrdered, Play, RotateCcw, Scissors, ShieldCheck, Sparkles, Timer, Users } from 'lucide-react'
import { Button, cx, Logo } from '@/components/ui'

// Marketing page. The product previews below are illustrative mockups and
// are labelled as such — the product itself never shows fabricated data.

const FLOW = [
  { k: 'CLIENT', t: 'Finds a barber', icon: Users },
  { k: 'BOOK', t: 'Real-time slots', icon: CalendarClock },
  { k: 'CUT', t: 'Timer starts', icon: Timer },
  { k: 'PAY', t: 'Price, tip, method', icon: CreditCard },
  { k: 'REBOOK', t: 'Next cut, one tap', icon: RotateCcw },
  { k: 'OWNER', t: 'Sees it all', icon: BarChart3 },
]

const OS = ['BOOKING', 'OPERATIONS', 'BARBERS', 'CLIENTS', 'MONEY', 'ANALYTICS', 'GROWTH']

const FEATURES = [
  { icon: CalendarClock, t: 'Smart availability', d: 'Slots are calculated from real schedules, breaks, buffers and bookings — and fill the gaps right after the last client instead of a rigid 30-minute grid.' },
  { icon: Play, t: 'Haircut timer', d: 'START CUT / FINISH CUT records actual vs booked time on every chair. Your real average cut time, by barber, service, day and hour.' },
  { icon: Gauge, t: 'Chair utilization', d: 'Available vs booked chair-minutes with a weekday × hour heatmap. Know exactly when to add hours — and when you are paying for empty chairs.' },
  { icon: CreditCard, t: 'Payments, tips, commissions', d: 'Every checkout records price, tip, discount and method. Percentage, fixed, tiered, booth-rental and hybrid commissions calculate themselves.' },
  { icon: DoorOpen, t: 'Walk-in queue', d: 'Live queue with wait estimates pulled from each barber’s real calendar. NEXT CLIENT puts them in the chair.' },
  { icon: ListOrdered, t: 'Waitlist that refills', d: 'A cancellation instantly offers the slot to matching waitlisted clients. First to claim gets it — double booking is impossible at the database level.' },
  { icon: Users, t: 'Client CRM & retention', d: 'Visit rhythm per client, cut notes, preferences. Active, at-risk and lost clients surface automatically — with a one-tap win-back.' },
  { icon: Sparkles, t: 'Insights & AI assistant', d: '“Saturday 2–5 PM is at 95% capacity.” Ask “How much did Carlos earn last month?” — answered from your real numbers, never guessed.' },
  { icon: ShieldCheck, t: 'Built for teams', d: 'Owner, manager, receptionist and barber roles enforced in the database. Barbers see their own money — never anyone else’s. Full audit log.' },
]

export default function Landing() {
  useEffect(() => {
    document.title = 'Autocoti — Run your barbershop. Not your spreadsheet.'
  }, [])
  return (
    <div className="overflow-x-hidden">
      <header className="sticky top-0 z-40 border-b border-line/60 bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Logo />
          <nav className="hidden items-center gap-7 text-sm text-muted md:flex">
            <a href="#product" className="hover:text-ink">Product</a>
            <a href="#features" className="hover:text-ink">Features</a>
            <a href="#pricing" className="hover:text-ink">Pricing</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login" className="hidden text-sm font-medium text-muted hover:text-ink sm:block">Sign in</Link>
            <Link to="/signup?intent=owner"><Button size="sm">Start free</Button></Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative">
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(900px 500px at 75% 0%, color-mix(in oklab, var(--accent) 18%, transparent), transparent 70%)' }} />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-16 lg:grid-cols-[1.1fr_1fr] lg:pt-24">
          <div className="animate-rise">
            <div className="eyebrow mb-5 inline-flex items-center gap-2"><span className="pole inline-block h-2 w-8 rounded-full" /> The operating system for your barbershop</div>
            <h1 className="display text-[58px] leading-[0.92] sm:text-[84px]">
              Run your barbershop.<br /><span className="italic text-accent">Not your spreadsheet.</span>
            </h1>
            <p className="mt-6 max-w-lg text-lg text-muted">Bookings, barbers, clients, payments and business intelligence — all in one place.</p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link to="/signup?intent=owner"><Button size="xl" icon={<ArrowRight className="size-5" />} className="flex-row-reverse">START FREE</Button></Link>
              <a href="mailto:hello@autocoti.com?subject=Autocoti%20demo"><Button size="xl" variant="outline">BOOK A DEMO</Button></a>
            </div>
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
              {['14-day free trial', 'No card required', 'Set up in 2 minutes'].map((t) => <span key={t} className="inline-flex items-center gap-1.5"><Check className="size-4 text-accent" />{t}</span>)}
            </div>
          </div>
          <HeroMockups />
        </div>
      </section>

      {/* FLOW */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <div className="grid grid-cols-2 gap-y-8 sm:grid-cols-3 lg:grid-cols-6">
            {FLOW.map((f, i) => (
              <div key={f.k} className="relative flex flex-col items-center text-center">
                {i < FLOW.length - 1 && <div className="absolute left-[calc(50%+28px)] top-6 hidden h-px w-[calc(100%-56px)] bg-gradient-to-r from-accent/70 to-line lg:block" />}
                <div className="flex size-12 items-center justify-center rounded-2xl border border-line bg-bg"><f.icon className="size-5 text-accent" /></div>
                <div className="mt-3 text-[12px] font-bold tracking-[0.18em]">{f.k}</div>
                <div className="mt-1 text-sm text-muted">{f.t}</div>
              </div>
            ))}
          </div>
          <p className="display mx-auto mt-12 max-w-2xl text-center text-3xl sm:text-4xl">Everything connects. The cut your barber finishes is the number you see on your dashboard.</p>
        </div>
      </section>

      {/* PRODUCT */}
      <section id="product" className="mx-auto max-w-6xl space-y-28 px-5 py-24">
        <Showcase eyebrow="For clients" title="Book my haircut." body="Pick a service, a barber — or “first available” — and see times that are actually free, right now. Rebook the same barber in one tap. No app download needed." points={['Real-time availability', 'First available across barbers', 'Reschedule & cancel by policy', 'Waitlist when the day is full']}>
          <PhoneBooking />
        </Showcase>
        <Showcase flip eyebrow="For barbers" title="Who is next?" body="The whole day from a phone. One big button starts the cut and the timer; finishing opens checkout and suggests the next booking before the client leaves." points={['Today, next client, time remaining', 'Start / finish cut timer', 'Record price, tip, payment', 'Own earnings, privately']}>
          <PhoneBarber />
        </Showcase>
        <Showcase eyebrow="For owners" title="How is my shop performing?" body="Revenue, utilization, cut time, rebooking and retention — calculated from real bookings and payments, with recommendations you can act on today." points={['Revenue by barber, service, hour', 'Chair utilization vs target', 'Average cut time vs booked', 'Smart insights + AI assistant']}>
          <OwnerDash />
        </Showcase>
      </section>

      {/* OS */}
      <section className="border-y border-line bg-surface py-20">
        <div className="mx-auto max-w-6xl px-5 text-center">
          <div className="eyebrow">Not just another booking app</div>
          <h2 className="display mt-3 text-5xl sm:text-6xl">The operating system for your barbershop</h2>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-3 gap-y-4 text-sm font-bold tracking-[0.16em]">
            {OS.map((o, i) => (
              <span key={o} className="inline-flex items-center gap-3">
                <span className={cx('rounded-full border px-4 py-2', i === 0 ? 'border-accent bg-accent text-accent-ink' : 'border-line')}>{o}</span>
                {i < OS.length - 1 && <span className="text-accent">●</span>}
              </span>
            ))}
          </div>
          <p className="mx-auto mt-8 max-w-xl text-muted">Booking is the entry point. The real value is everything that happens after the client sits down.</p>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="mx-auto max-w-6xl px-5 py-24">
        <div className="grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.t} className="bg-surface p-7">
              <f.icon className="size-6 text-accent" />
              <h3 className="mt-4 text-lg font-semibold">{f.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="mx-auto max-w-6xl px-5 pb-24">
        <h2 className="display text-center text-5xl">Simple pricing</h2>
        <p className="mt-3 text-center text-muted">Every plan starts with a 14-day free trial.</p>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            { n: 'Starter', p: 29, d: 'The independent barber', f: ['1 barber', 'Online booking & calendar', 'Client management', 'Haircut timer & basic analytics'] },
            { n: 'Shop', p: 79, d: 'Multi-chair shops', f: ['Unlimited barbers', 'Advanced analytics & exports', 'Walk-ins & waitlist', 'Commissions & automations'], hot: true },
            { n: 'Pro', p: 149, d: 'Growth & multiple locations', f: ['Everything in Shop', 'AI insights & assistant', 'Marketing, gift cards, memberships', 'Multi-location & custom domain'] },
          ].map((p) => (
            <div key={p.n} className={cx('rounded-3xl border p-7', p.hot ? 'border-accent bg-surface shadow-card' : 'border-line')}>
              <div className="flex items-center justify-between"><div className="text-lg font-semibold">{p.n}</div>{p.hot && <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-bold text-accent-ink">POPULAR</span>}</div>
              <div className="mt-1 text-sm text-muted">{p.d}</div>
              <div className="mt-6 text-5xl font-semibold tracking-tight">${p.p}<span className="text-base font-normal text-muted">/mo</span></div>
              <ul className="mt-6 space-y-2.5 text-sm">{p.f.map((x) => <li key={x} className="flex gap-2"><Check className="size-4 shrink-0 text-accent" />{x}</li>)}</ul>
              <Link to="/signup?intent=owner"><Button block size="lg" variant={p.hot ? 'primary' : 'outline'} className="mt-8">Start free</Button></Link>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto max-w-6xl px-5 py-24 text-center">
          <Scissors className="mx-auto size-8 text-accent" />
          <h2 className="display mx-auto mt-6 max-w-3xl text-5xl sm:text-6xl">Your chairs, your clients, your numbers. Finally in one place.</h2>
          <Link to="/signup?intent=owner"><Button size="xl" className="mt-10">START FREE</Button></Link>
        </div>
      </section>
      <footer className="border-t border-line py-10 text-center text-sm text-muted">
        <Logo className="justify-center" />
        <p className="mt-3">© {new Date().getFullYear()} Autocoti</p>
      </footer>
    </div>
  )
}

function Showcase({ eyebrow, title, body, points, children, flip }: { eyebrow: string; title: string; body: string; points: string[]; children: React.ReactNode; flip?: boolean }) {
  return (
    <div className={cx('grid items-center gap-12 lg:grid-cols-2', flip && 'lg:[&>*:first-child]:order-2')}>
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="display mt-3 text-5xl sm:text-6xl">“{title}”</h2>
        <p className="mt-5 max-w-md text-lg text-muted">{body}</p>
        <ul className="mt-6 grid gap-2 text-sm sm:grid-cols-2">{points.map((p) => <li key={p} className="flex gap-2"><Check className="size-4 shrink-0 text-accent" />{p}</li>)}</ul>
      </div>
      <div className="relative">{children}<div className="mt-3 text-center text-[11px] text-faint">Illustrative preview</div></div>
    </div>
  )
}

function useTicker(ms: number, n: number) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % n), ms)
    return () => clearInterval(t)
  }, [ms, n])
  return i
}

function Phone({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx('mx-auto w-[280px] rounded-[42px] border border-line-strong bg-surface p-2.5 shadow-2xl', className)}>
      <div className="relative overflow-hidden rounded-[34px] bg-bg">
        <div className="absolute left-1/2 top-2 z-10 h-5 w-20 -translate-x-1/2 rounded-full bg-black" />
        <div className="h-[540px] px-4 pb-4 pt-10">{children}</div>
      </div>
    </div>
  )
}

function PhoneBooking() {
  const i = useTicker(1300, 6)
  const times = ['2:30', '2:45', '3:30', '4:15', '4:30', '5:15']
  return (
    <Phone>
      <div className="text-[11px] font-semibold text-muted">STEP 3 OF 4</div>
      <div className="display mt-1 text-3xl">Pick a time</div>
      <div className="mt-1 text-xs text-muted">with Carlos · Haircut · 40 min</div>
      <div className="mt-4 flex gap-1.5">
        {['Today', 'Fri', 'Sat', 'Sun'].map((d, k) => <div key={d} className={cx('flex-1 rounded-xl border py-2 text-center text-[11px] font-semibold', k === 0 ? 'border-accent bg-accent text-accent-ink' : 'border-line')}>{d}</div>)}
      </div>
      <div className="mt-5 text-[10px] font-semibold tracking-widest text-muted">AFTERNOON</div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {times.map((t, k) => <div key={t} className={cx('rounded-xl border py-2.5 text-center text-sm font-semibold transition-all duration-500', k === i ? 'scale-105 border-accent bg-accent-soft' : 'border-line')}>{t}</div>)}
      </div>
      <div className="mt-6 rounded-2xl border border-line p-3 text-xs">
        <div className="font-semibold">First available</div>
        {[['Carlos', '2:30 PM'], ['Luis', '2:45 PM'], ['Miguel', '3:00 PM']].map(([n, t]) => <div key={n} className="mt-2 flex justify-between"><span className="text-muted">{n}</span><span className="font-semibold">{t}</span></div>)}
      </div>
      <div className="mt-5 rounded-xl bg-accent py-3 text-center text-sm font-bold text-accent-ink">Confirm · $35</div>
    </Phone>
  )
}

function PhoneBarber() {
  const [s, setS] = useState(37 * 60 + 12)
  useEffect(() => {
    const t = setInterval(() => setS((x) => (x >= 44 * 60 ? 30 * 60 : x + 1)), 1000)
    return () => clearInterval(t)
  }, [])
  const pct = s / (45 * 60)
  return (
    <Phone>
      <div className="text-[11px] font-semibold text-muted">TODAY</div>
      <div className="mt-3 rounded-2xl border border-success/40 p-4 text-center">
        <div className="inline-block rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success">IN CHAIR</div>
        <div className="mt-2 font-semibold">John D.</div>
        <div className="text-xs text-muted">Skin fade · booked 45 min</div>
        <svg viewBox="0 0 120 120" className="mx-auto mt-3 size-32 -rotate-90">
          <circle cx="60" cy="60" r="50" fill="none" stroke="var(--surface-3)" strokeWidth="7" />
          <circle cx="60" cy="60" r="50" fill="none" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${pct * 314} 314`} />
        </svg>
        <div className="-mt-[86px] mb-12 text-2xl font-semibold tnum">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</div>
        <div className="rounded-xl bg-accent py-2.5 text-sm font-bold text-accent-ink">FINISH CUT</div>
      </div>
      <div className="mt-4 space-y-2 text-xs">
        {[['3:30', 'Mike R.', 'Haircut + Beard'], ['4:30', 'David K.', 'Haircut'], ['5:15', 'Walk-in', 'Beard']].map(([t, n, sv]) => (
          <div key={t} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2"><span className="w-9 font-semibold">{t}</span><span className="size-1.5 rounded-full bg-accent" /><span className="flex-1">{n}</span><span className="text-muted">{sv}</span></div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px]">
        {[['Cuts', '8'], ['Tips', '$74'], ['Avg cut', '37m']].map(([l, v]) => <div key={l} className="rounded-xl bg-surface-2 py-2"><div className="text-muted">{l}</div><div className="text-sm font-semibold">{v}</div></div>)}
      </div>
    </Phone>
  )
}

function OwnerDash() {
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 300)
    return () => clearTimeout(t)
  }, [])
  const pts = [22, 28, 25, 34, 31, 42, 38, 45, 41, 52, 48, 58]
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * 300},${90 - v}`).join('')
  return (
    <div className="rounded-3xl border border-line-strong bg-surface p-5 shadow-2xl">
      <div className="display text-2xl">Good morning, Ana.</div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {[['Revenue', '$1,240'], ['Utilization', '82%'], ['Avg cut', '38 min']].map(([l, v]) => (
          <div key={l} className="rounded-2xl bg-surface-2 p-3"><div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{l}</div><div className="mt-1 text-xl font-semibold">{v}</div></div>
        ))}
      </div>
      <div className="mt-4 rounded-2xl border border-line p-3">
        <div className="flex justify-between text-xs"><span className="font-semibold">Revenue · 12 weeks</span><span className="font-semibold text-success">↑ 12%</span></div>
        <svg viewBox="0 0 300 95" className="mt-2 w-full">
          <path d={`${path}L300,95L0,95Z`} fill="var(--accent)" opacity={0.1} />
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray="600" strokeDashoffset={drawn ? 0 : 600} style={{ transition: 'stroke-dashoffset 2s ease' }} />
        </svg>
      </div>
      <div className="mt-3 space-y-2">
        {[['Carlos', 92], ['Luis', 78], ['Miguel', 64]].map(([n, v]) => (
          <div key={n} className="flex items-center gap-3 text-xs"><span className="w-14">{n}</span><div className="h-2 flex-1 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-accent transition-[width] duration-1000" style={{ width: drawn ? `${v}%` : '0%' }} /></div><span className="w-8 text-right font-semibold">{v}%</span></div>
        ))}
      </div>
      <div className="mt-4 rounded-2xl bg-accent-soft p-3 text-xs"><b>Insight:</b> Saturday 2–5 PM runs at 95%+. Consider extending Saturday by 2 hours.</div>
    </div>
  )
}

function HeroMockups() {
  return (
    <div className="relative mx-auto hidden h-[560px] w-full max-w-[520px] sm:block">
      <div className="absolute right-0 top-6 w-[360px] rotate-2"><OwnerDash /></div>
      <div className="absolute -left-2 top-24 -rotate-3 scale-[0.82]"><PhoneBooking /></div>
    </div>
  )
}
