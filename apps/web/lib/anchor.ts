/**
 * Anchor client: SEP-1 discovery, SEP-10 web authentication, and withdrawal through whichever
 * door the anchor opens, SEP-6 or SEP-24.
 *
 * WHY THIS FILE EXISTS. Until now the cash-out leg was the user sending their own dollars to an
 * exchange deposit address by hand (lib/payout.ts). That works, and it was walked end to end with
 * real money, but it is not a fiat rail the product owns: the user has to already have an account
 * at an exchange, find its Stellar deposit address, and copy a memo without making a mistake. An
 * anchor is the standard way to close that gap. It is a service that speaks a small set of Stellar
 * Ecosystem Proposals and, on the other side, touches real bank rails.
 *
 * WHAT AN ANCHOR WITHDRAWAL ACTUALLY IS, AND WHY IT COSTS US ALMOST NOTHING TO ADD.
 * A withdrawal, by either door, ends with the anchor telling us three things: an account to pay, a
 * memo to carry, and an amount. That is the exact shape lib/payout.ts already builds, validates and
 * fee-bumps through the sponsor's tight PAYOUT policy. So this module does NOT move money. It
 * discovers, authenticates, opens the withdrawal, waits for the anchor to name a destination, and
 * then hands that destination to the existing, hardened payout path. Every guard
 * that protects a manual cash-out protects an anchor withdrawal unchanged.
 *
 * NO NEW DEPENDENCY, DELIBERATELY. The obvious way to do this is @stellar/typescript-wallet-sdk,
 * which ships a SEP-24 client. It pins @stellar/stellar-sdk to one exact version, and this repo
 * pins a different exact version in both apps, so taking it means either carrying two copies of a
 * 30 MB SDK in the bundle or chasing its pin on every release. The parts we need are small and the
 * pinned SDK already exports the hard one: `WebAuth.readChallengeTx` does the SEP-10 challenge
 * parsing and validation that must not be hand-rolled. Everything else here is fetch and JSON.
 *
 * THE ONE SECURITY-CRITICAL STEP. In SEP-10 the anchor hands us a real Stellar transaction and
 * asks the user's key to sign it. An unverified challenge is an attacker asking you to sign
 * anything. `readChallengeTx` is what makes it safe: it checks the transaction is a well-formed
 * challenge, that the server's signature is from the SIGNING_KEY published in that domain's own
 * stellar.toml, that the sequence number is 0 so it can never reach the ledger, and that the home
 * domain and web auth domain are the ones we asked for. If any of that fails we throw before the
 * user's key is ever asked for a signature. Never relax this.
 *
 * WHAT THIS FILE DOES NOT DO. It never collects or forwards identity documents: on SEP-24 the
 * anchor's own hosted screen does its own know-your-customer step, and on SEP-6 an anchor that
 * demands documents is one this product should not be using. The one SEP-12 call here
 * (`setBankAccount`) sends a payout destination the person typed, nothing about who they are; see
 * its comment for where that line sits. It does not persist the session token. SEP-38 is limited
 * to `requestQuote`: a firm quote for the figure shown before the person approves, never an
 * indicative one dressed up as a promise.
 *
 * LIRA IN (SEP-6 deposit, added at the hackathon, 2026-09-19, decision register D27 item 2.1).
 * `startDeposit` opens a plain SEP-6 `/deposit` for the person's own account (already created
 * and trustlined by the sponsor, so the anchor always meets a ready account), `readDeposit` maps
 * the status walk, and `simulateBankTransfer` stands in for the person's bank on the sandbox
 * anchor only: it refuses to run anywhere but the test network. Nothing on this path signs or
 * pays anything: the anchor sends the dollars, the person only signs the SEP-10 sign-in.
 *
 * DECISION 2026-09-09 (owner, on the organiser's guidance): for the hackathon period the product
 * uses SEP-6 ONLY, plus the SEP-1 discovery and SEP-10 sign-in that SEP-6 cannot work without.
 * `requestQuote` (SEP-38) and `setBankAccount` (SEP-12) stay here, tested, and are called by no
 * product surface. The bank screen opens a plain `/withdraw` and shows the anchor's own sentence
 * about the rate and the payout account instead of a quote of ours.
 *
 * HARDENING 2026-09-18 (pre-hackathon, decision register D4), five things a live probe of the
 * sandbox anchor and a read of its source turned up:
 *   1. A memo whose type is missing or unknown is REFUSED before anything is paid (it used to be
 *      dropped, which would have paid a pooled treasury without its reference).
 *   2. On the `-exchange` paths the on-chain asset is sent as the bare code first, which is what
 *      SEP-6 specifies (`source_asset`: "Code of the on-chain asset", sep-0006.md line 1022); the
 *      SEP-38 `stellar:CODE:ISSUER` form is the one-shot retry, not the first attempt.
 *   3. A 401 or 403 from a protected route is an expired or forgotten session, not a failure:
 *      `withSession` re-runs SEP-10 once with the held signer and retries the call.
 *   4. Polling tolerates transient errors (done by the callers, see /send-out/bank and offramp.ts).
 *   5. `pending_customer_info_update` is terminal: that rail wants identity, which this product
 *      does not collect, so waiting on it would wait forever.
 * Under D2 the `-exchange` paths, `requestQuote` and `setBankAccount` are called by no product
 * surface. They stay here, correct and tested, for a rail that requires them.
 *
 * WHAT THE RAIL PUBLISHES ABOUT ITSELF (2026-09-20). The transfer `/info` carries a `features`
 * block next to the per-asset numbers, and on this rail it reads
 * `{"account_creation": false, "claimable_balances": true}`. That is the anchor stating, in
 * machine-readable form, the exact gap this product fills: it will not open a Stellar account for
 * anybody, so a recipient who has never touched Stellar cannot be paid by it at all. Every account
 * here is opened and trustlined by the sponsor before the lira is sent, which is why the dollars
 * land instead of sitting in the rail's queue as `pending_trust`. `readTransferInfo` reads that
 * block so a screen can quote it; it is display only and gates nothing (see `readTransferInfo`).
 *
 * HONESTY. Whether any given anchor actually settles in a particular currency is the anchor's
 * claim, not ours. `readAnchorInfo` reports what the anchor publishes and nothing more.
 */
