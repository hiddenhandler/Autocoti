import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Logo } from "@/components/ui";
import { signup } from "../auth-actions";
import { TimezoneField } from "./timezone-field";

export default function SignupPage() {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <Logo />
      <h1 className="h1 mt-8">Set up your barbershop</h1>
      <p className="muted mt-1">You&apos;ll be the owner. Add your barbers after.</p>
      <ActionForm action={signup} className="card mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="shopName">Shop name</label>
          <input className="input" id="shopName" name="shopName" required />
        </div>
        <div>
          <label className="label" htmlFor="ownerName">Your name</label>
          <input className="input" id="ownerName" name="ownerName" autoComplete="name" required />
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" minLength={8} autoComplete="new-password" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TimezoneField />
          <div>
            <label className="label" htmlFor="currency">Currency</label>
            <select className="input" id="currency" name="currency" defaultValue="USD">
              {["USD", "MXN", "EUR", "COP", "ARS", "CLP", "PEN", "GBP", "CAD"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="hasChair" defaultChecked className="mt-0.5 accent-[var(--accent)]" />
          <span>I also cut hair here (I have a chair clients can book)</span>
        </label>
        <SubmitButton className="btn-primary w-full">Create shop</SubmitButton>
      </ActionForm>
      <p className="muted mt-4 text-center">
        Already have an account? <Link href="/login" className="font-semibold text-accent">Log in</Link>
      </p>
    </main>
  );
}
