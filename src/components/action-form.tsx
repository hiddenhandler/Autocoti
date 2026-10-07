"use client";

import { createContext, useContext, useState, useTransition } from "react";

export type ActionResult = { error?: string; ok?: string } | void;

const PendingContext = createContext(false);

/**
 * Submits a server action without React's automatic form reset, so a
 * validation error doesn't wipe what the user typed.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [result, setResult] = useState<ActionResult>();
  const [pending, startTransition] = useTransition();
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        startTransition(async () => {
          const r = await action(data);
          setResult(r);
          if (resetOnSuccess && r && !r.error) form.reset();
        });
      }}
    >
      <PendingContext.Provider value={pending}>
        {result?.error && (
          <div role="alert" className="mb-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">
            {result.error}
          </div>
        )}
        {result?.ok && (
          <div role="status" className="mb-3 rounded-xl bg-good-soft px-3 py-2 text-sm text-good">
            {result.ok}
          </div>
        )}
        {children}
      </PendingContext.Provider>
    </form>
  );
}

export function SubmitButton({ children, className = "btn-primary" }: { children: React.ReactNode; className?: string }) {
  const pending = useContext(PendingContext);
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Saving…" : children}
    </button>
  );
}