import { Networks, Transaction, WebAuth } from "@stellar/stellar-sdk";
import type { Signer } from "./signer";
import { activeNetwork, type NetworkConfig } from "./network";

const TESTNET_PASSPHRASE = Networks.TESTNET;

/** The anchor's home domain, e.g. "testanchor.stellar.org". Configuration, never user input. */
export function anchorHomeDomain(): string | null {
  const raw = process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN?.trim();
  return raw ? raw.replace(/^https?:\/\//, "").replace(/\/+$/, "") : null;
}

/**
 * Which door an anchor opens for transfers.
 *
 * SEP-24 is the hosted, interactive one: the anchor hands back a URL, the person finishes on the
 * anchor's own screen. SEP-6 is the programmatic one: the anchor answers with the destination and
 * memo immediately, and any identity step happens over SEP-12 instead. Real anchors pick one or
 * both. We support both because the two anchors that matter to this product disagree: the Turkish
 * sandbox ramp used at the September 2026 hackathon publishes only `TRANSFER_SERVER` (SEP-6),
 * while the European and global anchors that could carry this corridor later publish SEP-24.
 */
export type AnchorDoor = "sep6" | "sep24";

/** Everything SEP-1 tells us about an anchor that we actually use. */
export interface AnchorInfo {
  homeDomain: string;
  /** SEP-10 endpoint. Absent means the anchor does not support authentication, so no withdrawal. */
  webAuthEndpoint: string;
  /** The transfer server for `door`. SEP-6 and SEP-24 use different toml keys and different paths. */
  transferServer: string;
  door: AnchorDoor;
  /** The key whose signature on a SEP-10 challenge we require. */
  signingKey: string;
  /** The network the anchor declares. Must equal ours or we are talking to the wrong deployment. */
  networkPassphrase: string | null;
  /** Currency codes the anchor publishes, upper-cased. Its claim, not our verification. */
  currencies: string[];
  /** SEP-38, when the anchor quotes a cross-currency rate. Absent for a same-asset withdrawal. */
  quoteServer: string | null;
  /**
   * SEP-12, when the anchor takes customer fields over an API. On the SEP-6 door this is the only
   * way to tell the anchor where the fiat should land. Absent means the anchor either asks on its
   * own hosted screen (SEP-24) or pays to whatever it has on file.
   */
  kycServer: string | null;
}

/** A withdrawal, as far as this client is concerned. */
export type AnchorWithdrawalState =
  | { status: "interactive"; url: string; id: string }
  | { status: "waiting" }
  /** The anchor has named where to pay. This is the hand-off to lib/payout.ts. */
  | {
      status: "ready-to-pay";
      id: string;
      destination: string;
      memo: string | null;
      memoType: "text" | "id" | "hash" | null;
      amountIn: string | null;
      amountOut: string | null;
      amountFee: string | null;
    }
  | { status: "settled"; id: string }
  | { status: "refunded"; id: string }
  | { status: "failed"; id: string; reason: string };

const TIMEOUT_MS = 15_000;

/**
 * The anchor stopped accepting the session token: it expired (24 hours on the sandbox anchor) or
 * the anchor was restarted and forgot it. The sandbox answers 403 `{"type":"authentication_required"}`
 * rather than the 401 the SEP-10 text suggests, so both codes mean the same thing here. The caller
 * still holds the signer, so the right response is one fresh SEP-10 round and a retry
 * (`withSession`), never a failed cash-out.
 */
export class AnchorAuthError extends Error {
  constructor(public readonly status: number) {
    super("that anchor no longer accepts the sign-in");
    this.name = "AnchorAuthError";
  }
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.status === 401 || res.status === 403) throw new AnchorAuthError(res.status);
    if (!res.ok) {
      const detail =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SEP-1. Fetch and parse the anchor's stellar.toml.
 *
 * The file is TOML, but the handful of fields we need are flat `KEY = "value"` lines plus
 * `[[CURRENCIES]]` blocks with a `code`. Parsing only those keeps a TOML dependency out of the
 * bundle. Anything we cannot find is reported as missing rather than guessed.
 */
export async function readAnchorInfo(homeDomain: string): Promise<AnchorInfo> {
  const domain = homeDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const url = `https://${domain}/.well-known/stellar.toml`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let toml: string;
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`that anchor did not answer (HTTP ${res.status})`);
    toml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const scalar = (key: string): string | null => {
    const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
    return m ? m[1] : null;
  };

  const webAuthEndpoint = scalar("WEB_AUTH_ENDPOINT");
  const sep24 = scalar("TRANSFER_SERVER_SEP0024");
  const sep6 = scalar("TRANSFER_SERVER");
  const signingKey = scalar("SIGNING_KEY");

  if (!webAuthEndpoint) throw new Error("that anchor does not offer sign-in (no WEB_AUTH_ENDPOINT)");
  if (!sep24 && !sep6) throw new Error("that anchor does not offer this kind of transfer");
  if (!signingKey) throw new Error("that anchor publishes no signing key, so it cannot be trusted");

  // Prefer the hosted flow when an anchor offers both: it puts the anchor's own identity step on
  // the anchor's own screen, which is the posture this product wants. Fall back to SEP-6, which is
  // the only door some anchors open.
  const door: AnchorDoor = sep24 ? "sep24" : "sep6";
  const transferServer = (sep24 ?? sep6) as string;

  const currencies = [...toml.matchAll(/^\s*code\s*=\s*"([^"]+)"/gm)].map((m) => m[1].toUpperCase());

  return {
    homeDomain: domain,
    webAuthEndpoint: webAuthEndpoint.replace(/\/+$/, ""),
    transferServer: transferServer.replace(/\/+$/, ""),
    door,
    signingKey,
    networkPassphrase: scalar("NETWORK_PASSPHRASE"),
    currencies,
    quoteServer: scalar("ANCHOR_QUOTE_SERVER")?.replace(/\/+$/, "") ?? null,
    kycServer: scalar("KYC_SERVER")?.replace(/\/+$/, "") ?? null,
  };
}

/** What an anchor publishes about one direction of one asset in its transfer `/info`. */
export interface TransferLimits {
  /** Smallest amount the anchor says it takes, as published. Null when it does not say. */
  min: string | null;
  max: string | null;
  /** Its stated fee, in percent of the amount. Null when it does not say. */
  feePercent: string | null;
}

/**
 * SEP-6 / SEP-24 `/info`: the limits the anchor publishes for a withdrawal of `assetCode`.
 *
 * Read so a screen can say "at least X" before asking, instead of learning it from a refusal.
 * These are the anchor's published figures and nothing more: the sandbox anchor published a
 * 0.5 minimum on 2026-09-10 while refusing anything under 1.0, so a refusal still has to be
 * shown in the anchor's own words even when the amount passed this check. No sign-in needed.
 */
export async function readWithdrawLimits(info: AnchorInfo, assetCode: string): Promise<TransferLimits> {
  return readLimits(info, assetCode, "withdraw");
}

/**
 * The same, for a deposit (lira in). MEASURED 2026-09-19 on the sandbox anchor: the published
 * deposit range (0.5-300) is in DOLLARS, the on-chain asset, while the `amount` the person types
 * is LIRA: a 400 TRY deposit was accepted and paid 8.1584363 USDC (payment `8c2c5d76...4c93`). So
 * a screen must not compare the typed lira against these figures; it shows the anchor's own
 * refusal instead.
 */
export async function readDepositLimits(info: AnchorInfo, assetCode: string): Promise<TransferLimits> {
  return readLimits(info, assetCode, "deposit");
}

/**
 * The `features` block of a transfer `/info`, three-valued: `null` is "the anchor did not say",
 * which is not the same as `false`.
 */
export interface AnchorFeatures {
  /** Whether the anchor will open a Stellar account for a recipient who has none. */
  accountCreation: boolean | null;
  /** Whether it can set the asset aside as a claimable balance when an account cannot hold it. */
  claimableBalances: boolean | null;
}

/** One read of the transfer `/info`: what the anchor says about itself, and about one asset. */
export interface TransferInfo {
  features: AnchorFeatures;
  deposit: TransferLimits;
  withdraw: TransferLimits;
}

/**
 * Read the whole transfer `/info` once: the `features` block plus both directions for one asset.
 *
 * DISPLAY ONLY, AND THIS IS LOAD-BEARING. Nothing here may gate a form. The deposit figures the
 * sandbox rail publishes are in DOLLARS while the amount the person types is LIRA (see
 * `readDepositLimits`), and on 2026-09-20 it publishes no deposit `min_amount` at all while
 * refusing anything under 50 TRY. A screen that turned these into validation would refuse amounts
 * the rail accepts and accept amounts it refuses. Quote them as the anchor's own figures, and let
 * the anchor's own refusal text be the answer when it says no.
 *
 * `readWithdrawLimits` and `readDepositLimits` stay as they were: one request each, same shape,
 * same callers. This is the one that also carries `features`.
 */
export async function readTransferInfo(info: AnchorInfo, assetCode: string): Promise<TransferInfo> {
  const body = await fetchTransferInfo(info);
  return {
    features: featuresFrom(body),
    deposit: limitsFrom(body, assetCode, "deposit"),
    withdraw: limitsFrom(body, assetCode, "withdraw"),
  };
}

async function readLimits(info: AnchorInfo, assetCode: string, direction: "deposit" | "withdraw"): Promise<TransferLimits> {
  return limitsFrom(await fetchTransferInfo(info), assetCode, direction);
}

/** An `/info` that does not answer is "no information", never an error on a money screen. */
async function fetchTransferInfo(info: AnchorInfo): Promise<Record<string, unknown> | null> {
  try {
    return ((await getJson(`${info.transferServer}/info`)) as Record<string, unknown> | null) ?? null;
  } catch {
    return null;
  }
}

function limitsFrom(body: Record<string, unknown> | null, assetCode: string, direction: "deposit" | "withdraw"): TransferLimits {
  const none: TransferLimits = { min: null, max: null, feePercent: null };
  const side = body?.[direction] as Record<string, unknown> | undefined;
  const entry = side?.[assetCode] as { min_amount?: unknown; max_amount?: unknown; fee_percent?: unknown } | undefined;
  if (!entry) return none;
  const num = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? String(v) : null);
  return { min: num(entry.min_amount), max: num(entry.max_amount), feePercent: num(entry.fee_percent) };
}

