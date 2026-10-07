import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Minus, Package, PackagePlus, Plus, Search, ShoppingBag, Trash2 } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useMovements, useProducts } from '@/lib/api'
import { rpc } from '@/lib/supabase'
import { ago, money, parseMoney } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import type { PaymentMethod, Product } from '@/lib/types'
import { Badge, Button, Card, Chip, cx, EmptyState, Field, Input, PageHeader, Segmented, Select, Sheet, Skeleton, Stat, useToast } from '@/components/ui'

type Scope = 'shop' | 'mine'
type Filter = 'all' | 'retail' | 'backbar' | 'low'

/**
 * Inventory per business: the shop's stock, or a chair owner's own stock
 * (private — the shop owner never sees it). Stock only moves through
 * receive / use / waste / count / sell, so the numbers always add up.
 */
export default function Inventory() {
  const { ws, can } = useWorkspace()
  const isChairOwner = ws.barber_type === 'chair_owner'
  const [scope, setScope] = useState<Scope>(isChairOwner ? 'mine' : 'shop')
  const owner = scope === 'mine' ? ws.barber_id : null
  const { data: products, isLoading } = useProducts(ws.shop_id, owner)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Product | 'new' | null>(null)
  const [selling, setSelling] = useState(false)
  const canManage = scope === 'mine' || can('inventory.manage')
  const canSell = scope === 'mine' || can('payments.record') || (!!ws.barber_id && can('inventory.sell'))

  const list = useMemo(() => (products ?? []).filter((p) => {
    if (filter === 'retail' && p.kind !== 'retail') return false
    if (filter === 'backbar' && p.kind !== 'backbar') return false
    if (filter === 'low' && p.stock_qty > p.low_stock_at) return false
    const s = q.trim().toLowerCase()
    return !s || [p.name, p.brand, p.sku, p.category].some((x) => x?.toLowerCase().includes(s))
  }), [products, filter, q])
  const active = (products ?? []).filter((p) => p.is_active)
  const value = active.reduce((n, p) => n + Math.max(p.stock_qty, 0) * p.cost_cents, 0)
  const retail = active.filter((p) => p.kind === 'retail').reduce((n, p) => n + Math.max(p.stock_qty, 0) * p.price_cents, 0)
  const low = active.filter((p) => p.stock_qty <= p.low_stock_at).length

  return (
    <div>
      <PageHeader title="Inventory" subtitle={scope === 'mine' ? 'Your own products — private to your business' : 'Shop products and back-bar supplies'}
        actions={<>
          {canSell && <Button variant="secondary" icon={<ShoppingBag className="size-4" />} onClick={() => setSelling(true)}>Sell</Button>}
          {canManage && <Button icon={<Plus className="size-4" />} onClick={() => setOpen('new')}>Product</Button>}
        </>} />
      {isChairOwner && (
        <Segmented className="mb-5" value={scope} onChange={setScope} options={[{ value: 'mine', label: 'My products' }, { value: 'shop', label: 'Shop products' }]} />
      )}

      <Card className="mb-5 grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
        <Stat label="Products" value={active.length} />
        <Stat label="Stock value" value={money(value, { cents: false })} sub="at cost" />
        <Stat label="Retail value" value={money(retail, { cents: false })} />
        <Stat label="Low stock" value={<span className={low ? 'text-danger' : ''}>{low}</span>} sub={low ? 'reorder soon' : 'all good'} />
      </Card>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="h-9 min-w-[200px] flex-1" leading={<Search className="size-4" />} placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
        {(['all', 'retail', 'backbar', 'low'] as Filter[]).map((f) => (
          <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>{{ all: 'All', retail: 'Retail', backbar: 'Back bar', low: 'Low stock' }[f]}</Chip>
        ))}
      </div>

      {isLoading ? <Skeleton className="h-64" /> : !products?.length ? (
        <Card>
          <EmptyState icon={<Package className="size-6" />} title="No products yet"
            body={scope === 'mine' ? 'Track what you sell (pomade, oils, shampoo) and what you use (blades, neck strips). Only you can see this.' : 'Add retail products and back-bar supplies to track stock, sales and margins.'}
            action={canManage && <Button onClick={() => setOpen('new')}>Add a product</Button>} />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {list.map((p) => {
            const isLow = p.stock_qty <= p.low_stock_at
            return (
              <button key={p.id} onClick={() => setOpen(p)} className={cx('flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2', !p.is_active && 'opacity-50')}>
                <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', p.kind === 'retail' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted')}><Package className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{p.name}</div>
                  <div className="truncate text-xs text-muted">{[p.brand, p.kind === 'retail' ? `Sells ${money(p.price_cents)}` : 'Back bar', `Cost ${money(p.cost_cents)}`].filter(Boolean).join(' · ')}</div>
                </div>
                <div className="text-right">
                  <div className={cx('text-xl font-bold tnum', isLow && 'text-danger')}>{p.stock_qty}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{isLow ? 'Low' : p.unit === 'unit' ? 'in stock' : p.unit}</div>
                </div>
              </button>
            )
          })}
          {list.length === 0 && <p className="p-6 text-center text-sm text-muted">Nothing matches.</p>}
        </Card>
      )}

      {open && <ProductSheet product={open === 'new' ? null : open} owner={owner} canManage={canManage} onClose={() => setOpen(null)} />}
      {selling && <SellSheet products={(products ?? []).filter((p) => p.kind === 'retail' && p.is_active)} scope={scope} onClose={() => setSelling(false)} />}
    </div>
  )
}

