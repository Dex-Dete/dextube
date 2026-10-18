"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Field, FormAlert, fieldErrorsFrom } from "@/components/forms/Field";
import { api, ApiClientError } from "@/lib/api-client";
import { estimatePasswordStrength } from "@/lib/password-strength";

function ResetPasswordFormInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = useMemo(() => estimatePasswordStrength(password), [password]);

  if (!token) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold">Reset link missing</h1>
        <FormAlert tone="error">
          This page needs a valid reset token. Open the link from your reset email, or request a new one.
        </FormAlert>
        <Link href="/forgot-password" className="dt-btn dt-btn-primary w-full">
          Request a new link
        </Link>
      </div>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    setMessage(null);
    if (password !== confirm) {
      setErrors({ confirm: "Passwords do not match." });
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/auth/password/reset", { token, password });
      router.replace("/login?reset=1");
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      setMessage(error instanceof ApiClientError ? error.message : "Could not reset your password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div>
        <h1 className="text-xl font-bold">Choose a new password</h1>
        <p className="mt-1 text-sm text-muted">All other signed-in devices will be signed out.</p>
      </div>
      {message && <FormAlert tone="error">{message}</FormAlert>}
      <Field
        label="New password"
        name="password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        required
        error={errors.password}
        hint="At least 10 characters with upper case, lower case and a number."
      />
      {password && <p className="text-xs text-subtle">Strength: {strength.label}</p>}
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        required
        error={errors.confirm}
      />
      <button type="submit" className="dt-btn dt-btn-primary w-full" disabled={busy}>
        {busy ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}

export function ResetPasswordForm() {
  return (
    <Suspense fallback={<div className="h-64" />}>
      <ResetPasswordFormInner />
    </Suspense>
  );
}