function featuresFrom(body: Record<string, unknown> | null): AnchorFeatures {
  const f = body?.features as Record<string, unknown> | undefined;
  // Only a real boolean counts. A string "false", or a key the anchor left out, is "did not say":
  // reporting an absent claim as `false` would put words in the rail's mouth on screen.
  const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
  return { accountCreation: flag(f?.account_creation), claimableBalances: flag(f?.claimable_balances) };
}

/**
 * SEP-10. Exchange a signature for a session token.
 *
 * The order here is the security property: read and VERIFY the challenge, then sign. Never sign
 * first. `readChallengeTx` throws if the challenge is not signed by the key the anchor's own
 * stellar.toml publishes, if the sequence number is not 0, or if the home domain does not match.
 */
export async function authenticate(
  info: AnchorInfo,
  signer: Signer,
  net: NetworkConfig = activeNetwork(),
): Promise<string> {
  if (info.networkPassphrase && info.networkPassphrase !== net.passphrase) {
    throw new Error("that anchor is on a different network");
  }

  const account = signer.publicKey();
  const challengeUrl = `${info.webAuthEndpoint}?account=${encodeURIComponent(account)}&home_domain=${encodeURIComponent(info.homeDomain)}`;
  const body = (await getJson(challengeUrl)) as { transaction?: string; network_passphrase?: string } | null;
  const challengeXdr = body?.transaction;
  if (!challengeXdr) throw new Error("that anchor did not send a sign-in request");
  if (body?.network_passphrase && body.network_passphrase !== net.passphrase) {
    throw new Error("that anchor is on a different network");
  }

  // The whole safety of this flow. Throws InvalidChallengeError on anything unexpected.
  const webAuthDomain = new URL(info.webAuthEndpoint).hostname;
  const { tx, clientAccountID } = WebAuth.readChallengeTx(
    challengeXdr,
    info.signingKey,
    net.passphrase,
    [info.homeDomain],
    webAuthDomain,
  );
  if (clientAccountID !== account) {
    throw new Error("that sign-in request was issued for a different account");
  }

  const signed = await signer.sign(tx as Transaction);
  let token: { token?: string } | null;
  try {
    token = (await getJson(info.webAuthEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: signed.toXDR() }),
    })) as { token?: string } | null;
  } catch (e) {
    // A 401/403 HERE is the anchor refusing the signature itself, not a stale session: there is
    // nothing to renew, so it must not look like one to `withSession`.
    if (e instanceof AnchorAuthError) throw new Error("that anchor refused the sign-in");
    throw e;
  }

  if (!token?.token) throw new Error("that anchor refused the sign-in");
  return token.token;
}

