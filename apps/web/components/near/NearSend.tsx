"use client";

/**
 * /near/send, the sender screen of the NEAR rail. The shape is the Stellar /send's: an amount, a
 * link to share, a list of what you sent with its live state. What differs is who signs: there is no
 * Lumenia account on NEAR yet, so the sender is a testnet account whose key lives in this tab's
 * session only: the shared demo sender (its key is public by design and set by the deployment), or
 * an account the person pastes.
 *
 * RECORD BEFORE SIGN, the rule lib/sent-links.ts states for the Stellar side: the link's record and
 * its key go to storage (the key encrypted, lib/near/store.ts) before the transfer is signed, and
 * the transaction hash is written the moment it is known, before the network sees it. A tab killed
 * mid-flight still knows about the funded link.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { KeyPair, type KeyPairString } from "near-api-js";
import { MoneyCard } from "../brand/MoneyCard";
import { PrimaryButton } from "../brand/PrimaryButton";
import { LinkReadyCard } from "../brand/LinkReadyCard";
import { StatusPill } from "../brand/StatusPill";
import { ToastHost, toast } from "../brand/Toast";
import { CopyButton, ExplorerLink, Field, Notice, SmallButton, Spinner, StateLine, downloadText } from "./primitives";
import { NearSendMany } from "./NearSendMany";
import { useInterval, useLoadable, useNow } from "../../lib/near/hooks";
import {
  NEAR_CONTRACT_ID,
  NEAR_DEMO_FUNDER_ID,
  NEAR_DEMO_FUNDER_KEY,
  NEAR_IS_TESTNET,
  NEAR_MAX_LINK_UNITS,
  NEAR_NETWORK,
  NEAR_USDC_ID,
  explorerAccountUrl,
  explorerTxUrl,
  nearLinkOrigin,
} from "../../lib/near/config";
import { demoSenderAvailable, linkLimits } from "../../lib/near/demo";
import { formatNear, formatUsd, formatUsdc, parseUsdcAmount } from "../../lib/near/amount";
import { isValidAccountId } from "../../lib/near/account-id";
import { MAX_MEMO_BYTES, buildDropMsg, isTerminal, memoBytes, type DropView } from "../../lib/near/drops";
import { describeError } from "../../lib/near/errors";
import { DEFAULT_EXPIRY_S, EXPIRY_OPTIONS, formatLocal, toIso } from "../../lib/near/expiry";
import { claimUrl, newLinkKey } from "../../lib/near/keys";
import { contractIsDeployed, getConfig, getDrop, keyBelongsToAccount, nearBalance, usdcBalance, usdcRegistered } from "../../lib/near/rpc";
import { sendFunctionCall } from "../../lib/near/chain";
import { chainResult, ftTransferCallUsedAmount, receiptFailure, txFailure } from "../../lib/near/outcome";
import { canTakeBack, linkExpiresAt, linkStateOf, linkStatusLine, recordDrop, type LinkState } from "../../lib/near/link-state";
import { CSV_BOM, linksCsv, type LinkCsvRow } from "../../lib/near/csv";
import { describeRelayError } from "../../lib/near/pay-forward";
import { buildSignedDelegateForReclaim, relay } from "../../lib/near/relayer";
import { sharedProvider } from "../../lib/near/chain";
import {
  accountKey,
  claimByAccount,
  clearFunder,
  linkSecret,
  loadFunder,
  loadLinks,
  removeLink,
  saveFunder,
  saveLink,
  storageAvailable,
  upsertLink,
  type FunderSession,
  type StoredLink,
} from "../../lib/near/store";
import "../site/app-theme.css";

/** What LinkReadyCard says under the buttons here: the rail's own take-back rule. */
const TAKE_BACK_NOTE =
  "Whoever holds the link can claim it, like cash in an envelope. If nobody claims it before it expires, take it back from Your links below. It does not come back by itself.";

