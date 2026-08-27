"use client";

/**
 * AccountMenu — the "you" corner of the nav (docs/IDENTITY_AND_ACCOUNTS.md §6).
 *
 * WHY IT EXISTS. The top row was carrying seven things at once: four places to go and three
 * controls, on a phone that has room for about five. So it did what a full row does — it cut the
 * last label in half, which on dark was the same as deleting it. The fix is not smaller text: it
 * is that half of what was in there is not navigation at all. Everything about the PERSON — who
 * you are, your settings, how this device is themed, and leaving it — belongs behind one control,
 * the way every product with an account does it.
 *
 * WHAT GOES IN AND WHAT STAYS OUT. In: identity, settings, appearance, and leaving this device.
 * Out: the notification bell (glanceable by definition — a badge inside a closed menu tells nobody
 * anything) and the life-buoy (one tap from every money surface, by owner directive; a menu makes
 * it two).
 *
 * LEAVING IS THE DANGEROUS ITEM, so it is last, styled as danger, and it does not act on the tap —
 * it opens the existing DisconnectButton, which keeps its own two-tier confirmation: one tap for a
 * backed-up account, a typed word for one whose keys exist only here.
 *
 * COST: nothing until it is used. The name is only looked up when the menu is first OPENED, so a
 * person who never touches it never pays a request for it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Copy, LogOut, Settings, User, Wallet } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { handleOf } from "../../lib/handles";
import { ensureCanReceive, type Receivable } from "../../lib/receivable";
import { hasBackup } from "../../lib/recovery-api";
import { markPublished } from "../../lib/keystore";
import { DisconnectButton } from "./DisconnectButton";
import { ThemeToggle } from "../site/ThemeToggle";

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function AccountMenu() {
  const { account, accounts, network, getSigner } = useWallet();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [receivable, setReceivable] = useState<Receivable | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setLeaving(false);
    triggerRef.current?.focus();
  }, []);

  // Escape closes; a click anywhere else closes. Deliberately NOT role="menu": that promises
  // arrow-key semantics this does not implement, and a plain popover of links and buttons is
  // already keyboard-operable with Tab.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);

  /* CAN THIS ADDRESS ACTUALLY BE PAID? Asked when the menu OPENS, which is the moment before it is
     copied and sent to somebody. On real money the account may not be on chain yet — and it cannot
     be put there without the account's own key, so a locked phone leaves an address that another
     wallet will answer with "the destination account doesn't exist". Better to say that here than
     to let it be found out by the person trying to pay. */
  useEffect(() => {
    if (!open || !account || network !== "public") return;
    let alive = true;
    void ensureCanReceive(account.address, getSigner).then((r) => alive && setReceivable(r));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account, network]);

  // The name is worth showing and not worth a request nobody asked for: fetched on first open.
  useEffect(() => {
    if (!open || asked || !account) return;
    setAsked(true);
    void handleOf(account.address)
      .then(setName)
      .catch(() => {
        /* an unreachable registry just means the address is shown instead */
      });
  }, [open, asked, account]);

  if (!account) return null;

  const others = accounts.filter((a) => a.kind === "user" && a.address !== account.address);
  const initial = name ? name[0]!.toUpperCase() : null;

  return (
    <div className="app-nav-you">
      <button
        ref={triggerRef}
        type="button"
        className="app-nav-avatar"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={name ? `You, @${name}` : "You"}
        onClick={() => setOpen((v) => !v)}
      >
        {initial ?? <User className="size-[17px]" aria-hidden="true" />}
      </button>

      {open && (
        <div ref={panelRef} className="app-menu" role="dialog" aria-label="Your account">
          {/* Who you are. The name if there is one, the address if there is not — never a
              placeholder that implies an account is unfinished when it is simply unnamed. */}
          {/* The address, one tap from every screen. It used to live only on /account, which is a
              navigation away from wherever somebody is when a person asks them "where do I send
              it?". Copying is also the moment the address becomes PUBLISHED — handed to somebody
              else — and /home's consolidation closes any account it may sweep, so this records it
              exactly as /account does. */}
          <button
            type="button"
            className="app-menu-id"
            onClick={async () => {
              void markPublished(account.address).catch(() => undefined);
              try {
                await navigator.clipboard.writeText(account.address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              } catch {
                /* clipboard blocked — the address is still on screen to read */
              }
            }}
            aria-label="Copy your address"
          >
            <span className="app-menu-id-row">
              <span className="app-menu-id-name">{name ? `@${name}` : "Your account"}</span>
              {copied ? <Check className="size-4 text-money" /> : <Copy className="size-4 opacity-50" />}
            </span>
            <span className="app-menu-id-sub">{copied ? "Copied" : short(account.address)}</span>
          </button>
          {/* THE ADDRESS IS THE SAME KEY ON EVERY CHAIN; THE ACCOUNT IS NOT. On practice money this
              account exists on the test network and nowhere else, so real dollars sent to it from an
              exchange or another wallet simply do not arrive — the sending wallet answers "the
              destination account doesn't exist" and flags the payment. Said here, at the one moment
              the address is being handed to somebody, rather than after the money has gone. */}
          {network !== "public" && (
            <p className="app-menu-row-s" style={{ margin: "2px 12px 6px" }}>
              Practice address — real dollars sent here won&apos;t arrive.
            </p>
          )}
          {/* On real money the blocker is not the chain, it is the key: opening the account needs
              the account's own signature. Say which errand it is — a Phase-1 account has no
              password yet and must set one, a Phase-2 account only has to unlock. */}
          {network === "public" && receivable?.state === "locked" && (
            <Link
              href={account.phase === 1 ? "/account" : `/unlock?next=${encodeURIComponent("/account")}`}
              className="app-menu-row"
              onClick={close}
            >
              <span className="app-menu-row-t">
                {account.phase === 1 ? "Set a password to finish" : "Unlock to finish setting up"}
                <span className="app-menu-row-s">
                  Until then, money sent to this address won&apos;t arrive.
                </span>
              </span>
              <ChevronRight className="size-4 opacity-40" aria-hidden="true" />
            </Link>
          )}

          {others.length > 0 && (
            <Link href="/settings" className="app-menu-row" onClick={close}>
              <Wallet className="size-4" aria-hidden="true" />
              <span className="app-menu-row-t">
                Switch account
                <span className="app-menu-row-s">{others.length + 1} on this phone</span>
              </span>
              <ChevronRight className="size-4 opacity-40" aria-hidden="true" />
            </Link>
          )}

          <Link href="/account" className="app-menu-row" onClick={close}>
            <Wallet className="size-4" aria-hidden="true" />
            <span className="app-menu-row-t">
              Your money
              <span className="app-menu-row-s">Balance, backup, real money</span>
            </span>
            <ChevronRight className="size-4 opacity-40" aria-hidden="true" />
          </Link>

          <Link href="/settings" className="app-menu-row" onClick={close}>
            <Settings className="size-4" aria-hidden="true" />
            <span className="app-menu-row-t">
              Settings
              <span className="app-menu-row-s">Your name and ways back in</span>
            </span>
            <ChevronRight className="size-4 opacity-40" aria-hidden="true" />
          </Link>

          {/* Appearance is a device setting, and this is the device menu — which is also where the
              theme switch belongs now that it is not competing for room in the nav row itself. */}
          <div className="app-menu-row app-menu-row-static">
            <span className="app-menu-row-t">
              Appearance
              <span className="app-menu-row-s">Follows your phone by default</span>
            </span>
            <ThemeToggle />
          </div>

          <div className="app-menu-danger">
            {leaving ? (
              <>
                <p className="app-menu-row-s" style={{ marginBottom: 6 }}>
                  This removes your keys from this phone. Your money stays on the public record.
                </p>
                <DisconnectButton backedUp={hasBackup(account.address)} />
              </>
            ) : (
              <button type="button" className="app-menu-row app-menu-row-btn" onClick={() => setLeaving(true)}>
                <LogOut className="size-4" aria-hidden="true" />
                <span className="app-menu-row-t">Leave this device</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
