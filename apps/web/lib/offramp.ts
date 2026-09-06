/**
 * Off-ramp exit adapters (architecture-review conditions #3 + #4).
 *
 * OUTSIDE the trust boundary. Off-ramp is the user's own edge choice; every
 * value move here is signed by the RECIPIENT's own key (never the sponsor KMS).
 * Each path is an independent, removable adapter behind one interface — if a
 * card/exchange policy changes, the core claim flow is unaffected.
 *
 * WHAT CHANGED, AND WHY. This registry sat empty for months with both adapters
 * commented out, because neither had a real counterparty. The anchor adapter below is the first
 * one with an actual protocol behind it: SEP-1 discovery, SEP-10 authentication and a SEP-24
 * hosted withdrawal, implemented in ./anchor.ts against the pinned Stellar SDK with no new
 * dependency.
 *
 * THE ADAPTER MOVES NO MONEY. A SEP-24 withdrawal ends with the anchor naming an account, a memo
 * and an amount. That is exactly what ./payout.ts already builds, validates and fee-bumps through
 * the sponsor's tight PAYOUT policy. So this adapter discovers, authenticates, opens the anchor's
 * own hosted screen and waits; when the anchor names a destination it calls back to the host,
 * which performs the payment on the existing hardened path. Every guard that protects a manual
 * cash-out protects an anchor withdrawal unchanged, and no new value route was added to the
 * sponsor to support this.
 *
 * NOTE (code review): the CCTP amount decimal scale (USDC 6 vs Stellar SAC 7) is
 * UNVERIFIED until a funded burn — confirm before any real value moves.
 */
import { anchorHomeDomain, authenticate, readAnchorInfo, readWithdrawal, startWithdrawal } from "./anchor";
import type { AnchorInfo } from "./anchor";
import type { Signer } from "./signer";

export type OffRampKind = "card" | "exchange" | "cctp-bridge" | "anchor";

/** Status surfaced to the UI as plain "spend / send to bank" — never crypto terms. */
export type OffRampStatus =
  | "idle"
  | "pending"
  | "attestation"
  | "settling"
  | "done"
  | "failed"
  /** The anchor needs the person on its own screen before it can go further. */
  | "needs-the-person"
  /** The anchor has named where to pay; the host now performs the transfer. */
  | "sending";

export interface OffRampQuote {
  kind: OffRampKind;
  /** What the user sees: dollars in, lira out (indicative). */
  usdIn: string;
  tryOut: string;
  etaSeconds: number;
  /** True if this path avoids the MASAK 72h first-withdrawal hold (card spend does). */
  avoidsBankHold: boolean;
}

export interface OffRampAdapter {
  readonly kind: OffRampKind;
  quote(usdAmount: string): Promise<OffRampQuote>;
  /** Recipient-signed; pluggable. CCTP returns through pending→attestation→settling→done. */
  start(usdAmount: string, onStatus: (s: OffRampStatus) => void): Promise<void>;
}

/**
 * What the anchor adapter needs from its host.
 *
 * Both callbacks exist so this module never opens a window and never moves money itself. The host
 * owns both, which keeps the popup policy in the UI layer and the payment on the audited path.
 */
export interface AnchorHost {
  signer: Signer;
  /** The account the dollars leave from, and the account SEP-10 authenticates. */
  account: string;
  /** Asset code the anchor knows, normally USDC. */
  assetCode: string;
  /**
   * Issuer of `assetCode`. Required for a cross-currency exit, because a SEP-38 asset identifier
   * is `stellar:CODE:ISSUER` and a bare `stellar:USDC` names no particular dollar. It must be the
   * issuer the ANCHOR knows, which is not automatically the one this product escrows.
   */
  assetIssuer?: string;
  /**
   * SEP-6 only. What the person actually receives, in SEP-38 notation, e.g. "iso4217:TRY".
   * Naming it is what turns a transfer into an exit into local currency.
   */
  fiatAsset?: string;
  /** SEP-6 only. Where the fiat lands, when the anchor asks for it. An IBAN, typically. */
  fiatDestination?: string;
  /**
   * SEP-6 only. A SEP-38 quote the person has already been shown, so the anchor is held to that
   * rate rather than repricing at execution. Without it the anchor prices live, and the figure on
   * the review screen was an estimate dressed up as a promise.
   */
  quoteId?: string;
  /** Show the anchor's own hosted screen. The host decides popup versus redirect. */
  openInteractive(url: string): void | Promise<void>;
  /**
   * Perform the transfer the anchor asked for, on the existing payout path.
   * The host is expected to call lib/payout.ts::sendOut, which carries the memo through the
   * fee-bump and applies the whole unconfirmed-submit doctrine.
   */
  pay(request: { destination: string; memo: string | null; memoType: "text" | "id" | "hash" | null; amount: string }): Promise<void>;
}

/** How long to wait for the person to finish on the anchor's screen before giving up. */
const INTERACTIVE_TIMEOUT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A SEP-24 withdrawal, driven to the point where the money leaves on the existing payout path.
 *
 * `quote` reports only what can be known before authenticating, which is nothing about price. It
 * deliberately does not invent a lira figure: the anchor quotes the rate on its own screen, and a
 * made-up number on the way in would be the kind of claim this codebase does not make.
 */
