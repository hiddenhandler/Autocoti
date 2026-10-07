import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Logo } from "@/components/ui";
import { login } from "../auth-actions";

export default function LoginPage() {
  return (
    <main className="mx-auto max-w-sm px-4 py-10">
      <Logo />
      <h1 className="h1 mt-8">Log in</h1>
      <p className="muted mt-1">For shop owners and barbers.</p>
      <ActionForm action={login} className="card mt-6 space-y-4">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <SubmitButton className="btn-primary w-full">Log in</SubmitButton>
      </ActionForm>
      <p className="muted mt-4 text-center">
        New shop? <Link href="/signup" className="font-semibold text-accent">Create one</Link>
      </p>
    </main>
  );
}