/**
 * A signed-in session at one anchor: everything needed to renew the token without asking the
 * person for anything. Held in memory by the caller for one flow; never persisted.
 */
export interface AnchorSession {
  info: AnchorInfo;
  token: string;
  signer: Signer;
  net?: NetworkConfig;
}

/**
 * Run one authenticated call, and if the anchor answers 401/403, sign in again ONCE and retry it.
 *
 * Why once: a second refusal after a fresh token is not a stale session, it is the anchor saying
 * no, and looping on it would hide that. Why here and not inside each call: the library functions
 * take a plain token so they stay testable in isolation; the renewal policy lives in one place.
 * The renewed token is written back into `session`, so the next call starts from the good one.
 */
export async function withSession<T>(session: AnchorSession, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(session.token);
  } catch (e) {
    if (!(e instanceof AnchorAuthError)) throw e;
    session.token = await authenticate(session.info, session.signer, session.net);
    return await call(session.token);
  }
}

/** What opening a withdrawal gave us: either a screen to finish on, or a destination to pay. */
export type OpenedWithdrawal =
  | { kind: "interactive"; id: string; url: string }
  | {
      kind: "ready-to-pay";
      id: string;
      destination: string;
      memo: string | null;
      memoType: "text" | "id" | "hash" | null;
      /**
       * Whatever the anchor said in `extra_info.message`, verbatim. On a plain SEP-6 withdrawal
       * this is where an anchor states the rate it locked and where the fiat will land; it is
       * the anchor's sentence, shown as such, never parsed into a promise of ours.
       */
      note: string | null;
    };

/**
 * Open a withdrawal, by whichever door the anchor publishes.
 *
 * SEP-24 answers with a URL: the anchor collects whatever identity information it needs on its own
 * screen, under its own licence, and this product never sees, stores or forwards a document.
 *
 * SEP-6 answers with the destination and memo straight away. The `-exchange` variant is the one to
 * use when the asset leaving is not the currency arriving, which is exactly the case here: USDC
 * leaves, Turkish lira arrives. It carries an optional SEP-38 quote id so the rate is locked before
 * the money moves rather than discovered after.
 *
 * Either way the money itself is moved later, by the caller, on the existing payout path.
 */
