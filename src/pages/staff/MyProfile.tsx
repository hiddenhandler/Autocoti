import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Clock, ExternalLink, LogOut } from 'lucide-react'
import { useAuth, useWorkspace } from '@/lib/auth'
import { useBarbers } from '@/lib/api'
import { rpc } from '@/lib/supabase'
import { Avatar, Button, Card, CardHeader, Field, Input, PageHeader, Segmented, Textarea, useToast } from '@/components/ui'
import { friendlyError } from '@/lib/errors'
import { getThemePref, setThemePref, type ThemePref } from '@/lib/theme'
import type { Barber } from '@/lib/types'

export default function MyProfile() {
  const { ws } = useWorkspace()
  const { data: barbers } = useBarbers(ws.shop_id)
  if (!ws.barber_id) return <Navigate to="/app" replace />
  const me = barbers?.find((b) => b.id === ws.barber_id)
  return me ? <ProfileForm barber={me} /> : null
}

export function ProfileForm({ barber, title = 'My profile' }: { barber: Barber; title?: string }) {
  const { ws } = useWorkspace()
  const { signOut } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState({ title: '', bio: '', specialties: '', photo_url: '', instagram: '' })
  const [theme, setTheme] = useState<ThemePref>(getThemePref())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setF({ title: barber.title ?? '', bio: barber.bio ?? '', specialties: barber.specialties.join(', '), photo_url: barber.photo_url ?? '', instagram: barber.instagram ?? '' })
  }, [barber])

  const save = async () => {
    setBusy(true)
    try {
      await rpc('update_my_barber_profile', {
        p_barber_id: barber.id, p_title: f.title || null, p_bio: f.bio || null,
        p_specialties: f.specialties.split(',').map((s) => s.trim()).filter(Boolean), p_photo_url: f.photo_url || null, p_instagram: f.instagram || null,
        p_buffer_minutes: barber.buffer_minutes, p_max_daily_appointments: barber.max_daily_appointments,
        p_same_day_booking: barber.same_day_booking, p_accepts_online_booking: barber.accepts_online_booking,
      })
      qc.invalidateQueries({ queryKey: ['barbers'] })
      toast('Profile saved', 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={title} actions={<a href={`/s/${ws.shop_slug}/barber/${barber.slug}`} target="_blank" rel="noreferrer"><Button variant="secondary" size="sm" icon={<ExternalLink className="size-4" />}>Public profile</Button></a>} />
      <Card className="p-5">
        <div className="mb-5 flex items-center gap-4">
          <Avatar name={barber.display_name} src={f.photo_url || null} size={72} />
          <div>
            <div className="text-xl font-semibold">{barber.display_name}</div>
            <div className="text-sm text-muted">{f.title || 'Barber'}</div>
          </div>
        </div>
        <div className="grid gap-4">
          <Field label="Title" hint='e.g. "Fade Specialist"'><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Bio"><Textarea rows={4} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
          <Field label="Specialties" hint="Comma separated"><Input value={f.specialties} onChange={(e) => setF({ ...f, specialties: e.target.value })} placeholder="Skin fades, beard sculpting, kids" /></Field>
          <Field label="Photo URL"><Input type="url" value={f.photo_url} onChange={(e) => setF({ ...f, photo_url: e.target.value })} placeholder="https://…" /></Field>
          <Field label="Instagram"><Input value={f.instagram} onChange={(e) => setF({ ...f, instagram: e.target.value })} placeholder="@handle" /></Field>
        </div>
        <Button className="mt-5" loading={busy} onClick={save}>Save profile</Button>
      </Card>
      <Card>
        <CardHeader title="App" />
        <div className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Theme</span>
            <Segmented size="sm" value={theme} onChange={(t) => { setThemePref(t); setTheme(t) }} options={[{ value: 'light', label: 'Light' }, { value: 'system', label: 'Auto' }, { value: 'dark', label: 'Dark' }]} />
          </div>
          <Link to="/app/schedule" className="flex items-center gap-2 text-sm font-medium hover:underline"><Clock className="size-4" /> My schedule & time off</Link>
          <Button variant="ghost" icon={<LogOut className="size-4" />} onClick={signOut}>Sign out</Button>
        </div>
      </Card>
    </div>
  )
}
