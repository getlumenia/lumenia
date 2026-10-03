/**
 * The popup's one way to talk to the worker: a typed wrapper over call() in lib/client.ts.
 *
 * call<T>() cannot infer T from its argument (the request type is an Extract), so every call site
 * would have to spell the type twice. ask("send", { ... }) names it once and the compiler checks
 * the arguments and the answer against lib/messages.ts.
 */
import { call } from "../lib/client";
import type { RequestOf, RequestType, ResponseMap } from "../lib/messages";
import type { Result } from "../lib/types";

type Args<T extends RequestType> = Omit<RequestOf<T>, "type">;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type Rest<T extends RequestType> = {} extends Args<T> ? [args?: Args<T>] : [args: Args<T>];

// An answer that says "the worker is somewhere else than you thought" (it locked itself, it has no
// account, consent or host access is missing) makes what the popup is showing stale. Whoever asked
// handles the answer; the shell, told here, reads the state again so the right screen takes over.
const staleListeners = new Set<() => void>();
const STALE_CODES: ReadonlySet<string> = new Set(["locked", "no-account", "needs-consent", "host-access"]);

/** Be told when an answer shows the screen is out of date. Returns the unsubscribe function. */
export function onStale(listener: () => void): () => void {
  staleListeners.add(listener);
  return () => {
    staleListeners.delete(listener);
  };
}

export async function ask<T extends RequestType>(type: T, ...rest: Rest<T>): Promise<Result<ResponseMap[T]>> {
  const req = { type, ...(rest[0] ?? {}) } as unknown as RequestOf<T>;
  const res = await call<T>(req);
  if (!res.ok && STALE_CODES.has(res.code) && type !== "state") staleListeners.forEach((l) => l());
  return res;
}
