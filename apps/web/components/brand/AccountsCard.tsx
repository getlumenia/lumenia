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
 * EACH ACCOUNT IS NAMED THE SAME WAY EVERYWHERE: its short address and the email that backs it up
 * (lib/account-label.ts), with its OWN balance. The money screens add up only the account in use
 * (lib/accounts-total.ts), so another account's dollars are shown here, where they belong.
 *
 * BRINGING ONE IN. "Bring another account here" restores a backed-up account BESIDE this one (email,
 * code, password), without wiping anything and without switching: the person chooses "Use it now".
 *
 * Removing an account is the dangerous action on this screen, so it is typed unless the server has
 * confirmed that account's backup is tied to it: with that backup the money comes back, without one
 * it does not come back at all.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { backupRecord, backupRecords } from "../../lib/backup-record";
import { disconnectTier } from "../../lib/leave-device";
import { accountLine, shortAddress } from "../../lib/account-label";
import { loadTotalUsd } from "../../lib/horizon";
import { formatUsd } from "../../lib/money";
import { MoneyCard } from "./MoneyCard";
import { RecoveryFlow } from "./RecoveryFlow";
import { MAX_USER_ACCOUNTS } from "../../lib/new-account";

const CONFIRM_WORD = "REMOVE";

export function AccountsCard() {
  const router = useRouter();
  const { account, accounts, switchAccount, createAccount, forgetAccount, network, mainnetApproved } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [bringing, setBringing] = useState(false);
  /** Each deliberate account's own balance; a missing entry is "not read yet", never zero. */
  const [balances, setBalances] = useState<Record<string, string>>({});

  const mine = accounts.filter((a) => a.kind === "user");
  const mineKey = mine.map((a) => a.address).join(",");
  useEffect(() => {
    const addresses = mineKey ? mineKey.split(",") : [];
    if (addresses.length < 2) return;
    let alive = true;
    void loadTotalUsd(addresses)
      .then((t) => {
        if (alive) setBalances(Object.fromEntries(t.perAccount.map((p) => [p.address, p.usd])));
      })
      .catch(() => {
        /* unread is not zero: the rows simply show no number */
      });
    return () => {
      alive = false;
    };
  }, [mineKey, network]);

  if (!account) return null;

  // Only deliberate accounts. See the note above on why throwaways never appear.
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

  const balanceOf = (address: string) => (balances[address] !== undefined ? formatUsd(balances[address]!) : null);

  return (
    <MoneyCard className="p-5">
      <div className="app-krow" style={{ borderBottom: 0, paddingTop: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="app-kicon" src="/brand-kit-assets/icon-key.webp" alt="" />
        <div className="app-krow-body">
          <p className="app-krow-t">Your accounts</p>
          <p className="app-krow-s app-krow-s--prose">
            {others.length > 0
              ? "Money, names and history are separate for each one."
              : "You can keep more than one on this phone — a personal one and a shared one, say."}
          </p>
        </div>
      </div>

      {/* The active account is always shown, so this never reads as an empty list. */}
      <div className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-line bg-paper px-3 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            This one{others.length > 0 && balanceOf(account.address) ? `, ${balanceOf(account.address)}` : ""}
          </p>
          <p className="truncate font-mono text-xs text-ink-soft">{accountLine(account.address, backupRecord(account.address)).text}</p>
        </div>
        <Check className="size-4 shrink-0 text-money" />
      </div>

      {others.map((a) => {
        // The same rule as leaving the device (lib/leave-device.ts), for this one account.
        const confirmed = disconnectTier({ userAccounts: [a.address], records: backupRecords(), throwawayWithMoney: false }) === "one-tap";
        return (
          <div key={a.address} className="mt-2 rounded-[14px] border border-line px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-ink-soft">{accountLine(a.address, backupRecord(a.address)).text}</p>
                {balanceOf(a.address) && <p className="text-xs text-ink-soft">{balanceOf(a.address)}</p>}
              </div>
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
                {/* The same rule as leaving the device (lib/leave-device.ts), for one account: one tap
                    only for a backup the server confirmed is tied to it. */}
                {confirmed ? (
                  <p className="text-sm text-ink-soft">
                    This one ({shortAddress(a.address)}) is backed up, so it comes back with its email and
                    password. Remove it from this phone?
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-danger">
                      This account ({shortAddress(a.address)}) has no confirmed backup. Removing it ends your
                      access to its money for good, and nobody, including us, can undo it.
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
                  disabled={busy !== null || (!confirmed && typed.trim().toUpperCase() !== CONFIRM_WORD)}
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
        );
      })}

      <div className="mt-4 border-t border-line pt-4">
        {network === "public" && canCreate && !atLimit && (
          <p className="mb-2 text-xs text-ink-soft">The new account asks to join real money on its own.</p>
        )}
        <div className="flex flex-wrap gap-2">
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
          <button
            type="button"
            disabled={busy !== null || atLimit}
            onClick={() => setBringing((v) => !v)}
            aria-expanded={bringing}
            className="rounded-full border border-line px-4 py-2.5 text-sm font-medium text-ink disabled:opacity-40"
          >
            Bring another account here
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-soft">
          {atLimit
            ? `That is as many as one phone can hold (${MAX_USER_ACCOUNTS}).`
            : !canCreate
              ? "On real money, only an approved account can open another one, and the new one asks to join real money on its own."
              : "It opens empty and unlocked — give it a password before you put money in it."}
        </p>
        {bringing && !atLimit && (
          <div className="mt-3 border-t border-line pt-3">
            <p className="mb-3 text-sm text-ink-soft">
              An account you backed up somewhere else, with its email and password. It joins this one; nothing
              here is removed.
            </p>
            <RecoveryFlow mode="add" onDone={() => setBringing(false)} />
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </MoneyCard>
  );
}
