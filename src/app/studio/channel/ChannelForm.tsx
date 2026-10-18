"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field, FormAlert, fieldErrorsFrom } from "@/components/forms/Field";
import { api, ApiClientError } from "@/lib/api-client";

export interface ChannelFormProps {
  /** "create" is only used for the rare account that has no channel yet. */
  mode: "create" | "edit";
  initialName: string;
  initialHandle: string;
  initialDescription: string;
}

const HANDLE_HINT =
  "Lowercase letters, numbers, dashes or underscores; must start with a letter. 3–30 characters.";

/**
 * Create or edit the signed-in user's channel.
 *
 * Handle validation lives on the server (`PATCH /api/channels/me`); the same
 * rules are surfaced as a hint, and any per-field message the server returns is
 * shown against the field that caused it.
 */
export function ChannelForm({ mode, initialName, initialHandle, initialDescription }: ChannelFormProps) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: initialName,
    handle: initialHandle,
    description: initialDescription,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    setMessage(null);
    setBusy(true);
    try {
      if (mode === "create") {
        await api.post("/api/channels", {
          name: form.name,
          handle: form.handle,
          description: form.description,
        });
        router.replace("/studio/channel");
        router.refresh();
        setMessage({ tone: "success", text: "Your channel is ready." });
      } else {
        await api.patch("/api/channels/me", {
          name: form.name,
          handle: form.handle,
          description: form.description,
        });
        setMessage({ tone: "success", text: "Channel updated." });
        router.refresh();
      }
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      setMessage({
        tone: "error",
        text: error instanceof ApiClientError ? error.message : "Could not save your channel.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="dt-card flex flex-col gap-4 p-4 sm:p-5" onSubmit={submit} noValidate>
      <h2 className="text-sm font-bold">{mode === "create" ? "Create your channel" : "Channel details"}</h2>

      {message && <FormAlert tone={message.tone}>{message.text}</FormAlert>}

      <Field
        label="Channel name"
        name="name"
        value={form.name}
        onChange={(value) => setForm((current) => ({ ...current, name: value }))}
        error={errors.name}
        required
        maxLength={80}
        disabled={busy}
        placeholder="Your channel name"
      />

      <Field
        label="Handle"
        name="handle"
        value={form.handle}
        onChange={(value) => setForm((current) => ({ ...current, handle: value }))}
        error={errors.handle}
        hint={HANDLE_HINT}
        required
        minLength={3}
        maxLength={30}
        disabled={busy}
        placeholder="your-handle"
      />

      <Field
        label="Description"
        name="description"
        value={form.description}
        onChange={(value) => setForm((current) => ({ ...current, description: value }))}
        error={errors.description}
        hint="Shown on your channel's about section. Up to 5000 characters."
        multiline
        rows={5}
        maxLength={5000}
        disabled={busy}
      />

      <div>
        <button type="submit" className="dt-btn dt-btn-primary" disabled={busy || form.name.trim() === ""}>
          {busy ? "Saving…" : mode === "create" ? "Create channel" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
