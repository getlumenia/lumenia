/**
 * The worker's message handler: who may ask, what they may ask, and what each request does.
 *
 * Only this extension's own pages may ask: the sender must carry our runtime id and an URL on our own
 * extension origin. No `externally_connectable` is declared, so no web page can message the
 * extension at all. Every request is parsed by the zod contract in lib/messages.ts
 * before anything acts on it.
 */
import { createV2Link, getTestMoney, loadV2DropStatus, prepareAccount, reclaimV2, sendEvent, v2DepositLanded, type NetworkConfig } from "../core";
import { API_HOSTS, VERSION, netConfig } from "../config";
import { readBalance } from "../lib/balance";
import { ext, isFirefox } from "../lib/browser";
import { ExtError, MESSAGES, fail, openLinksMessage, toFailure } from "../lib/errors";
import { openLinks } from "../lib/links";
import { RequestSchema, type Request, type ResponseMap } from "../lib/messages";
import { sealLink, unsealLink } from "../lib/sealed";
import { pilotStanding, standingError } from "../lib/standing";
import { K, readSettings, session, writeSettings } from "../lib/storage";
import type { LinkRecord, Result, WorkerState } from "../lib/types";
import {
  accountView,
  backupAgain,
  backupCancel,
  backupReplace,
  backupRequestCode,
  backupSubmitCode,
  backupUseExisting,
  backupView,
  checkBackupEmail,
  createAccount,
  currentAccount,
  forget,
  isUnlockedNow,
  linksKeyForSession,
  lock,
  restoreCancel,
  restoreRequestCode,
  restoreState,
  restoreSubmitCode,
  restoreSubmitPassword,
  signerFor,
  touch,
  unlock,
} from "./account";
import { clearPendingInsert, insertLink, readPendingInsert } from "./insert";
import { keepAlive } from "./keepalive";
import { runOpenReal } from "./open-real";
import { addPracticeDollars } from "./practice";
import { cachedPilot, pilotStatus } from "./pilot";
import { pilotRequest, pilotRequestCode } from "./pilot-ask";
import { allRecords, getRecord, putRecord } from "./records";
import { runReclaim } from "./reclaim";
import { runSend } from "./send";
import { anyOpen, settleOnce, SETTLE_ALARM } from "./settle";

/**
 * The one send this worker is running, if any. Lost on a worker restart, which is the point: a
 * record left `submitted` by a dead worker is then picked up by the settle loop.
 */
let sending: { startedAt: number } | null = null;

/** Take-backs this worker is asking for, by link: a second request for the same link is refused. */
const reclaiming = new Set<string>();

/**
 * May a usage counter be sent? Only after the first-run agreement, and on Firefox 140+ only while
 * the user keeps the optional "technical and interaction data" permission (Firefox's own consent:
 * the manifest declares it optional, the user can switch it off at install or later). Chrome has no
 * `data_collection` permission, so there the first-run agreement is the whole gate.
 */
async function countersAllowed(): Promise<boolean> {
  if (!(await readSettings()).consentAt) return false;
  if (!isFirefox()) return true;
  try {
    const perms = ext.permissions as unknown as { contains(p: { data_collection: string[] }): Promise<boolean> };
    return await perms.contains({ data_collection: ["technicalAndInteraction"] });
  } catch {
    return false; // a Firefox that cannot answer the question gets no counters
  }
}

/**
 * The usage counters (lib/events.ts): an event name, two one-way hashes cut to 8 bytes, and the
 * marker src "ext". Never a URL, a link secret or an address.
 */
async function beacon(event: "send_started" | "send_link_created" | "link_shared", claimId: string, account: string, net: NetworkConfig): Promise<void> {
  try {
    if (!(await countersAllowed())) return;
    void sendEvent(event, claimId, account, { net, src: "ext" });
  } catch {
    /* a counter must never break a send */
  }
}

export async function ensureSettleAlarm(): Promise<void> {
  try {
    const open = anyOpen(await allRecords());
    if (open) await ext.alarms.create(SETTLE_ALARM, { periodInMinutes: 1 });
    else await ext.alarms.clear(SETTLE_ALARM);
  } catch {
    /* alarms unavailable */
  }
}

