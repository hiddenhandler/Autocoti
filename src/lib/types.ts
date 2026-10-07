export type StaffRole = 'owner' | 'manager' | 'barber' | 'receptionist'

export type AppointmentStatus =
  | 'BOOKED'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_SERVICE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'RESCHEDULED'

export type CalendarKind = 'appointment' | 'block' | 'break' | 'personal' | 'emergency'
export type PaymentStatus = 'UNPAID' | 'PAID' | 'PARTIAL' | 'REFUNDED' | 'VOID'
export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'mobile' | 'gift_card' | 'membership' | 'other'

export type Permission =
  | 'shop.settings'
  | 'staff.manage'
  | 'services.manage'
  | 'schedule.manage_all'
  | 'calendar.all'
  | 'clients.all'
  | 'payments.view'
  | 'payments.record'
  | 'payments.refund'
  | 'reports.shop'
  | 'marketing.manage'
  | 'walkins.manage'
  | 'waitlist.manage'
  | 'reviews.manage'
  | 'commissions.manage'
  | 'financials.all_barbers'
  | 'audit.view'
  | 'billing'
  | 'notifications.view'
  | '*private_notes'
  | 'inventory.manage'
  | 'inventory.sell'
  | 'finance.manage'

export type BarberType = 'employee' | 'chair_owner'

export interface Workspace {
  shop_id: string
  shop_name: string
  shop_slug: string
  organization_id: string
  role: StaffRole
  barber_id: string | null
  barber_type: BarberType | null
  timezone: string
  accent_color: string
  is_published: boolean
  permissions: Permission[]
}

export interface Shop {
  id: string
  organization_id: string
  name: string
  slug: string
  timezone: string
  tagline: string | null
  description: string | null
  phone: string | null
  email: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  instagram: string | null
  website: string | null
  logo_url: string | null
  cover_url: string | null
  gallery_urls: string[]
  accent_color: string
  custom_domain: string | null
  is_published: boolean
}

export interface Barber {
  id: string
  shop_id: string
  user_id: string | null
  display_name: string
  slug: string
  title: string | null
  bio: string | null
  specialties: string[]
  photo_url: string | null
  instagram: string | null
  color: string
  status: 'active' | 'suspended' | 'archived'
  accepts_online_booking: boolean
  buffer_minutes: number | null
  max_daily_appointments: number | null
  same_day_booking: boolean
  sort_order: number
  deleted_at: string | null
  barber_type: BarberType
  presence: 'auto' | 'break' | 'offline'
  presence_until: string | null
}

export interface Service {
  id: string
  shop_id: string
  name: string
  description: string | null
  category: string | null
  price_cents: number
  duration_minutes: number
  is_active: boolean
  is_public: boolean
  sort_order: number
  deleted_at: string | null
  owner_barber_id: string | null
}

export interface BarberService {
  barber_id: string
  service_id: string
  price_cents: number | null
  duration_minutes: number | null
  is_active: boolean
}

export interface Client {
  id: string
  shop_id: string
  user_id: string | null
  first_name: string
  last_name: string | null
  phone: string | null
  email: string | null
  birthday: string | null
  tags: string[]
  source: string
  referral_code: string | null
  marketing_email_opt_in: boolean
  marketing_sms_opt_in: boolean
  created_at: string
}

export interface AppointmentService {
  id: string
  service_id: string | null
  name: string
  price_cents: number
  duration_minutes: number
  position: number
}

export interface Appointment {
  id: string
  shop_id: string
  barber_id: string
  client_id: string | null
  kind: CalendarKind
  status: AppointmentStatus
  source: string
  starts_at: string
  ends_at: string
  buffer_minutes: number
  title: string | null
  notes: string | null
  client_message: string | null
  expected_price_cents: number
  payment_status: PaymentStatus
  checked_in_at: string | null
  actual_started_at: string | null
  actual_finished_at: string | null
  actual_duration_seconds: number | null
  completed_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  is_late_cancellation: boolean
  fee_cents: number
  rebooked_from_id: string | null
  walk_in_id: string | null
  created_at: string
  client?: Pick<Client, 'id' | 'first_name' | 'last_name' | 'phone' | 'email'> | null
  services?: AppointmentService[]
}

