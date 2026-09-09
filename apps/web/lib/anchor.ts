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
 * its comment for where that line sits. It does not persist the session token. It does not
 * deposit, only withdraw, because the direction this product needs first is dollars out to local
 * currency. SEP-38 is limited to `requestQuote`: a firm quote for the figure shown before the
 * person approves, never an indicative one dressed up as a promise.
 *
 * DECISION 2026-09-09 (owner, on the organiser's guidance): for the hackathon period the product
 * uses SEP-6 ONLY, plus the SEP-1 discovery and SEP-10 sign-in that SEP-6 cannot work without.
 * `requestQuote` (SEP-38) and `setBankAccount` (SEP-12) stay here, tested, and are called by no
 * product surface. The bank screen opens a plain `/withdraw` and shows the anchor's own sentence
 * about the rate and the payout account instead of a quote of ours.
 *
 * HONESTY. Whether any given anchor actually settles in a particular currency is the anchor's
 * claim, not ours. `readAnchorInfo` reports what the anchor publishes and nothing more.
 */
import { Transaction, WebAuth } from "@stellar/stellar-sdk";
import type { Signer } from "./signer";
import { activeNetwork, type NetworkConfig } from "./network";

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
  const token = (await getJson(info.webAuthEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: signed.toXDR() }),
  })) as { token?: string } | null;

  if (!token?.token) throw new Error("that anchor refused the sign-in");
  return token.token;
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
    /** SEP-6 only. Where the fiat lands, when the anchor asks for it. */
    dest?: string;
    /**
     * SEP-6 -exchange only. The issuer of the asset LEAVING. Required, because a SEP-38 asset
     * identifier is `stellar:CODE:ISSUER`: a bare `stellar:USDC` names no particular dollar.
     */
    assetIssuer?: string;
    /** SEP-6 -exchange only. What the person receives, e.g. "iso4217:TRY". */
    destinationAsset?: string;
    /** SEP-6 -exchange only. A SEP-38 quote id, so the rate is locked. */
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

  // SEP-6. Cross-currency goes through -exchange; a same-asset withdrawal uses plain /withdraw.
  //
  // Two things here were wrong in the first draft and were caught by probing the live Turkish
  // sandbox anchor rather than by reading the spec, so they are pinned by the self-test now:
  //   1. `asset_code` is required on BOTH paths. The -exchange variant does not replace it with
  //      `source_asset`, it adds to it. Omitting it answers 400 "'asset_code' is required".
  //   2. A SEP-38 asset identifier carries the issuer: `stellar:USDC:GBBD…FLA5`. Sending a bare
  //      `stellar:USDC` names no particular dollar, and the anchor rejects it.
  const exchange = Boolean(params.destinationAsset);
  const q = new URLSearchParams();
  q.set("asset_code", params.assetCode);
  if (exchange) {
    if (!params.assetIssuer) {
      throw new Error("a cross-currency withdrawal needs the issuer of the asset being sent");
    }
    q.set("source_asset", `stellar:${params.assetCode}:${params.assetIssuer}`);
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
    /* The spec form first, the anchor's dialect second. SEP-6 defines `source_asset` as a SEP-38
     * asset id (`stellar:CODE:ISSUER`), and on 2026-09-06 the sandbox anchor refused anything
     * else. On 2026-09-09 the same anchor refused exactly that form ("unsupported source_asset
     * ... this anchor ramps USDC") and accepted the bare code. Anchors under active development
     * move; a client that dies on the first dialect it did not expect is a demo that fails on
     * stage. So: if the refusal names `source_asset`, retry once with the bare code. Nothing has
     * been paid at this point, so the retry costs a request and nothing else. */
    const msg = e instanceof Error ? e.message : "";
    if (!exchange || !/source_asset/i.test(msg)) throw e;
    q.set("source_asset", params.assetCode);
    res = (await getJson(`${info.transferServer}/${path}?${q.toString()}`, { headers: auth })) as Opened;
  }

  const id = res?.id;
  const destination = res?.account_id;
  if (!res || !id) throw new Error("that anchor could not start the withdrawal");
  // An anchor that opens a withdrawal without naming where to pay has told us nothing usable.
  // Refuse rather than carry a half-answer into the money path.
  if (!destination) throw new Error("that anchor did not say where to send the money");

  return {
    kind: "ready-to-pay",
    id,
    destination,
    memo: res.memo ? String(res.memo) : null,
    memoType: normaliseMemoType(res.memo_type),
    note: res.extra_info?.message ? String(res.extra_info.message) : null,
  };
}

/** SEP-6 and SEP-24 both use this vocabulary. Anything else is dropped, never guessed. */
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
      return {
        status: "ready-to-pay",
        id,
        destination,
        memo: t.withdraw_memo ? String(t.withdraw_memo) : null,
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
    default:
      // pending_anchor, pending_stellar, pending_external, pending_user_transfer_complete and
      // anything an anchor invents. All of them mean "not yet", never "finished".
      return { status: "waiting" };
  }
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
