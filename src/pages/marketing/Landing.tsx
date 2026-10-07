import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
  ArrowRight, BarChart3, Box, CalendarCheck, CalendarClock, Check, CreditCard, DoorOpen, Gauge, Landmark, LayoutDashboard, ListOrdered,
  Play, QrCode, Radio, Receipt, RotateCcw, ShieldCheck, Sparkles, Timer, Wallet, Zap,
} from 'lucide-react'
import { Badge, Button, cx, Logo, LogoMark } from '@/components/ui'
import { BarberChairIcon } from '@/components/BarberChair'

// Marketing page. Product previews are illustrative mockups and are labelled
// as such — the product itself never shows fabricated data.

const FLOW = [
  { k: 'SCAN', t: 'Your shop’s QR or link', icon: QrCode },
  { k: 'BOOK', t: 'Book or join the queue', icon: CalendarClock },
  { k: 'SERVE', t: 'Cut timer per chair', icon: Timer },
  { k: 'PAY', t: 'Price, tip, method', icon: Wallet },
  { k: 'REBOOK', t: 'Next visit, one tap', icon: RotateCcw },
  { k: 'GROW', t: 'Finance, analytics & AI', icon: BarChart3 },
]

type Status = 'live' | 'beta' | 'soon'
const SUITE: { name: string; d: string; icon: typeof Zap; status: Status }[] = [
  { name: 'Studio', d: 'Appointments, live barber status, walk-in queue, waitlist, clients and services.', icon: CalendarCheck, status: 'live' },
  { name: 'Owner', d: 'Chairs, chair rent, payouts, expenses, profit and barber performance.', icon: LayoutDashboard, status: 'live' },
  { name: 'POS', d: 'Checkout for services: price, tip, discount, promo codes and receipts.', icon: Receipt, status: 'beta' },
  { name: 'Pay', d: 'Payment tracking across cash, card and transfer — ready for online payments.', icon: CreditCard, status: 'beta' },
  { name: 'AI', d: 'Business assistant, smart insights and scheduling intelligence.', icon: Sparkles, status: 'live' },
  { name: 'Inventory', d: 'Shop stock and each chair owner’s private stock, low-stock alerts and margins.', icon: Box, status: 'live' },
  { name: 'Fiscal', d: 'Dominican Republic electronic invoicing (e-CF / DGII).', icon: ShieldCheck, status: 'soon' },
]

const CONTROL = [
  'I know what’s happening in my shop.',
  'I know how much we’re making.',
  'I know which barber is performing.',
  'I know what’s booked.',
  'Everything is in one place.',
]

const FEATURES = [
  { icon: Radio, t: 'Live barber status', d: 'Available, cutting, on break, queue, offline — driven by the real calendar and the service timer. Customers see who can take them right now.' },
  { icon: BarberChairIcon, t: 'Chairs & chair owners', d: 'Employees on commission or chair owners who keep 100% and pay rent. Each chair owner runs their own schedule, prices and money.' },
  { icon: Landmark, t: 'Finance', d: 'Money in, money out, profit. Chair rent ledger, payouts, expenses — and a take-home view for every chair owner.' },
  { icon: CalendarClock, t: 'Smart availability', d: 'Slots come from real schedules, breaks, buffers and bookings — and fill the gap right after the last client instead of a rigid grid.' },
  { icon: Play, t: 'Service timer', d: 'Start and finish every service on the chair. Real average service time by barber, service, day and hour.' },
  { icon: Gauge, t: 'Chair occupancy', d: 'Booked vs available time with a weekday × hour heatmap. Know when to add hours — and when you pay for empty chairs.' },
  { icon: Wallet, t: 'Payments & commissions', d: 'Every checkout records price, tip, discount and method. Percentage, fixed, tiered, booth-rental and hybrid commissions calculate themselves.' },
  { icon: DoorOpen, t: 'Walk-in queue', d: 'Customers join from your QR code and see “You are #4 · 20–30 min” live. One tap seats the next client.' },
  { icon: ListOrdered, t: 'Waitlist that refills', d: 'A cancellation instantly offers the slot to matching waitlisted clients. Double booking is impossible at the database level.' },
  { icon: Sparkles, t: 'AI business assistant', d: '“How much did we make last month?” — answered from your real numbers, never guessed.' },
  { icon: ShieldCheck, t: 'Your shop, not a marketplace', d: 'Your own branded page and QR — customers never see other shops. Roles are enforced in the database; barbers see only their own money.' },
]

