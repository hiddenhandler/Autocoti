import { Card, Logo } from './ui'

export function SetupNotice() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="max-w-lg p-8">
        <Logo />
        <h1 className="display mt-6 text-3xl">Connect your database</h1>
        <p className="mt-3 text-sm text-muted">
          BarberNGo needs a Supabase project. Copy <code className="rounded bg-surface-2 px-1">.env.example</code> to{' '}
          <code className="rounded bg-surface-2 px-1">.env</code>, set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then run the
          migrations in <code>supabase/migrations</code> (<code>supabase db push</code>).
        </p>
      </Card>
    </div>
  )
}
