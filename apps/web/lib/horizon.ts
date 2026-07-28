/**
 * Client-side Horizon reads for the app shell (FRONTEND_PLAN §0/§9: /home reads
 * straight from Horizon, no proxy, no DB — "status from the ledger, not our
 * server"). Balance + activity are REAL testnet data (no-mock-data rule); an
 * account that doesn't exist yet returns an honest null / empty list.
 */
import { Horizon } from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

export interface Balance {
  /** USDC balance the recipient holds, as a decimal string. */
  usd: string;
  /** The trustline's issuer — lets other reads pin the exact asset, not just the code. */
  issuer?: string;
}

export interface IncomingClaim {
  balanceId: string;
  usd: string;
  at: string; // ISO timestamp (last modified)
}

export interface ActivityItem {
  id: string;
  direction: "in" | "out";
  usd: string;
  at: string; // ISO timestamp
}

export interface ReclaimableSend {
  balanceId: string;
  usd: string;
  at: string; // ISO (last modified)
  /** ISO time the reclaim window opened (already in the past for a reclaimable send). */
  reclaimableAt: string;
}

function server(): Horizon.Server {
  return new Horizon.Server(HORIZON_URL);
}

// USDC carries 7 decimals; sum in integer stroops so many small balances add up
// without float drift, then render back to a decimal string.
function usdToStroops(dec: string): bigint {
  const [whole, frac = ""] = dec.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole || "0") * 10_000_000n + BigInt(fracPadded || "0");
}
function stroopsToUsd(s: bigint): string {
  const whole = s / 10_000_000n;
  const frac = (s % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

/**
 * ONE total USDC across several accounts — the home account plus any not-yet-swept
 * throwaway accounts (RECOVERY_ARCHITECTURE §3.1). The user always sees a single
 * number; the split into multiple accounts is plumbing, never UI. Returns the total
 * as a decimal string plus the per-account breakdown (so /home can consolidate each
 * throwaway and pin the right trustline issuer). Missing accounts count as 0.
 */
export async function loadTotalUsd(
  addresses: string[],
): Promise<{ usd: string; perAccount: { address: string; usd: string; issuer?: string }[] }> {
  const perAccount = await Promise.all(
    addresses.map(async (address) => {
      const b = await loadBalance(address);
      return { address, usd: b?.usd ?? "0", issuer: b?.issuer };
    }),
  );
  const total = perAccount.reduce((sum, p) => sum + usdToStroops(p.usd), 0n);
  return { usd: stroopsToUsd(total), perAccount };
}

/** The account's USDC balance, or null if the account doesn't exist yet. */
export async function loadBalance(address: string): Promise<Balance | null> {
  try {
    const acc = await server().loadAccount(address);
    const usdc = acc.balances.find(
      (b) => "asset_code" in b && b.asset_code === "USDC",
    ) as { balance: string; asset_issuer?: string } | undefined;
    return { usd: usdc?.balance ?? "0", issuer: usdc?.asset_issuer };
  } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status === 404) return null;
    throw e;
  }
}

/**
 * Money waiting to be collected: open Claimable Balances where THIS account is an
 * UNCONDITIONAL claimant (a paid request, or any transfer straight to the address).
 * The account's own outgoing sends never match — there it is the reclaim claimant,
 * whose predicate is time-locked, not unconditional. Pinned to the account's own
 * trustline asset (code + issuer), so a look-alike token can't pose as money.
 *
 * Horizon's claimant filter matches CBs where the address is ANY claimant, so the
 * account's own open outgoing sends occupy page rows before the client-side
 * filter runs. limit(200) is Horizon's max page; an active sender's open links
 * can no longer bury a genuinely-waiting payment behind a 20-row page. Residual:
 * beyond 200 open rows (deliberate dust-spam) needs pagination — noted, not built.
 */
