import { clsx } from 'clsx'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownRight, ArrowUpRight, Check, Loader2, X } from 'lucide-react'
import { initials } from '@/lib/format'

export const cx = clsx

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type Size = 'sm' | 'md' | 'lg' | 'xl'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center gap-2 rounded-xl font-semibold transition-[background,color,transform,box-shadow] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50',
        {
          primary: 'bg-accent text-accent-ink hover:brightness-105 shadow-[0_1px_0_rgb(255_255_255/0.2)_inset]',
          secondary: 'bg-surface-2 text-ink hover:bg-surface-3',
          outline: 'border border-line-strong bg-transparent text-ink hover:bg-surface-2',
          ghost: 'bg-transparent text-ink hover:bg-surface-2',
          danger: 'bg-danger/12 text-danger hover:bg-danger/20',
        }[variant],
        {
          sm: 'h-8 px-3 text-[13px]',
          md: 'h-10 px-4 text-sm',
          lg: 'h-12 px-5 text-[15px]',
          xl: 'h-14 px-6 text-base tracking-wide',
        }[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex size-9 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink', className)}
      {...rest}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------
export function Card({ className, children, as: As = 'div', ...rest }: { className?: string; children?: ReactNode; as?: 'div' | 'section' | 'article' } & Record<string, unknown>) {
  return (
    <As className={cx('rounded-2xl border border-line bg-surface shadow-card', className)} {...rest}>
      {children}
    </As>
  )
}

export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start justify-between gap-3 px-5 pt-5', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold leading-tight">{title}</h3>
        {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="display text-[34px] leading-none sm:text-[40px]">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
        {
          neutral: 'bg-surface-2 text-muted',
          accent: 'bg-accent-soft text-accent',
          success: 'bg-success/12 text-success',
          warning: 'bg-warning/14 text-warning',
          danger: 'bg-danger/12 text-danger',
          info: 'bg-info/12 text-info',
        }[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Avatar({ name, src, color, size = 36, className }: { name?: string | null; src?: string | null; color?: string; size?: number; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.36) }
  if (src) return <img src={src} alt={name ?? ''} style={style} className={cx('shrink-0 rounded-full object-cover', className)} loading="lazy" />
  return (
    <span
      style={{ ...style, background: color ? `color-mix(in oklab, ${color} 22%, transparent)` : undefined, color: color ?? undefined }}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-ink', className)}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx('h-px bg-line', className)} />
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} />
}

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">{icon}</div>}
      <div className="text-[15px] font-semibold">{title}</div>
      {body && <p className="mt-1.5 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = (error as Error)?.message ?? 'Something went wrong'
  return (
    <EmptyState
      title="Couldn't load this"
      body={msg}
      action={retry && (
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
export function Delta({ value, inverse, className }: { value: number | null | undefined; inverse?: boolean; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const up = value >= 0
  const good = inverse ? !up : up
  return (
    <span className={cx('inline-flex items-center gap-0.5 text-xs font-semibold tnum', good ? 'text-success' : 'text-danger', className)}>
      {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      {Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0)}%
    </span>
  )
}

export function Stat({ label, value, sub, delta, inverse, hint, className, big }: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  delta?: number | null
  inverse?: boolean
  hint?: string
  className?: string
  big?: boolean
}) {
  return (
    <div className={cx('min-w-0', className)} title={hint}>
      <div className="eyebrow truncate">{label}</div>
      <div className={cx('mt-2 font-semibold tracking-tight tnum', big ? 'text-[34px] leading-none' : 'text-2xl leading-none')}>{value}</div>
      {(sub || delta !== undefined) && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          {delta !== undefined && <Delta value={delta} inverse={inverse} />}
          {sub}
        </div>
      )}
    </div>
  )
}

export function Progress({ value, target, className }: { value: number | null | undefined; target?: number; className?: string }) {
  const v = Math.max(0, Math.min(100, Number(value ?? 0)))
  return (
    <div className={cx('relative h-2 overflow-hidden rounded-full bg-surface-3', className)}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${v}%` }} />
      {target !== undefined && <div className="absolute inset-y-0 w-0.5 bg-ink/60" style={{ left: `${target}%` }} title={`Target ${target}%`} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      {label && <span className="mb-1.5 block text-[13px] font-medium">{label}</span>}
      {children}
      {error ? <span className="mt-1.5 block text-xs text-danger">{error}</span> : hint ? <span className="mt-1.5 block text-xs text-muted">{hint}</span> : null}
    </label>
  )
}

const widthCls = (className?: string) => (/(^|\s)(w-|min-w-|flex-1)/.test(className ?? '') ? '' : 'w-full')
const inputCls =
  'rounded-xl border border-line bg-surface px-3.5 text-[15px] text-ink placeholder:text-faint transition focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 disabled:opacity-60'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { leading?: ReactNode }>(function Input({ className, leading, ...rest }, ref) {
  if (leading)
    return (
      <div className={cx('relative', widthCls(className))}>
        <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted">{leading}</span>
        <input ref={ref} className={cx(inputCls, 'w-full h-11 pl-9', className)} {...rest} />
      </div>
    )
  return <input ref={ref} className={cx(inputCls, widthCls(className), 'h-11', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputCls, widthCls(className), 'min-h-[88px] py-2.5', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(inputCls, widthCls(className), 'h-11 appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-9', className)}
      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23999' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }}
      {...rest}>
      {children}
    </select>
  )
})

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      {(label || description) && (
        <label htmlFor={id} className="min-w-0 cursor-pointer">
          {label && <div className="text-sm font-medium">{label}</div>}
          {description && <div className="mt-0.5 text-[13px] text-muted">{description}</div>}
        </label>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-surface-3', disabled && 'opacity-50')}
      >
        <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </div>
  )
}

export function Segmented<T extends string>({ value, onChange, options, className, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div className={cx('inline-flex rounded-xl bg-surface-2 p-1', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-lg font-medium transition',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]',
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Chip({ active, onClick, children, className }: { active?: boolean; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition',
        active ? 'border-accent bg-accent-soft text-ink' : 'border-line bg-surface text-muted hover:text-ink',
        className,
      )}
    >
      {active && <Check className="size-3.5 text-accent" />}
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Sheet: bottom sheet on mobile, centred dialog on desktop
// ---------------------------------------------------------------------------
export function Sheet({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className="animate-fade absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        className={cx(
          'animate-sheet relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-line bg-surface shadow-2xl outline-none sm:animate-rise sm:rounded-3xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line-strong sm:hidden" />
        {title && (
          <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
            <h2 className="text-lg font-semibold">{title}</h2>
            <IconButton label="Close" onClick={onClose}>
              <X className="size-5" />
            </IconButton>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 pb-5 pt-2">{children}</div>
        {footer && <div className="safe-bottom border-t border-line bg-surface px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
type Toast = { id: number; message: ReactNode; tone: 'default' | 'success' | 'error' }
const ToastContext = createContext<(message: ReactNode, tone?: Toast['tone']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((message: ReactNode, tone: Toast['tone'] = 'default') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cx(
                'animate-rise pointer-events-auto flex max-w-md items-center gap-2.5 rounded-2xl border px-4 py-3 text-sm font-medium shadow-2xl',
                t.tone === 'error' ? 'border-danger/30 bg-surface text-danger' : 'border-line bg-ink text-bg',
              )}
            >
              {t.tone === 'success' && <Check className="size-4 text-accent" />}
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export function StatusDot({ status }: { status: string }) {
  const color =
    {
      BOOKED: 'bg-info',
      CONFIRMED: 'bg-accent',
      CHECKED_IN: 'bg-warning',
      IN_SERVICE: 'bg-success',
      COMPLETED: 'bg-muted',
      CANCELLED: 'bg-danger',
      NO_SHOW: 'bg-danger',
      RESCHEDULED: 'bg-faint',
    }[status] ?? 'bg-faint'
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', color, status === 'IN_SERVICE' && 'pulse-ring')} />
}

export const STATUS_LABEL: Record<string, string> = {
  BOOKED: 'Booked',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  IN_SERVICE: 'In chair',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
  RESCHEDULED: 'Rescheduled',
}

export function StatusBadge({ status }: { status: string }) {
  const tone = (
    {
      BOOKED: 'info',
      CONFIRMED: 'accent',
      CHECKED_IN: 'warning',
      IN_SERVICE: 'success',
      COMPLETED: 'neutral',
      CANCELLED: 'danger',
      NO_SHOW: 'danger',
      RESCHEDULED: 'neutral',
    } as const
  )[status as 'BOOKED'] ?? 'neutral'
  return <Badge tone={tone}>{STATUS_LABEL[status] ?? status}</Badge>
}

export function Logo({ className, mark = false }: { className?: string; mark?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="9" fill="var(--accent)" />
        <path d="M10 22.5 16 8l6 14.5" stroke="var(--accent-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d="M12.4 17h7.2" stroke="var(--accent-ink)" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      {!mark && <span className="text-[17px] font-bold tracking-tight">Autocoti</span>}
    </span>
  )
}

export function KeyHint({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] text-muted">{children}</kbd>
}
