"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Field, FormAlert, fieldErrorsFrom } from "@/components/forms/Field";
import { api, ApiClientError } from "@/lib/api-client";
import { estimatePasswordStrength } from "@/lib/password-strength";

const INTERESTS = [
  "gaming",
  "music",
  "technology",
  "education",
  "film",
  "sports",
  "news",
  "comedy",
  "science",
  "art",
  "cooking",
  "travel",
];

export function RegisterForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    displayName: "",
    username: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [interests, setInterests] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = useMemo(() => estimatePasswordStrength(form.password), [form.password]);

  const update = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    setMessage(null);

    if (form.password !== form.confirm) {
      setErrors({ confirm: "Passwords do not match." });
      return;
    }

    setBusy(true);
    try {
      await api.post("/api/auth/register", {
        displayName: form.displayName,
        username: form.username,
        email: form.email,
        password: form.password,
        interests,
      });
      router.replace("/");
      router.refresh();
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      setMessage(error instanceof ApiClientError ? error.message : "Could not create your account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div>
        <h1 className="text-xl font-bold">Create your DEXTube account</h1>
        <p className="mt-1 text-sm text-muted">
          A channel is created automatically so you can upload straight away.
        </p>
      </div>

      {message && <FormAlert tone="error">{message}</FormAlert>}

      <Field
        label="Display name"
        name="displayName"
        value={form.displayName}
        onChange={update("displayName")}
        autoComplete="name"
        required
        error={errors.displayName}
        placeholder="Ada Lovelace"
      />
      <Field
        label="Username"
        name="username"
        value={form.username}
        onChange={update("username")}
        autoComplete="username"
        required
        error={errors.username}
        hint="Letters, numbers, dashes or underscores. Also becomes your @handle."
        placeholder="ada"
      />
      <Field
        label="Email"
        name="email"
        type="email"
        value={form.email}
        onChange={update("email")}
        autoComplete="email"
        required
        error={errors.email}
        placeholder="ada@example.com"
      />
      <div>
        <Field
          label="Password"
          name="password"
          type="password"
          value={form.password}
          onChange={update("password")}
          autoComplete="new-password"
          required
          error={errors.password}
          hint="At least 10 characters with upper case, lower case and a number."
        />
        {form.password && (
          <div className="mt-2 flex items-center gap-2" aria-live="polite">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${(strength.score / 4) * 100}%`,
                  background:
                    strength.score <= 1
                      ? "var(--dt-danger)"
                      : strength.score === 2
                        ? "var(--dt-warning)"
                        : "var(--dt-success)",
                }}
              />
            </div>
            <span className="text-xs text-subtle">{strength.label}</span>
          </div>
        )}
      </div>
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        value={form.confirm}
        onChange={update("confirm")}
        autoComplete="new-password"
        required
        error={errors.confirm}
      />

      <fieldset>
        <legend className="dt-label">What are you into? (optional)</legend>
        <p className="mb-2 text-xs text-subtle">
          Used only to avoid the cold-start problem on your home feed. You can change it later.
        </p>
        <div className="flex flex-wrap gap-2">
          {INTERESTS.map((tag) => {
            const active = interests.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setInterests((current) =>
                    current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
                  )
                }
                className="dt-btn !px-3 !py-1 text-xs"
                style={
                  active
                    ? { background: "var(--dt-brand)", color: "var(--dt-brand-contrast)" }
                    : { background: "var(--dt-surface-2)" }
                }
              >
                {tag}
              </button>
            );
          })}
        </div>
      </fieldset>

      <button type="submit" className="dt-btn dt-btn-primary w-full" disabled={busy}>
        {busy ? "Creating your account…" : "Create account"}
      </button>

      <p className="text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="dt-link">
          Sign in
        </Link>
      </p>
    </form>
  );
}
