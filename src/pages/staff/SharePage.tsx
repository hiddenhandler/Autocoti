import { Copy, Download, ExternalLink, MessageCircle, Printer } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { APP_URL } from '@/lib/supabase'
import { QrImage, qrDataUrl } from '@/components/QrImage'
import { Badge, Button, Card, CardHeader, Logo, PageHeader, Textarea, useToast } from '@/components/ui'

/** The shop's own booking link + printable QR "BOOK YOUR CUT" poster. */
export default function SharePage() {
  const { ws } = useWorkspace()
  const toast = useToast()
  const url = `${APP_URL}/shop/${ws.shop_slug}`
  const button = `<a href="${url}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 24px;border-radius:12px;background:${ws.accent_color};color:#111;font:700 16px/1 system-ui,sans-serif;letter-spacing:.04em;text-decoration:none">BOOK YOUR CUT</a>`

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${what} copied`, 'success')
    } catch {
      toast('Copy failed — select and copy manually', 'error')
    }
  }
  const downloadPng = async () => {
    const a = document.createElement('a')
    a.href = await qrDataUrl(url)
    a.download = `${ws.shop_slug}-qr.png`
    a.click()
  }

  return (
    <div>
      <div className="no-print">
        <PageHeader eyebrow="Get booked" title="Booking page & QR"
          subtitle="Your customers only ever see your shop, your barbers and your availability."
          actions={<a href={url} target="_blank" rel="noreferrer"><Button variant="secondary" icon={<ExternalLink className="size-4" />}>Open page</Button></a>} />
        {!ws.is_published && <Card className="mb-4 border-warning/40 p-4 text-sm text-warning">Your page isn't published yet — publish it in Settings → Booking page so customers can book.</Card>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Printable poster */}
        <Card className="print-area flex flex-col items-center p-8 text-center sm:p-12">
          <Logo />
          <div className="mt-8 text-[13px] font-bold tracking-[0.3em] text-muted">SCAN TO</div>
          <div className="mt-1 text-[44px] font-extrabold leading-none tracking-tight sm:text-[56px]">BOOK YOUR CUT</div>
          <QrImage value={url} size={260} className="mt-8 shadow-lg" />
          <div className="mt-6 text-2xl font-bold uppercase">{ws.shop_name}</div>
          <div className="mt-1 text-sm text-muted">See who's available · Book · Join the walk-in queue</div>
          <div className="mt-4 rounded-full bg-surface-2 px-4 py-1.5 text-sm font-medium">{url.replace(/^https?:\/\//, '')}</div>
          <Badge className="mt-6">No app download required</Badge>
        </Card>

        <div className="no-print space-y-4">
          <Card className="p-5">
            <div className="eyebrow mb-2">Your link</div>
            <div className="flex gap-2">
              <code className="min-w-0 flex-1 truncate rounded-xl bg-surface-2 px-3 py-2.5 text-sm">{url}</code>
              <Button variant="secondary" icon={<Copy className="size-4" />} onClick={() => copy(url, 'Link')}>Copy</Button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.print()}>Print poster</Button>
              <Button variant="secondary" icon={<Download className="size-4" />} onClick={downloadPng}>QR as PNG</Button>
              <a className="col-span-2" href={`https://wa.me/?text=${encodeURIComponent(`Book your cut at ${ws.shop_name}: ${url}`)}`} target="_blank" rel="noreferrer">
                <Button block variant="secondary" icon={<MessageCircle className="size-4" />}>Share on WhatsApp</Button>
              </a>
            </div>
          </Card>
          <Card>
            <CardHeader title="Instagram & Facebook" subtitle="Paste the link as your bio link / “Book now” action button." />
            <div className="p-5 pt-3"><Button variant="ghost" size="sm" onClick={() => copy(url, 'Link')}>Copy link</Button></div>
          </Card>
          <Card>
            <CardHeader title="Website button" subtitle="Paste this HTML where you want a booking button." />
            <div className="space-y-3 p-5 pt-3">
              <div dangerouslySetInnerHTML={{ __html: button }} />
              <Textarea readOnly rows={4} className="font-mono text-xs" value={button} onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" variant="secondary" icon={<Copy className="size-4" />} onClick={() => copy(button, 'Button code')}>Copy code</Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