export async function startWithdrawal(
  info: AnchorInfo,
  token: string,
  params: {
    assetCode: string;
    account: string;
    amount?: string;
    lang?: string;
    /** SEP-6 only. The anchor's own name for how the money leaves, e.g. "bank_account". */
    type?: string;
    /**
     * SEP-6 only. Where the fiat lands, when the anchor asks for it. UNUSED under D2: the sandbox
     * anchor ignores it (the payout account is whatever it holds for the wallet) and no product
     * surface passes it.
     */
    dest?: string;
    /**
     * SEP-6 -exchange only, and only for the dialect retry. SEP-6 specifies the bare code for
     * `source_asset` on `withdraw-exchange` (sep-0006.md line 1022), so the issuer is not needed
     * for the first request; it is used once, when an anchor refuses the bare code by name and
     * wants the SEP-38 form `stellar:CODE:ISSUER` instead. UNUSED under D2.
     */
    assetIssuer?: string;
    /**
     * SEP-6 -exchange only. What the person receives, in SEP-38 notation, e.g. "iso4217:TRY".
     * Naming it selects the `-exchange` path. UNUSED under D2: the product opens a plain
     * `/withdraw` and shows the anchor's own sentence about the rate.
     */
    destinationAsset?: string;
    /** SEP-6 -exchange only. A SEP-38 quote id, so the rate is locked. UNUSED under D2. */
    quoteId?: string;
  },
): Promise<OpenedWithdrawal> {
  const auth = { authorization: `Bearer ${token}` };

  if (info.door === "sep24") {
    const res = (await getJson(`${info.transferServer}/transactions/withdraw/interactive`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        asset_code: params.assetCode,
        account: params.account,
        ...(params.amount ? { amount: params.amount } : {}),
        ...(params.lang ? { lang: params.lang } : {}),
      }),
    })) as { type?: string; url?: string; id?: string } | null;

    if (!res?.url || !res?.id) throw new Error("that anchor could not start the withdrawal");
    return { kind: "interactive", id: res.id, url: res.url };
  }

  // SEP-6. Cross-currency goes through -exchange (UNUSED under D2, kept correct); a same-asset
  // withdrawal uses plain /withdraw, which is what the product does.
  //
  // Two things about the -exchange form were learned by probing the live Turkish sandbox anchor
  // and then checked against the spec, and both are pinned by the self-test:
  //   1. `asset_code` is required on BOTH paths. The -exchange variant does not replace it with
  //      `source_asset`, it adds to it. Omitting it answers 400 "'asset_code' is required".
  //   2. `source_asset` on `withdraw-exchange` is the BARE CODE of the on-chain asset (SEP-6,
  //      sep-0006.md line 1022: "Code of the on-chain asset the user wants to withdraw"). The
  //      SEP-38 form `stellar:CODE:ISSUER` belongs to the OFF-chain side (`destination_asset`,
  //      e.g. `iso4217:TRY`). The first draft had this backwards, so every first request to the
  //      sandbox anchor failed and only the retry succeeded.
  const exchange = Boolean(params.destinationAsset);
  const q = new URLSearchParams();
  q.set("asset_code", params.assetCode);
  if (exchange) {
    q.set("source_asset", params.assetCode);
    q.set("destination_asset", params.destinationAsset as string);
  }
  q.set("account", params.account);
  q.set("type", params.type ?? "bank_account");
  if (params.amount) q.set("amount", params.amount);
  if (params.dest) q.set("dest", params.dest);
  if (params.quoteId) q.set("quote_id", params.quoteId);
  if (params.lang) q.set("lang", params.lang);

  const path = exchange ? "withdraw-exchange" : "withdraw";
  type Opened = { id?: string; account_id?: string; memo?: string; memo_type?: string; extra_info?: { message?: string } } | null;
  let res: Opened;
  try {
    res = (await getJson(`${info.transferServer}/${path}?${q.toString()}`, { headers: auth })) as Opened;
  } catch (e) {
    /* The spec form first, the anchor's dialect second. The sandbox anchor itself flipped between
     * the two forms during September 2026 (it accepted only `stellar:USDC:G...` on 09-06 and only
     * the bare code from 09-09). Anchors under active development move; a client that dies on the
     * first dialect it did not expect is a demo that fails on stage. So: if the refusal names
     * `source_asset` and the issuer is known, retry once with the SEP-38 form. Nothing has been
     * paid at this point, so the retry costs a request and nothing else. A 401/403 is an
     * AnchorAuthError whose message never mentions the field, so it passes straight through to
     * `withSession`. */
    const msg = e instanceof Error ? e.message : "";
    if (!exchange || !params.assetIssuer || !/source_asset/i.test(msg)) throw e;
    q.set("source_asset", `stellar:${params.assetCode}:${params.assetIssuer}`);
    res = (await getJson(`${info.transferServer}/${path}?${q.toString()}`, { headers: auth })) as Opened;
  }

  const id = res?.id;
  const destination = res?.account_id;
  if (!res || !id) throw new Error("that anchor could not start the withdrawal");
  // An anchor that opens a withdrawal without naming where to pay has told us nothing usable.
  // Refuse rather than carry a half-answer into the money path.
  if (!destination) throw new Error("that anchor did not say where to send the money");

  const memo = res.memo != null && String(res.memo) !== "" ? String(res.memo) : null;
  const memoType = normaliseMemoType(res.memo_type);
  if (memo !== null && memoType === null) throw new Error(MEMO_REFUSAL);

  return {
    kind: "ready-to-pay",
    id,
    destination,
    memo,
    memoType,
    note: res.extra_info?.message ? String(res.extra_info.message) : null,
  };
}

/**
 * Why a memo of unknown type is REFUSED rather than defaulted.
 *
 * SEP-6 lets a client default a missing `memo_type` to text. This client does not, on purpose:
 * an anchor's withdrawal account is a pooled treasury, and the memo is the only thing that ties
 * a payment to the person's withdrawal. The sandbox anchor matches withdrawals by `Memo.id` alone
 * and never refunds an unmatched payment (a text memo, even all digits, is "unmatched"), so a
 * guessed type is money that arrives and belongs to nobody. Refusing costs one screen of copy;
 * guessing wrong costs the whole amount. The old behaviour, dropping the memo and paying without
 * it, was the worst of the three.
 */
