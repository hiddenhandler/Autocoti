import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ChevronRight, Search } from 'lucide-react'
import { Button, Card, EmptyState, Input } from '@/components/ui'
import { useMyAppointments } from './data'

export default function ClientBook() {
  const { data: appts } = useMyAppointments()
  const nav = useNavigate()
  const [slug, setSlug] = useState('')
  const shops = [...new Map((appts ?? []).map((a) => [a.shop_id, a])).values()]
  return (
    <div className="space-y-5">
      <h1 className="display text-[40px] leading-none">Book a cut</h1>
      {shops.length ? (
        <div className="space-y-2">
          {shops.map((s) => (
            <Link key={s.shop_id} to={`/shop/${s.shop_slug}/book`}>
              <Card className="flex items-center gap-3 p-4 transition hover:border-accent">
                <span className="size-3 rounded-full" style={{ background: s.accent_color }} />
                <div className="flex-1 font-semibold">{s.shop_name}</div>
                <ChevronRight className="size-5 text-faint" />
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card><EmptyState title="Your shops appear here" body="After your first booking, your barbershop shows up here for one-tap booking." /></Card>
      )}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (slug.trim()) nav(`/shop/${slug.trim().toLowerCase()}`) }}>
        <Input leading={<Search className="size-4" />} placeholder="Shop link, e.g. fade-factory" value={slug} onChange={(e) => setSlug(e.target.value)} />
        <Button type="submit" variant="secondary">Go</Button>
      </form>
    </div>
  )
}
