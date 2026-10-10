/**
 * The popup <-> background contract. The popup is a thin view: it asks, the worker decides, signs,
 * talks to the network and keeps the records. Every request is validated here before the worker
 * acts on it, and every answer is a Result (ok + data, or a named error the popup can explain).
 */
import { z } from "zod";
import type { AutolockMin } from "../config";
import type { Standing } from "./standing";
import type { BackupRecord, BalanceInfo, LinkRecord, PilotInfo, SendOutcome, Settings, WorkerState } from "./types";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const RequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  /** the first-run data disclosure: nothing leaves the device before this */
  z.object({ type: z.literal("consent.agree") }).strict(),
  /** `switching`: "Use another account" in Settings brings another account in place of the one held */
  z.object({ type: z.literal("restore.requestCode"), email: z.string().min(3).max(254), switching: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("restore.submitCode"), code: z.string().min(1).max(16) }).strict(),
  z.object({ type: z.literal("restore.submitPassword"), password: z.string().min(1).max(1024) }).strict(),
  z.object({ type: z.literal("restore.cancel") }).strict(),
  /** a new account made here, locked with this password (it also opens the account's backup) */
  z.object({ type: z.literal("account.create"), password: z.string().min(1).max(1024) }).strict(),
  z.object({ type: z.literal("backup.requestCode"), email: z.string().min(3).max(254) }).strict(),
  z.object({ type: z.literal("backup.submitCode"), code: z.string().min(1).max(16) }).strict(),
  /** back to the email step; `end` also ends a Change backup email */
  z.object({ type: z.literal("backup.cancel"), end: z.literal(true).optional() }).strict(),
  /**
   * the email already backs up another account, and the person opens that backup with its password:
   * `loseAccount` when this browser's account was never backed up and goes, `leaveOpenLinks` when its
   * open links go with it
   */
  z
    .object({
      type: z.literal("backup.useExisting"),
      password: z.string().min(1).max(1024),
      loseAccount: z.literal(true).optional(),
      leaveOpenLinks: z.literal(true).optional(),
    })
    .strict(),
  /** the email holds a backup tied to no account yet, and the person typed REPLACE to replace it */
  z.object({ type: z.literal("backup.replace"), confirm: z.literal("REPLACE") }).strict(),
  /** Change backup email: the account's password wraps a new backup copy for the next email */
  z.object({ type: z.literal("backup.again"), password: z.string().min(1).max(1024) }).strict(),
  /** Add your backup email (an account restored by 0.1.3 or earlier): is this email its backup? */
  z.object({ type: z.literal("account.checkBackupEmail"), email: z.string().min(3).max(254) }).strict(),
  /** open this account on real money (an approved account that never received real money) */
  z.object({ type: z.literal("account.openReal") }).strict(),
  /** ask to join real money: a code mailed to `email` from the real-money server */
  z.object({ type: z.literal("pilot.requestCode"), email: z.string().min(3).max(254) }).strict(),
  /** ask to join real money (or for more sends) for this extension's own key */
  z
    .object({
      type: z.literal("pilot.request"),
      email: z.string().min(3).max(254),
      code: z.string().regex(/^\s*\d(?:\s*\d){5}\s*$/).optional(),
    })
    .strict(),
  z.object({ type: z.literal("unlock"), password: z.string().min(1).max(1024) }).strict(),
  z.object({ type: z.literal("lock") }).strict(),
  /**
   * `leaveOpenLinks`: the person saw that links are still open and chose to forget anyway;
   * `loseAccount`: the account was never backed up, and they chose to delete its only copy anyway.
   */
  z
    .object({
      type: z.literal("forget"),
      confirm: z.literal("FORGET"),
      leaveOpenLinks: z.literal(true).optional(),
      loseAccount: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("settings.set"),
      patch: z
        .object({
          autolockMin: z.union([z.literal(5), z.literal(15), z.literal(60)]).optional(),
          mainnetAck: z.literal(true).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("network.set"), net: z.enum(["testnet", "public"]) }).strict(),
  z.object({ type: z.literal("pilot.status"), force: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("balance") }).strict(),
  /** practice money only: ask the testnet sponsor's faucet for a top-up */
  z.object({ type: z.literal("testmoney") }).strict(),
  z
    .object({
      type: z.literal("send"),
      amount: z.string().min(1).max(32),
      from: z.string().max(40),
      password: z.string().max(256).optional(),
      /** the person saw that an earlier send is unconfirmed and chose to make a new link anyway */
      anyway: z.literal(true).optional(),
    })
    .strict(),
  z.object({ type: z.literal("links.list") }).strict(),
  z.object({ type: z.literal("links.reveal"), linkHex: hex64 }).strict(),
  z.object({ type: z.literal("links.refresh"), linkHex: hex64.optional() }).strict(),
  z.object({ type: z.literal("links.reclaim"), linkHex: hex64 }).strict(),
  z.object({ type: z.literal("insert.run"), linkHex: hex64 }).strict(),
  z.object({ type: z.literal("insert.cancel") }).strict(),
  z.object({ type: z.literal("shared"), linkHex: hex64, how: z.enum(["copy", "insert"]) }).strict(),
]);

export type Request = z.infer<typeof RequestSchema>;
export type RequestType = Request["type"];
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;

/** What each request answers with, when it succeeds. */
export interface ResponseMap {
  state: WorkerState;
  "consent.agree": WorkerState;
  "restore.requestCode": { codeSentAt: number };
  "restore.submitCode": { step: "password" };
  /** the account restored, the email it came from, whether its backup is now confirmed as its own, and whether it was the one held */
  "restore.submitPassword": { pubkey: string; email: string; bound: boolean | null; same: boolean };
  "restore.cancel": null;
  "account.create": { pubkey: string };
  "backup.requestCode": { codeSentAt: number };
  "backup.submitCode": { backedUpAt: number; bound: boolean | null };
  "backup.cancel": null;
  "backup.useExisting": { pubkey: string; same: boolean; bound: boolean | null };
  "backup.replace": { backedUpAt: number; bound: boolean | null };
  "backup.again": null;
  "account.checkBackupEmail": BackupRecord;
  "account.openReal": BalanceInfo;
  "pilot.requestCode": { codeSentAt: number };
  "pilot.request": {
    state: "pending" | "approved" | "rejected";
    filed: boolean;
    already: boolean;
    emailAlsoFor?: string;
    standing: Standing;
  };
  unlock: { lockAt: number };
  lock: null;
  forget: null;
  "settings.set": Settings;
  "network.set": Settings;
  "pilot.status": PilotInfo | null;
  balance: BalanceInfo;
  testmoney: BalanceInfo;
  send: SendOutcome;
  "links.list": LinkRecord[];
  "links.reveal": { link: string };
  "links.refresh": LinkRecord[];
  "links.reclaim": LinkRecord;
  "insert.run": { inserted: boolean; how?: string };
  "insert.cancel": null;
  shared: null;
}

export type AutolockChoice = AutolockMin;