const MEMO_REFUSAL =
  "that anchor asked for a kind of payment reference this product cannot attach, so nothing was sent";

/** SEP-6 and SEP-24 both use this vocabulary. Anything else is null, and a null next to a memo is refused. */
function normaliseMemoType(raw: unknown): "text" | "id" | "hash" | null {
  const s = String(raw ?? "");
  return s === "text" || s === "id" || s === "hash" ? s : null;
}

/**
 * SEP-24. Ask the anchor where a withdrawal stands.
 *
 * The status vocabulary is the anchor's, and anchors vary. The mapping below is deliberately
 * conservative: anything we do not recognise is reported as `waiting`, never as settled. Calling
 * an unknown state "done" is the failure mode this codebase has already been bitten by once, on
 * the link status reader, so it is not repeated here.
 */
export async function readWithdrawal(
  info: AnchorInfo,
  token: string,
  id: string,
): Promise<AnchorWithdrawalState> {
  const res = (await getJson(`${info.transferServer}/transaction?id=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  })) as { transaction?: Record<string, unknown> } | null;

  const t = res?.transaction;
  if (!t) return { status: "waiting" };

  const status = String(t.status ?? "");
  const memoType = normaliseMemoType(t.withdraw_memo_type);

  switch (status) {
    case "pending_user_transfer_start": {
      const destination = String(t.withdraw_anchor_account ?? "");
      if (!destination) return { status: "waiting" };
      const memo = t.withdraw_memo != null && String(t.withdraw_memo) !== "" ? String(t.withdraw_memo) : null;
      // Same rule as at open time (see MEMO_REFUSAL): a memo without a usable type is not a
      // payment instruction, it is a way to lose the money. Terminal, and nothing has been paid.
      if (memo !== null && memoType === null) return { status: "failed", id, reason: MEMO_REFUSAL };
      return {
        status: "ready-to-pay",
        id,
        destination,
        memo,
        memoType,
        amountIn: t.amount_in ? String(t.amount_in) : null,
        amountOut: t.amount_out ? String(t.amount_out) : null,
        amountFee: t.amount_fee ? String(t.amount_fee) : null,
      };
    }
    case "completed":
      return { status: "settled", id };
    case "refunded":
      return { status: "refunded", id };
    case "error":
      return { status: "failed", id, reason: String(t.message ?? "the anchor reported a problem") };
    case "incomplete":
      return t.url ? { status: "interactive", url: String(t.url), id } : { status: "waiting" };
    case "pending_customer_info_update":
      // The rail wants identity information (SEP-12) before it goes on. This product does not
      // collect it, by decision, so this state would never resolve: report it as terminal now
      // rather than polling until the deadline and calling it "late".
      return {
        status: "failed",
        id,
        reason: "this rail wants identity information before it pays out, which this product does not collect",
      };
    default:
      // pending_anchor, pending_stellar, pending_external, pending_user_transfer_complete and
      // anything an anchor invents. All of them mean "not yet", never "finished".
      return { status: "waiting" };
  }
}

/* ------------------------------------------------------------------ */
/* SEP-6 deposit: lira in                                               */
/* ------------------------------------------------------------------ */

/** One line of the anchor's payment instructions, exactly as it sent it. */
export interface DepositInstruction {
  /** The anchor's field name, e.g. "bank_account_number". */
  key: string;
  value: string;
  /** The anchor's own description of the field, when it gave one. */
  description: string | null;
}

/** A deposit the anchor has opened: where the person sends the lira, and under which reference. */
export interface OpenedDeposit {
  id: string;
  /** In the order the anchor listed them. Shown verbatim; nothing here is rewritten. */
  instructions: DepositInstruction[];
  /** The anchor's own sentence (`extra_info.message`, else the deprecated `how`), verbatim. */
  note: string | null;
  /** Seconds the anchor expects, when it says. */
  eta: number | null;
  minAmount: string | null;
  maxAmount: string | null;
  feePercent: string | null;
}

/** A deposit, as far as this client is concerned. Anything unrecognised is `waiting`, never settled. */
export type AnchorDepositState =
  /** `awaiting-transfer`: the anchor waits for the bank transfer. `processing`: it has it and is paying. */
  | { status: "waiting"; stage: "awaiting-transfer" | "processing"; raw: string }
  | {
      status: "settled";
      id: string;
      /** The Stellar payment that brought the dollars in. */
      stellarTransactionId: string | null;
      /**
       * Set only when the anchor could not pay the account directly and set the asset aside as a
       * claimable balance instead (SEP-6 `claimable_balance_id`). When this is present the dollars
       * are NOT spendable yet: they wait on the ledger until the account claims them. A receipt
       * must say which of the two happened, because "arrived" means different things.
       */
      claimableBalanceId: string | null;
      amountIn: string | null;
      amountOut: string | null;
      amountFee: string | null;
    }
  | { status: "refunded"; id: string }
  | { status: "failed"; id: string; reason: string };

/**
 * SEP-6 `GET /deposit`: open a lira-in transfer to the person's own account.
 *
 * Plain `/deposit`, never `/deposit-exchange` and never a quote (decision D2): the anchor names
 * its own rate in its own sentence, which the screen shows verbatim. The asset code is bare
 * (`USDC`), the SEP-6 form. `funding_method` is the current SEP-6 name for how the fiat arrives
 * and `type` the older one the sandbox anchor still lists as required in `/info`; both are sent
 * with the same value so either reading of the spec is satisfied. The account must already hold
 * the trustline: every account the sponsor creates does, so `pending_trust` should never appear.
 *
 * `claimable_balance_supported=true` is the safety net under that last sentence. SEP-6 (sep-0006.md
 * line 508) has the client declare it can be paid with a `CreateClaimableBalance` when its account
 * cannot hold the asset, and this rail publishes `features.claimable_balances: true`. Without the
 * parameter an anchor's only other move is to park the transfer at `pending_trust`, which is
 * terminal here and occupies a slot in the rail's shared settlement queue. It is sent as the exact
 * string "true": the spec types this parameter as a string, and an anchor comparing it to "true"
 * counts nothing else. The branch should never fire for an account this product opened; if it
 * does, `readDeposit` reports the balance id rather than calling the dollars spendable.
 */
export async function startDeposit(
  info: AnchorInfo,
  token: string,
  params: { assetCode: string; account: string; amount: string; fundingMethod?: string; lang?: string },
): Promise<OpenedDeposit> {
  if (info.door !== "sep6") throw new Error("that anchor takes deposits on its own screen, which this product does not open");
  const method = params.fundingMethod ?? "bank_account";
  const q = new URLSearchParams();
  q.set("asset_code", params.assetCode);
  q.set("account", params.account);
  q.set("amount", params.amount);
  q.set("funding_method", method);
  q.set("type", method);
  q.set("claimable_balance_supported", "true");
  if (params.lang) q.set("lang", params.lang);

  const res = (await getJson(`${info.transferServer}/deposit?${q.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  })) as {
    id?: unknown;
    how?: unknown;
    eta?: unknown;
    min_amount?: unknown;
    max_amount?: unknown;
    fee_percent?: unknown;
    instructions?: Record<string, { value?: unknown; description?: unknown } | undefined>;
    extra_info?: { message?: unknown };
  } | null;

  const id = res?.id != null ? String(res.id) : "";
  if (!res || !id) throw new Error("that anchor could not open the deposit");

  const instructions: DepositInstruction[] = [];
  for (const [key, v] of Object.entries(res.instructions ?? {})) {
    if (!v || v.value == null || String(v.value) === "") continue;
    instructions.push({ key, value: String(v.value), description: v.description != null ? String(v.description) : null });
  }
  const text = (v: unknown) => (v != null && String(v).trim() !== "" ? String(v) : null);
  const num = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? String(v) : null);
  return {
    id,
    instructions,
    note: text(res.extra_info?.message) ?? text(res.how),
    eta: typeof res.eta === "number" && Number.isFinite(res.eta) ? res.eta : null,
    minAmount: num(res.min_amount),
    maxAmount: num(res.max_amount),
    feePercent: num(res.fee_percent),
  };
}

