"use client";

/**
 * AccountsCard — every account on this phone, which one is active, and how to add or remove one
 * (docs/IDENTITY_AND_ACCOUNTS.md §4).
 *
 * THE DEFAULT STAYS ONE. Lumenia deliberately hides the fact that claiming produces a throwaway
 * account per link — /home sweeps them into the active account and closes them, and the user never
 * sees "account 1 / account 2". Surfacing a switcher to everybody would undo that. So the list only
 * appears once there is genuinely more than one DELIBERATE account; before that this card is just
 * "add another account", which is a different, opt-in idea.
 *
 * Throwaways are never listed here. They are plumbing, they are mid-sweep, and naming them would
 * teach people to worry about something the app is already handling.
 *
 * Removing an account is the dangerous action on this screen, so it is typed, and the wording
 * changes with the truth: with a backup the money comes back, without one it does not come back
 * at all.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { hasBackup } from "../../lib/recovery-api";
import { MoneyCard } from "./MoneyCard";
import { MAX_USER_ACCOUNTS } from "../../lib/new-account";

const CONFIRM_WORD = "REMOVE";

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

export function AccountsCard() {
  const router = useRouter();
  const { account, accounts, switchAccount, createAccount, forgetAccount, network, mainnetApproved } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  if (!account) return null;

  // Only deliberate accounts. See the note above on why throwaways never appear.
  const mine = accounts.filter((a) => a.kind === "user");
  const others = mine.filter((a) => a.address !== account.address);
  const atLimit = mine.length >= MAX_USER_ACCOUNTS;

  /**
   * Real money creation costs the sponsor a reserve it does not get back, so on mainnet it stays
   * behind the same pilot allowlist that gates everything else there. On practice money it is free.
   */
  const canCreate = network !== "public" || mainnetApproved;

  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <MoneyCard className="p-5">
      <div className="app-krow" style={{ borderBottom: 0, paddingTop: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="app-kicon" src="/brand-kit-assets/icon-key.webp" alt="" />
        <div className="app-krow-body">
          <p className="app-krow-t">Your accounts</p>
          <p className="app-krow-s">
            {others.length > 0
              ? "Money, names and history are separate for each one."
              : "You can keep more than one on this phone — a personal one and a shared one, say."}
          </p>
        </div>
      </div>

      {/* The active account is always shown, so this never reads as an empty list. */}
      <div className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-line bg-paper px-3 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">This one</p>
          <p className="truncate font-mono text-xs text-ink-soft">{short(account.address)}</p>
        </div>
        <Check className="size-4 shrink-0 text-money" />
      </div>

      {others.map((a) => (
        <div key={a.address} className="mt-2 rounded-[14px] border border-line px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate font-mono text-xs text-ink-soft">{short(a.address)}</p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run(a.address, () => switchAccount(a.address))}
                className="rounded-full border border-line px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-40"
              >
                {busy === a.address ? "Switching…" : "Use this"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRemoving(removing === a.address ? null : a.address);
                  setTyped("");
                }}
                className="rounded-full px-2 py-1.5 text-sm text-ink-soft"
              >
                Remove
              </button>
            </div>
          </div>

          {removing === a.address && (
            <div className="mt-3 border-t border-line pt-3">
              {hasBackup(a.address) ? (
                <p className="text-sm text-ink-soft">
                  This one is backed up, so it comes back with your email and password. Remove it from
                  this phone?
                </p>
              ) : (
                <>
                  <p className="text-sm text-danger">
                    This account has no backup. Removing it ends your access to its money for good, and
                    nobody — including us — can undo it.
                  </p>
                  <label className="mt-2 block text-sm text-ink-soft">
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
              <button
                type="button"
                disabled={busy !== null || (!hasBackup(a.address) && typed.trim().toUpperCase() !== CONFIRM_WORD)}
                onClick={() =>
                  void run(a.address, async () => {
                    await forgetAccount(a.address);
                    setRemoving(null);
                  })
                }
                className="mt-3 rounded-[14px] border border-danger px-3 py-2 text-sm font-medium text-danger disabled:opacity-40"
              >
                Remove it from this phone
              </button>
            </div>
          )}
        </div>
      ))}

      <div className="mt-4 border-t border-line pt-4">
        <button
          type="button"
          disabled={busy !== null || atLimit || !canCreate}
          onClick={() =>
            void run("new", async () => {
              await createAccount();
              // A brand-new account has no name and no history — the same first minute a claimer
              // gets, offered in the same place rather than left for them to find.
              router.push("/welcome");
            })
          }
          className="rounded-full border border-line px-4 py-2.5 text-sm font-medium text-ink disabled:opacity-40"
        >
          {busy === "new" ? "Opening…" : "Add another account"}
        </button>
        <p className="mt-2 text-xs text-ink-soft">
          {atLimit
            ? `That is as many as one phone can hold (${MAX_USER_ACCOUNTS}).`
            : !canCreate
              ? "On real money, new accounts open once you are on the pilot list."
              : "It opens empty and unlocked — give it a password before you put money in it."}
        </p>
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </MoneyCard>
  );
}
