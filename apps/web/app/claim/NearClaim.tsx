"use client";

/**
 * The claim screen of a practice link, value-first: the money is shown before any choice is asked.
 * The link's secret is read from the #fragment in the browser, taken out of the address bar at once
 * (the v2 route's posture: the address bar, the history and any screenshot of either stop carrying
 * the money), and kept in memory for this visit only. Nothing moves until the person chooses where
 * it goes.
 *
 * ONE PRIMARY BUTTON. The dollars, then "Create my account and claim": a NEW named account
 * (yourname.testnet), made by the escrow at the claim, with a plain address (an implicit account)
 * as the fallback behind "use an address instead". The other two ways sit collapsed under it:
 *   - an account they already have;
 *   - another network through NEAR Intents: a live dry quote for USDC on Stellar or Base, and
 *     nothing more, because Intents has no testnet and the card says so.
 *
 * ONE PRODUCT. No heading, button or lead names the network. It appears in the Details disclosures
 * (date, status, amount, network fee, Network, explorer), the one consumer place that may say it,
 * and the practice band under the wordmark says what kind of money this is on every beat.
 *
 * KEYS BEFORE MONEY. A new account's key pair is made here and kept in the encrypted store
 * (lib/near/store.ts) BEFORE the claim is sent, and a browser that cannot keep a key is told so and
 * offered only the existing-account path: a claim whose key is lost on reload pays money to nobody.
 *
 * The claim transaction is signed by the LINK key, with the escrow as both signer and receiver:
 * the escrow holds the link key as a function-call key and pays the fee, so the recipient pays no gas.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { KeyPair, type KeyPairString } from "near-api-js";
import { Mascot } from "../../components/brand/Mascot";
import { MoneyCard } from "../../components/brand/MoneyCard";
import { PrimaryButton } from "../../components/brand/PrimaryButton";
import { CopyButton, Details, ExplorerLink, Field, Notice, PracticeBand, SmallButton, Spinner, StateLine, downloadText, escrowExplorer, escrowRows } from "../../components/near/primitives";
import { useInterval, useLoadable, useNow } from "../../lib/near/hooks";
import { NEAR_CONTRACT_ID, NEAR_DEMO_FUNDER_ID, NEAR_IS_TESTNET, NEAR_NETWORK, explorerAccountUrl, explorerTxUrl } from "../../lib/near/config";
import { formatNear, formatUsd } from "../../lib/near/amount";
import { isImplicitAccountId, isValidAccountId } from "../../lib/near/account-id";
import { NAME_RULES, availabilityFromLookup, checkName, type Availability } from "../../lib/near/names";
import { encryptWithPassword } from "../../lib/near/crypto";
import { isTerminal, type DropView } from "../../lib/near/drops";
import { describeError } from "../../lib/near/errors";
import { formatLocal, formatRemaining, isExpired, nsToMs, toIso } from "../../lib/near/expiry";
import {
  DESTINATIONS,
  buildQuoteRequest,
  describeTimeEstimate,
  isDestinationAddress,
  requestQuote,
  type Destination,
  type QuoteResult,
} from "../../lib/near/intents";
import { decodeLinkFragment, implicitAccountId, publicKeyOf, secretFromPastedLink } from "../../lib/near/keys";
import { accountExists, getConfig, getDrop, usdcBalance } from "../../lib/near/rpc";
import { sendFunctionCall } from "../../lib/near/chain";
import { chainResult, receiptFailure, txFailure } from "../../lib/near/outcome";
import { accountKey, claimForDrop, saveClaim, secretStoreReady, upsertClaim, type ClaimedAccount } from "../../lib/near/store";
import { PayForwardCard } from "./NearPayForward";

/**
 * The claim button's label never changes and never names an account or a network: "Create my account
 * and claim $1.00". One line at 375 px (the padding narrows and the size steps down a notch on a phone);
 * a long amount on a narrower screen wraps into two even lines instead of spilling out of the pill.
 */
const CLAIM_CTA = "h-auto min-h-14 px-4 py-2 text-[15px] leading-tight whitespace-normal text-balance sm:px-8 sm:text-base";
const claimLabel = (amount: string) => `Create my account and claim ${amount}`;

type ClaimState =
  | { kind: "idle" }
  | { kind: "submitting"; target: string; txHash?: string; step: string }
  | { kind: "confirming"; target: string; txHash: string; since: number }
  | { kind: "done"; target: string; txHash?: string }
  | { kind: "failed"; target: string; txHash?: string; message: string };

const CONFIRM_PATIENCE_MS = 30_000;

