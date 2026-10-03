/**
 * The popup <-> background contract. The popup is a thin view: it asks, the worker decides, signs,
 * talks to the network and keeps the records. Every request is validated here before the worker
 * acts on it, and every answer is a Result (ok + data, or a named error the popup can explain).
 */
import { z } from "zod";
import type { AutolockMin } from "../config";
import type { BalanceInfo, LinkRecord, PilotInfo, SendOutcome, Settings, WorkerState } from "./types";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const RequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  /** the first-run data disclosure: nothing leaves the device before this */
  z.object({ type: z.literal("consent.agree") }).strict(),
  z.object({ type: z.literal("restore.requestCode"), email: z.string().min(3).max(254) }).strict(),
  z.object({ type: z.literal("restore.submitCode"), code: z.string().min(1).max(16) }).strict(),
  z.object({ type: z.literal("restore.submitPassword"), password: z.string().min(1).max(1024) }).strict(),
  z.object({ type: z.literal("restore.cancel") }).strict(),
  /** a new account made here, locked with this password (it also opens the account's backup) */
  z.object({ type: z.literal("account.create"), password: z.string().min(1).max(1024) }).strict(),
  z.object({ type: z.literal("backup.requestCode"), email: z.string().min(3).max(254) }).strict(),
  z.object({ type: z.literal("backup.submitCode"), code: z.string().min(1).max(16) }).strict(),
  z.object({ type: z.literal("backup.cancel") }).strict(),
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
          from: z.string().max(40).optional(),
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
  "restore.submitPassword": { pubkey: string };
  "restore.cancel": null;
  "account.create": { pubkey: string };
  "backup.requestCode": { codeSentAt: number };
  "backup.submitCode": { backedUpAt: number };
  "backup.cancel": null;
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
