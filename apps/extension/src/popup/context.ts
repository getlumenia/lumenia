/**
 * What the shell hands every screen: the worker's state, the link records, and the few things a
 * screen may ask the shell to do. Kept apart from App.tsx so the screens never import the shell.
 */
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { LinkRecord, NetId, WorkerState } from "../lib/types";

export type View = "home" | "links" | "settings" | "backup";

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
}

export const AppCtx = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const api = useContext(AppCtx);
  if (!api) throw new Error("useApp outside the shell");
  return api;
}
