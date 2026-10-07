import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Heart, LogOut } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { getThemePref, setThemePref, type ThemePref } from '@/lib/theme'
import { friendlyError } from '@/lib/errors'
import { Avatar, Button, Card, CardHeader, Field, Input, Segmented, Toggle, useToast } from '@/components/ui'
import { useMyAppointments, useMyFavorites } from './data'

export default function ClientProfile() {
  const { user, signOut } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: profile } = useQuery({ queryKey: ['profile', user?.id], queryFn: async () => (await supabase.from('profiles').select('*').eq('id', user!.id).single()).data })
  const { data: appts } = useMyAppointments()
  const { data: favs } = useMyFavorites()
  const [f, setF] = useState({ full_name: '', phone: '' })
  const [theme, setTheme] = useState<ThemePref>(getThemePref())
  useEffect(() => { if (profile) setF({ full_name: profile.full_name ?? '', phone: profile.phone ?? '' }) }, [profile])
  const barbers = [...new Map((appts ?? []).map((a) => [a.barber_id, a])).values()]
  const favSet = new Set(favs?.map((x) => x.barber_id))

  const save = async () => {
    const { error } = await supabase.from('profiles').update(f).eq('id', user!.id)
    if (error) toast(friendlyError(error), 'error')
    else toast('Saved', 'success')
  }
  const toggleFav = async (barberId: string, on: boolean) => {
    const r = on ? await supabase.from('client_favorites').insert({ user_id: user!.id, barber_id: barberId }) : await supabase.from('client_favorites').delete().eq('user_id', user!.id).eq('barber_id', barberId)
    if (r.error) toast(friendlyError(r.error), 'error')
    qc.invalidateQueries({ queryKey: ['my_favorites'] })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <Avatar name={f.full_name || user?.email} size={64} />
        <div><h1 className="text-2xl font-semibold">{f.full_name || 'Your profile'}</h1><div className="text-sm text-muted">{user?.email}</div></div>
      </div>
      <Card className="space-y-4 p-5">
        <Field label="Name"><Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Phone"><Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Button onClick={save}>Save</Button>
      </Card>
      {!!barbers.length && (
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Heart className="size-4 text-accent" /> Favorite barbers</span>} />
          <div className="divide-y divide-line px-5 py-2">
            {barbers.map((b) => (
              <div key={b.barber_id} className="flex items-center gap-3 py-3">
                <Avatar name={b.barber_name} src={b.barber_photo_url} size={32} />
                <div className="flex-1 text-sm"><div className="font-medium">{b.barber_name}</div><div className="text-xs text-muted">{b.shop_name}</div></div>
                <Toggle checked={favSet.has(b.barber_id)} onChange={(v) => toggleFav(b.barber_id, v)} />
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card className="flex items-center justify-between p-5">
        <span className="text-sm font-medium">Theme</span>
        <Segmented size="sm" value={theme} onChange={(t) => { setThemePref(t); setTheme(t) }} options={[{ value: 'light', label: 'Light' }, { value: 'system', label: 'Auto' }, { value: 'dark', label: 'Dark' }]} />
      </Card>
      <Button variant="ghost" icon={<LogOut className="size-4" />} onClick={signOut}>Sign out</Button>
    </div>
  )
}