export async function loadIncomingClaims(address: string, issuer: string): Promise<IncomingClaim[]> {
  try {
    const page = await server().claimableBalances().claimant(address).limit(200).order("desc").call();
    return page.records
      .filter((cb) => {
        const mine = cb.claimants.find((c) => c.destination === address);
        return (
          cb.asset === `USDC:${issuer}` &&
          (mine?.predicate as { unconditional?: boolean } | undefined)?.unconditional === true
        );
      })
      .map((cb) => ({
        balanceId: cb.id,
        usd: cb.amount,
        at: (cb as unknown as { last_modified_time?: string }).last_modified_time ?? "",
      }));
  } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status === 404) return [];
    throw e;
  }
}

/**
 * Your OWN sends that have come back to you: open Claimable Balances where THIS account is
 * the SENDER-RECLAIM claimant — a `not(before-time)` predicate — whose window has already
 * PASSED (the recipient never claimed and the reclaim window is up). You can take that money
 * back gaslessly via /feebump (a reclaim IS a claimClaimableBalance sourced by you — proven
 * by spike9). Still present in Horizon ⇒ unclaimed. This is the exact mirror of
 * loadIncomingClaims: incoming = your UNCONDITIONAL claimant; reclaimable = your time-locked
 * claimant with an elapsed window. Pinned to the account's own trustline asset.
 */
export async function loadReclaimableSends(address: string, issuer: string): Promise<ReclaimableSend[]> {
  try {
    const now = Date.now();
    const page = await server().claimableBalances().claimant(address).limit(200).order("desc").call();
    const out: ReclaimableSend[] = [];
    for (const cb of page.records) {
      if (cb.asset !== `USDC:${issuer}`) continue;
      const mine = cb.claimants.find((c) => c.destination === address);
      const not = (mine?.predicate as { not?: { abs_before?: string; abs_before_epoch?: string } } | undefined)?.not;
      if (!not) continue; // not the time-locked reclaim claimant (unconditional = incoming, handled elsewhere)
      // Horizon resolves the relative predicate to an absolute cutoff: reclaimable once now >= it.
      const openMs = not.abs_before
        ? Date.parse(not.abs_before)
        : not.abs_before_epoch
          ? Number.parseInt(not.abs_before_epoch, 10) * 1000
          : NaN;
      if (!Number.isFinite(openMs) || openMs > now) continue; // window not open yet
      out.push({
        balanceId: cb.id,
        usd: cb.amount,
        at: (cb as unknown as { last_modified_time?: string }).last_modified_time ?? "",
        reclaimableAt: not.abs_before ?? new Date(openMs).toISOString(),
      });
    }
    return out;
  } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status === 404) return [];
    throw e;
  }
}

/**
 * A public transfer record by its transaction hash (for /tools/verify). Returns
 * null if there's no such transaction. Plain "was it real + when", no jargon.
 */
export async function loadTransfer(
  hash: string,
): Promise<{ successful: boolean; createdAt: string } | null> {
  try {
    const tx = await server().transactions().transaction(hash).call();
    return { successful: tx.successful, createdAt: tx.created_at };
  } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status === 404) return null;
    throw e;
  }
}

/**
 * A sent link's status straight from the ledger (FRONTEND_PLAN §1: /sent status =
 * Horizon reads on the claimable-balance id — no DB). "pending" = the balance still
 * exists (waiting to be claimed); "settled" = it's gone (claimed by the recipient,
 * or reclaimed by the sender after 7 days).
 */
export async function loadLinkStatus(balanceId: string): Promise<"pending" | "settled"> {
  try {
    await server().claimableBalances().claimableBalance(balanceId).call();
    return "pending";
  } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status === 404) return "settled";
    throw e;
  }
}

/**
 * Is this effect a movement of the EXACT dollars this account holds?
 *
 * The issuer check is not pedantry. Anyone can issue an asset and call it USDC; matching on the
 * code alone would render a stranger's look-alike token as money in someone's activity list.
 * loadIncomingClaims already pins the issuer, and this now matches it. The parameter stays
 * optional so an older call site degrades to the previous behaviour rather than throwing, but
 * every call site in this repo passes it.
 */