/**
 * Ask the anchor where a deposit stands. The same conservative rule as `readWithdrawal`: a status
 * we do not recognise is `waiting`, never settled, because calling an unknown state "done" is how
 * a screen tells someone money arrived when it did not.
 */
export async function readDeposit(info: AnchorInfo, token: string, id: string): Promise<AnchorDepositState> {
  const res = (await getJson(`${info.transferServer}/transaction?id=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  })) as { transaction?: Record<string, unknown> } | null;

  const t = res?.transaction;
  if (!t) return { status: "waiting", stage: "awaiting-transfer", raw: "" };
  const status = String(t.status ?? "");
  const str = (v: unknown) => (v != null && String(v) !== "" ? String(v) : null);

  switch (status) {
    case "completed":
      return {
        status: "settled",
        id,
        stellarTransactionId: str(t.stellar_transaction_id),
        // Present only when the anchor took the claimable-balance route (SEP-6 sets the status to
        // completed either way, so the id is the only thing that tells the two apart).
        claimableBalanceId: str(t.claimable_balance_id),
        amountIn: str(t.amount_in),
        amountOut: str(t.amount_out),
        amountFee: str(t.amount_fee),
      };
    case "refunded":
      return { status: "refunded", id };
    case "error":
      return { status: "failed", id, reason: str(t.message) ?? "the anchor reported a problem" };
    case "expired":
      return { status: "failed", id, reason: "the anchor let this deposit expire before the bank transfer arrived" };
    case "too_small":
    case "too_large":
      // The anchor's own sentence first: its figures are the ones that decided this, and on this
      // rail the published range is in dollars while the amount asked for was in lira.
      return { status: "failed", id, reason: str(t.message) ?? `the anchor refused the amount (${status.replace("_", " ")})` };
    case "no_market":
      return { status: "failed", id, reason: "the anchor has no market for this conversion right now" };
    case "pending_trust":
      // Every account the sponsor creates holds the trustline, so this means the account is not
      // one of ours in the state we expect. Terminal here: waiting would wait forever.
      return { status: "failed", id, reason: "this account cannot hold these dollars yet (no trustline)" };
    case "pending_customer_info_update":
      return { status: "failed", id, reason: "this rail wants identity information, which this product does not collect" };
    case "pending_transaction_info_update":
    case "pending_user":
      // The other two states SEP-6 defines as blocked on the PERSON, and the two the default
      // bucket used to swallow. Both wait for something this screen has no way to send (a PATCH
      // of the transaction's fields, or an action on the rail's own side), so polling them reads
      // as "the rail is working on it" while nothing is moving at all. Terminal, with whatever the
      // anchor said about what it wants, so the person hears it from the rail rather than waiting
      // out the clock. Nothing has been paid from the account on this path either way.
      return {
        status: "failed",
        id,
        reason: str(t.required_info_message) ?? str(t.message) ?? "this rail is waiting on something it has not asked for in a way this screen can answer",
      };
    case "incomplete":
    case "pending_user_transfer_start":
      return { status: "waiting", stage: "awaiting-transfer", raw: status };
    default:
      // pending_user_transfer_complete, pending_external, pending_anchor, pending_stellar,
      // on_hold (a review the rail clears by itself) and anything an anchor invents: the transfer
      // is in, the dollars are not here yet.
      return { status: "waiting", stage: "processing", raw: status };
  }
}

/**
 * THE SANDBOX'S BANK, not a Stellar standard. The Turkish sandbox anchor exposes
 * `POST /sep6/tx/{id}/simulate-bank-transfer` so a test can play the person's bank and say "the
 * lira arrived". It exists only on test deployments, and a real anchor learns this from its bank,
 * never from us. So this refuses unless both our network and the anchor's declared network are
 * the test network: on real money the button must not exist and the call must not be possible.
 */
export async function simulateBankTransfer(
  info: AnchorInfo,
  id: string,
  amount: string,
  net: NetworkConfig = activeNetwork(),
): Promise<void> {
  if (net.isMainnet || net.passphrase !== TESTNET_PASSPHRASE) throw new Error("the simulated bank transfer exists only on the test network");
  if (info.networkPassphrase !== TESTNET_PASSPHRASE) throw new Error("that anchor is not a test-network anchor");
  await getJson(`${info.transferServer}/tx/${encodeURIComponent(id)}/simulate-bank-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount }),
  });
}

