"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Field, FormAlert, fieldErrorsFrom } from "@/components/forms/Field";
import { api, ApiClientError } from "@/lib/api-client";

function LoginFormInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      await api.post("/api/auth/login", { identifier, password });
      // Full navigation so the server-rendered shell picks up the new session
      // immediately (and so a refresh cannot show stale signed-out chrome).
      router.replace(next.startsWith("/") ? next : "/");
      router.refresh();
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      setMessage(error instanceof ApiClientError ? error.message : "Could not sign in. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div>
        <h1 className="text-xl font-bold">Sign in to DEXTube</h1>
        <p className="mt-1 text-sm text-muted">Use your username or email address.</p>
      </div>

      {message && <FormAlert tone="error">{message}</FormAlert>}

      <Field
        label="Username or email"
        name="identifier"
        value={identifier}
        onChange={setIdentifier}
        autoComplete="username"
        required
        error={errors.identifier}
        placeholder="ada or ada@example.com"
      />
      <Field
        label="Password"
        name="password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        required
        error={errors.password}
      />

      <button type="submit" className="dt-btn dt-btn-primary w-full" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link href="/forgot-password" className="dt-link">
          Forgot password?
        </Link>
        <span className="text-muted">
          New here?{" "}
          <Link href="/register" className="dt-link">
            Create an account
          </Link>
        </span>
      </div>
    </form>
  );
}

export function LoginForm() {
  return (
    <Suspense fallback={<div className="h-64" />}>
      <LoginFormInner />
    </Suspense>
  );
}
