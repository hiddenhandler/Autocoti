import { requireUser } from "@/lib/auth";
import { getServices } from "@/lib/booking";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { addService, updateService } from "../actions";

export default async function ServicesPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { user, shop } = await requireUser();
  const services = getServices(user.id, true);
  const welcome = (await searchParams).welcome === "1";

  return (
    <div className="space-y-6">
      {welcome && (
        <div className="rounded-2xl bg-accent-soft p-4 text-sm">
          <div className="font-semibold text-accent">Welcome! Your shop is live at /s/{shop.slug}</div>
          <p className="mt-1">
            Next: add the services you offer and their prices, check your hours, then invite your barbers from Team.
          </p>
        </div>
      )}
      <header>
        <h1 className="h1">Services &amp; prices</h1>
        <p className="muted">What clients can book with you. The price is what they see; you log the real charge when you finish.</p>
      </header>

      <section className="card">
        <h2 className="h2">Add a service</h2>
        <ActionForm action={addService} resetOnSuccess className="mt-3 grid gap-3 sm:grid-cols-[1fr_8rem_8rem_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="new-name">Name</label>
            <input className="input" id="new-name" name="name" placeholder="Haircut" required />
          </div>
          <div>
            <label className="label" htmlFor="new-duration">Minutes</label>
            <input className="input" id="new-duration" name="duration" type="number" min={5} max={480} step={5} defaultValue={30} required />
          </div>
          <div>
            <label className="label" htmlFor="new-price">Price ({shop.currency})</label>
            <input className="input" id="new-price" name="price" inputMode="decimal" placeholder="20" required />
          </div>
          <SubmitButton>Add</SubmitButton>
        </ActionForm>
      </section>

      <section className="space-y-3">
        {services.map((s) => (
          <ActionForm
            key={s.id}
            action={updateService.bind(null, s.id)}
            className={`card grid gap-3 sm:grid-cols-[1fr_8rem_8rem_auto_auto] sm:items-end ${s.active ? "" : "opacity-60"}`}
          >
            <div>
              <label className="label" htmlFor={`n-${s.id}`}>Name</label>
              <input className="input" id={`n-${s.id}`} name="name" defaultValue={s.name} required />
            </div>
            <div>
              <label className="label" htmlFor={`d-${s.id}`}>Minutes</label>
              <input className="input" id={`d-${s.id}`} name="duration" type="number" min={5} max={480} step={5} defaultValue={s.duration_min} required />
            </div>
            <div>
              <label className="label" htmlFor={`p-${s.id}`}>Price</label>
              <input className="input" id={`p-${s.id}`} name="price" inputMode="decimal" defaultValue={(s.price_cents / 100).toString()} required />
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-sm">
              <input type="checkbox" name="active" defaultChecked={!!s.active} className="accent-[var(--accent)]" /> Bookable
            </label>
            <SubmitButton className="btn-ghost">Save</SubmitButton>
          </ActionForm>
        ))}
        {services.length === 0 && <p className="muted">No services yet — clients can&apos;t book you until you add one.</p>}
      </section>
    </div>
  );
}