export interface Slot {
  barber_id: string
  starts_at: string
  ends_at: string
  duration_minutes: number
  price_cents: number
}

export interface PublicShop {
  id: string
  name: string
  slug: string
  tagline: string | null
  description: string | null
  timezone: string
  phone: string | null
  email: string | null
  address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postal_code: string | null; country: string | null }
  latitude: number | null
  longitude: number | null
  instagram: string | null
  website: string | null
  logo_url: string | null
  cover_url: string | null
  gallery_urls: string[]
  accent_color: string
  is_published: boolean
  is_preview: boolean
  currency: string
  booking: {
    enabled: boolean
    allow_any_barber: boolean
    min_notice_minutes: number
    max_advance_days: number
    cancellation_window_hours: number
    late_cancel_fee_cents: number
    no_show_fee_cents: number
    deposit_required: boolean
    deposit_cents: number
    require_phone: boolean
    require_email: boolean
    cancellation_policy_text: string | null
    waitlist_enabled: boolean
  }
  hours: { weekday: number; opens_at: string; closes_at: string }[]
  services: {
    id: string
    name: string
    description: string | null
    category: string | null
    price_cents: number
    duration_minutes: number
    min_price_cents: number | null
    max_price_cents: number | null
  }[]
  barbers: {
    id: string
    slug: string
    name: string
    title: string | null
    bio: string | null
    specialties: string[]
    photo_url: string | null
    instagram: string | null
    color: string
    rating: number | null
    review_count: number
    services: { service_id: string; price_cents: number; duration_minutes: number }[]
  }[]
  rating: { average: number | null; count: number }
  reviews: { rating: number; comment: string; barber_name: string | null; client_name: string | null; created_at: string; owner_reply: string | null }[]
}

export interface CoreMetrics {
  net_revenue_cents: number
  tickets: number
  tips_cents: number
  avg_ticket_cents: number | null
  bookings: number
  completed: number
  cancelled: number
  no_shows: number
  cancellation_rate: number | null
  no_show_rate: number | null
  available_minutes: number
  booked_minutes: number
  utilization: number | null
  rebooking_rate: number | null
  rebooked: number
  clients_served: number
  new_clients: number
  returning_clients: number
}

export interface BarberPerf {
  barber_id: string
  name: string
  color: string
  photo_url: string | null
  status: string
  can_view_money: boolean
  cuts: number
  bookings: number
  no_shows: number
  cancelled: number
  no_show_rate: number | null
  avg_cut_minutes: number | null
  avg_scheduled_minutes: number | null
  clients_served: number
  new_clients: number
  returning_clients: number
  rebooking_rate: number | null
  utilization: number | null
  available_hours: number
  net_revenue_cents: number | null
  tips_cents: number | null
  avg_ticket_cents: number | null
  commission_cents: number | null
  revenue_per_hour_cents: number | null
  revenue_per_day_cents: number | null
  service_mix: { name: string; count: number }[]
}