export default function Landing() {
  useEffect(() => {
    document.title = 'BarberNGo — Run Your Shop. Grow Your Business.'
  }, [])
  return (
    <div className="overflow-x-hidden">
      <header className="sticky top-0 z-40 border-b border-line/60 bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Logo />
          <nav className="hidden items-center gap-7 text-sm text-muted md:flex">
            <a href="#how" className="hover:text-ink">How it works</a>
            <a href="#platform" className="hover:text-ink">Platform</a>
            <a href="#pricing" className="hover:text-ink">Pricing</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login" className="hidden text-sm font-medium text-muted hover:text-ink sm:block">Sign in</Link>
            <Link to="/signup?intent=owner"><Button size="sm">Start Free</Button></Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative">
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(900px 520px at 78% -10%, color-mix(in oklab, var(--accent) 26%, transparent), transparent 70%)' }} />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-16 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
          <div className="animate-rise">
            <div className="eyebrow mb-6 inline-flex items-center gap-2.5"><span className="pole inline-block h-1 w-8 rounded-full" />The operating system for modern barbershops</div>
            <h1 className="display text-[48px] sm:text-[68px]">
              Run Your Shop.<br /><span className="text-glow">Grow Your Business.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted">
              From appointments and clients to POS, payments, inventory, staff management, analytics and electronic invoicing, BarberNGo puts everything your shop needs into one powerful platform.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link to="/signup?intent=owner"><Button size="xl" icon={<ArrowRight className="size-5" />} className="flex-row-reverse">Start Free</Button></Link>
              <a href="#how"><Button size="xl" variant="outline">See How It Works</Button></a>
            </div>
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
              {['14-day free trial', 'No card required', 'Set up in minutes'].map((t) => <span key={t} className="inline-flex items-center gap-1.5"><Check className="size-4 text-accent" />{t}</span>)}
            </div>
          </div>
          <div className="relative">
            <CommandCenter />
            <div className="mt-3 text-center text-[11px] text-faint">Illustrative preview</div>
          </div>
        </div>
      </section>

      {/* SUPPORTING TAGLINE + FLOW */}
      <section id="how" className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="display text-center text-3xl sm:text-4xl">Everything your barbershop needs. <span className="text-accent">One platform.</span></h2>
          <div className="mt-12 grid grid-cols-2 gap-y-8 sm:grid-cols-3 lg:grid-cols-6">
            {FLOW.map((f, i) => (
              <div key={f.k} className="relative flex flex-col items-center text-center">
                {i < FLOW.length - 1 && <div className="absolute left-[calc(50%+28px)] top-6 hidden h-px w-[calc(100%-56px)] bg-gradient-to-r from-accent/80 to-line lg:block" />}
                <div className="flex size-12 items-center justify-center rounded-2xl border border-line bg-bg"><f.icon className="size-5 text-accent" strokeWidth={2} /></div>
                <div className="mt-3 font-display text-[12px] font-semibold tracking-[0.16em]">{f.k}</div>
                <div className="mt-1 text-sm text-muted">{f.t}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* LESS / MORE */}
      <section className="mx-auto max-w-6xl px-5 pt-24">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-3xl border border-line p-8">
            {['Less juggling.', 'Less paperwork.', 'Less guesswork.'].map((t) => <div key={t} className="display text-3xl text-muted sm:text-4xl">{t}</div>)}
          </div>
          <div className="rounded-3xl border border-accent/50 bg-accent-soft p-8">
            {['More control.', 'More customers.', 'More growth.'].map((t) => <div key={t} className="display text-3xl sm:text-4xl">{t.split(' ')[0]} <span className="text-glow">{t.split(' ')[1]}</span></div>)}
          </div>
        </div>
      </section>

      {/* CONTROL */}
      <section className="mx-auto max-w-6xl px-5 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="eyebrow">What you’re really getting</div>
            <h2 className="display mt-3 text-5xl sm:text-6xl">Control.</h2>
            <p className="mt-5 max-w-md text-lg text-muted">Not just bookings. A live view of your shop — every chair, every barber, every dollar — calculated from what actually happened.</p>
          </div>
          <ul className="space-y-3">
            {CONTROL.map((c, i) => (
              <li key={c} className={cx('flex items-center gap-4 rounded-2xl border border-line bg-surface px-5 py-4 text-[17px] font-medium', i === CONTROL.length - 1 && 'border-accent/60')}>
                <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-full', i === CONTROL.length - 1 ? 'bg-accent text-accent-ink' : 'bg-accent-soft text-accent')}><Check className="size-4" /></span>
                “{c}”
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* PLATFORM / BRAND ARCHITECTURE */}
      <section id="platform" className="border-y border-line bg-surface py-24">
        <div className="mx-auto max-w-6xl px-5">
          <div className="max-w-2xl">
            <div className="eyebrow">The BarberNGo platform</div>
            <h2 className="display mt-3 text-4xl sm:text-5xl">One workspace. Every part of the business.</h2>
          </div>
          <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SUITE.map((m) => (
              <div key={m.name} className={cx('rounded-2xl border border-line bg-bg p-6', m.status === 'soon' && 'opacity-80')}>
                <div className="flex items-center justify-between">
                  <m.icon className="size-6 text-accent" strokeWidth={2} />
                  <Badge tone={m.status === 'live' ? 'success' : m.status === 'beta' ? 'accent' : 'neutral'}>{m.status === 'live' ? 'Available' : m.status === 'beta' ? 'Early access' : 'Coming soon'}</Badge>
                </div>
                <div className="mt-5 font-display text-lg font-semibold">BarberNGo <span className="text-accent">{m.name}</span></div>
                <p className="mt-2 text-sm leading-relaxed text-muted">{m.d}</p>
              </div>
            ))}
            <div className="flex flex-col justify-center rounded-2xl border border-dashed border-line-strong p-6">
              <LogoMark size={40} />
              <p className="mt-4 text-sm text-muted">All modules share one client list, one calendar and one source of truth for your numbers.</p>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="mx-auto max-w-6xl px-5 py-24">
        <div className="grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.t} className="bg-surface p-7">
              <f.icon className="size-6 text-accent" strokeWidth={2} />
              <h3 className="mt-4 font-display text-lg font-semibold">{f.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="mx-auto max-w-6xl px-5 pb-24">
        <h2 className="display text-center text-4xl sm:text-5xl">Simple pricing</h2>
        <p className="mt-3 text-center text-muted">Every plan starts with a 14-day free trial.</p>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            { n: 'Starter', p: 29, d: 'The independent barber', f: ['1 barber / chair owner', 'Your booking page + QR', 'Customers, timer & live status', 'Inventory, expenses & take-home'] },
            { n: 'Shop', p: 79, d: 'Multi-chair shops', f: ['Unlimited chairs & barbers', 'Chair owners, rent & payouts', 'Live walk-in queue & waitlist', 'Finance, analytics & exports'], hot: true },
            { n: 'Pro', p: 149, d: 'Growth & multiple locations', f: ['Everything in Shop', 'AI assistant & insights', 'Marketing, gift cards, memberships', 'Multi-location & custom domain'] },
          ].map((p) => (
            <div key={p.n} className={cx('rounded-3xl border p-7', p.hot ? 'border-accent bg-surface shadow-card' : 'border-line')}>
              <div className="flex items-center justify-between"><div className="font-display text-lg font-semibold">{p.n}</div>{p.hot && <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-bold text-accent-ink">POPULAR</span>}</div>
              <div className="mt-1 text-sm text-muted">{p.d}</div>
              <div className="mt-6 font-display text-5xl font-semibold tracking-tight">${p.p}<span className="font-sans text-base font-normal text-muted">/mo</span></div>
              <ul className="mt-6 space-y-2.5 text-sm">{p.f.map((x) => <li key={x} className="flex gap-2"><Check className="size-4 shrink-0 text-accent" />{x}</li>)}</ul>
              <Link to="/signup?intent=owner"><Button block size="lg" variant={p.hot ? 'primary' : 'outline'} className="mt-8">Start Free</Button></Link>
            </div>
          ))}
        </div>
      </section>

      <section className="relative overflow-hidden border-t border-line">
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(700px 300px at 50% 120%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 70%)' }} />
        <div className="relative mx-auto max-w-6xl px-5 py-24 text-center">
          <LogoMark size={56} className="mx-auto" />
          <h2 className="display mx-auto mt-8 max-w-3xl text-4xl sm:text-6xl">Run Your Shop.<br />Grow Your Business.</h2>
          <p className="mt-5 text-muted"><span className="font-semibold text-ink">BarberNGo</span> — Everything your barbershop needs. One platform.</p>
          <Link to="/signup?intent=owner"><Button size="xl" className="mt-10">Start Free</Button></Link>
        </div>
      </section>
      <footer className="border-t border-line py-10 text-center text-sm text-muted">
        <Logo className="justify-center" />
        <p className="mt-3">© {new Date().getFullYear()} BarberNGo</p>
      </footer>
    </div>
  )
}

/** Hero preview: the owner command center (illustrative data, labelled as such). */
function CommandCenter() {
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 300)
    return () => clearTimeout(t)
  }, [])
  const pts = [18, 24, 22, 31, 29, 38, 35, 44, 41, 50, 47, 58]
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * 300},${80 - v}`).join('')
  const schedule = [['09:00', 'Carlos', 'Fade + Beard'], ['09:30', 'Marcus', 'Haircut'], ['10:00', 'David', 'Premium Cut'], ['10:45', 'Luis', 'Kids Cut']]
  return (
    <div className="animate-rise rounded-3xl border border-line-strong bg-surface p-5 shadow-2xl">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-display text-xl font-semibold">Good morning, Alex.</div>
          <div className="text-sm text-muted">Your shop is looking good today.</div>
        </div>
        <LogoMark size={30} />
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2">
        {[['$2,840', 'Today’s revenue'], ['42', 'Appointments'], ['8', 'Barbers working'], ['94%', 'Occupancy']].map(([v, l]) => (
          <div key={l} className="rounded-xl bg-surface-2 p-2.5">
            <div className="font-display text-lg font-semibold leading-none">{v}</div>
            <div className="mt-1.5 text-[10px] leading-tight text-muted">{l}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-[1fr_1.1fr] gap-3">
        <div className="rounded-xl border border-line p-3">
          <div className="eyebrow text-[9px]">Today’s schedule</div>
          <div className="mt-2 space-y-1.5">
            {schedule.map(([t, n, s]) => (
              <div key={t} className="flex items-center gap-2 text-[11px]"><span className="w-9 font-semibold tnum">{t}</span><span className="size-1.5 rounded-full bg-accent" /><span className="flex-1 truncate">{n}</span><span className="truncate text-muted">{s}</span></div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-line p-3">
          <div className="flex justify-between"><span className="eyebrow text-[9px]">Revenue</span><span className="text-[10px] font-semibold text-success">↑ 12%</span></div>
          <svg viewBox="0 0 300 85" className="mt-2 w-full">
            <path d={`${path}L300,85L0,85Z`} fill="var(--accent)" opacity={0.12} />
            <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="600" strokeDashoffset={drawn ? 0 : 600} style={{ transition: 'stroke-dashoffset 2s ease' }} />
          </svg>
        </div>
      </div>
      <div className="mt-3 rounded-xl border border-accent/40 bg-accent-soft p-3 text-[12px]">
        <div className="flex items-center gap-1.5 font-semibold"><Zap className="size-3.5 text-accent" /> AI insight</div>
        <p className="mt-1 text-muted">Friday is trending 18% above average. <span className="text-ink">Consider opening one additional booking slot.</span></p>
      </div>
    </div>
  )
}
