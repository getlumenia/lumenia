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
  used?: unknown;
  limit?: unknown;
  revoked?: unknown;
}

function isPilotState(s: unknown): s is PilotState {
  return s === "none" || s === "pending" || s === "approved" || s === "rejected" || s === "open";
}

/**
 * What an ask settles on. A FAILED ask is not one of these: askPilotStatus returns null for it.
 *
 * `mainnetApproved` and `pilotState` are the two readings the switch rules below were written
 * against. The rest is the sponsor's own answer, kept so the standing table (pilotStanding) can tell
 * "approved with sends left" from "approved, all sends used" from "taken off real money", which
 * `pilotState` folds together.
 */
export interface PilotRead {
  mainnetApproved: boolean;
  pilotState: PilotState;
  /** false: the pilot is retired and real money is open to every wallet. */
  pilot: boolean;
  /** The sponsor's `state` as sent, or null when it sent none. */
  state: string | null;
  /** The sponsor's `approved`, true only when it sent exactly true. */
  approved: boolean;
  /** Real-money sends used and allowed, when the sponsor said. */
  used: number | null;
  limit: number | null;
  /** The owner took this wallet off real money (contract 3.1). false when not said (an older server). */
  revoked: boolean;
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Read the sponsor's answer. `mainnetApproved` is "the allowlist would admit this wallet": true for
 * an approved pilot wallet, and true for every wallet once the pilot is retired. Whether THIS device
 * may switch also depends on the lock and the backup; that is `mainnetSwitchBlock` below.
 */
export function readPilotStatus(d: PilotStatusAnswer): PilotRead {
  if (d.pilot === false) {
    return { mainnetApproved: true, pilotState: "open", pilot: false, state: "open", approved: true, used: null, limit: null, revoked: false };
  }
  return {
    mainnetApproved: d.approved === true,
    pilotState: isPilotState(d.state) && d.state !== "open" ? d.state : "none",
    pilot: true,
    state: typeof d.state === "string" ? d.state : null,
    approved: d.approved === true,
    used: count(d.used),
    limit: count(d.limit),
    revoked: d.revoked === true,
  };
}

const NOT_OPEN: PilotRead = {
  mainnetApproved: false,
  pilotState: "none",
  pilot: true,
  state: "none",
  approved: false,
  used: null,
  limit: null,
  revoked: false,
};

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
  /* For a wallet, a pilot-mode answer must also say WHERE the wallet stands. `{pilot:true,
     approved:false}` with no state is what the sponsor used to send when its store could not be
     read (contract 3.1), and reading it as "never asked" told an approved or waiting person to ask
     again. No state is a failed ask (contract 4), never "not approved". */
  if (theSponsorAnswered && answer!.pilot === true && typeof answer!.state !== "string") return null;
  return theSponsorAnswered ? readPilotStatus(answer!) : null;
}

/**
 * Where an account stands for real money, the same table on the website and in the extension
 * (contract 4). Rows read top to bottom; "checking" is the website's own state before the first
 * ask has settled.
 */
export type PilotStanding = "checking" | "open" | "none" | "pending" | "approved" | "no-sends" | "declined" | "revoked" | "unknown";

/**
 * A failed ask (null, or `failed`) is "unknown": never "not approved". The caller keeps showing the
 * last answer it had, with its age; "unknown" is for when there is none.
 */
export function pilotStanding(read: PilotRead | null, opts: { failed?: boolean } = {}): Exclude<PilotStanding, "checking"> {
  if (opts.failed || !read) return "unknown";
  if (!read.pilot) return "open";
  if (read.state === "approved") {
    if (read.approved && read.limit !== null && read.limit > 0 && read.used !== null && read.used >= read.limit) return "no-sends";
    return read.approved ? "approved" : "revoked";
  }
  if (read.state === "pending") return "pending";
  if (read.state === "rejected") return read.revoked ? "revoked" : "declined";
  if (read.state === "none") return "none";
  return "unknown";
}