export interface Analytics {
  period: { from: string; to: string; days: number; timezone: string; currency: string; barber_id: string | null }
  summary: CoreMetrics
  previous: CoreMetrics
  revenue: {
    gross_cents: number
    discount_cents: number
    net_service_cents: number
    fees_cents: number
    gift_card_sales_cents: number
    tax_cents: number
    tips_cents: number
    refunds_cents: number
    collected_cents: number
    outstanding_cents: number
    tickets: number
    commission_cents: number
    by_method: Record<string, number>
    by_service: { name: string; count: number; revenue_cents: number }[]
    unpaid_completed: number
  }
  bookings: {
    total: number
    completed: number
    cancelled: number
    late_cancellations: number
    no_shows: number
    rescheduled: number
    upcoming: number
    walk_ins: number
    online: number
    staff: number
    from_waitlist: number
    avg_lead_time_hours: number | null
    cancellation_rate: number | null
    no_show_rate: number | null
    peak_hours: { hour: number; count: number }[]
    peak_days: { dow: number; count: number }[]
    funnel: Record<string, number> | null
  }
  series: { date: string; revenue_cents: number; tips_cents: number; bookings: number; completed: number; new_clients: number }[]
  cut_time: {
    count: number
    avg_actual_minutes: number | null
    avg_scheduled_minutes: number | null
    efficiency: number | null
    finished_early: number
    ran_over: number
    by_barber: { barber_id: string; name: string; avg_minutes: number; scheduled_minutes: number; count: number }[]
    by_service: { name: string; avg_minutes: number; scheduled_minutes: number; count: number }[]
    by_weekday: { dow: number; avg_minutes: number; count: number }[]
    by_hour: { hour: number; avg_minutes: number; count: number }[]
  }
  utilization: {
    available_minutes: number | null
    booked_minutes: number | null
    blocked_minutes: number | null
    idle_minutes: number | null
    utilization: number | null
    target: number
    actual_service_minutes: number
  }
  heatmap: { dow: number; hour: number; available_minutes: number; booked_minutes: number; utilization: number | null }[]
  barbers: BarberPerf[]
  clients: {
    served: number
    new: number
    returning: number
    rebooking_rate: number | null
    health: Record<string, number>
    due: number
  }
  reviews: {
    average: number | null
    count: number
    all_time_average: number | null
    distribution: Record<string, number>
    trend: { week: string; average: number; count: number }[]
    recent: { id: string; rating: number; comment: string | null; barber_name: string | null; client_name: string | null; created_at: string; owner_reply: string | null; hidden: boolean }[]
  }
}

export interface ClientRow {
  id: string
  first_name: string
  last_name: string | null
  phone: string | null
  email: string | null
  tags: string[]
  visits: number
  last_visit: string | null
  next_appointment: string | null
  total_spent_cents: number | null
  avg_ticket_cents: number | null
  no_shows: number
  cancellations: number
  health: 'NEW' | 'ACTIVE' | 'AT_RISK' | 'LOST'
  is_due: boolean
  cadence_days: number
  days_since_last: number | null
  favorite_barber_id: string | null
  created_at: string
  total_count: number
}

// ---------------------------------------------------------------------------
// Live status, chairs, queue
// ---------------------------------------------------------------------------
export type LiveStatus = 'AVAILABLE' | 'CUTTING' | 'BOOKED' | 'BREAK' | 'QUEUE' | 'OFFLINE' | 'NOT_WORKING'

export interface BarberLive {
  barber_id: string
  status: LiveStatus
  until: string | null
  note: 'offline' | 'done' | 'starts' | null
  presence: 'auto' | 'break' | 'offline'
  current: { started_at: string | null; estimated_finish: string; service: string | null; target_minutes: number } | null
  queue_count: number
  estimated_wait_minutes: number
  avg_cut_minutes: number | null
  next_available: string | null
  works_today: boolean
  day_starts: string | null
  day_ends: string | null
}

export interface WalkInSummary {
  enabled: boolean
  waiting: number
  avg_service_minutes: number
  barbers_working: number
  estimated_wait_minutes: number | null
}

export interface ShopLive {
  now: string
  open_now: boolean
  barbers: (BarberLive & { name: string; slug: string; title: string | null; photo_url: string | null; color: string; chair: string | null })[]
  walk_ins: WalkInSummary
}

export interface LiveBoardBarber extends BarberLive {
  name: string
  photo_url: string | null
  color: string
  barber_type: BarberType
  chair_id: string | null
}

export interface LiveBoard {
  now: string
  open_now: boolean
  chairs: { id: string; label: string; position: number; is_active: boolean; notes: string | null; barber_id: string | null; barber: LiveBoardBarber | null }[]
  barbers: LiveBoardBarber[]
  counts: { working: number; available: number; cutting: number; on_break: number; off: number }
  walk_ins: WalkInSummary
}