/**
 * Timing, injectable only so a test can drive the poll loop without waiting real seconds. The
 * defaults are the production values and nothing in the app passes this.
 */
export interface AnchorPolling {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export function createAnchorAdapter(
  host: AnchorHost,
  homeDomain = anchorHomeDomain(),
  polling: AnchorPolling = {},
): OffRampAdapter | null {
  if (!homeDomain) return null;
  const pollMs = polling.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = polling.timeoutMs ?? INTERACTIVE_TIMEOUT_MS;

  let cached: AnchorInfo | null = null;
  const info = async (): Promise<AnchorInfo> => (cached ??= await readAnchorInfo(homeDomain));

  return {
    kind: "anchor",

    async quote(usdAmount: string): Promise<OffRampQuote> {
      await info();
      return {
        kind: "anchor",
        usdIn: usdAmount,
        // The anchor prices the exit on its own screen. We do not guess it here.
        tryOut: "",
        etaSeconds: 0,
        avoidsBankHold: false,
      };
    },

    async start(usdAmount: string, onStatus: (s: OffRampStatus) => void): Promise<void> {
      onStatus("pending");
      const anchor = await info();

      // Session token is held here, in memory, for the life of this call only. It is a bearer
      // credential for this account at this anchor and is never written anywhere.
      const token = await authenticate(anchor, host.signer);

      const opened = await startWithdrawal(anchor, token, {
        assetCode: host.assetCode,
        account: host.account,
        amount: usdAmount,
        // SEP-6 only, and ignored by a SEP-24 anchor. The cross-currency variant is what makes
        // this a lira exit rather than a same-asset transfer, and it is why the anchor is worth
        // integrating at all.
        ...(anchor.door === "sep6"
          ? {
              destinationAsset: host.fiatAsset,
              dest: host.fiatDestination,
              // Carried here too, or the cross-currency call below refuses: the issuer is half of
              // the asset's identity, not decoration.
              assetIssuer: host.assetIssuer,
              quoteId: host.quoteId,
            }
          : {}),
      });
      const id = opened.id;

      /**
       * A withdrawal is paid ONCE, and this flag is the only thing that guarantees it.
       *
       * The anchor stays at `pending_user_transfer_start` until it sees the payment land on the
       * ledger, which on the Turkish sandbox ramp takes about ten seconds. This loop polls every
       * three. So without a latch, the status has not changed yet on the next three or four
       * passes, `readWithdrawal` truthfully answers "ready to pay", and each pass sends another
       * real payment to a pooled treasury account. Every one of them is individually valid,
       * correctly memoed and signed by the person's own key, so nothing downstream refuses it,
       * and none of it is recoverable.
       *
       * "settling" is what "we have paid and the anchor has not agreed yet" looks like. It is not
       * a state this loop may leave by paying again.
       */
      let paid = false;

      // SEP-6 names the destination immediately, so there is no screen to send anyone to. SEP-24
      // needs the person on the anchor's own page first.
      if (opened.kind === "ready-to-pay") {
        onStatus("sending");
        paid = true;
        await host.pay({
          destination: opened.destination,
          memo: opened.memo,
          memoType: opened.memoType,
          amount: usdAmount,
        });
        onStatus("settling");
      } else {
        onStatus("needs-the-person");
        await host.openInteractive(opened.url);
      }

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (Date.now() > deadline) {
          onStatus("failed");
          throw new Error("that withdrawal was not finished in time");
        }
        await sleep(pollMs);

        const state = await readWithdrawal(anchor, token, id);

        if (state.status === "ready-to-pay") {
          // Already handed over. The anchor has simply not noticed yet. Wait, do not pay again.
          if (paid) {
            onStatus("settling");
            continue;
          }
          onStatus("sending");
          // Set BEFORE the attempt, on purpose. If this payment turns out to be undecided rather
          // than failed, the money may already be on the ledger, and a second attempt would be
          // the one mistake with no way back. A withdrawal that never gets paid times out below
          // and the person can start again; a withdrawal paid twice is simply gone.
          paid = true;
          await host.pay({
            destination: state.destination,
            memo: state.memo,
            memoType: state.memoType,
            amount: state.amountIn ?? usdAmount,
          });
          onStatus("settling");
          continue;
        }
        if (state.status === "settled") return onStatus("done");
        if (state.status === "refunded") {
          onStatus("failed");
          throw new Error("the anchor sent that money back");
        }
        if (state.status === "failed") {
          onStatus("failed");
          throw new Error(state.reason);
        }
        // "waiting" and "interactive" both mean not yet. Never treat an unrecognised
        // status as finished.
      }
    },
  };
}

/** Registry so the UI offers whatever adapters are enabled; none selected → user just holds dollars. */
export const offRampAdapters: Partial<Record<OffRampKind, OffRampAdapter>> = {
  // card: createKastAdapter(),       // v1 user-facing (stub)
  // "cctp-bridge": createCctpAdapter(), // fallback, Stellar-side proven in Spike #4 (stub)
  // anchor: built per host at call time by createAnchorAdapter(), since it needs a signer.
};