/** The words for a standing (contract 5.1): a title, one line, and the action, if any. */
export interface StandingCopy {
  title: string;
  line: string;
  action: string | null;
}

/**
 * `short` is the account in use (lib/account-label.ts shortAddress); `left` and `limit` are its
 * real-money sends. Identical on every surface that shows a standing, and plain ASCII.
 */
export function standingCopy(standing: PilotStanding, v: { short: string; left?: number | null; limit?: number | null }): StandingCopy {
  const { short } = v;
  switch (standing) {
    case "none":
      return { title: "Real money is invite-only for now.", line: `Ask to join with this account (${short}).`, action: "Ask to join" };
    case "pending":
      return { title: "You're on the list.", line: `We'll email you when this account (${short}) is approved.`, action: "Check again" };
    case "approved":
      return {
        title: "You're approved for real money.",
        line:
          // A limit the sponsor did not report is not read out as "0 of 0", as in the extension.
          typeof v.left === "number" && typeof v.limit === "number" && v.limit > 0
            ? `This account (${short}) has ${v.left} of ${v.limit} real-money sends left.`
            : `This account (${short}) is approved for real money.`,
        action: "Switch to real money",
      };
    case "no-sends":
      return {
        title: "No real-money sends left.",
        line: `This account (${short}) has used all ${typeof v.limit === "number" && v.limit > 0 ? `${v.limit} ` : ""}of its real-money sends. Your money stays yours: you can still receive it, cash it out and take links back.`,
        action: "Ask for more sends",
      };
    case "declined":
      return {
        title: "Not approved for now.",
        line: `This account (${short}) isn't approved for real money yet. If you think we got it wrong, reply to our email.`,
        action: null,
      };
    case "revoked":
      return {
        title: "Real money is off for this account.",
        line: `We took this account (${short}) off real money. Your money stays yours: you can still receive it, cash it out and take links back.`,
        action: null,
      };
    case "open":
      return { title: "Real money is open to everyone.", line: "Every link is capped.", action: "Switch to real money" };
    case "unknown":
      return { title: "We couldn't check real money for this account.", line: "Try again in a minute.", action: "Try again" };
    case "checking":
      return { title: "Checking real money for this account.", line: "", action: null };
  }
}

/**
 * "Checked 3 minutes ago." for an answer the latest ask could not refresh (contract 4: a failed ask
 * shows the last known answer with its age, never "not approved"). Empty when there is no answer.
 */
export function checkedAgo(at: number | null, now: number = Date.now()): string {
  if (at === null) return "";
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  return min < 1 ? "Checked just now." : min === 1 ? "Checked 1 minute ago." : `Checked ${min} minutes ago.`;
}

/** The standings in which this account may use real money right now (the switch is offered). */
export function standingAllowsRealMoney(standing: PilotStanding): boolean {
  return standing === "approved" || standing === "no-sends" || standing === "open";
}

/**
 * The approval email's button lands on /account?switch=mainnet#for=<G...> (contract 3.3). What
 * the page does with it, given the account it names:
 *   switch       it is the account in use: switch to real money, as before.
 *   offer-use    it is another account on this device: say so, and offer to use that one.
 *   offer-bring  it is not on this device: say so, and offer to bring it here.
 * Nothing is done silently: a link for one account never switches another to real money.
 */
export function approvalLinkPlan(forPubkey: string | null, active: string | null, onDevice: readonly string[]): "switch" | "offer-use" | "offer-bring" {
  if (!forPubkey || forPubkey === active) return "switch";
  return onDevice.includes(forPubkey) ? "offer-use" : "offer-bring";
}

/** The `for=` an approval link carries after its #, when it is a well-formed account address. */
export function approvalFor(hash: string): string | null {
  const m = /(?:^#|&)for=(G[A-Z2-7]{55})(?:&|$)/.exec(hash.startsWith("#") ? hash : `#${hash}`);
  return m ? m[1]! : null;
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