export function isUsdcMovement(effect: unknown, issuer?: string): boolean {
  const e = effect as { type?: string; asset_code?: string; asset_issuer?: string };
  if (e.type !== "account_credited" && e.type !== "account_debited") return false;
  if (e.asset_code !== "USDC") return false;
  return issuer ? e.asset_issuer === issuer : true;
}

/** Map a matching effect to the UI shape. Pure, so the self-test can drive it with no network. */
export function toActivityItem(effect: unknown): ActivityItem {
  const e = effect as { id: string; type: string; amount: string; created_at: string };
  return {
    id: e.id,
    direction: e.type === "account_credited" ? "in" : "out",
    usd: e.amount,
    at: e.created_at,
  };
}

/**
 * Page Horizon's effects until we have `want` MATCHES, or run out.
 *
 * The bug this exists to kill: Horizon applies `.limit()` on the server and the USDC filter runs
 * here, afterwards. A freshly claimed account's newest effects are its CREATION effects
 * (account_created, trustline_created, two sponsorship effects, signer_created), so asking for 8
 * rows and filtering returned an empty list for an account that had just received $20 — /account
 * said "No money in or out yet" while the balance above it said $20.
 *
 * Cost: the common case (an account with recent movement) still takes ONE request, because we only
 * page when the first page came back short. maxPages bounds a noisy account so this can never spin.
 */
async function pageActivity(
  address: string,
  want: number,
  issuer?: string,
  maxPages = 4,
): Promise<ActivityItem[]> {
  const out: ActivityItem[] = [];
  let page = await server().effects().forAccount(address).order("desc").limit(200).call();
  for (let i = 0; i < maxPages; i++) {
    for (const rec of page.records) {
      if (isUsdcMovement(rec, issuer)) out.push(toActivityItem(rec));
      if (out.length >= want) return out;
    }
    if (page.records.length === 0) break;
    page = await page.next();
  }
  return out;
}

/**
 * Money in/out for ONE account, newest first — derived from ledger effects.
 * `issuer` is optional for backward compatibility; pass it (see isUsdcMovement).
 */
export async function loadActivity(address: string, limit = 20, issuer?: string): Promise<ActivityItem[]> {
  try {
    return await pageActivity(address, limit, issuer);
  } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status === 404) return [];
    throw e;
  }
}

/** The most accounts we will ever read in one aggregate pass — a rate-limit guard. */
const MAX_READ_ACCOUNTS = 8;

/**
 * Merge per-account activity into one list, newest first.
 *
 * The double-entry trap this handles: consolidating a per-link throwaway into home DEBITS the
 * throwaway and CREDITS home for the same money. Both are real effects with distinct ids, so
 * de-duplicating cannot catch it, and the user would see "Sent $20" next to "Received $20" for
 * money that never left them. A throwaway only ever debits when sweeping home, so dropping
 * non-home debits removes the phantom without hiding anything genuine.
 */
export function mergeActivity(
  perAccount: { items: ActivityItem[]; isHome: boolean }[],
  limit: number,
): ActivityItem[] {
  const seen = new Set<string>();
  const all: ActivityItem[] = [];
  for (const { items, isHome } of perAccount) {
    for (const it of items) {
      if (!isHome && it.direction === "out") continue;
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      all.push(it);
    }
  }
  return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/**
 * Money in/out across EVERY stored account, newest first.
 *
 * Each claim link creates its own throwaway account. Money paid to one that hasn't been swept yet
 * is still the user's money, and reading only `home` meant it counted in the balance total but
 * never appeared as a movement — the balance went up and the activity list stayed empty. Reads run
 * in parallel; one account failing never blanks the whole list.
 */
export async function loadActivityForAccounts(
  accounts: { address: string; issuer?: string; isHome: boolean }[],
  limit = 20,
): Promise<ActivityItem[]> {
  const capped = accounts.slice(0, MAX_READ_ACCOUNTS);
  const per = await Promise.all(
    capped.map(async (a) => ({
      isHome: a.isHome,
      items: await loadActivity(a.address, limit, a.issuer).catch(() => [] as ActivityItem[]),
    })),
  );
  return mergeActivity(per, limit);
}
