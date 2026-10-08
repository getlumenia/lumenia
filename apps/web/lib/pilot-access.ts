/**
 * Who may switch this device to real money, decided in one pure place (SOW 2, D3 item i).
 *
 * Two inputs decide it. The mainnet sponsor's `/pilot-status` answer says which world we are in:
 * the hand-approved pilot (`pilot: true`, with this wallet's own standing), or the pilot retired
 * (`pilot: false`: the Worker runs without PILOT_MODE and admits every wallet to its value routes).
 * And this device knows whether its account is locked with a password and backed up.
 *
 * The pilot's precondition was that real money never sits under a device-only key and can always
 * be brought back, so a wallet could only ASK to join once it was locked and backed up. Retiring the
 * allowlist removes the hand approval, not that precondition: with the pilot off, the switch opens to
 * every wallet that is locked and backed up, and sends the others to do that first. A device with no
 * account yet may switch; the account it then creates is born on real money, and the wallet refuses
 * to sign any money movement from it until it is locked and backed up (backupBlocksRealMoney below,
 * enforced in lib/wallet.tsx getSigner), which is the same one step on /pilot.
 *
 * Before this module the web read `pilot: false` as "not approved", which would have locked every
 * user OUT of real money the day the switch was flipped. Pure, so the self-test can hold it.
 */

/** This account's standing: the sponsor's `state`, plus "open" for a retired pilot. */
export type PilotState = "none" | "pending" | "approved" | "rejected" | "open";

/** What `/pilot-status` answers, untrusted. */
export interface PilotStatusAnswer {
  pilot?: unknown;
  approved?: unknown;
  state?: unknown;
}

function isPilotState(s: unknown): s is PilotState {
  return s === "none" || s === "pending" || s === "approved" || s === "rejected" || s === "open";
}

/**
 * Read the sponsor's answer. `mainnetApproved` is "the allowlist would admit this wallet": true for
 * an approved pilot wallet, and true for every wallet once the pilot is retired. Whether THIS device
 * may switch also depends on the lock and the backup; that is `mainnetSwitchBlock` below.
 */
export function readPilotStatus(d: PilotStatusAnswer): { mainnetApproved: boolean; pilotState: PilotState } {
  if (d.pilot === false) return { mainnetApproved: true, pilotState: "open" };
  return {
    mainnetApproved: d.approved === true,
    pilotState: isPilotState(d.state) && d.state !== "open" ? d.state : "none",
  };
}

/** What an ask settles on. A FAILED ask is not one of these: askPilotStatus returns null for it. */
export interface PilotRead {
  mainnetApproved: boolean;
  pilotState: PilotState;
}

const NOT_OPEN: PilotRead = { mainnetApproved: false, pilotState: "none" };

/**
 * Ask the mainnet sponsor where real money stands, and map the reply. Pure apart from the fetch it
 * is handed, so the self-test drives it with no network; the provider passes the real one.
 *
 * WITH AN ACCOUNT the question is "may THIS wallet?" (`?pubkey=`), and only the sponsor's own answer
 * counts as one: a 2xx JSON body with a boolean `pilot`. A 429, any other error status, a body that
 * is not JSON (a captive portal, a proxy page) or a network error is a FAILED ask: null, and the
 * caller keeps its last answer. The provider used to read any JSON body as an answer, so a
 * rate-limited ask (`{"error":"per-account rate limit exceeded"}`, no `pilot` field) demoted an
 * open-mode user to "invite-only" until a later ask happened to get through.
 *
 * WITHOUT AN ACCOUNT the only question is "is the pilot retired?", so no pubkey is sent: a retired
 * pilot's sponsor answers `{pilot:false}` to that without one (it reads no store and is not rate
 * limited). That 200 is "open"; every other answer, including the 400 a pilot-mode sponsor gives a
 * request with no pubkey, is "none". Before this, a device with no account never asked at all and
 * read "invite-only" after the switch was flipped. A failed ask is null here too.
 */
export async function askPilotStatus(opts: {
  sponsorUrl: string;
  pubkey: string | null;
  fetchImpl?: typeof fetch;
}): Promise<PilotRead | null> {
  // Destructured, never called as `opts.fetchImpl(...)`: a browser's fetch invoked as a method of
  // another object throws "Illegal invocation".
  const { sponsorUrl, pubkey, fetchImpl = fetch } = opts;
  const base = sponsorUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchImpl(pubkey ? `${base}/pilot-status?pubkey=${encodeURIComponent(pubkey)}` : `${base}/pilot-status`);
  } catch {
    return null;
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const answer = body !== null && typeof body === "object" ? (body as PilotStatusAnswer) : null;
  const theSponsorAnswered = res.ok && typeof answer?.pilot === "boolean";
  if (!pubkey) {
    if (theSponsorAnswered && answer!.pilot === false) return readPilotStatus(answer!);
    // The pilot-mode refusal of a missing pubkey is an answer ("not open"); a 429, a 5xx or a page
    // that is not the sponsor's JSON is not, and keeps whatever was known.
    return theSponsorAnswered || res.status === 400 ? NOT_OPEN : null;
  }
  return theSponsorAnswered ? readPilotStatus(answer!) : null;
}

