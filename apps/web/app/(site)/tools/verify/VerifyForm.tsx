"use client";

/**
 * Paste a transfer code (tx hash) → plain-language rendering of the public record + an explorer deep
 * link. Real Horizon read (lib/horizon::loadTransfer). Logic carried over unchanged; only the chrome
 * moved to the --pw-* system.
 */
import { useState } from "react";
import { loadTransfer } from "../../../../lib/horizon";

const explorer = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;

export function VerifyForm() {
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "found" | "missing" | "error">("idle");
  const [result, setResult] = useState<{ successful: boolean; createdAt: string } | null>(null);

  async function check(e: React.FormEvent) {
    e.preventDefault();
    const hash = code.trim();
    if (!/^[a-f0-9]{64}$/i.test(hash)) {
      setState("error");
      return;
    }
    setState("loading");
    try {
      const r = await loadTransfer(hash);
      if (!r) return setState("missing");
      setResult(r);
      setState("found");
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <form onSubmit={check} className="tool-form">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Transfer code"
          aria-label="Transfer code"
          className="tool-input tool-input-mono"
        />
        <button className="pg-btn pg-btn-primary tool-submit">Check</button>
      </form>

      {state === "loading" && <p className="tool-status">Checking the public record…</p>}
      {state === "error" && <p className="tool-error">That doesn&apos;t look like a valid transfer code.</p>}
      {state === "missing" && <p className="tool-status">No transfer found with that code.</p>}
      {state === "found" && result && (
        <div className="tool-card">
          <p className="tool-card-head" data-tone="accent">
            {result.successful ? "✓ Real and confirmed" : "This transfer did not complete"}
          </p>
          <p className="tool-note">
            Recorded on {new Date(result.createdAt).toLocaleString()} on the public ledger.
          </p>
          <a href={explorer(code.trim())} target="_blank" rel="noreferrer" className="tool-link">
            See the full record ↗
          </a>
        </div>
      )}
    </>
  );
}
