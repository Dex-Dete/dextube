"use client";

/**
 * Shared form primitives used by every DEXTube form.
 * Kept tiny and unstyled-by-default so each screen can compose its own layout
 * while keeping error display and accessibility consistent.
 */
import { useId, useState } from "react";
import type { ApiClientError } from "@/lib/api-client";

export interface FieldProps {
  label: string;
  name: string;
  type?: "text" | "email" | "password" | "search" | "url" | "number" | "date" | "datetime-local";
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  minLength?: number;
  maxLength?: number;
  multiline?: boolean;
  rows?: number;
  inputMode?: "text" | "numeric" | "email" | "url" | "search";
}

export function Field({
  label,
  name,
  type = "text",
  value,
  onChange,
  error,
  hint,
  required,
  placeholder,
  autoComplete,
  disabled,
  minLength,
  maxLength,
  multiline,
  rows = 4,
  inputMode,
}: FieldProps) {
  const id = useId();
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ");

  return (
    <div>
      <label className="dt-label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
      </label>
      {multiline ? (
        <textarea
          id={id}
          name={name}
          className="dt-input"
          value={value}
          rows={rows}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          minLength={minLength}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          className="dt-input"
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          disabled={disabled}
          minLength={minLength}
          maxLength={maxLength}
          inputMode={inputMode}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormAlert({ tone, children }: { tone: "error" | "success" | "info"; children: React.ReactNode }) {
  const role = tone === "error" ? "alert" : "status";
  return (
    <div role={role} className={`dt-alert dt-alert-${tone}`}>
      <span>{children}</span>
    </div>
  );
}

/** Maps `ApiClientError.details` onto a field-name → message dictionary. */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  const details = (error as ApiClientError | undefined)?.details;
  if (!details) return {};
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(details)) {
    if (messages?.[0]) out[key] = messages[0];
  }
  return out;
}

export function useFormMessage() {
  const [message, setMessage] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  return {
    message,
    setError: (text: string) => setMessage({ tone: "error", text }),
    setSuccess: (text: string) => setMessage({ tone: "success", text }),
    setInfo: (text: string) => setMessage({ tone: "info", text }),
    clear: () => setMessage(null),
  };
}
