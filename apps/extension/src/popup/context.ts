/**
 * What the shell hands every screen: the worker's state, the link records, and the few things a
 * screen may ask the shell to do. Kept apart from App.tsx so the screens never import the shell.
 */
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { LinkRecord, NetId, WorkerState } from "../lib/types";

/**
 * The screens of an account that is here and unlocked: the home screen, Links, Settings, the backup
 * steps, Ask to join real money, Use another account (the restore steps in place of this account),
 * Change backup email (the backup steps for an account that is already backed up), and Add your
 * backup email (an account restored by an older version, which never kept it).
 */
export type View = "home" | "links" | "settings" | "backup" | "ask" | "switch" | "change-email" | "add-email";

/** What a restore just brought here, named once on the screen after it. */
export interface Restored {
  pubkey: string;
  email: string;
  bound: boolean | null;
  /** it was the account already held here (Use another account, with its own email) */
  same: boolean;
}

export interface AppApi {
  ws: WorkerState;
  net: NetId;
  /** newest first */
  records: LinkRecord[];
  /** ask the worker for its state again; resolves with the new state, or null when it did not answer */
  refresh(): Promise<WorkerState | null>;
  /** take a state the worker just returned (consent.agree answers with one) */
  applyState(next: WorkerState): void;
  /** read the link list again (local, cheap) */
  reloadRecords(): Promise<void>;
  /** replace the list with one the worker just returned (links.refresh answers with one) */
  setRecords(rs: LinkRecord[]): void;
  go(view: View): void;
  /** the account question -> the restore steps (email, code, password) */
  startRestore(): void;
  /** back to the account question from the restore steps */
  leaveRestore(): void;
  /** the account question -> pick a password for a new account */
  startCreate(): void;
  /** an account was just made here: show the "you're in" beat, once */
  justCreated(): void;
  /** an account was just restored here: name it once (LUMENIA ACCOUNT CONTRACT v1, 5.5) */
  justRestored(r: Restored): void;
}

export const AppCtx = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const api = useContext(AppCtx);
  if (!api) throw new Error("useApp outside the shell");
  return api;
}
