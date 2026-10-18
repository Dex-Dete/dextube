"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { FormAlert } from "@/components/forms/Field";
import { api, ApiClientError } from "@/lib/api-client";

type State = { status: "working" | "ok" | "error"; message?: string };

function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<State>({ status: "working" });

  // A missing token is a render-time fact, not a side effect: derive it.
  const effective: State = token
    ? state
    : { status: "error", message: "This verification link is missing its token." };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .post("/api/auth/verify-email", { token })
      .then(() => !cancelled && setState({ status: "ok" }))
      .catch((error: unknown) =>
        !cancelled &&
        setState({
          status: "error",
          message: error instanceof ApiClientError ? error.message : "Verification failed.",
        }),
      );
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Email verification</h1>
      {effective.status === "working" && <FormAlert tone="info">Verifying your email address…</FormAlert>}
      {effective.status === "ok" && (
        <FormAlert tone="success">Your email address is confirmed. Thanks!</FormAlert>
      )}
      {effective.status === "error" && <FormAlert tone="error">{effective.message}</FormAlert>}
      <Link href="/" className="dt-btn dt-btn-primary w-full">
        Go to DEXTube
      </Link>
    </div>
  );
}

export function VerifyEmailPanel() {
  return (
    <Suspense fallback={<div className="h-40" />}>
      <VerifyEmailInner />
    </Suspense>
  );
}
