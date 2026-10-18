"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { formatCount } from "@/lib/format";
import { BellIcon, CheckIcon } from "@/components/icons";

export interface SubscribeButtonProps {
  channelHandle: string;
  initiallySubscribed: boolean;
  subscriberCount: number;
  /** Signed-out visitors are sent to the login page instead. */
  signedIn: boolean;
  /** The owner cannot subscribe to their own channel. */
  isOwner?: boolean;
}

/**
 * Subscribe toggle.
 *
 * Uses an optimistic update so the button feels instant, then reconciles with
 * the authoritative subscriber count returned by the server. If the request
 * fails the change is rolled back and the error is announced.
 */
export function SubscribeButton({
  channelHandle,
  initiallySubscribed,
  subscriberCount,
  signedIn,
  isOwner = false,
}: SubscribeButtonProps) {
  const [subscribed, setSubscribed] = useState(initiallySubscribed);
  const [count, setCount] = useState(subscriberCount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isOwner) {
    return (
      <span className="dt-btn dt-btn-secondary cursor-default" aria-disabled="true" title="This is your channel">
        Your channel
      </span>
    );
  }

  if (!signedIn) {
    return (
      <a href={`/login?next=/watch`} className="dt-btn dt-btn-primary">
        Subscribe
      </a>
    );
  }

  async function toggle() {
    if (pending) return;
    const next = !subscribed;
    const previous = { subscribed, count };
    setPending(true);
    setError(null);
    setSubscribed(next);
    setCount((value) => Math.max(0, value + (next ? 1 : -1)));
    try {
      const result = await api[ next ? "post" : "del" ]<{ subscribed: boolean; subscriberCount: number }>(
        `/api/channels/${encodeURIComponent(channelHandle)}/subscribe`,
        next ? {} : undefined,
      );
      setSubscribed(result.subscribed);
      setCount(result.subscriberCount);
    } catch (e) {
      setSubscribed(previous.subscribed);
      setCount(previous.count);
      setError(e instanceof Error ? e.message : "Could not update your subscription.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={pending}
        aria-pressed={subscribed}
        className={subscribed ? "dt-btn dt-btn-secondary" : "dt-btn dt-btn-primary"}
      >
        {subscribed ? (
          <>
            <BellIcon size={16} /> Subscribed
          </>
        ) : (
          "Subscribe"
        )}
      </button>
      <p className="text-[11px] text-subtle">
        {formatCount(count)} {count === 1 ? "subscriber" : "subscribers"}
      </p>
      {error && (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      )}
      {subscribed && !error && (
        <p className="flex items-center gap-1 text-[11px] text-subtle">
          <CheckIcon size={11} /> Notifications on
        </p>
      )}
    </div>
  );
}