function ProductSheet({ product, owner, canManage, onClose }: { product: Product | null; owner: string | null; canManage: boolean; onClose: () => void }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(!product)
  const [f, setF] = useState({
    name: product?.name ?? '', brand: product?.brand ?? '', sku: product?.sku ?? '', kind: product?.kind ?? 'retail',
    cost: product ? String(product.cost_cents / 100) : '', price: product ? String(product.price_cents / 100) : '',
    low: String(product?.low_stock_at ?? 2), supplier: product?.supplier ?? '', initial: '',
  })
  const [busy, setBusy] = useState<string | null>(null)
  const { data: moves } = useMovements(product?.id ?? null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['products'] })
    qc.invalidateQueries({ queryKey: ['finance', ws.shop_id] })
  }

  const save = async () => {
    setBusy('save')
    try {
      await rpc('save_product', {
        p_shop_id: ws.shop_id, p_product_id: product?.id ?? null, p_name: f.name, p_owner_barber_id: owner, p_kind: f.kind,
        p_brand: f.brand, p_sku: f.sku, p_cost_cents: parseMoney(f.cost) ?? 0, p_price_cents: parseMoney(f.price) ?? 0,
        p_low_stock_at: Number(f.low) || 0, p_supplier: f.supplier, p_initial_qty: product ? 0 : Number(f.initial) || 0,
      })
      refresh()
      toast('Product saved', 'success')
      product ? setEditing(false) : onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet open onClose={onClose} title={product ? product.name : 'New product'}
      footer={editing && canManage ? <Button block loading={busy === 'save'} disabled={!f.name.trim()} onClick={save}>Save product</Button> : undefined}>
      {editing ? (
        <div className="space-y-3">
          <Field label="Name"><Input value={f.name} onChange={set('name')} placeholder="Matte Pomade" /></Field>
          <Segmented value={f.kind} onChange={(v) => setF((x) => ({ ...x, kind: v }))} options={[{ value: 'retail', label: 'Sold to clients' }, { value: 'backbar', label: 'Used in services' }]} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cost (per unit)"><Input inputMode="decimal" value={f.cost} onChange={set('cost')} /></Field>
            {f.kind === 'retail' && <Field label="Sell price"><Input inputMode="decimal" value={f.price} onChange={set('price')} /></Field>}
            <Field label="Low-stock alert at"><Input inputMode="numeric" value={f.low} onChange={set('low')} /></Field>
            {!product && <Field label="Starting stock"><Input inputMode="numeric" value={f.initial} onChange={set('initial')} placeholder="0" /></Field>}
            <Field label="Brand"><Input value={f.brand} onChange={set('brand')} /></Field>
            <Field label="SKU / barcode"><Input value={f.sku} onChange={set('sku')} /></Field>
          </div>
          <Field label="Supplier"><Input value={f.supplier} onChange={set('supplier')} /></Field>
          {f.kind === 'retail' && parseMoney(f.price) !== null && parseMoney(f.cost) !== null && parseMoney(f.price)! > 0 && (
            <p className="text-sm text-muted">Margin: <b className="text-ink">{money(parseMoney(f.price)! - parseMoney(f.cost)!)}</b> ({Math.round(((parseMoney(f.price)! - parseMoney(f.cost)!) / parseMoney(f.price)!) * 100)}%)</p>
          )}
        </div>
      ) : product && (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl bg-surface-2 p-3"><div className={cx('text-2xl font-bold tnum', product.stock_qty <= product.low_stock_at && 'text-danger')}>{product.stock_qty}</div><div className="text-[11px] text-muted">in stock</div></div>
            <div className="rounded-xl bg-surface-2 p-3"><div className="text-lg font-semibold tnum">{money(product.cost_cents)}</div><div className="text-[11px] text-muted">cost</div></div>
            <div className="rounded-xl bg-surface-2 p-3"><div className="text-lg font-semibold tnum">{product.kind === 'retail' ? money(product.price_cents) : '—'}</div><div className="text-[11px] text-muted">price</div></div>
          </div>
          <StockActions product={product} canManage={canManage} onDone={refresh} />
          {canManage && (
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setEditing(true)}>Edit details</Button>
              <Button variant="danger" icon={<Trash2 className="size-4" />} loading={busy === 'archive'} onClick={async () => {
                if (!confirm(`Remove ${product.name} from inventory?`)) return
                setBusy('archive')
                try { await rpc('archive_product', { p_product_id: product.id }); refresh(); onClose() } catch (e) { toast(friendlyError(e), 'error') } finally { setBusy(null) }
              }}>Remove</Button>
            </div>
          )}
          <div>
            <div className="eyebrow mb-2">History</div>
            <div className="divide-y divide-line rounded-xl border border-line">
              {(moves ?? []).length === 0 && <p className="p-4 text-sm text-muted">No movements yet.</p>}
              {(moves ?? []).map((m) => (
                <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <span className={cx('w-12 text-right font-semibold tnum', m.qty_delta > 0 ? 'text-success' : 'text-danger')}>{m.qty_delta > 0 ? `+${m.qty_delta}` : m.qty_delta}</span>
                  <span className="flex-1 capitalize">{m.kind}{m.note ? <span className="text-muted normal-case"> · {m.note}</span> : null}</span>
                  <span className="text-xs text-muted">{ago(m.created_at)} · {m.stock_after}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Sheet>
  )
}

function StockActions({ product, canManage, onDone }: { product: Product; canManage: boolean; onDone: () => void }) {
  const toast = useToast()
  const [kind, setKind] = useState<'purchase' | 'use' | 'waste' | 'count'>(canManage ? 'purchase' : 'use')
  const [qty, setQty] = useState(1)
  const [cost, setCost] = useState(String(product.cost_cents / 100))
  const [busy, setBusy] = useState(false)
  const opts = canManage
    ? [{ value: 'purchase' as const, label: 'Received' }, { value: 'use' as const, label: 'Used' }, { value: 'waste' as const, label: 'Waste' }, { value: 'count' as const, label: 'Count' }]
    : [{ value: 'use' as const, label: 'Used' }]
  const go = async () => {
    setBusy(true)
    try {
      const after = await rpc<number>('move_stock', { p_product_id: product.id, p_kind: kind, p_qty: qty, p_unit_cost_cents: kind === 'purchase' ? parseMoney(cost) : null })
      toast(`${product.name}: ${after} in stock`, 'success')
      onDone()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-2xl border border-line p-4">
      <Segmented size="sm" value={kind} onChange={setKind} options={opts} />
      <div className="mt-4 flex items-center justify-center gap-4">
        <button className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-xl" onClick={() => setQty((n) => Math.max(kind === 'count' ? 0 : 1, n - 1))} aria-label="Less"><Minus className="size-5" /></button>
        <input className="w-20 bg-transparent text-center text-4xl font-bold tnum focus:outline-none" inputMode="numeric" value={qty} onChange={(e) => setQty(Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0))} />
        <button className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-xl" onClick={() => setQty((n) => n + 1)} aria-label="More"><Plus className="size-5" /></button>
      </div>
      <p className="mt-1 text-center text-xs text-muted">{kind === 'count' ? 'Exact number on the shelf' : kind === 'purchase' ? 'Units received' : 'Units'}</p>
      {kind === 'purchase' && <Field className="mt-3" label="Cost per unit"><Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>}
      <Button className="mt-4" block loading={busy} icon={<PackagePlus className="size-4" />} onClick={go}>
        {kind === 'purchase' ? `Add ${qty} to stock` : kind === 'count' ? `Set stock to ${qty}` : `Remove ${qty}`}
      </Button>
    </div>
  )
}

/** Quick retail sale at the chair or the desk. */
export function SellSheet({ products, scope, onClose, appointmentId, clientId }: { products: Product[]; scope: Scope; onClose: () => void; appointmentId?: string; clientId?: string | null }) {
  const { ws, can } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [cart, setCart] = useState<Record<string, number>>({})
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [asDesk, setAsDesk] = useState(!ws.barber_id)
  const [busy, setBusy] = useState(false)
  const total = products.reduce((n, p) => n + (cart[p.id] ?? 0) * p.price_cents, 0)
  const items = Object.entries(cart).filter(([, n]) => n > 0)
  const add = (id: string, d: number, max: number) => setCart((c) => ({ ...c, [id]: Math.min(max, Math.max(0, (c[id] ?? 0) + d)) }))

  const sell = async () => {
    setBusy(true)
    try {
      await rpc('sell_products', {
        p_shop_id: ws.shop_id, p_items: items.map(([product_id, quantity]) => ({ product_id, quantity })),
        p_barber_id: scope === 'mine' || !asDesk ? ws.barber_id : null, p_method: method,
        p_appointment_id: appointmentId ?? null, p_client_id: clientId ?? null,
      })
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['finance', ws.shop_id] })
      qc.invalidateQueries({ queryKey: ['analytics', ws.shop_id] })
      toast(`Sold · ${money(total)}`, 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open onClose={onClose} title="Sell products"
      footer={<Button size="lg" block loading={busy} disabled={!items.length} onClick={sell}>Charge {money(total)}</Button>}>
      {products.length === 0 ? <p className="text-sm text-muted">No retail products in stock.</p> : (
        <div className="space-y-4">
          <div className="divide-y divide-line rounded-xl border border-line">
            {products.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="text-xs text-muted">{money(p.price_cents)} · {p.stock_qty} left</div>
                </div>
                <button className="flex size-9 items-center justify-center rounded-full bg-surface-2 disabled:opacity-40" disabled={!cart[p.id]} onClick={() => add(p.id, -1, p.stock_qty)} aria-label="Less"><Minus className="size-4" /></button>
                <span className="w-6 text-center font-semibold tnum">{cart[p.id] ?? 0}</span>
                <button className="flex size-9 items-center justify-center rounded-full bg-surface-2 disabled:opacity-40" disabled={(cart[p.id] ?? 0) >= p.stock_qty} onClick={() => add(p.id, 1, p.stock_qty)} aria-label="More"><Plus className="size-4" /></button>
              </div>
            ))}
          </div>
          <Field label="Paid by">
            <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              <option value="cash">Cash</option><option value="card">Card</option><option value="transfer">Transfer</option><option value="mobile">Mobile</option>
            </Select>
          </Field>
          {scope === 'shop' && ws.barber_id && can('payments.record') && (
            <Segmented value={asDesk ? 'desk' : 'me'} onChange={(v) => setAsDesk(v === 'desk')} options={[{ value: 'me', label: 'My sale (commission)' }, { value: 'desk', label: 'Front desk' }]} />
          )}
          {scope === 'shop' && <Badge>Shop products · seller earns the shop's product commission</Badge>}
        </div>
      )}
    </Sheet>
  )
}