/* ------------------------------------------------------------------ */
/* SEP-38: what the person will actually receive                       */
/* ------------------------------------------------------------------ */

export interface AnchorQuote {
  /** The anchor's own id for this quote, passed back when the withdrawal is opened. */
  id: string;
  /** Dollars leaving. */
  sellAmount: string;
  /** Local currency arriving. */
  buyAmount: string;
  /**
   * SEP-38 defines price as sell-asset units per ONE unit of the buy asset, so for a dollar-to-lira
   * quote this is dollars per lira (about 0.02), not lira per dollar. Verified against the live
   * sandbox: `sell 5 -> buy 240.94, price 0.0206`. Show `buyAmount`; do not multiply by this.
   */
  price: string;
  /** When the quote stops being honoured. */
  expiresAt: string;
}

/**
 * Ask what a given number of dollars turns into, and hold that answer.
 *
 * A firm quote, not an indicative one: the person is about to be shown a figure and then asked to
 * approve a transfer against it, so the rate has to be the one that will be used. An indicative
 * price shown as a promise is the kind of small dishonesty that this product does not do.
 *
 * The quote expires. The caller is expected to show that, and to refuse to send against a stale
 * one rather than send and hope.
 */
export async function requestQuote(
  info: AnchorInfo,
  token: string,
  params: { sellAssetCode: string; sellAssetIssuer: string; buyAsset: string; sellAmount: string },
): Promise<AnchorQuote> {
  if (!info.quoteServer) throw new Error("that anchor does not quote a rate");
  const res = (await getJson(`${info.quoteServer}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      sell_asset: `stellar:${params.sellAssetCode}:${params.sellAssetIssuer}`,
      buy_asset: params.buyAsset,
      sell_amount: params.sellAmount,
      // How the money leaves the anchor at the far end. Named explicitly because an anchor may
      // price a bank transfer and a cash pickup differently.
      buy_delivery_method: "bank_account",
      // Required by SEP-38 on POST /quote (sep-0038.md line 579: one of sep6, sep24, sep31). The
      // sandbox anchor does not enforce it; a stricter anchor refuses the quote without it.
      context: "sep6",
    }),
  })) as { id?: string; sell_amount?: string; buy_amount?: string; price?: string; expires_at?: string } | null;

  if (!res?.id || !res.buy_amount) throw new Error("that anchor did not return a usable quote");
  return {
    id: res.id,
    sellAmount: res.sell_amount ?? params.sellAmount,
    buyAmount: res.buy_amount,
    price: res.price ?? "",
    expiresAt: res.expires_at ?? "",
  };
}

/* ------------------------------------------------------------------ */
/* SEP-12: where the local currency lands                              */
/* ------------------------------------------------------------------ */

/**
 * Tell the anchor which bank account the person wants their money in.
 *
 * THE LINE THIS DOES AND DOES NOT CROSS, because it is worth being explicit. This product does not
 * collect, hold or forward identity documents, and that is deliberate: the anchor performs its own
 * checks, under its own licence, and we never see a passport or a national id number. That stays
 * true here.
 *
 * What this sends is a destination the person typed, for their own withdrawal. It is the same
 * category of thing as the exchange deposit address the cash-out screen has always accepted: an
 * answer to "where should this money go", not an answer to "who are you". Without it the anchor
 * pays whatever account it happens to have on file, which for a sandbox is a default that belongs
 * to nobody, and a screen that asks for a bank account and then ignores it would be a prop.
 *
 * Send this field and nothing else. If an anchor demands documents, that is the point to stop and
 * hand the person to the anchor's own hosted screen instead.
 */
export async function setBankAccount(
  info: AnchorInfo,
  token: string,
  params: { account: string; bankAccountNumber: string; bankName?: string },
): Promise<void> {
  if (!info.kycServer) throw new Error("that anchor does not accept a payout destination");
  await getJson(`${info.kycServer}/customer`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      account: params.account,
      type: "sep6-withdraw",
      bank_account_number: params.bankAccountNumber,
      ...(params.bankName ? { bank_name: params.bankName } : {}),
    }),
  });
}
