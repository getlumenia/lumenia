/**
 * Make one link, in the background worker.
 *
 * Order matters and is the whole design:
 *   1. every refusal that can be known BEFORE signing is made first (consent, account, amount, the
 *      real-money gate, the session, the balance), so nothing is signed that cannot go through;
 *   2. the deposit is built and signed by the same createV2Link the website uses, on the network the
 *      user chose, carrying `src=ext`;
 *   3. in its `onPrepared` hook, BEFORE the POST, the full link is sealed in IndexedDB and a
 *      `submitted` record is written. A worker that dies after this point leaves a record the settle
 *      loop finishes by reading the escrow; one that dies before it has submitted nothing;
 *   4. the answer is judged by lib/errors.ts: provably nothing moved -> failed; anything else that
 *      is not a confirmation -> uncertain, which is NEVER retried automatically. A 2xx counts as a
 *      confirmation only with the transaction hash the sponsor always sends; without one, the
 *      escrow is read before the link is called made.
 *
 * While an earlier send on the same network is posted and unconfirmed, another one needs the
 * person's explicit "send a new one anyway" (`anyway`): if the first went through, a second
 * escrows the money twice. This is checked against the stored records, so it holds across a
 * worker restart, where the in-memory "busy" guard does not.
 *
 * The real-money gate mirrors apps/web/lib/wallet.tsx (getSigner): a mainnet send needs a
 * password-locked (Phase-2) account. The sponsor does not check that; this does, exactly as the
 * website does. The pilot allowlist and the caps are the sponsor's to enforce; they are checked
 * here only to say so before anything is signed.
 */
import { claimPasswordProblem, type NetworkConfig, type PreparedDeposit, type Signer, type createV2Link } from "../core";
import { LINK_TTL_S, SRC, WEB_ORIGIN } from "../config";
import { exceedsBalance, parseAmount } from "../lib/amount";
import { ExtError, MESSAGES, fail, judgeDepositFailure, toFailure } from "../lib/errors";
import { confirm, fromPrepared, markFailed, markUncertain, unconfirmedSend } from "../lib/links";
import type { BalanceInfo, LinkRecord, NetId, PilotInfo, SendOutcome, Settings } from "../lib/types";
import { canSendRealMoney } from "./pilot";

export interface SendRequest {
  amount: string;
  from: string;
  password?: string;
  /** the person saw that an earlier send is unconfirmed and chose to make a new link anyway */
  anyway?: boolean;
}

export interface SendDeps {
  now(): number;
  settings(): Promise<Settings>;
  account(): Promise<{ pubkey: string; phase: 1 | 2 } | null>;
  signer(pubkey: string): Promise<Signer>;
  pilot(pubkey: string): Promise<PilotInfo>;
  balance(pubkey: string, net: NetworkConfig): Promise<BalanceInfo>;
  netConfig(id: NetId): NetworkConfig;
  createLink: typeof createV2Link;
  /** the escrow's answer to "did this deposit land?" (v2DepositLanded) */
  landed(linkHex: string, sender: string, net: NetworkConfig): Promise<boolean | "unknown">;
  records(): Promise<LinkRecord[]>;
  seal(linkHex: string, link: string): Promise<void>;
  putRecord(r: LinkRecord): Promise<void>;
  beacon(event: "send_started" | "send_link_created", pubkey: string, net: NetworkConfig): void;
}

export async function runSend(deps: SendDeps, req: SendRequest): Promise<SendOutcome> {
  const settings = await deps.settings();
  if (!settings.consentAt) throw fail("needs-consent");
  const acct = await deps.account();
  if (!acct) throw fail("no-account");
  const netId = settings.net;
  const net = deps.netConfig(netId);
  const amount = parseAmount(req.amount, netId);
  if (!req.anyway && unconfirmedSend(await deps.records(), netId, deps.now())) throw fail("open-send");
  const from = req.from.trim().slice(0, 40);
  const password = req.password ? req.password : undefined;
  if (password) {
    const problem = claimPasswordProblem(password);
    if (problem) throw new ExtError("weak-link-password", problem);
  }

  if (net.isMainnet) {
    // Real money never sits under a key that opens without a password (wallet.tsx getSigner).
    if (acct.phase !== 2) throw fail("needs-password");
    if (!settings.mainnetAck) throw new ExtError("not-approved", "Read the real-money note in Settings and accept it first.");
    const p = await deps.pilot(acct.pubkey);
    if (!p.approved) throw fail("not-approved");
    if (!canSendRealMoney(p)) throw fail("slots-used");
  }

  const signer = await deps.signer(acct.pubkey);
  const bal = await deps.balance(acct.pubkey, net);
  if (bal.missing) throw fail("account-not-found");
  if (exceedsBalance(amount, bal.usd)) throw fail("not-enough-money");

  deps.beacon("send_started", acct.pubkey, net);
  const kept: { record: LinkRecord | null } = { record: null };
  const expiry = Math.floor(deps.now() / 1000) + LINK_TTL_S;
  let made: Awaited<ReturnType<typeof createV2Link>>;
  try {
    made = await deps.createLink({
      signer,
      amount,
      from: from || "Someone",
      webOrigin: WEB_ORIGIN,
      sponsorUrl: net.sponsorUrl,
      net,
      expiry,
      password,
      src: SRC,
      onPrepared: async (p: PreparedDeposit) => {
        // The link first: if it cannot be kept, nothing is posted and nothing moves.
        await deps.seal(p.linkHex, p.link);
        const record = fromPrepared(p, {
          net: netId,
          sender: acct.pubkey,
          from,
          locked: Boolean(password),
          now: deps.now(),
          contract: net.contract,
        });
        await deps.putRecord(record);
        kept.record = record;
      },
    });
  } catch (e) {
    if (!kept.record) {
      // Nothing was signed and kept, so nothing can have moved.
      const f = toFailure(e);
      throw new ExtError(f.code, f.message);
    }
    const verdict = judgeDepositFailure(e, { mainnet: net.isMainnet });
    if (verdict.kind === "uncertain") {
      await deps.putRecord(markUncertain(kept.record, deps.now(), verdict.why));
      throw new ExtError("uncertain", MESSAGES.uncertain);
    }
    await deps.putRecord(markFailed(kept.record, verdict.message, deps.now()));
    throw new ExtError(verdict.code, verdict.message);
  }

  // The deposit went out and was answered. From here no failure may read as "nothing moved": the
  // worst that is true is that we could not confirm it, and the settle loop reads the escrow.
  const kept1 = kept.record;
  if (!kept1) throw new ExtError("uncertain", MESSAGES.uncertain);
  try {
    const hash = /^[0-9a-f]{64}$/i.test(made.hash) ? made.hash : undefined;
    if (!hash) {
      // The sponsor's 200 always names the transaction. An answer without one (an empty body, a
      // proxy), or a dropped connection that lumendrop.ts settled by reading the escrow, is
      // confirmed only by the escrow holding the drop now.
      const landed = await deps.landed(kept1.linkHex, acct.pubkey, net).catch(() => "unknown" as const);
      if (landed !== true) throw new ExtError("uncertain", "the answer did not name a transaction");
    }
    const record = confirm(kept1, hash, deps.now());
    await deps.putRecord(record);
    deps.beacon("send_link_created", acct.pubkey, net);
    return { linkHex: record.linkHex, record, link: made.link };
  } catch (e) {
    const why = e instanceof ExtError && e.code === "uncertain" ? e.message : "the answer could not be kept";
    await deps.putRecord(markUncertain(kept1, deps.now(), why)).catch(() => undefined);
    throw new ExtError("uncertain", MESSAGES.uncertain);
  }
}
