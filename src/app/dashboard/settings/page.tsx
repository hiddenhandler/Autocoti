import { requireUser } from "@/lib/auth";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { logout } from "../../auth-actions";
import { changePassword, saveProfile } from "../actions";

export default async function SettingsPage() {
  const { user, shop } = await requireUser();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="h1">My settings</h1>
        <p className="muted">
          Your booking page: <a className="font-medium text-accent underline" href={`/s/${shop.slug}`}>/s/{shop.slug}</a>
        </p>
      </header>

      <ActionForm action={saveProfile} className="card space-y-4">
        <div>
          <label className="label" htmlFor="name">Name clients see</label>
          <input className="input" id="name" name="name" defaultValue={user.name} required />
        </div>
        <div>
          <label className="label" htmlFor="bio">Short bio</label>
          <input className="input" id="bio" name="bio" defaultValue={user.bio} maxLength={200} placeholder="Fades, beards, classic cuts" />
        </div>
        <label className="flex items-start gap-3 rounded-xl bg-surface-2 p-3 text-sm">
          <input type="checkbox" name="requiresApproval" defaultChecked={!!user.requires_approval} className="mt-0.5 accent-[var(--accent)]" />
          <span>
            <b>I approve each booking</b>
            <span className="block text-ink-2">
              Off: bookings are confirmed instantly. On: clients send a request and the time is held until you accept or decline.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-xl bg-surface-2 p-3 text-sm">
          <input type="checkbox" name="shareEarnings" defaultChecked={!!user.share_earnings} className="mt-0.5 accent-[var(--accent)]" />
          <span>
            <b>Share my revenue totals with the owner</b>
            <span className="block text-ink-2">The owner always sees visit counts and cut times, but your money stays private unless you turn this on.</span>
          </span>
        </label>
        <SubmitButton>Save</SubmitButton>
      </ActionForm>

      <ActionForm action={changePassword} resetOnSuccess className="card flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="password">New password</label>
          <input className="input" id="password" name="password" type="password" minLength={8} autoComplete="new-password" required />
        </div>
        <SubmitButton className="btn-ghost">Change password</SubmitButton>
      </ActionForm>

      <form action={logout}>
        <button className="btn-ghost w-full sm:w-auto">Log out</button>
      </form>
    </div>
  );
}
