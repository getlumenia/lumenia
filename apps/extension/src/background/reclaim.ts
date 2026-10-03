/**
 * Take an unclaimed link back after its expiry: the sender signs reclaim(link) and the sponsor pays
 * the fee (/v2-reclaim), exactly as the website does (lumendrop.ts reclaimV2).
 *
 * The escrow is read first, so a link the recipient claimed a minute ago is reported as claimed,
 * not attempted. /v2-reclaim has no 202: a 200 is a landed take-back. A failure that provably
 * submitted nothing (anything before the take-back was posted, including a failed simulation, or the
 * sponsor's own JSON refusal with 403, 429 or 503) forgets this attempt; anything else leaves its
 * outcome open, and a link that then reads settled is Closed (claimed or taken back), because the
 * escrow records both the same way.
 */
import { reclaimV2, type NetworkConfig, type Signer } from "../core";
import { ExtError, fail, parseRelayError, reasonOf, toFailure } from "../lib/errors";
import { isReclaimable, netForRecord, onDropRead, onReclaimAttempt, onReclaimFailed, onReclaimed } from "../lib/links";
import type { LinkRecord, NetId } from "../lib/types";

export interface ReclaimDeps {
  now(): number;
  get(linkHex: string): Promise<LinkRecord | null>;
  put(r: LinkRecord): Promise<void>;
  netConfig(id: NetId): NetworkConfig;
  signer(pubkey: string): Promise<Signer>;
  dropStatus(linkHex: string, sender: string, net: NetworkConfig): Promise<"pending" | "settled" | "unknown">;
  reclaim: typeof reclaimV2;
}

export async function runReclaim(deps: ReclaimDeps, linkHex: string): Promise<LinkRecord> {
  let r = await deps.get(linkHex);
  if (!r) throw fail("not-found");
  const net = netForRecord(deps.netConfig(r.net), r);

  // Ask the escrow first: the list may be a minute old, and a claim may have just landed.
  r = onDropRead(r, await deps.dropStatus(r.linkHex, r.sender, net), deps.now());
  await deps.put(r);
  if (!isReclaimable(r, deps.now())) {
    throw new ExtError(
      "not-reclaimable",
      r.status === "claimed"
        ? "It was claimed, so there is nothing to take back."
        : r.status === "closed" || r.status === "reclaimed"
          ? "There is nothing left in it to take back."
          : "That link can't be taken back yet.",
    );
  }

  const signer = await deps.signer(r.sender);
  r = onReclaimAttempt(r, deps.now());
  await deps.put(r);
  let posted = false;
  try {
    const { hash } = await deps.reclaim({
      signer,
      linkHex: r.linkHex,
      sponsorUrl: net.sponsorUrl,
      group: false,
      net,
      onPosting: () => {
        posted = true;
      },
    });
    r = onReclaimed(r, hash, deps.now());
    await deps.put(r);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const simulation = /reclaim simulation failed/i.test(msg);
    if (!posted && !simulation) {
      // Nothing was posted (the network could not be read, the key could not sign): nothing moved.
      await deps.put(onReclaimFailed(r, true, deps.now()));
      const f = toFailure(e);
      throw new ExtError(f.code, f.message);
    }
    const relay = parseRelayError(msg);
    const reason = relay ? reasonOf(relay.body) : "";
    // Only the sponsor's own JSON refusal proves nothing was submitted; the same status with another
    // body (a platform error page) may come from after the submit.
    const refused = relay !== null && reason !== "" && [403, 429, 503].includes(relay.status);
    const definite = simulation || refused;
    await deps.put(onReclaimFailed(r, definite, deps.now()));
    if (refused && relay.status === 429) throw fail("rate-limited");
    if (refused && relay.status === 503) throw fail("halted");
    if (definite) {
      throw new ExtError("sponsor-refused", reason ? `It couldn't be taken back: ${reason}. Nothing moved.` : "It couldn't be taken back. Nothing moved.");
    }
    throw new ExtError("uncertain", "We asked for it back but couldn't confirm it. We keep checking; Links will show the result.");
  }
}
