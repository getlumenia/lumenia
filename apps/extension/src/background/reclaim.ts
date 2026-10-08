/**
 * Take an unclaimed link back after its expiry: the sender signs reclaim(link) and the sponsor pays
 * the fee (/v2-reclaim), exactly as the website does (lumendrop.ts reclaimV2).
 *
 * The escrow is read first, so a link the recipient claimed a minute ago is reported as claimed,
 * not attempted. A 200 is a landed take-back. A 202 (the sponsor accepted it and the ledger had not
 * shown it landing yet, SOW 2 D3) is NOT: it is kept open exactly like the uncertain failures below,
 * so the settle pass decides it from the escrow. A failure that provably
 * submitted nothing (anything before the take-back was posted, including a failed simulation, or the
 * sponsor's own JSON refusal: 403, 429, a 503 in one of its wait sentences, the fee budget's 400)
 * forgets this attempt; anything else leaves its
 * outcome open, and a link that then reads settled is Closed (claimed or taken back), because the
 * escrow records both the same way.
 */
import { reclaimV2, type NetworkConfig, type Signer } from "../core";
import { ExtError, fail, parseRelayError, reasonOf, sponsorWait, toFailure } from "../lib/errors";
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
  let result: { hash: string; confirmed?: boolean };
  try {
    result = await deps.reclaim({
      signer,
      linkHex: r.linkHex,
      sponsorUrl: net.sponsorUrl,
      group: false,
      net,
      onPosting: () => {
        posted = true;
      },
    });
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
    /* Only the sponsor's own JSON refusal proves nothing was submitted; the same status with another
       body (a platform error page) may come from after the submit. A 503 proves it only in one of
       the sponsor's wait sentences (the halt, the busy network), told apart by the words, never by
       the status: a busy network used to read "Sending is paused right now". The fee budget is a
       400 raised before the sponsor signs anything, so it proves the same. */
    const wait = relay !== null && reason !== "" ? sponsorWait(reason) : null;
    const refused =
      relay !== null &&
      reason !== "" &&
      (relay.status === 403 || relay.status === 429 || (relay.status === 503 && wait !== null) || (relay.status === 400 && wait?.code === "day-limit"));
    const definite = simulation || refused;
    await deps.put(onReclaimFailed(r, definite, deps.now()));
    if (refused && relay.status === 429) throw fail("rate-limited");
    if (refused && wait) throw new ExtError(wait.code, wait.message);
    if (definite) {
      throw new ExtError("sponsor-refused", reason ? `It couldn't be taken back: ${reason}. Nothing moved.` : "It couldn't be taken back. Nothing moved.");
    }
    throw new ExtError("uncertain", "We asked for it back but couldn't confirm it. We keep checking; Links will show the result.");
  }
  if (result.confirmed === false) {
    // Accepted, not yet seen landing: open, never "reclaimed" on the sponsor's word alone.
    await deps.put(onReclaimFailed(r, false, deps.now()));
    throw new ExtError("uncertain", "We asked for it back and the network hasn't confirmed it yet. We keep checking; Links will show the result.");
  }
  r = onReclaimed(r, result.hash, deps.now());
  await deps.put(r);
  return r;
}
