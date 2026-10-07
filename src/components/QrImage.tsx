import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { cx } from './ui'

/** Renders a QR code as an <img> (crisp at any size, printable, long-press to save on phones). */
export function QrImage({ value, size = 220, className, dark = '#111111', light = '#ffffff' }: { value: string; size?: number; className?: string; dark?: string; light?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    qrDataUrl(value, { dark, light }).then((u) => alive && setSrc(u)).catch(() => alive && setSrc(null))
    return () => {
      alive = false
    }
  }, [value, dark, light])
  return src ? (
    <img src={src} width={size} height={size} alt={`QR code for ${value}`} className={cx('rounded-xl bg-white p-2', className)} style={{ imageRendering: 'pixelated' }} />
  ) : (
    <div className={cx('animate-pulse rounded-xl bg-surface-2', className)} style={{ width: size, height: size }} />
  )
}

export function qrDataUrl(value: string, colors: { dark?: string; light?: string } = {}, width = 1024) {
  return QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width, color: { dark: colors.dark ?? '#111111', light: colors.light ?? '#ffffff' } })
}