export async function runSettle(opts: { force?: boolean; only?: string } = {}): Promise<LinkRecord[]> {
  await settleOnce(
    {
      now: () => Date.now(),
      records: allRecords,
      get: getRecord,
      put: putRecord,
      netConfig,
      landed: (linkHex, sender, net) => v2DepositLanded(linkHex, sender, { net }),
      dropStatus: (linkHex, sender, net) => loadV2DropStatus(linkHex, sender, { net }),
      inFlight: (r) => sending !== null && r.phase === "submitted" && Date.now() - r.createdAt < 5 * 60_000,
    },
    opts,
  );
  await ensureSettleAlarm();
  return allRecords();
}

async function hostAccess(): Promise<boolean> {
  if (!isFirefox()) return true;
  try {
    return await ext.permissions.contains({ origins: [...API_HOSTS] });
  } catch {
    return false;
  }
}

async function workerState(): Promise<WorkerState> {
  const [settings, acct, unlocked, restore, pending, backup] = await Promise.all([
    readSettings(),
    accountView(),
    isUnlockedNow(),
    restoreState(),
    readPendingInsert(),
    backupView(),
  ]);
  return {
    account: acct,
    unlocked: unlocked.unlocked,
    lockAt: unlocked.lockAt,
    settings,
    restore,
    pilot: acct ? await cachedPilot(acct.pubkey) : null,
    sending,
    pendingInsert: pending ? { host: pending.host, at: pending.at } : null,
    backup,
    hostAccess: await hostAccess(),
    version: VERSION,
  };
}

async function requireAccount(): Promise<{ pubkey: string; phase: 1 | 2 }> {
  const acct = await currentAccount();
  if (!acct) throw fail("no-account");
  return acct;
}