/**
 * Must this account be backed up before it may move real money?
 *
 * The pilot's precondition, kept after the allowlist is retired (SOW 2, D3 item i). With the pilot
 * on, approval already required the lock AND the backup (the ask on /pilot needs both), so nothing is
 * added. With the pilot retired the wallet is the only place left to enforce it: an account that is
 * not backed up may hold and receive real money, and may not move it, until the backup exists. While
 * the sponsor's answer is not known yet, a device on real money fails closed: an account with no
 * backup waits the moment the first answer takes, rather than slipping a send through before it.
 *
 * `backedUp` is this device's own record (lib/recovery-api.ts hasBackup), conservative by design: a
 * restore made elsewhere reads "not backed up" and is merely asked to back up again.
 */
export function backupBlocksRealMoney(opts: {
  onMainnet: boolean;
  pilotState: PilotState;
  /** a valid /pilot-status answer has arrived since this account was loaded */
  pilotKnown: boolean;
  backedUp: boolean;
}): boolean {
  if (opts.backedUp) return false;
  if (opts.pilotState === "open") return true;
  return opts.onMainnet && !opts.pilotKnown;
}

/**
 * The real-money warning ("an early pilot, not reviewed by an outside security firm, keep amounts
 * small"), decided in one pure place. Everyone reads it once per device before using real money,
 * whichever way the device got there:
 *
 *   "switch"  the person asked to switch to real money. "I understand" marks it read and switches;
 *             "Not now" leaves the device on practice money.
 *   "mount"   the app opened ON real money and this device never acknowledged the warning: a
 *             mainnet claim (the claim page sets the network itself, outside this provider) and a
 *             device already on real money both arrive this way. "I understand" marks it read;
 *             "Not now" (or closing the sheet) goes back to practice money only when the way back
 *             to real money is open to this account (`arrivalDismissTarget`), and otherwise leaves
 *             the device where it is, unacknowledged, so the sheet comes back on the next start.
 *
 * `network` is where the device is (mount) or where it is going (switch).
 */
export type MainnetWarning =
  | { show: false }
  | { show: true; onConfirm: "mark-seen" | "mark-seen-and-switch"; onDismiss: "stay" | "back-to-practice" };

export function mainnetWarningPlan(opts: {
  trigger: "mount" | "switch";
  network: "public" | "testnet";
  seen: boolean;
}): MainnetWarning {
  if (opts.network !== "public" || opts.seen) return { show: false };
  return opts.trigger === "switch"
    ? { show: true, onConfirm: "mark-seen-and-switch", onDismiss: "stay" }
    : { show: true, onConfirm: "mark-seen", onDismiss: "back-to-practice" };
}

/**
 * Where "Not now" on the ARRIVAL sheet leaves the device, given what `mainnetSwitchBlock` answers
 * for a switch back to real money. Practice money only when that way back is open (null). Otherwise
 * the sheet would strand someone who may hold real money and cannot return to it: in pilot mode
 * every recipient not on the allowlist (a claim recipient may cash out without approval), and with
 * the pilot retired an account not yet locked and backed up. A review found exactly that: the
 * sheet's dismiss moved such a recipient to practice money, and every way back answered
 * "invite-only". Staying unacknowledged costs nothing: the sheet shows again on the next start.
 */
export function arrivalDismissTarget(blockBack: null | "invite-only" | "secure-first"): "practice" | "stay" {
  return blockBack === null ? "practice" : "stay";
}

export interface SwitchAccount {
  /** 1 = a device key with no password, 2 = locked with a password. */
  phase: number;
}

/**
 * Why a switch to real money must not happen now, or null when it may.
 *   "invite-only"  the pilot is on and this wallet is not approved;
 *   "secure-first" the pilot is retired, and this account is not yet locked and backed up.
 * A switch back to practice money is never blocked.
 */
export function mainnetSwitchBlock(opts: {
  to: "public" | "testnet";
  mainnetApproved: boolean;
  pilotState: PilotState;
  account: SwitchAccount | null;
  backedUp: boolean;
}): null | "invite-only" | "secure-first" {
  if (opts.to !== "public") return null;
  if (!opts.mainnetApproved) return "invite-only";
  if (opts.pilotState === "open" && opts.account && !(opts.account.phase === 2 && opts.backedUp)) return "secure-first";
  return null;
}
