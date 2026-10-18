"use client";

import Link from "next/link";
import { useState } from "react";
import { Field, FormAlert, fieldErrorsFrom } from "@/components/forms/Field";
import { api, ApiClientError } from "@/lib/api-client";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      await api.post("/api/auth/password/request-reset", { email });
      setDone(true);
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      setMessage(error instanceof ApiClientError ? error.message : "Could not start the reset.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold">Check your email</h1>
        <FormAlert tone="info">
          If an account exists for <strong>{email}</strong>, a single-use reset link is on its way. The link expires in
          one hour. On a development machine without SMTP configured, the message is written to{" "}
          <code>storage/mail-outbox/</code> and the link is printed in the server console.
        </FormAlert>
        <Link href="/login" className="dt-btn dt-btn-secondary w-full">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div>
        <h1 className="text-xl font-bold">Reset your password</h1>
        <p className="mt-1 text-sm text-muted">We will email you a single-use link.</p>
      </div>
      {message && <FormAlert tone="error">{message}</FormAlert>}
      <Field
        label="Email"
        name="email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        required
        error={errors.email}
      />
      <button type="submit" className="dt-btn dt-btn-primary w-full" disabled={busy}>
        {busy ? "Sending…" : "Send reset link"}
      </button>
      <Link href="/login" className="text-sm dt-link text-center">
        Back to sign in
      </Link>
    </form>
  );
}
