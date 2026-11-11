// The relayer, from the browser: the library's client (one NEP-366 delegate in, one answer out),
// pointed at the configured base URL. `${base}/relay`, `${base}/health`, `${base}/policy`.

import { relay as relayDelegate, type RelayOk } from "@lumenia/near/relayer/client";
import { NEAR_RELAYER_URL } from "./config";

export { buildSignedDelegateForPayForward, buildSignedDelegateForReclaim, RelayRequestError } from "@lumenia/near/relayer/client";
export type { RelayOk } from "@lumenia/near/relayer/client";

export function relayerBase(): string {
  return NEAR_RELAYER_URL;
}

/** POST {signedDelegate} to the relayer; throws RelayRequestError on any non-2xx answer. */
export function relay(signedDelegateBase64: string): Promise<RelayOk> {
  return relayDelegate(relayerBase(), signedDelegateBase64);
}

export interface RelayerHealth {
  ok: boolean;
  network?: string;
  escrowId?: string;
  relayer?: { accountId?: string; balanceNear?: string };
}

/** GET /health; null when the relayer cannot be reached (the screen says so, never a guess). */
export async function relayerHealth(fetchImpl: typeof fetch = fetch): Promise<RelayerHealth | null> {
  try {
    const res = await fetchImpl(`${relayerBase()}/health`);
    if (!res.ok) return null;
    return (await res.json()) as RelayerHealth;
  } catch {
    return null;
  }
}
