import { requireOwner } from "@/lib/auth";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { saveShop } from "../actions";

export default async function ShopSettingsPage() {
  const { shop } = await requireOwner();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="h1">Shop settings</h1>
        <p className="muted">How your public booking page looks and behaves.</p>
      </header>
      <ActionForm action={saveShop} className="card grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="name">Shop name</label>
          <input className="input" id="name" name="name" defaultValue={shop.name} required />
        </div>
        <div>
          <label className="label" htmlFor="slug">Booking link</label>
          <div className="flex items-center gap-1 text-sm">
            <span className="text-ink-3">/s/</span>
            <input className="input" id="slug" name="slug" defaultValue={shop.slug} required />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="address">Address</label>
          <input className="input" id="address" name="address" defaultValue={shop.address} />
        </div>
        <div>
          <label className="label" htmlFor="phone">Phone</label>
          <input className="input" id="phone" name="phone" defaultValue={shop.phone} />
        </div>
        <div>
          <label className="label" htmlFor="timezone">Time zone</label>
          <input className="input" id="timezone" name="timezone" defaultValue={shop.timezone} required />
        </div>
        <div>
          <label className="label" htmlFor="currency">Currency</label>
          <input className="input" id="currency" name="currency" defaultValue={shop.currency} maxLength={3} />
        </div>
        <div>
          <label className="label" htmlFor="interval">Show a start time every</label>
          <select className="input" id="interval" name="interval" defaultValue={shop.slot_interval_min}>
            {[5, 10, 15, 20, 30, 60].map((n) => <option key={n} value={n}>{n} minutes</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="notice">Minimum notice (minutes)</label>
          <input className="input" id="notice" name="notice" type="number" min={0} max={2880} defaultValue={shop.min_notice_min} />
        </div>
        <div>
          <label className="label" htmlFor="ahead">Clients can book up to (days ahead)</label>
          <input className="input" id="ahead" name="ahead" type="number" min={1} max={120} defaultValue={shop.max_days_ahead} />
        </div>
        <div className="flex items-end">
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}
