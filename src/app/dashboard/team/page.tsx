import { requireOwner } from "@/lib/auth";
import { getDb, USER_COLUMNS, type User } from "@/lib/db";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { addBarber, updateMember } from "../actions";

export default async function TeamPage() {
  const { user, shop } = await requireOwner();
  const team = getDb().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE shop_id = ? ORDER BY role DESC, name`).all(shop.id) as User[];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="h1">Team</h1>
        <p className="muted">Only people here can log in. Barbers with a chair show up on your booking page.</p>
      </header>

      <section className="card divide-y divide-line">
        {team.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div>
              <div className="font-medium">
                {m.name} {m.id === user.id && <span className="text-ink-3">(you)</span>}
              </div>
              <div className="text-xs text-ink-2">
                {m.email} · {m.role === "owner" ? "Owner" : "Barber"} ·{" "}
                {m.requires_approval ? "approves requests" : "auto-confirms"}
                {!m.active && <span className="text-bad"> · deactivated</span>}
              </div>
            </div>
            <div className="flex gap-2">
              <form action={updateMember.bind(null, m.id, "has_chair", !m.has_chair)}>
                <button className={m.has_chair ? "btn-primary btn-sm" : "btn-ghost btn-sm"} aria-pressed={!!m.has_chair}>
                  {m.has_chair ? "✓ Has a chair" : "No chair"}
                </button>
              </form>
              {m.id !== user.id && (
                <form action={updateMember.bind(null, m.id, "active", !m.active)}>
                  <button className="btn-ghost btn-sm">{m.active ? "Deactivate" : "Reactivate"}</button>
                </form>
              )}
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="h2">Add a barber</h2>
        <p className="muted">Give them a temporary password; they can change it in their settings.</p>
        <ActionForm action={addBarber} resetOnSuccess className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="b-name">Name</label>
            <input className="input" id="b-name" name="name" required />
          </div>
          <div>
            <label className="label" htmlFor="b-email">Email</label>
            <input className="input" id="b-email" name="email" type="email" required />
          </div>
          <div>
            <label className="label" htmlFor="b-pw">Temporary password</label>
            <input className="input" id="b-pw" name="password" minLength={8} required />
          </div>
          <SubmitButton>Add barber</SubmitButton>
        </ActionForm>
      </section>
    </div>
  );
}
