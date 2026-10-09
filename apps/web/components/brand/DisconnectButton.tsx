"use client";

/**
 * DisconnectButton — remove this device's keys, so someone can hand the phone on, use a different
 * account, or stop practising and start fresh.
 *
 * The reason this is not a plain "sign out": everywhere else that phrase is reversible, because
 * the account lives on a server and a password brings it back. Here the keys ARE the account. On a
 * backed-up (Phase 2) wallet the promise holds — email and password, or Face ID, restore it. On a
 * Phase-1 wallet this device holds the only copy, and pressing this ends access to that money
 * permanently. Same button, two completely different consequences, so it types differently: a
 * backed-up account gets one confirmation, an unbacked one has to type the word.
 *
 * A BACKUP IS NOT THE WHOLE STORY. It brings the account back, not the list of money links sent from
 * this browser: that list lives only here (localStorage `lumenia.sent`, per network), and it is the
 * only way the website finds a link to take back. Removing the account leaves the list where it is,
 * so the way back to an unclaimed link is this account, on this browser. When there are links, the
 * sheet says so before anything is removed.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { clearKeystore } from "../../lib/keystore";

const CONFIRM_WORD = "REMOVE";

/** Does this browser hold any money links sent from it (either network)? Blocked storage reads as no. */
function sentLinksHere(): boolean {
  for (const net of ["testnet", "public"]) {
    try {
      const all = JSON.parse(localStorage.getItem(`lumenia.sent.${net}`) ?? "{}") as Record<string, { balanceId?: unknown }>;
      if (Object.values(all).some((r) => typeof r?.balanceId === "string" && /^[0-9a-f]{64}$/i.test(r.balanceId))) return true;
    } catch {
      /* unreadable: nothing to warn about from here */
    }
  }
  return false;
}

export function DisconnectButton({ backedUp }: { backedUp: boolean }) {
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasLinks, setHasLinks] = useState(false);

  const canGo = backedUp || typed.trim().toUpperCase() === CONFIRM_WORD;

  async function run(): Promise<void> {
    setBusy(true);
    try {
      await clearKeystore();
    } finally {
      // Full reload rather than a client navigation: every module holding an unlocked seed or a
      // cached account in memory has to be torn down, and a soft route change would leave them.
      window.location.href = "/";
    }
  }

  if (!arming) {
    return (
      <button
        type="button"
        onClick={() => {
          setHasLinks(sentLinksHere());
          setArming(true);
        }}
        className="mt-3 rounded-[14px] border border-line px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-muted"
      >
        Remove this account from this phone
      </button>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {hasLinks && (
        <p className="text-sm text-ink-soft">
          Links you sent from this browser can only be taken back from this browser. If any are still
          unclaimed, bring this account back here, not on another phone, to take them back.
        </p>
      )}
      {backedUp ? (
        <p className="text-sm text-ink-soft">
          You have a backup, so your account comes back with your email and password. Remove it here?
        </p>
      ) : (
        <>
          <p className="text-sm text-danger">
            This account has no backup. Removing it here ends your access to its money for good, and
            nobody — including us — can undo it.
          </p>
          <label className="text-sm text-ink-soft">
            Type {CONFIRM_WORD} to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink outline-none"
            />
          </label>
        </>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canGo || busy}
          onClick={run}
          className="rounded-[14px] border border-danger px-3 py-2 text-sm font-medium text-danger transition-opacity disabled:opacity-40"
        >
          {busy ? "Removing…" : "Remove it"}
        </button>
        <button
          type="button"
          onClick={() => {
            setArming(false);
            setTyped("");
          }}
          className="rounded-[14px] px-3 py-2 text-sm text-ink-soft"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