export interface WalkInTicket {
  id: string
  status: 'waiting' | 'called' | 'serving' | 'done' | 'left' | 'cancelled'
  name: string
  created_at: string
  position: number | null
  ahead: number
  estimated_wait_minutes: number | null
  wait_low: number | null
  wait_high: number | null
  estimated_start: string | null
  almost_ready: boolean
  service_name: string | null
  preferred_barber: string | null
  likely_barber: string | null
  appointment: { status: string; actual_started_at: string | null; scheduled_minutes: number } | null
  avg_service_minutes: number | null
  shop: { name: string; slug: string; accent_color: string; timezone: string; phone: string | null; address: string }
}

// ---------------------------------------------------------------------------
// Inventory & finance
// ---------------------------------------------------------------------------
export interface Product {
  id: string
  shop_id: string
  owner_barber_id: string | null
  name: string
  brand: string | null
  sku: string | null
  category: string | null
  kind: 'retail' | 'backbar'
  unit: string
  cost_cents: number
  price_cents: number
  stock_qty: number
  low_stock_at: number
  supplier: string | null
  is_active: boolean
  updated_at: string
}

export interface InventoryMovement {
  id: string
  product_id: string
  barber_id: string | null
  kind: 'purchase' | 'sale' | 'use' | 'adjustment' | 'waste' | 'return' | 'count'
  qty_delta: number
  stock_after: number
  unit_cost_cents: number | null
  unit_price_cents: number | null
  note: string | null
  created_at: string
}

export const EXPENSE_CATEGORIES = [
  'rent', 'utilities', 'supplies', 'products', 'equipment', 'payroll', 'marketing', 'software', 'fees', 'taxes',
  'maintenance', 'education', 'transport', 'other',
] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

export interface Expense {
  id: string
  shop_id: string
  barber_id: string | null
  category: ExpenseCategory
  amount_cents: number
  spent_on: string
  vendor: string | null
  note: string | null
  method: PaymentMethod
  created_at: string
}

export interface RentCharge {
  id: string
  barber_id: string
  barber_name: string
  chair_label: string | null
  period: 'week' | 'month'
  period_start: string
  period_end: string
  due_date: string
  amount_cents: number
  paid_cents: number
  balance_cents: number
  status: 'due' | 'partial' | 'paid' | 'overdue' | 'waived'
  waived: boolean
  note: string | null
}

export interface FinanceSummary {
  period: { from: string; to: string; timezone: string; currency: string }
  scope: 'shop' | 'barber'
  money_in: Record<string, number>
  money_out: Record<string, number>
  total_in_cents: number
  total_out_cents: number
  net_cents: number
  series: { date: string; in_cents: number; out_cents: number }[]
  expenses_by_category: { category: ExpenseCategory; cents: number }[]
  rent: { outstanding_cents: number; overdue_count?: number; charged_cents?: number; next_due?: { due_date: string; balance_cents: number } | null; plan?: { type: string; rent_cents: number | null; rent_period: string | null; percent_bps: number | null } | null }
  inventory: { value_cents: number; retail_value_cents?: number; low_stock: number; cogs_cents: number } | null
  // shop scope
  pass_through?: { chair_owner_services_cents: number; tips_to_barbers_cents: number }
  collected_by_method?: Record<string, number>
  barbers?: { barber_id: string; name: string; barber_type: BarberType; services_cents: number; commission_cents: number; tips_cents: number; product_commission_cents: number; payout_cents: number | null; rent_paid_cents: number; rent_balance_cents: number }[]
  // barber scope
  barber_type?: BarberType
  private?: boolean
  cuts?: number
}

export interface Operations {
  walk_ins: number
  walk_ins_served: number
  walk_ins_left: number
  avg_wait_minutes: number | null
  on_time_pct: number | null
  timed_cuts: number
  product_sales_cents: number
  products_sold: number
}

export interface ServiceTimeStat {
  barber_id: string
  barber_name: string
  service_id: string
  service_name: string
  default_minutes: number
  booked_minutes: number | null
  learned_minutes: number | null
  avg_30d: number | null
  avg_prev_30d: number | null
  samples_30d: number
  samples_total: number
}