export function NearSend() {
  const [funder, setFunder] = useState<FunderSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<"one" | "many">("one");
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // The session lives in sessionStorage, which the server render cannot see: read after mount.
  useEffect(() => {
    setFunder(loadFunder());
    setHydrated(true);
  }, []);

  return (
    <div className="nr-column">
      <ContractStatus />
      {!hydrated ? null : funder ? (
        <FunderPanel
          funder={funder}
          onForget={() => {
            clearFunder();
            setFunder(null);
          }}
        />
      ) : (
        <FunderForm onReady={setFunder} />
      )}
      {funder ? (
        <div className="nr-tabs" role="tablist" aria-label="What to send">
          <button role="tab" aria-selected={mode === "one"} className="nr-tab" type="button" onClick={() => setMode("one")}>
            One link
          </button>
          <button role="tab" aria-selected={mode === "many"} className="nr-tab" type="button" onClick={() => setMode("many")}>
            Send to many
          </button>
        </div>
      ) : null}
      {funder && mode === "one" ? <CreateLink funder={funder} onChange={bump} /> : null}
      {funder && mode === "many" ? <NearSendMany funder={funder} onChange={bump} /> : null}
      {hydrated ? <YourLinks funder={funder} version={version} onChange={bump} /> : null}
      <p className="nr-foot">
        Prefer the other rail? <Link href="/send">Send on Stellar instead</Link>.
      </p>
      <ToastHost />
    </div>
  );
}

function ContractStatus() {
  const deployed = useLoadable(() => contractIsDeployed(), [], 30_000);
  if (deployed.value.state === "loading") return null;
  if (deployed.value.state === "error") {
    return (
      <Notice kind="error" onRetry={deployed.reload}>
        Could not reach the escrow {NEAR_CONTRACT_ID}: {deployed.value.message}
      </Notice>
    );
  }
  if (!deployed.value.value) {
    return (
      <Notice kind="warn" onRetry={deployed.reload} retryLabel="Check again">
        The account {NEAR_CONTRACT_ID} exists but holds no contract right now. Links cannot be made until it does.
      </Notice>
    );
  }
  return null;
}