async function handle(req: Request): Promise<ResponseMap[Request["type"]]> {
  switch (req.type) {
    case "state": {
      await touch();
      return workerState();
    }
    case "consent.agree": {
      await writeSettings({ consentAt: Date.now() });
      return workerState();
    }
    case "restore.requestCode":
      // Bringing another account in: never in the middle of a send or a take-back (their records
      // belong to the account held now, and would be written after it left).
      if (req.switching && (sending || reclaiming.size > 0)) throw fail("busy");
      return restoreRequestCode(req.email, { switching: req.switching === true });
    case "restore.submitCode":
      return restoreSubmitCode(req.code);
    case "restore.submitPassword": {
      if ((await restoreState())?.switching && (sending || reclaiming.size > 0)) throw fail("busy");
      const out = await keepAlive(restoreSubmitPassword(req.password));
      void runSettle();
      return out;
    }
    case "restore.cancel":
      return restoreCancel();
    case "account.create": {
      const out = await createAccount(req.password);
      void runSettle();
      return out;
    }
    case "backup.requestCode":
      return backupRequestCode(req.email);
    case "backup.submitCode":
      return backupSubmitCode(req.code);
    case "backup.cancel":
      return backupCancel({ end: req.end === true });
    case "backup.useExisting": {
      if (sending || reclaiming.size > 0) throw fail("busy");
      const out = await keepAlive(
        backupUseExisting(req.password, {
          loseAccount: req.loseAccount === true,
          leaveOpenLinks: req.leaveOpenLinks === true,
          open: openLinks(await allRecords()),
        }),
      );
      void runSettle();
      return out;
    }
    case "backup.replace":
      return keepAlive(backupReplace());
    case "backup.again":
      return keepAlive(backupAgain(req.password));
    case "account.checkBackupEmail":
      return checkBackupEmail(req.email);
    case "account.openReal":
      // The same gates as the switch to real money, then a forced ask: an account is opened on real
      // money only while it may use it (open-real.ts).
      return keepAlive(
        runOpenReal({
          consentAt: async () => (await readSettings()).consentAt,
          account: currentAccount,
          backupNeeded: async () => (await backupView()).needed,
          signer: signerFor,
          pilot: (pubkey) => pilotStatus(pubkey, { force: true }),
          balance: readBalance,
          prepare: async (signer, n) => {
            await prepareAccount({ sponsorUrl: n.sponsorUrl, signer, net: n });
          },
          net: netConfig("public"),
        }),
      );
    case "pilot.requestCode":
      return pilotRequestCode(req.email);
    case "pilot.request":
      return keepAlive(pilotRequest(req.email, req.code));
    case "unlock":
      return unlock(req.password);
    case "lock":
      return lock();
    case "forget": {
      // Never in the middle of a send or a take-back: their records would be written after the wipe.
      if (sending || reclaiming.size > 0) throw fail("busy");
      // This browser holds the only list of these links and the only way to take them back.
      const open = openLinks(await allRecords());
      if (open.length > 0 && !req.leaveOpenLinks) throw new ExtError("open-links", openLinksMessage(open));
      // An account made here and never backed up has no other copy anywhere: forgetting it deletes
      // the account and any money in it, for good.
      if ((await backupView()).needed && !req.loseAccount) throw new ExtError("not-backed-up", MESSAGES["not-backed-up"]);
      return forget();
    }
    case "settings.set": {
      const patch = { ...req.patch };
      const next = await writeSettings(patch);
      if (patch.autolockMin) await touch();
      return next;
    }
    case "network.set": {
      if (req.net === "public") {
        const acct = await requireAccount();
        if (acct.phase !== 2) throw fail("needs-password");
        /* An account made here and never backed up exists in this browser only. The pilot's
           approval used to stand between it and real money; with the pilot retired the sponsor
           admits every wallet, so this is where the backup rule holds (and again in runSend). */
        if ((await backupView()).needed) throw fail("needs-backup");
        // Approved (with or without sends left: with none, the balance and the take-backs are still
        // there) or open to everyone goes on; waiting, declined, taken off and unknown are each said
        // as such (lib/standing.ts).
        const p = await pilotStatus(acct.pubkey);
        const refused = standingError(pilotStanding(p), "switch", { pubkey: acct.pubkey, used: p.used, limit: p.limit });
        if (refused) throw refused;
        if (!(await readSettings()).mainnetAck) throw new ExtError("not-approved", "Read the real-money note and accept it first.");
      }
      return writeSettings({ net: req.net });
    }
    case "pilot.status": {
      const acct = await currentAccount();
      if (!acct) return null;
      return pilotStatus(acct.pubkey, { force: req.force });
    }
    case "balance": {
      const acct = await requireAccount();
      return readBalance(acct.pubkey, netConfig((await readSettings()).net));
    }
    case "testmoney": {
      const acct = await requireAccount();
      const settings = await readSettings();
      if (settings.net !== "testnet") throw new ExtError("internal", "Practice dollars are for practice money only.");
      const net = netConfig("testnet");
      return keepAlive(
        addPracticeDollars(
          {
            balance: readBalance,
            signer: signerFor,
            prepare: async (signer, n) => {
              await prepareAccount({ sponsorUrl: n.sponsorUrl, signer, net: n });
            },
            faucet: getTestMoney,
          },
          acct.pubkey,
          net,
        ),
      );
    }
    case "send": {
      if (sending) throw fail("busy");
      sending = { startedAt: Date.now() };
      await session().set({ [K.sending]: sending });
      try {
        const outcome = await keepAlive(
          runSend(
            {
              now: () => Date.now(),
              settings: readSettings,
              account: currentAccount,
              backupNeeded: async () => (await backupView()).needed,
              signer: signerFor,
              pilot: (pubkey) => pilotStatus(pubkey),
              balance: readBalance,
              netConfig,
              createLink: createV2Link,
              landed: (linkHex, sender, net) => v2DepositLanded(linkHex, sender, { net }),
              records: allRecords,
              seal: async (id, link) => sealLink(id, link, await linksKeyForSession()),
              putRecord,
              beacon: (event, pubkey, net) => void beacon(event, pubkey, pubkey, net),
            },
            { amount: req.amount, from: req.from, password: req.password, anyway: req.anyway === true },
          ),
        );
        await touch();
        // The name typed for this link is not kept as a default for the next one: a link carries a
        // name only when the sender types it for that link.
        // The person right-clicked a text field and asked for the link there: put it there now.
        if (outcome.link && (await readPendingInsert())) {
          try {
            const r = await insertLink(outcome.link, { pendingOnly: true });
            if (r.inserted) {
              outcome.inserted = true;
              const withInsert = { ...((await getRecord(outcome.linkHex)) ?? outcome.record), insertedAt: Date.now() };
              await putRecord(withInsert);
              outcome.record = withInsert;
              void beacon("link_shared", outcome.linkHex, outcome.record.sender, netConfig(outcome.record.net));
            }
          } catch {
            /* the popup offers Copy instead */
          }
        }
        return outcome;
      } finally {
        sending = null;
        await session().remove(K.sending);
        await ensureSettleAlarm();
      }
    }
    case "links.list":
      return allRecords();
    case "links.reveal": {
      const r = await getRecord(req.linkHex);
      if (!r) throw fail("not-found");
      const key = await linksKeyForSession(); // locked -> refused
      const link = await unsealLink(r.linkHex, key).catch(() => null);
      if (!link) throw fail("not-found", "This browser no longer holds that link.");
      return { link };
    }
    case "links.refresh":
      return runSettle({ force: true, only: req.linkHex });
    case "links.reclaim": {
      // One take-back per link at a time: a double tap would relay it twice at the sponsor's cost.
      if (reclaiming.has(req.linkHex)) throw fail("busy", "That link is already being taken back. Wait for it to finish.");
      reclaiming.add(req.linkHex);
      try {
        const r = await keepAlive(
          runReclaim(
            {
              now: () => Date.now(),
              get: getRecord,
              put: putRecord,
              netConfig,
              signer: signerFor,
              dropStatus: (linkHex, sender, net) => loadV2DropStatus(linkHex, sender, { net }),
              reclaim: reclaimV2,
            },
            req.linkHex,
          ),
        );
        return r;
      } finally {
        reclaiming.delete(req.linkHex);
        await ensureSettleAlarm();
      }
    }
    case "insert.run": {
      const r = await getRecord(req.linkHex);
      if (!r) throw fail("not-found");
      const key = await linksKeyForSession(); // locked -> refused
      const link = await unsealLink(r.linkHex, key).catch(() => null);
      if (!link) throw fail("not-found", "This browser no longer holds that link.");
      const out = await insertLink(link);
      if (out.inserted) {
        await putRecord({ ...((await getRecord(r.linkHex)) ?? r), insertedAt: Date.now() });
        void beacon("link_shared", r.linkHex, r.sender, netConfig(r.net));
      }
      return out;
    }
    case "insert.cancel": {
      await clearPendingInsert();
      return null;
    }
    case "shared": {
      const r = await getRecord(req.linkHex);
      if (r) void beacon("link_shared", r.linkHex, r.sender, netConfig(r.net));
      return null;
    }
  }
}

/**
 * Only this extension's own pages. The id check keeps every other extension out; the URL check keeps
 * out any script running inside a web page, including the paste function this extension injects
 * (a script in a page reports that page's https URL, never our extension origin).
 */
export function trustedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== ext.runtime.id) return false;
  return typeof sender.url === "string" && sender.url.startsWith(ext.runtime.getURL(""));
}

export async function route(msg: unknown, sender: chrome.runtime.MessageSender): Promise<Result<unknown>> {
  if (!trustedSender(sender)) return { ok: false, code: "internal", message: "Refused: not from this extension." };
  const parsed = RequestSchema.safeParse(msg);
  if (!parsed.success) return { ok: false, code: "internal", message: "Refused: not a request this extension knows." };
  try {
    return { ok: true, data: await handle(parsed.data) };
  } catch (e) {
    const f = toFailure(e);
    return { ok: false, code: f.code, message: f.message };
  }
}

