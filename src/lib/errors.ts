// Map stable server error codes (raised by app.fail) to human messages.
const MESSAGES: Record<string, string> = {
  SLOT_TAKEN: 'That time was just taken. Please pick another one.',
  NOT_AUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: "You don't have permission to do that.",
  SHOP_NOT_AVAILABLE: 'This shop is not taking online bookings right now.',
  SERVICE_NOT_BOOKABLE: 'That service can only be booked in the shop.',
  PHONE_REQUIRED: 'Please add a phone number so the shop can reach you.',
  EMAIL_REQUIRED: 'Please add an email address.',
  CLIENT_NAME_REQUIRED: 'Please add a name.',
  TOO_MANY_UPCOMING: 'You already have several upcoming appointments. Please manage those first.',
  NOT_CANCELLABLE: 'This appointment can no longer be cancelled online.',
  NOT_RESCHEDULABLE: 'This appointment can no longer be moved.',
  CANCEL_DISABLED: 'Online cancellation is turned off — please call the shop.',
  RESCHEDULE_DISABLED: 'Online rescheduling is turned off — please call the shop.',
  BARBER_REQUIRED: 'Please choose a barber.',
  BARBER_BUSY: 'This barber already has a cut in progress. Finish it first.',
  BARBER_NOT_IN_SHOP: 'That barber does not work at this shop.',
  INVALID_STATUS_TRANSITION: "That change isn't possible for this appointment's status.",
  NOT_STARTED_YET: "You can't mark a no-show before the appointment starts.",
  ALREADY_PAID: 'This appointment has already been paid.',
  PROMO_INVALID: 'That promo code is not valid.',
  PROMO_FIRST_VISIT_ONLY: 'That promo code is for first visits only.',
  INVALID_AMOUNT: 'Please check the amount.',
  ITEMS_REQUIRED: 'Add at least one service.',
  QUEUE_EMPTY: 'Nobody is waiting for this barber.',
  NOT_ENOUGH_TIME: 'Not enough time before the next booking.',
  SERVICE_REQUIRED: 'Pick a service first.',
  SERVICE_NOT_OFFERED: "That barber doesn't offer this service.",
  OFFER_EXPIRED: 'This offer has expired. You are still on the waitlist.',
  WAITLIST_DISABLED: 'The waitlist is not available for this shop.',
  CONTACT_REQUIRED: 'Add a phone number or email so we can notify you.',
  DATE_IN_PAST: 'Pick a date in the future.',
  SLUG_TAKEN: 'That link is taken — try another.',
  INVALID_TIMEZONE: 'Unknown timezone.',
  PLAN_UPGRADE_REQUIRED: 'This feature is not included in your current plan.',
  PLAN_LIMIT_BARBERS: 'Your plan limit for barbers is reached. Upgrade to add more.',
  PLAN_LIMIT_LOCATIONS: 'Your plan limit for locations is reached.',
  INVITATION_INVALID: 'This invitation is no longer valid.',
  INVITATION_USED: 'This invitation was already used.',
  INVITATION_EMAIL_MISMATCH: 'This invitation was sent to a different email address.',
  OVERLAPS_EXISTING: 'That overlaps something already on the calendar.',
  NOT_MOVABLE: 'This appointment cannot be moved.',
  ALREADY_REVIEWED: 'Thanks — you already reviewed this visit.',
  NOT_COMPLETED: 'You can review once the appointment is completed.',
  RATING_REQUIRED: 'Choose a rating.',
  NOT_FOUND: 'Not found.',
  GIFT_CARD_INVALID: 'That gift card is not valid.',
  INSUFFICIENT_BALANCE: 'Not enough balance on that gift card.',
  INVALID_MERGE: 'Those clients cannot be merged.',
  INVALID_RANGE: 'Choose a shorter date range.',
  NO_FEE: 'There is no fee to charge.',
}

export function errorCode(e: unknown): string | null {
  const msg = (e as { message?: string })?.message
  if (msg && /^[A-Z_]+$/.test(msg)) return msg
  return null
}

export function friendlyError(e: unknown): string {
  const err = e as { message?: string; details?: string; code?: string }
  const code = errorCode(e)
  if (code && MESSAGES[code]) return MESSAGES[code]
  if (code) return err.details && err.details !== code ? err.details : code.replace(/_/g, ' ').toLowerCase()
  if (err?.code === '23P01') return MESSAGES.SLOT_TAKEN
  if (err?.message?.includes('Failed to fetch')) return "You're offline. Check your connection and try again."
  if (err?.message?.toLowerCase().includes('invalid login')) return 'Wrong email or password.'
  return err?.message ?? 'Something went wrong.'
}