function FunderForm({ onReady }: { onReady: (f: FunderSession) => void }) {
  const [accountId, setAccountId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [own, setOwn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const demoAvailable = demoSenderAvailable(NEAR_DEMO_FUNDER_ID, NEAR_DEMO_FUNDER_KEY);

  const pickDemo = async () => {
    setErr(null);
    setDemoBusy(true);
    try {
      const kp = KeyPair.fromString(NEAR_DEMO_FUNDER_KEY as KeyPairString);
      const ok = await keyBelongsToAccount(NEAR_DEMO_FUNDER_ID, kp.getPublicKey().toString());
      if (!ok) {
        setErr(`The demo sender ${NEAR_DEMO_FUNDER_ID} does not carry the configured key on NEAR ${NEAR_NETWORK}. Bring your own account below.`);
        return;
      }
      const f: FunderSession = { accountId: NEAR_DEMO_FUNDER_ID, secret: kp.toString(), demo: true };
      if (!saveFunder(f)) {
        setErr("This browser blocks session storage, so the sender cannot be kept for this tab.");
        return;
      }
      onReady(f);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setDemoBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const id = accountId.trim().toLowerCase();
    if (!isValidAccountId(id)) {
      setErr("That is not a valid NEAR account id.");
      return;
    }
    let kp: KeyPair;
    try {
      kp = KeyPair.fromString(secret.trim() as KeyPairString);
    } catch {
      setErr("The key should look like ed25519:... (the private_key field of a NEAR credentials file).");
      return;
    }
    setBusy(true);
    try {
      const pk = kp.getPublicKey().toString();
      const ok = await keyBelongsToAccount(id, pk);
      if (!ok) {
        setErr(`${id} does not have the key ${pk} on NEAR ${NEAR_NETWORK}. Check the account id and the key.`);
        return;
      }
      const f: FunderSession = { accountId: id, secret: kp.toString() };
      if (!saveFunder(f)) {
        setErr("This browser blocks session storage, so the key cannot be kept for this tab.");
        return;
      }
      onReady(f);
    } catch (e2) {
      setErr(describeError(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MoneyCard className="flex flex-col gap-4 p-5">
      <div>
        <p className="font-semibold text-ink">Who is sending</p>
        <p className="mt-1 text-sm text-ink-soft">
          {demoAvailable
            ? "Use the shared demo sender, a throwaway testnet account anyone may use, or bring your own testnet account."
            : "A NEAR testnet account whose key you paste here. It stays in this tab only and is gone when the tab closes."}
        </p>
      </div>
      {demoAvailable && !own ? (
        <>
          <PrimaryButton onClick={() => void pickDemo()} loading={demoBusy} loadingLabel="Checking the demo sender...">
            Use the demo sender
          </PrimaryButton>
          <p className="text-xs text-ink-soft">
            Up to $5.00 a link. Its key is public on purpose, so treat it as a playground, not a wallet.
          </p>
          <button type="button" className="nr-link self-start" onClick={() => setOwn(true)}>
            Bring my own testnet account instead
          </button>
          {err ? <Notice kind="error">{err}</Notice> : null}
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <p className="text-xs text-ink-soft">
            The key stays in this tab&apos;s session storage, never in local storage, and is sent nowhere but the NEAR
            network. Use a test account you do not care about.
          </p>
          <Field label="Account id" htmlFor="nr-funder-id">
            <input
              id="nr-funder-id"
              className="nr-input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="yourname.testnet"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Private key" htmlFor="nr-funder-key" hint="ed25519:... from ~/.near-credentials/testnet/<account>.json">
            <input
              id="nr-funder-key"
              className="nr-input nr-input--mono"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="ed25519:..."
              autoComplete="off"
            />
          </Field>
          {err ? <Notice kind="error">{err}</Notice> : null}
          <PrimaryButton type="submit" loading={busy} loadingLabel="Checking the key...">
            Use this account for this tab
          </PrimaryButton>
          {demoAvailable ? (
            <button type="button" className="nr-link self-start" onClick={() => setOwn(false)}>
              Back to the demo sender
            </button>
          ) : null}
        </form>
      )}
    </MoneyCard>
  );
}

function FunderPanel({ funder, onForget }: { funder: FunderSession; onForget: () => void }) {
  const usdc = useLoadable(
    async () => ({
      balance: await usdcBalance(funder.accountId),
      registered: await usdcRegistered(funder.accountId),
    }),
    [funder.accountId],
    15_000,
  );
  const near = useLoadable(() => nearBalance(funder.accountId), [funder.accountId], 15_000);

  return (
    <MoneyCard className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">Sending from</p>
          <p className="nr-mono mt-1 text-ink-soft">{funder.accountId}</p>
        </div>
        <SmallButton onClick={onForget}>{funder.demo ? "Switch sender" : "Forget key"}</SmallButton>
      </div>
      {funder.demo ? (
        <Notice kind="warn">
          Shared demo sender: anyone can use it and its balance may be low (refill at faucet.circle.com for {funder.accountId}).
          Links are capped at $5.00 each here.
        </Notice>
      ) : null}
      <dl className="nr-kv">
        <dt>USDC</dt>
        <dd>
          {usdc.value.state === "loading" ? (
            <span className="text-ink-soft">reading...</span>
          ) : usdc.value.state === "error" ? (
            <span className="text-danger">
              could not read it{" "}
              <button type="button" className="nr-link" onClick={usdc.reload}>
                retry
              </button>
            </span>
          ) : (
            <>
              {formatUsdc(usdc.value.value.balance)} USDC
              {!usdc.value.value.registered ? <span className="ml-2 text-xs text-ink-soft">(not registered with the USDC contract)</span> : null}
            </>
          )}
        </dd>
        <dt>NEAR</dt>
        <dd>
          {near.value.state === "loading" ? (
            <span className="text-ink-soft">reading...</span>
          ) : near.value.state === "error" ? (
            <span className="text-danger">
              could not read it{" "}
              <button type="button" className="nr-link" onClick={near.reload}>
                retry
              </button>
            </span>
          ) : (
            `${formatNear(near.value.value)} NEAR`
          )}
        </dd>
      </dl>
      <ExplorerLink href={explorerAccountUrl(funder.accountId)}>View the account on the explorer</ExplorerLink>
    </MoneyCard>
  );
}

type CreateResult =
  | { kind: "created"; link: StoredLink; txHash: string | null; kept: boolean }
  | { kind: "failed"; link: StoredLink; message: string; txHash: string | null; retryable: boolean };

async function pollDrop(publicKey: string, limitMs: number): Promise<DropView | null> {
  const started = Date.now();
  for (;;) {
    const d = await getDrop(publicKey);
    if (d) return d;
    if (Date.now() - started > limitMs) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function CreateLink({ funder, onChange }: { funder: FunderSession; onChange: () => void }) {
  const limits = linkLimits(!!funder.demo, NEAR_MAX_LINK_UNITS);
  const [amount, setAmount] = useState(limits.defaultAmount);
  const [expiry, setExpiry] = useState<number>(DEFAULT_EXPIRY_S);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [canStore, setCanStore] = useState(true);
  const config = useLoadable(() => getConfig(), [], 60_000);
  const maxExpiry = config.value.state === "ready" ? config.value.value.max_expiry_s : Number.MAX_SAFE_INTEGER;
  const paused = config.value.state === "ready" && config.value.value.paused;
  const expiryOptions = EXPIRY_OPTIONS.filter((o) => o.seconds <= maxExpiry);

  useEffect(() => setCanStore(storageAvailable()), []);

  const run = async (existing?: StoredLink) => {
    setFormErr(null);
    let link: StoredLink;
    if (existing) {
      link = existing;
    } else {
      const parsed = parseUsdcAmount(amount, { maxUnits: limits.maxUnits });
      if (!parsed.ok) {
        setFormErr(funder.demo && /limit here/.test(parsed.reason) ? "The shared demo sender is capped at $5.00 a link. Bring your own account for more." : parsed.reason);
        return;
      }
      if (memoBytes(memo) > MAX_MEMO_BYTES) {
        setFormErr(`The memo is too long for the contract (${memoBytes(memo)} of ${MAX_MEMO_BYTES} bytes).`);
        return;
      }
      if (expiry > maxExpiry) {
        setFormErr(`The contract allows at most ${Math.floor(maxExpiry / 3600)} hours of expiry.`);
        return;
      }
      const key = newLinkKey();
      link = {
        publicKey: key.publicKey,
        secret: key.secret,
        amountUnits: parsed.units,
        memo: memo.trim(),
        expiresInS: expiry,
        createdAt: toIso(Date.now()),
        funder: funder.accountId,
        network: NEAR_NETWORK,
      };
    }
    setBusy(true);
    setResult(null);
    // The record and the key are kept BEFORE anything is signed: a crash mid-flight must never lose a funded link.
    setStep("Keeping the link safe");
    const kept = await saveLink(link);
    onChange();
    let txHash: string | null = link.createTxHash ?? null;
    try {
      if (existing) {
        setStep("Checking the chain");
        const already = await getDrop(link.publicKey);
        if (already) {
          recordDrop(link.publicKey, already);
          setResult({ kind: "created", link: { ...link, lastStatus: already.status }, txHash, kept });
          return;
        }
      }
      setStep("Signing and sending");
      const sent = await sendFunctionCall({
        signerId: funder.accountId,
        secretKey: funder.secret as KeyPairString,
        receiverId: NEAR_USDC_ID,
        methodName: "ft_transfer_call",
        args: {
          receiver_id: NEAR_CONTRACT_ID,
          amount: link.amountUnits,
          msg: buildDropMsg(link.publicKey, link.expiresInS, link.memo),
        },
        gasTgas: 100,
        depositYocto: 1n,
        onSigned: (h) => {
          txHash = h;
          upsertLink({ publicKey: link.publicKey, createTxHash: h });
          onChange();
        },
      });
      txHash = sent.txHash;
      const failure = txFailure(sent.outcome);
      if (failure) throw new Error(`The transaction failed: ${failure}`);
      setStep("Confirming the link");
      const drop = await pollDrop(link.publicKey, 20_000);
      if (!drop) {
        const used = ftTransferCallUsedAmount(sent.outcome);
        if (used !== null && used !== link.amountUnits) {
          const why = receiptFailure(sent.outcome);
          upsertLink({ publicKey: link.publicKey, createError: `refunded${why ? `: ${why}` : ""}` });
          setResult({
            kind: "failed",
            link,
            txHash,
            retryable: false,
            message: `The escrow did not keep the USDC, so the token contract refunded ${funder.accountId}` + (why ? `: ${why}` : "."),
          });
          return;
        }
        setResult({
          kind: "failed",
          link,
          txHash,
          retryable: true,
          message: "The transaction went through but the link is not visible yet. Your links below keep checking.",
        });
        return;
      }
      recordDrop(link.publicKey, drop);
      setResult({ kind: "created", link: { ...link, createTxHash: txHash ?? undefined, lastStatus: drop.status }, txHash, kept });
    } catch (e) {
      const message = describeError(e);
      upsertLink({ publicKey: link.publicKey, createError: message });
      setResult({ kind: "failed", link, txHash, message, retryable: true });
    } finally {
      setBusy(false);
      setStep("");
      onChange();
    }
  };

  if (result?.kind === "created") {
    return (
      <LinkCreated
        link={result.link}
        txHash={result.txHash}
        kept={result.kept}
        onAnother={() => {
          setResult(null);
          setMemo("");
        }}
      />
    );
  }

  return (
    <MoneyCard className="p-5">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <p className="font-semibold text-ink">New link</p>
        <Field label="Amount" htmlFor="nr-amount">
          <div className="nr-amount">
            <span>$</span>
            <input id="nr-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.00" autoComplete="off" />
          </div>
        </Field>
        <Field label="The link expires in" htmlFor="nr-expiry" hint="After that, the money can be taken back by you.">
          <select id="nr-expiry" className="nr-select" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
            {expiryOptions.map((o) => (
              <option key={o.seconds} value={o.seconds}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Memo (optional)" htmlFor="nr-memo" hint="Stored on chain with the link, shown to the person who opens it.">
          <input id="nr-memo" className="nr-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="For the concert tickets" maxLength={MAX_MEMO_BYTES} />
        </Field>
        {formErr ? <Notice kind="error">{formErr}</Notice> : null}
        {paused ? <Notice kind="warn">The escrow is paused for new links right now. Existing links can still be claimed.</Notice> : null}
        {!canStore ? <Notice kind="warn">This browser blocks local storage, so the link will NOT be saved here. Copy it the moment it appears.</Notice> : null}
        {result?.kind === "failed" ? (
          <Notice kind="error" onRetry={result.retryable ? () => void run(result.link) : undefined} retryLabel="Try again with the same link key">
            {result.message}
            {result.txHash ? (
              <div className="mt-2">
                <ExplorerLink href={explorerTxUrl(result.txHash)}>View the transaction on the explorer</ExplorerLink>
              </div>
            ) : null}
          </Notice>
        ) : null}
        <PrimaryButton type="submit" loading={busy} loadingLabel={step ? `${step}...` : "Working..."} disabled={paused}>
          Create a money link
        </PrimaryButton>
      </form>
    </MoneyCard>
  );
}

function LinkCreated({ link, txHash, kept, onAnother }: { link: StoredLink; txHash: string | null; kept: boolean; onAnother: () => void }) {
  const url = claimUrl(nearLinkOrigin(), link.secret as KeyPairString);
  const [live, setLive] = useState<StoredLink>(link);
  const now = useNow(1000);
  const terminal = live.lastStatus ? isTerminal(live.lastStatus) : false;
  useInterval(
    () => {
      getDrop(link.publicKey)
        .then((d) => {
          if (d) {
            recordDrop(link.publicKey, d);
            const fresh = loadLinks().find((l) => l.publicKey === link.publicKey);
            if (fresh) setLive({ ...fresh, secret: link.secret });
          }
        })
        .catch(() => undefined);
    },
    terminal ? null : 5000,
  );
  const state = linkStateOf(live, now);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-center text-3xl font-bold tabular-nums text-ink">{formatUsd(link.amountUnits)}</p>
      <LinkReadyCard link={url} balanceId={link.publicKey} title="Your link is ready" trackHref={null} footnote={TAKE_BACK_NOTE} beacon={false} />
      <MoneyCard className="flex flex-col gap-2 p-4">
        <StateLine state={state} />
        <p className="text-sm text-ink-soft">{linkStatusLine(live, now)}</p>
        {txHash ? <ExplorerLink href={explorerTxUrl(txHash)}>View the transaction on the explorer</ExplorerLink> : null}
        {!kept ? (
          <Notice kind="warn">This browser could not keep the link&apos;s key on disk. It stays only while this tab is open, so copy the link now.</Notice>
        ) : null}
      </MoneyCard>
      <button type="button" className="nr-btn self-start" onClick={onAnother}>
        Create another link
      </button>
    </div>
  );
}

function pillFor(state: LinkState | null): { status: "waiting" | "received" | "returned"; label: string } {
  if (state === "claimed") return { status: "received", label: "Claimed" };
  if (state === "returned") return { status: "returned", label: "Returned to you" };
  if (state === "expired") return { status: "returned", label: "Expired" };
  if (state === "waiting") return { status: "waiting", label: "Waiting" };
  return { status: "waiting", label: "Not confirmed yet" };
}

function YourLinks({ funder, version, onChange }: { funder: FunderSession | null; version: number; onChange: () => void }) {
  const [links, setLinks] = useState<StoredLink[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const now = useNow(1000);
  useEffect(() => setLinks(loadLinks()), [version]);

  const visible = links.filter((l) => !l.network || l.network === NEAR_NETWORK);
  const pending = visible.filter((l) => !(l.lastStatus && isTerminal(l.lastStatus)));

  /* The secrets are recalled once per list change, not on the copy tap: the clipboard must be
     written inside the tap on Safari, and an IndexedDB read in between loses the gesture. */
  const openKeys = visible
    .filter((l) => l.lastStatus !== "Claimed" && l.lastStatus !== "Reclaimed")
    .map((l) => l.publicKey)
    .join(",");
  useEffect(() => {
    let alive = true;
    const keys = openKeys ? openKeys.split(",") : [];
    void Promise.all(keys.map(async (k) => [k, await linkSecret(k)] as const)).then((pairs) => {
      if (!alive) return;
      const next: Record<string, string> = {};
      for (const [k, s] of pairs) if (s) next[k] = claimUrl(nearLinkOrigin(), s as KeyPairString);
      setUrls(next);
    });
    return () => {
      alive = false;
    };
  }, [openKeys]);

  useInterval(
    () => {
      void (async () => {
        for (const l of pending) {
          try {
            const d = await getDrop(l.publicKey);
            if (d) recordDrop(l.publicKey, d);
          } catch {
            // keep the last chain-read status; never invent one
          }
        }
        setLinks(loadLinks());
      })();
    },
    pending.length ? 5000 : null,
  );

  const exportCsv = () => {
    const rows: LinkCsvRow[] = visible.map((l) => ({
      created_at: l.createdAt,
      public_key: l.publicKey,
      amount_usdc: formatUsdc(l.amountUnits),
      memo: l.memo ?? "",
      expires_at: toIso(linkExpiresAt(l)),
      status: l.lastStatus ?? "not confirmed yet",
      claimed_to: l.claimedTo ?? "",
      create_tx_hash: l.createTxHash ?? "",
      explorer_url: l.createTxHash ? explorerTxUrl(l.createTxHash) : "",
      label: l.label ?? "",
    }));
    downloadText(`lumenia-near-links-${new Date().toISOString().slice(0, 10)}.csv`, CSV_BOM + linksCsv(rows), "text/csv");
    toast("CSV downloaded.");
  };

  const fail = (l: StoredLink, e: unknown) =>
    setRowErr((m) => ({ ...m, [l.publicKey]: e instanceof Error && e.name === "RelayRequestError" ? describeRelayError(e) : describeError(e) }));

  /** A link made through the relayer by an account whose key this browser holds (a claimed account). */
  const relayedOwner = (l: StoredLink) => (l.relayed ? claimByAccount(l.funder) : undefined);

  const reclaimViaRelayer = async (l: StoredLink) => {
    const owner = relayedOwner(l);
    if (!owner) return;
    setBusyKey(l.publicKey);
    setRowErr((m) => ({ ...m, [l.publicKey]: "" }));
    try {
      const key = await accountKey(owner.accountId);
      if (!key) throw new Error(`This browser no longer holds the key of ${owner.accountId}.`);
      const built = await buildSignedDelegateForReclaim({
        senderId: owner.accountId,
        senderKeyPair: key as KeyPairString,
        escrowId: NEAR_CONTRACT_ID,
        linkPublicKey: l.publicKey,
        provider: sharedProvider(),
      });
      const r = await relay(built.base64);
      upsertLink({ publicKey: l.publicKey, reclaimTxHash: r.txHash });
      if (r.outcome.status !== "success" || r.outcome.reclaimed === false) {
        throw new Error(r.outcome.failures[0] ?? r.outcome.summary ?? "the contract did not return the money");
      }
      const d = await getDrop(l.publicKey);
      if (d) recordDrop(l.publicKey, d);
      toast("The money is back in your account.");
    } catch (e) {
      fail(l, e);
    } finally {
      setBusyKey(null);
      setLinks(loadLinks());
      onChange();
    }
  };

  const reclaim = async (l: StoredLink) => {
    if (!funder) return;
    setBusyKey(l.publicKey);
    setRowErr((m) => ({ ...m, [l.publicKey]: "" }));
    try {
      const sent = await sendFunctionCall({
        signerId: funder.accountId,
        secretKey: funder.secret as KeyPairString,
        receiverId: NEAR_CONTRACT_ID,
        methodName: "reclaim",
        args: { public_key: l.publicKey },
        gasTgas: 100,
        depositYocto: 0n,
        onSigned: (h) => {
          upsertLink({ publicKey: l.publicKey, reclaimTxHash: h });
        },
      });
      const failure = txFailure(sent.outcome);
      if (failure) throw new Error(failure);
      const chain = chainResult(sent.outcome);
      if (chain && !chain.ok) {
        throw new Error(
          `the contract put the link back to Open (${chain.reason ?? "the transfer back failed"})` +
            (receiptFailure(sent.outcome) ? `; detail: ${receiptFailure(sent.outcome)}` : ""),
        );
      }
      const d = await getDrop(l.publicKey);
      if (d) recordDrop(l.publicKey, d);
      toast("The money is back in your account.");
    } catch (e) {
      fail(l, e);
    } finally {
      setBusyKey(null);
      setLinks(loadLinks());
      onChange();
    }
  };

  return (
    <MoneyCard className="p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-ink">Your links</p>
        {visible.length ? <SmallButton onClick={exportCsv}>Export CSV</SmallButton> : null}
      </div>
      {!visible.length ? (
        <p className="mt-2 text-sm text-ink-soft">Links you make in this browser appear here with their live state.</p>
      ) : (
        <div className="nr-rows mt-3">
          {visible.map((l) => {
            const expiredNow = canTakeBack(l, now);
            const mine = !!funder && funder.accountId === l.funder;
            const owner = relayedOwner(l);
            const canReclaim = mine && expiredNow;
            const canReclaimViaRelayer = !canReclaim && expiredNow && owner !== undefined;
            const url = urls[l.publicKey];
            const err = rowErr[l.publicKey];
            const state = linkStateOf(l, now);
            const pill = pillFor(state);
            const terminal = l.lastStatus ? isTerminal(l.lastStatus) : false;
            return (
              <div className="nr-row" key={l.publicKey}>
                <div className="nr-row-top">
                  <span className="nr-row-amt">
                    {formatUsd(l.amountUnits)}
                    {l.label ? <small>{l.label}</small> : null}
                  </span>
                  <span className="nr-row-when">{formatLocal(Date.parse(l.createdAt))}</span>
                </div>
                {l.memo ? <p className="nr-row-memo">{l.memo}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={pill.status} label={pill.label} />
                  <span className="nr-row-sub">{linkStatusLine(l, now)}</span>
                </div>
                <StateLine state={state} />
                <p className="nr-row-sub">
                  Expires {formatLocal(linkExpiresAt(l))}
                  {!mine ? ` from ${l.funder}` : ""}
                  {l.lastStatus === "Claimed" && l.claimedTo ? (
                    <>
                      {" "}
                      <ExplorerLink href={explorerAccountUrl(l.claimedTo)}>recipient on the explorer</ExplorerLink>
                    </>
                  ) : null}
                </p>
                {err ? <Notice kind="error">{err}</Notice> : null}
                <div className="nr-row-actions">
                  {!terminal && url ? <CopyButton text={url} /> : null}
                  {canReclaim ? (
                    <SmallButton className="nr-btn--accent" busy={busyKey === l.publicKey} onClick={() => void reclaim(l)}>
                      Take the money back
                    </SmallButton>
                  ) : null}
                  {canReclaimViaRelayer ? (
                    <SmallButton className="nr-btn--accent" busy={busyKey === l.publicKey} onClick={() => void reclaimViaRelayer(l)}>
                      Take it back, fee paid by the relayer
                    </SmallButton>
                  ) : null}
                  {terminal ? (
                    <SmallButton
                      className="nr-btn--quiet"
                      onClick={() => {
                        void removeLink(l.publicKey).then(() => setLinks(loadLinks()));
                      }}
                    >
                      Remove from this list
                    </SmallButton>
                  ) : null}
                  {(l.lastStatus === "Reclaimed" && l.reclaimTxHash) || l.createTxHash ? (
                    <ExplorerLink href={explorerTxUrl(l.lastStatus === "Reclaimed" && l.reclaimTxHash ? l.reclaimTxHash : (l.createTxHash as string))}>
                      explorer
                    </ExplorerLink>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {NEAR_IS_TESTNET ? <p className="mt-3 text-xs text-ink-soft">Test network. This money isn&apos;t real.</p> : null}
      {busyKey ? <Spinner /> : null}
    </MoneyCard>
  );
}
