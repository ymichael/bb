import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { trackLandingEvent } from "./analytics";
import type { CtaPlacement } from "./site";
import {
  DISCORD_URL,
  GITHUB_URL,
  X_URL,
  SUBSCRIBE_PATH,
  downloadMacosHref,
} from "./site";

type CtaLinkProps = {
  placement: CtaPlacement;
  className?: string;
  children: ReactNode;
};

export function DownloadLink({ placement, className, children }: CtaLinkProps) {
  return (
    <a className={className} href={downloadMacosHref(placement)}>
      {children}
    </a>
  );
}

export function GitHubLink({
  placement,
  className,
  children,
  "aria-label": ariaLabel,
}: CtaLinkProps & { "aria-label"?: string }) {
  return (
    <a
      className={className}
      aria-label={ariaLabel}
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      onClick={() =>
        trackLandingEvent({
          name: "landing_github_clicked",
          properties: { placement },
        })
      }
    >
      {children}
    </a>
  );
}

export function DiscordLink({ placement, className, children }: CtaLinkProps) {
  return (
    <a
      className={className}
      href={DISCORD_URL}
      target="_blank"
      rel="noreferrer"
      onClick={() =>
        trackLandingEvent({
          name: "landing_discord_clicked",
          properties: { placement },
        })
      }
    >
      {children}
    </a>
  );
}

export function XLink({ placement, className, children }: CtaLinkProps) {
  return (
    <a
      className={className}
      href={X_URL}
      target="_blank"
      rel="noreferrer"
      onClick={() =>
        trackLandingEvent({
          name: "landing_x_clicked",
          properties: { placement },
        })
      }
    >
      {children}
    </a>
  );
}

type SubscribeStatus = "idle" | "submitting" | "success" | "error";

export const SUBSCRIBE_EMAIL_ID = "subscribe-email";

export function focusSubscribeEmail() {
  document.getElementById(SUBSCRIBE_EMAIL_ID)?.focus();
}

export function EmailSignup({ placement }: { placement: CtaPlacement }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<SubscribeStatus>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash === SUBSCRIBE_EMAIL_ID || hash === "subscribe") {
      focusSubscribeEmail();
    }
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "submitting") {
      return;
    }
    setStatus("submitting");
    setError("");
    try {
      const response = await fetch(SUBSCRIBE_PATH, {
        body: JSON.stringify({ email }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? "Something went wrong. Try again.");
        setStatus("error");
        return;
      }
      trackLandingEvent({
        name: "landing_email_subscribed",
        properties: { placement },
      });
      setStatus("success");
    } catch {
      setError("Could not reach the server. Try again.");
      setStatus("error");
    }
  };

  if (status === "success") {
    return (
      <p className="subscribe-done" role="status">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          className="subscribe-done-ic"
        />
        You&rsquo;re on the list. We&rsquo;ll be in touch.
      </p>
    );
  }

  return (
    <form className="subscribe-form" onSubmit={submit} noValidate>
      <input
        id={SUBSCRIBE_EMAIL_ID}
        className="subscribe-input"
        type="email"
        name="email"
        inputMode="email"
        autoComplete="email"
        required
        placeholder="you@example.com"
        aria-label="Email address"
        aria-invalid={status === "error"}
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
          if (status === "error") {
            setStatus("idle");
          }
        }}
      />
      <button
        type="submit"
        className="btn btn-primary subscribe-btn"
        disabled={status === "submitting"}
      >
        {status === "submitting" ? "Subscribing…" : "Subscribe"}
      </button>
      {status === "error" ? (
        <span className="subscribe-error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}
