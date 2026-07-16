"use client";

/**
 * EmailCapture (Periwinkle) — the only PII we collect (notify-me email). Posts to the sponsor
 * /waitlist endpoint, which keeps it in an ISOLATED store, never joined to a pubkey or any money
 * data ("email + account balance in one row is a dataset we don't want to be holding when it
 * leaks"). Rebuilt on the --pw-* system from the retired warm-paper marketing version.
 */
import { useState } from "react";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.vercel.app";

export function EmailCapture({ list, cta }: { list: "waitlist" | "cashout"; cta: string }) {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${SPONSOR_URL}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ list, email }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Please try again.");
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p className="cap-done">Thanks — you&apos;re on the list. We&apos;ll be in touch.</p>;
  }

  return (
    <form onSubmit={submit} className="cap-form">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com"
        className="tool-input cap-input"
      />
      <button type="submit" disabled={busy} className="pg-btn pg-btn-primary tool-submit">
        {busy ? "…" : cta}
      </button>
      {error && <p className="tool-error sm:w-full">{error}</p>}
    </form>
  );
}