/** The wordmark, and under it the practice band: on every beat, so the kind of money is never in doubt. */
function Wordmark() {
  return (
    <>
      <header className="nc-top">
        <Link href="/" aria-label="Lumenia home">
          {/* The light wordmark: this route is light-only, like the v2 claim. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-kit-assets/logo-wordmark-t.svg" alt="" />
        </Link>
      </header>
      <PracticeBand className="nc-band" />
    </>
  );
}

export function NearClaim() {
  /** undefined: not read yet (the server render); null: no usable fragment. */
  const [secret, setSecret] = useState<KeyPairString | null | undefined>(undefined);
  /* Read ONCE. The read strips the fragment, so a second run of this effect (React's development
     double-invoke, a fast refresh) would find an empty hash and show the paste form over a link
     that was perfectly good. The ref outlives both runs. */
  const read = useRef(false);
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const s = decodeLinkFragment(window.location.hash);
    setSecret(s);
    // The secret is the money: out of the address bar and the history the moment it is read.
    if (s) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, []);

  if (secret === undefined) {
    return (
      <>
        <Wordmark />
        <div className="nc-main">
          <p className="nc-eyebrow">
            <Spinner /> Opening your link...
          </p>
        </div>
      </>
    );
  }
  if (!secret) return <PasteLink onOpen={setSecret} />;
  return <Claim key={secret} secret={secret} />;
}

function PasteLink({ onOpen }: { onOpen: (s: KeyPairString) => void }) {
  const [pasted, setPasted] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const open = (e: FormEvent) => {
    e.preventDefault();
    const s = secretFromPastedLink(pasted);
    if (!s) {
      setErr("That does not look like a Lumenia link. A link made with practice money ends with #ed25519: followed by a long code.");
      return;
    }
    onOpen(s);
  };
  return (
    <>
      <Wordmark />
      <div className="nc-main">
        <Mascot pose="wave" size="md" />
        <h1 className="nc-title">Got a link?</h1>
        <p className="nc-lead">
          A Lumenia link made with practice money ends with <b>#ed25519:</b> and a long code. If you opened one and landed
          here, that part was lost on the way; ask the sender to share it again, or paste the whole link below.
        </p>
        <form onSubmit={open} className="nc-stack nc-card">
          <Field label="Paste the link you received" htmlFor="nc-paste">
            <input
              id="nc-paste"
              className="nr-input nr-input--mono"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="https://getlumenia.com/claim#ed25519:..."
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </Field>
          {err ? <Notice kind="error">{err}</Notice> : null}
          <PrimaryButton type="submit">Open my link</PrimaryButton>
        </form>
        <p className="nc-foot">
          The link&apos;s key stays in your browser; it never reaches a server. <Link href="/">What is Lumenia?</Link>
        </p>
      </div>
    </>
  );
}

function Claim({ secret }: { secret: KeyPairString }) {
  const dropKey = useMemo(() => publicKeyOf(secret), [secret]);
  const [drop, setDrop] = useState<DropView | null | undefined>(undefined);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimState>({ kind: "idle" });
  const [mine, setMine] = useState<ClaimedAccount | undefined>(undefined);
  const [canKeep, setCanKeep] = useState<boolean | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    setMine(claimForDrop(dropKey));
    void secretStoreReady().then(setCanKeep);
  }, [dropKey]);

  const load = useCallback(async (): Promise<DropView | null | undefined> => {
    try {
      const d = await getDrop(dropKey);
      setDrop(d);
      setLoadErr(null);
      return d;
    } catch (e) {
      setLoadErr(describeError(e));
      return undefined;
    }
  }, [dropKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = claim.kind === "submitting" || claim.kind === "confirming";
  const polling = (drop !== undefined && drop !== null && !isTerminal(drop.status)) || claim.kind === "confirming";
  useInterval(() => void load(), polling ? (claim.kind === "confirming" ? 2000 : 5000) : null);

  // The chain is the source of truth: a Claimed drop that names our target ends the flow.
  useEffect(() => {
    if (!drop || drop.status !== "Claimed") return;
    if (claim.kind === "submitting" || claim.kind === "confirming" || claim.kind === "failed") {
      if (drop.claimed_to === claim.target) {
        setClaim({ kind: "done", target: claim.target, txHash: claim.txHash });
        if (mine && mine.accountId === claim.target && !mine.claimedAt) {
          upsertClaim({ accountId: mine.accountId, claimedAt: toIso(Date.now()) });
          setMine(claimForDrop(dropKey));
        }
      }
    }
  }, [drop, claim, mine, dropKey]);

  // A new beat moves focus to its heading, so a screen reader announces it.
  const heading = useRef<HTMLHeadingElement>(null);
  const beat = drop === undefined ? "loading" : drop === null ? "none" : claim.kind === "done" ? "done" : claim.kind;
  const shownBeat = useRef(beat);
  useEffect(() => {
    if (shownBeat.current === beat) return;
    shownBeat.current = beat;
    heading.current?.focus();
  }, [beat]);

  const submitClaim = async (method: "claim" | "claim_to_new_account", args: Record<string, unknown>, target: string) => {
    setClaim({ kind: "submitting", target, step: "Signing with the link key" });
    try {
      const sent = await sendFunctionCall({
        signerId: NEAR_CONTRACT_ID,
        secretKey: secret,
        receiverId: NEAR_CONTRACT_ID,
        methodName: method,
        args,
        gasTgas: 100,
        depositYocto: 0n,
        onSigned: (h) => {
          setClaim({ kind: "submitting", target, txHash: h, step: "Waiting for the network" });
          if (claimForDrop(dropKey)?.accountId === target) upsertClaim({ accountId: target, claimTxHash: h });
        },
      });
      const failure = txFailure(sent.outcome);
      if (failure) {
        setClaim({ kind: "failed", target, txHash: sent.txHash, message: failure });
        void load();
        return;
      }
      const chain = chainResult(sent.outcome);
      if (chain && !chain.ok) {
        const inner = receiptFailure(sent.outcome);
        setClaim({
          kind: "failed",
          target,
          txHash: sent.txHash,
          message:
            `the escrow put the money back (${chain.reason ?? "the recipient account could not be prepared"})` +
            (inner ? `; detail: ${inner}` : "") +
            ". Nothing was lost; you can try again.",
        });
        void load();
        return;
      }
      const d = await load();
      if (d?.status === "Claimed" && d.claimed_to === target) {
        setClaim({ kind: "done", target, txHash: sent.txHash });
      } else {
        setClaim({ kind: "confirming", target, txHash: sent.txHash, since: Date.now() });
      }
    } catch (e) {
      setClaim((prev) => ({
        kind: "failed",
        target,
        txHash: prev.kind === "submitting" ? prev.txHash : undefined,
        message: describeError(e),
      }));
      void load();
    }
  };

  /** The recipient's own implicit account for this link: made once in this browser, kept before use. */
  const ensureRecipientAccount = async (): Promise<ClaimedAccount> => {
    if (mine && mine.kind === "implicit") return mine;
    const kp = KeyPair.fromRandom("ed25519");
    const publicKey = kp.getPublicKey().toString();
    const account: ClaimedAccount = {
      accountId: implicitAccountId(publicKey),
      publicKey,
      dropPublicKey: dropKey,
      kind: "implicit",
      createdAt: toIso(Date.now()),
    };
    // Kept before anything is sent, so a reload after a crash still finds the key.
    const kept = await saveClaim(account, kp.toString());
    if (!kept) throw new Error("This browser cannot keep a key safe (its storage is blocked), so a new account cannot be made here.");
    setMine(account);
    return account;
  };

  const createNewAccount = async () => {
    try {
      const account = await ensureRecipientAccount();
      await submitClaim("claim", { account_id: account.accountId }, account.accountId);
    } catch (e) {
      setClaim({ kind: "failed", target: "a new address", message: describeError(e) });
    }
  };

  const claimToExisting = async (id: string) => {
    await submitClaim("claim", { account_id: id }, id);
  };

  const createNamedAccount = async (id: string) => {
    const kp = KeyPair.fromRandom("ed25519");
    const publicKey = kp.getPublicKey().toString();
    const account: ClaimedAccount = { accountId: id, publicKey, dropPublicKey: dropKey, kind: "named", createdAt: toIso(Date.now()) };
    const kept = await saveClaim(account, kp.toString());
    if (!kept) {
      setClaim({ kind: "failed", target: id, message: "This browser cannot keep a key safe (its storage is blocked), so a new account cannot be made here. Send the money to an account you already have instead." });
      return;
    }
    setMine(account);
    await submitClaim("claim_to_new_account", { new_account_id: id, new_public_key: publicKey }, id);
  };

  // ---- render --------------------------------------------------------------------------------

  if (drop === undefined) {
    return (
      <>
        <Wordmark />
        <div className="nc-main">
          {loadErr ? (
            <>
              <h1 ref={heading} tabIndex={-1} className="nc-title">
                We couldn&apos;t read this link.
              </h1>
              <div className="nc-card">
                <Notice kind="error" onRetry={() => void load()}>
                  {loadErr}
                </Notice>
              </div>
              <p className="nc-foot">The money, if any, is untouched. Nothing is sent until you choose where it should go.</p>
            </>
          ) : (
            <p className="nc-eyebrow">
              <Spinner /> Checking the link...
            </p>
          )}
        </div>
      </>
    );
  }

  if (drop === null) {
    return (
      <>
        <Wordmark />
        <div className="nc-main">
          <Mascot pose="phone" size="md" />
          <h1 ref={heading} tabIndex={-1} className="nc-title">
            Nothing is waiting behind this link.
          </h1>
          <p className="nc-lead">
            The escrow has no record of it. Either it was never funded, it was made for a different network, or the link was
            copied incompletely. Ask the sender to share it again.
          </p>
          <p className="nc-foot nc-mono">Link key: {dropKey}</p>
          <SmallButton onClick={() => void load()}>Check again</SmallButton>
          <Details rows={[["Status", "no record"], ...escrowRows()]} explorer={escrowExplorer()} />
        </div>
      </>
    );
  }

  const amount = formatUsd(drop.amount);
  const expiresAt = nsToMs(drop.expires_at_ns);
  const expired = isExpired(expiresAt, now);

  if (claim.kind === "done" || (drop.status === "Claimed" && mine && drop.claimed_to === mine.accountId)) {
    const target = claim.kind === "done" ? claim.target : (drop.claimed_to as string);
    const txHash = claim.kind === "done" ? claim.txHash : mine?.claimTxHash;
    const own = mine && mine.accountId === target ? mine : undefined;
    const claimedAt = drop.status_changed_at_ns ? nsToMs(drop.status_changed_at_ns) : undefined;
    return <Done amount={amount} target={target} txHash={txHash} account={own} claimedAt={claimedAt} heading={heading} />;
  }

  if (drop.status === "Claimed") {
    return (
      <>
        <Wordmark />
        <div className="nc-main">
          <StateLine state="claimed" />
          <h1 ref={heading} tabIndex={-1} className="nc-title">
            This link was already used.
          </h1>
          <p className="nc-lead">
            The {amount} went to <span className="nc-mono">{drop.claimed_to}</span>
            {drop.memo ? ` (memo: ${drop.memo})` : ""}. If that was not you, the link was opened by someone else first.
          </p>
          <Details
            rows={[
              drop.status_changed_at_ns ? ["Claimed", formatLocal(nsToMs(drop.status_changed_at_ns))] : null,
              ["Status", "Claimed"],
              ["Amount", amount],
              drop.claimed_to ? ["Claimed by", <span key="to" className="nc-mono">{drop.claimed_to}</span>] : null,
              ["Network fee", "covered by Lumenia"],
            ]}
            explorer={drop.claimed_to ? [["View the account on explorer", explorerAccountUrl(drop.claimed_to)]] : undefined}
          />
        </div>
      </>
    );
  }

  if (drop.status === "Reclaimed") {
    return (
      <>
        <Wordmark />
        <div className="nc-main">
          <StateLine state="returned" />
          <h1 ref={heading} tabIndex={-1} className="nc-title">
            The sender took this money back.
          </h1>
          <p className="nc-lead">
            This link for {amount} expired on {formatLocal(expiresAt)} and the sender reclaimed it. Ask them for a new link.
          </p>
        </div>
      </>
    );
  }

  if (claim.kind === "submitting" || claim.kind === "confirming") {
    const waited = claim.kind === "confirming" ? now - claim.since : 0;
    return (
      <>
        <Wordmark />
        <div className="nc-main">
          <p className="nc-amount">{amount}</p>
          <h1 ref={heading} tabIndex={-1} className="nc-title">
            <Spinner /> Moving your money
          </h1>
          <p className="nc-lead">
            {claim.kind === "submitting"
              ? `${claim.step}...`
              : waited < CONFIRM_PATIENCE_MS
                ? `The transaction is in. Waiting for the escrow to finish (${Math.round(waited / 1000)} s)...`
                : "This is taking longer than usual. The transaction is on chain and the escrow still shows the claim in progress. Keep this page open, or come back to this link in a minute."}
          </p>
          <p className="nc-foot nc-mono">to {claim.target}</p>
          {claim.txHash ? <ExplorerLink href={explorerTxUrl(claim.txHash)}>View on explorer</ExplorerLink> : null}
        </div>
      </>
    );
  }

  if (drop.status === "Claiming" && claim.kind === "idle") {
    return (
      <>
        <Wordmark />
        <div className="nc-main">
          <p className="nc-amount">{amount}</p>
          <h1 ref={heading} tabIndex={-1} className="nc-title">
            <Spinner /> This link is being claimed right now.
          </h1>
          <p className="nc-lead">A claim is in progress. If it was you on another device, wait a moment; this page updates on its own.</p>
        </div>
      </>
    );
  }

  if (expired) {
    return (
      <>
        <Wordmark />
        <div className="nc-main">
          <StateLine state="expired" />
          <h1 ref={heading} tabIndex={-1} className="nc-title">
            This link has expired.
          </h1>
          <p className="nc-lead">
            {amount} was waiting here until {formatLocal(expiresAt)}. The sender can take it back now; ask them for a new link.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <Wordmark />
      <div className="nc-main">
        <Mascot pose="wave" size="md" alt="The Lumenia messenger, waving" />
        <p className="nc-eyebrow">Someone sent you</p>
        <p className="nc-amount">{amount}</p>
        <h1 ref={heading} tabIndex={-1} className="nc-title">
          It&apos;s waiting for you.
        </h1>
        {drop.memo ? <p className="nc-memo">{drop.memo}</p> : null}
        <p className="nc-lead">
          In dollars. Claim it within <b>{formatRemaining(expiresAt - now)}</b>. No wallet, no app. Network fee: covered by
          Lumenia.
        </p>
        {claim.kind === "failed" ? (
          <div className="nc-card">
            <Notice kind="error">
              The claim did not go through: {claim.message}
              {claim.txHash ? (
                <div className="mt-2">
                  <ExplorerLink href={explorerTxUrl(claim.txHash)}>View on explorer</ExplorerLink>
                </div>
              ) : null}
            </Notice>
          </div>
        ) : null}
        <Choices
          drop={drop}
          mine={mine}
          busy={busy}
          canKeep={canKeep}
          onNew={() => void createNewAccount()}
          onExisting={(id) => void claimToExisting(id)}
          onNamed={(id) => void createNamedAccount(id)}
          refundAccount={async () => (await ensureRecipientAccount()).accountId}
        />
        <p className="nc-foot">
          {/* A practice link is funded by the sponsor's own account: say what it is, not its technical name (that is in Details). */}
          {NEAR_DEMO_FUNDER_ID && drop.funder === NEAR_DEMO_FUNDER_ID ? (
            <>Sent from the shared practice balance.</>
          ) : (
            <>
              Sent by <span className="nc-mono">{drop.funder}</span>.
            </>
          )}{" "}
          Nothing moves until you choose. The link&apos;s key stays in your browser; it never reaches a server.
        </p>
        <Details
          rows={[
            ["Sent", formatLocal(nsToMs(drop.created_at_ns))],
            ["Expires", formatLocal(expiresAt)],
            ["Status", "Waiting for you"],
            ["Amount", amount],
            ["Network fee", "covered by Lumenia"],
            ["Sent by", <span key="from" className="nc-mono">{drop.funder}</span>],
            ...escrowRows(),
          ]}
          explorer={escrowExplorer()}
        />
      </div>
    </>
  );
}

function Choices({
  drop,
  mine,
  busy,
  canKeep,
  onNew,
  onExisting,
  onNamed,
  refundAccount,
}: {
  drop: DropView;
  mine: ClaimedAccount | undefined;
  busy: boolean;
  /** null while the store is being asked; false when this browser cannot keep a key. */
  canKeep: boolean | null;
  onNew: () => void;
  onExisting: (id: string) => void;
  onNamed: (id: string) => void;
  refundAccount: () => Promise<string>;
}) {
  // Named accounts are the default; "use an address instead" falls back to the implicit path.
  const [useName, setUseName] = useState(true);
  const amount = formatUsd(drop.amount);
  const cannotKeep = canKeep === false;
  return (
    <MoneyCard className="nc-card flex flex-col gap-4 p-4 sm:p-5">
      {cannotKeep ? (
        <Notice kind="warn">
          This browser cannot keep a key safe (its storage is blocked, as in some private windows and in-app browsers), so a new
          account cannot be made here. Open the link in your regular browser, or send the money to an account you already have.
        </Notice>
      ) : (
        <>
          <h2 className="text-base font-semibold text-ink">Create my account</h2>
          {useName ? (
            <NamedForm busy={busy || canKeep === null} amount={amount} onSubmit={onNamed} onSkip={() => setUseName(false)} />
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink-soft">
                One tap makes an account that is yours alone (a 64-character address) and puts the money in it. The key is made in
                this browser; you save it right after.
                {mine?.kind === "implicit" ? ` This browser already prepared an address (${mine.accountId.slice(0, 8)}...); the same one will be used.` : ""}
              </p>
              <PrimaryButton className={CLAIM_CTA} onClick={onNew} loading={busy || canKeep === null} loadingLabel="One moment...">
                {claimLabel(amount)}
              </PrimaryButton>
              <button type="button" className="nr-link self-start" onClick={() => setUseName(true)}>
                Prefer a name? Pick one instead
              </button>
            </div>
          )}
        </>
      )}
      {/* The other ways to take it, collapsed: the first-timer meets one button, not a menu. */}
      <div className="nc-more">
        <details className="nc-option" open={cannotKeep || undefined}>
          <summary>Send it to an account I already have</summary>
          <div className="nc-option-body">
            <ExistingForm busy={busy} amount={amount} onSubmit={onExisting} />
          </div>
        </details>
        <details className="nc-option">
          <summary>Another network</summary>
          <div className="nc-option-body">
            <OtherChain amountUnits={drop.amount} refundAccount={refundAccount} />
          </div>
        </details>
      </div>
    </MoneyCard>
  );
}

function ExistingForm({ busy, amount, onSubmit }: { busy: boolean; amount: string; onSubmit: (id: string) => void }) {
  const [id, setId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const v = id.trim().toLowerCase();
    if (!isValidAccountId(v)) {
      setErr("That is not a valid account id (like alice.testnet or a 64-character address).");
      return;
    }
    setChecking(true);
    try {
      const exists = await accountExists(v);
      if (!exists && !isImplicitAccountId(v)) {
        setErr(`${v} does not exist on this network. Check the spelling, or create a new account instead.`);
        return;
      }
      onSubmit(v);
    } catch (e2) {
      setErr(describeError(e2));
    } finally {
      setChecking(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <Field label="Your account id" htmlFor="nc-existing" hint="An account that already exists on this network. The money is sent straight to it.">
        <input id="nc-existing" className="nr-input" value={id} onChange={(e) => setId(e.target.value)} placeholder="alice.testnet" autoComplete="off" autoCapitalize="none" spellCheck={false} />
      </Field>
      {err ? <Notice kind="error">{err}</Notice> : null}
      <PrimaryButton type="submit" loading={busy || checking} loadingLabel={checking ? "Checking the account..." : "One moment..."}>
        Send {amount} to this account
      </PrimaryButton>
    </form>
  );
}

type NameStatus =
  | { kind: "idle" }
  | { kind: "invalid"; reason: string }
  | { kind: "checking"; accountId: string }
  | { kind: "checked"; accountId: string; availability: Availability; message?: string };

/** Live availability: view_account on <name>.<root>; UnknownAccount means free, anything else is shown. */
function useNameAvailability(name: string, root: string | null): [NameStatus, () => void] {
  const [status, setStatus] = useState<NameStatus>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (root === null) return;
    if (name.trim() === "") {
      setStatus({ kind: "idle" });
      return;
    }
    const check = checkName(name, root);
    if (!check.ok) {
      setStatus({ kind: "invalid", reason: check.reason });
      return;
    }
    let alive = true;
    setStatus({ kind: "checking", accountId: check.accountId });
    const timer = setTimeout(() => {
      accountExists(check.accountId)
        .then((exists) => alive && setStatus({ kind: "checked", accountId: check.accountId, availability: availabilityFromLookup({ exists }) }))
        .catch((e: unknown) => {
          if (!alive) return;
          const message = describeError(e);
          setStatus({ kind: "checked", accountId: check.accountId, availability: availabilityFromLookup({ error: message }), message });
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [name, root, attempt]);
  return [status, () => setAttempt((a) => a + 1)];
}

function NamedForm({ busy, amount, onSubmit, onSkip }: { busy: boolean; amount: string; onSubmit: (id: string) => void; onSkip: () => void }) {
  const [name, setName] = useState("");
  const config = useLoadable(() => getConfig(), []);
  const root = config.value.state === "ready" ? config.value.value.root_account_id : null;
  const [status, recheck] = useNameAvailability(name, root);
  const free = status.kind === "checked" && status.availability === "free";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (free) onSubmit(status.accountId);
  };
  const tone = status.kind === "checked" && status.availability === "free" ? "ok" : status.kind === "invalid" || (status.kind === "checked" && status.availability !== "free") ? "bad" : undefined;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">Pick a name for your new account. The money lands in it and the key stays with you.</p>
      {/* The address is said ONCE, quietly, under the field: never in the button, never in the status line. */}
      <Field
        label="Your name"
        htmlFor="nc-name"
        hint={
          <span className="nc-address">
            Your account address:{" "}
            <span className="nc-mono">
              {name.trim().toLowerCase() || "yourname"}.{root ?? NEAR_NETWORK}
            </span>
          </span>
        }
      >
        <div className="nr-suffix">
          <input
            id="nc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="yourname"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="nc-name-availability"
          />
          <span>.{root ?? NEAR_NETWORK}</span>
        </div>
      </Field>
      <div id="nc-name-availability" className="nc-availability" data-tone={tone} aria-live="polite">
        {config.value.state === "error" ? (
          <span className="text-danger">
            Could not read the escrow&apos;s settings: {config.value.message}{" "}
            <button type="button" className="nr-link" onClick={config.reload}>
              retry
            </button>
          </span>
        ) : status.kind === "invalid" ? (
          status.reason
        ) : status.kind === "checking" ? (
          <>
            <Spinner /> Checking the name...
          </>
        ) : status.kind === "checked" && status.availability === "free" ? (
          "That name is free"
        ) : status.kind === "checked" && status.availability === "taken" ? (
          "That name is already taken, try another"
        ) : status.kind === "checked" ? (
          <>
            Could not check the name: {status.message}{" "}
            <button type="button" className="nr-link" onClick={recheck}>
              retry
            </button>
          </>
        ) : (
          `${NAME_RULES}. We check whether it is free as you type.`
        )}
      </div>
      <PrimaryButton className={CLAIM_CTA} type="submit" loading={busy} loadingLabel="One moment..." disabled={!free}>
        {claimLabel(amount)}
      </PrimaryButton>
      <button type="button" className="nr-link nr-link--quiet self-start" onClick={onSkip}>
        Skip the name, use an address instead
      </button>
    </form>
  );
}

function OtherChain({ amountUnits, refundAccount }: { amountUnits: string; refundAccount: () => Promise<string> }) {
  const [destination, setDestination] = useState<Destination>("stellar");
  const [address, setAddress] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuoteResult | null>(null);
  const dest = DESTINATIONS[destination];

  const getQuote = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setResult(null);
    if (!isDestinationAddress(destination, address)) {
      setErr(dest.hint);
      return;
    }
    setBusy(true);
    try {
      // 1Click wants a NEAR account it can refund to; it refuses named testnet accounts, so the
      // recipient's own implicit account (key held in this browser) is used.
      const refundTo = await refundAccount();
      const body = buildQuoteRequest({ destination, amountUnits, recipient: address, refundTo, nowMs: Date.now(), dry: true });
      setResult(await requestQuote(body));
    } catch (e2) {
      setErr(describeError(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void getQuote(e)} className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">
        <span className="nc-pill">real money only</span> The money can be delivered to another network instead. There is no practice
        version of this service, so here you see a real quote and nothing is sent. With real money the claim would pay the quote&apos;s
        deposit address and the money would be delivered to your address; if that failed, it would be refunded to an account whose key
        this browser holds.
      </p>
      <p className="text-sm text-ink-soft">
        Make sure the destination supports this network; sending to an incompatible network can cause permanent loss.
      </p>
      <Field label="Deliver as" htmlFor="nc-dest">
        <select id="nc-dest" className="nr-select" value={destination} onChange={(e) => setDestination(e.target.value as Destination)}>
          {(Object.keys(DESTINATIONS) as Destination[]).map((k) => (
            <option key={k} value={k}>
              {DESTINATIONS[k].label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`Your ${dest.chain} address`} htmlFor="nc-dest-address" hint={dest.hint}>
        <input id="nc-dest-address" className="nr-input nr-input--mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={dest.placeholder} autoComplete="off" spellCheck={false} />
      </Field>
      {err ? <Notice kind="error">{err}</Notice> : null}
      <button type="submit" className="nr-btn nr-btn--accent" disabled={busy}>
        {busy ? <Spinner /> : null}
        Get a quote
      </button>
      {result ? (
        result.ok ? (
          <Notice kind="soft">
            <p className="font-semibold text-ink">
              You would receive about {result.quote.amountOutFormatted} USDC on {dest.chain}.
            </p>
            <p className="mt-1">
              For {formatUsd(amountUnits)} in, delivered in {describeTimeEstimate(result.quote.timeEstimate)}.
              {result.quote.minAmountOut ? " The quote carries a 1% slippage tolerance." : ""}
            </p>
            <p className="mt-1 text-xs">Dry quote from NEAR Intents (1Click). {NEAR_IS_TESTNET ? "Practice money: the claim stops here on purpose." : ""}</p>
          </Notice>
        ) : (
          <Notice kind="error">The quote service said: {result.message}</Notice>
        )
      ) : null}
    </form>
  );
}

function Done({
  amount,
  target,
  txHash,
  account,
  claimedAt,
  heading,
}: {
  amount: string;
  target: string;
  txHash: string | undefined;
  account: ClaimedAccount | undefined;
  /** When the escrow recorded the claim (ms), once the chain has said so. */
  claimedAt: number | undefined;
  heading: React.RefObject<HTMLHeadingElement | null>;
}) {
  const balance = useLoadable(() => usdcBalance(target), [target]);
  const config = useLoadable(() => getConfig(), []);
  const starter = config.value.state === "ready" && config.value.value.starter_yocto ? BigInt(config.value.value.starter_yocto) : null;
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    let alive = true;
    void accountKey(account.accountId).then((k) => alive && setPrivateKey(k));
    return () => {
      alive = false;
    };
  }, [account]);
  return (
    <>
      <Wordmark />
      <div className="nc-main">
        <Mascot pose="celebrate" size="md" enter="pop" alt="The Lumenia messenger, celebrating" />
        <p className="nc-amount">{amount}</p>
        <h1 ref={heading} tabIndex={-1} className="nc-title">
          It&apos;s yours.
        </h1>
        <p className="nc-lead">
          {account ? (
            account.kind === "named" ? (
              <>
                It is in your new account <b>{account.accountId}</b>.
              </>
            ) : (
              "It is in your new account."
            )
          ) : (
            <>
              It was sent to <span className="nc-mono">{target}</span>.
            </>
          )}
        </p>
        {account ? (
          <div className="nc-idbox">
            <code>{account.accountId}</code>
            <CopyButton text={account.accountId} label="Copy" />
          </div>
        ) : null}
        <p className="text-sm text-ink">
          Balance now:{" "}
          {balance.value.state === "loading" ? (
            <span className="text-ink-soft">reading...</span>
          ) : balance.value.state === "error" ? (
            <span className="text-danger">
              could not read it yet{" "}
              <button type="button" className="nr-link" onClick={balance.reload}>
                retry
              </button>
            </span>
          ) : (
            <b>{formatUsd(balance.value.value)}</b>
          )}
        </p>
        <p className="text-sm text-ink">Network fee: covered by Lumenia.</p>
        {/* The receipt. The network, and the small balance a new account holds for its own fees, live here. */}
        <Details
          rows={[
            claimedAt !== undefined ? ["Claimed", formatLocal(claimedAt)] : null,
            ["Status", "Claimed"],
            ["Amount", amount],
            ["Network fee", "covered by Lumenia"],
            account && starter !== null && starter > 0n ? ["Your account also holds", `${formatNear(starter, 2)} NEAR for network fees`] : null,
            ["Held as", "USDC, a dollar-denominated asset"],
          ]}
          explorer={[["View the account on explorer", explorerAccountUrl(target)], ...(txHash ? [["View the claim on explorer", explorerTxUrl(txHash)] as [string, string]] : [])]}
        />
        {account ? (
          privateKey ? (
            <SaveKey account={account} privateKey={privateKey} />
          ) : (
            <div className="nc-card">
              <Notice kind="warn">
                This browser no longer holds the key of {account.accountId}. If you downloaded the key file when you claimed, that file
                is the way in.
              </Notice>
            </div>
          )
        ) : null}
        {account ? (
          <MoneyCard className="nc-card p-4 sm:p-5">
            <details className="nc-option">
              <summary>Use this account in another app</summary>
              <div className="nc-option-body">
                <p className="text-sm text-ink-soft">
                  Any NEAR wallet app that imports an ed25519 private key can hold this account. In HOT Wallet, look for Import account
                  and paste the private key from your key file. In Meteor Wallet, look for Import account, choose Private key and paste
                  it. Your account id is <span className="nc-mono">{account.accountId}</span>.
                </p>
              </div>
            </details>
          </MoneyCard>
        ) : null}
        {account && privateKey ? (
          <PayForwardCard
            account={account}
            privateKey={privateKey}
            balanceUnits={balance.value.state === "ready" ? balance.value.value : null}
            onChanged={balance.reload}
          />
        ) : null}
        <p className="nc-foot">
          <Link href="/">What is Lumenia?</Link>
        </p>
      </div>
    </>
  );
}

function SaveKey({ account, privateKey }: { account: ClaimedAccount; privateKey: string }) {
  const plain = JSON.stringify({ account_id: account.accountId, public_key: account.publicKey, private_key: privateKey, network: NEAR_NETWORK }, null, 2);
  const stem = `lumenia-${account.accountId.slice(0, 10)}`;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedPlain, setSavedPlain] = useState(false);
  const [savedProtected, setSavedProtected] = useState(false);

  const saveProtected = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) {
      setErr("Use at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const box = await encryptWithPassword(password, plain);
      const file = JSON.stringify(
        {
          account_id: account.accountId,
          public_key: account.publicKey,
          network: NEAR_NETWORK,
          note: "private key encrypted with PBKDF2-SHA256 and AES-256-GCM; open with the password in any WebCrypto runtime",
          ...box,
        },
        null,
        2,
      );
      downloadText(`${stem}-protected.json`, file);
      setSavedProtected(true);
    } catch (e2) {
      setErr(describeError(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MoneyCard className="nc-card flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-lg font-semibold text-ink">Save your key</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Your account is a key pair made in this browser. The file is the way back in: no email, no reset. It is also kept in this
          browser&apos;s storage, encrypted, which a cleared cache would wipe.
        </p>
      </div>
      <PrimaryButton
        onClick={() => {
          downloadText(`${stem}-key.json`, plain);
          setSavedPlain(true);
        }}
      >
        {savedPlain ? "Downloaded. Download again" : "Download the key file"}
      </PrimaryButton>
      <details className="text-sm text-ink-soft">
        <summary className="cursor-pointer list-none font-semibold text-money underline-offset-2 hover:underline [&::-webkit-details-marker]:hidden">
          Prefer a password-protected copy?
        </summary>
        <form onSubmit={(e) => void saveProtected(e)} className="mt-3 flex flex-col gap-3">
          <Field label="Password" htmlFor="nc-key-password" hint="Encrypts the file with AES-256-GCM. Forgetting the password loses the file.">
            <input id="nc-key-password" className="nr-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          {err ? <Notice kind="error">{err}</Notice> : null}
          <button type="submit" className="nr-btn nr-btn--accent self-start" disabled={busy}>
            {busy ? <Spinner /> : null}
            {savedProtected ? "Downloaded. Download again" : "Download a protected copy"}
          </button>
        </form>
      </details>
      <p className="text-xs text-ink-soft">The key file also opens this account in other apps later (see Use this account in another app). Until then this page, and your file, are the way in.</p>
    </MoneyCard>
  );
}
