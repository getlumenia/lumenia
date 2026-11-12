// The escrow's return timer from this tab: after a link the person's own key made exists, the same key
// arms the link's return (`arm_return`), so an unclaimed link comes back by itself after it expires,
// with no further signature from anyone. Sent and waited on only until INCLUDED_FINAL: a transaction
// whose timer is pending does not reach FINAL until the timer ends. Practice links are armed by the
// Worker that makes them (lib/near/practice.ts carries its answer).

import type { KeyPairString } from "near-api-js";
import { armReturnTgas, returnTimerFits } from "@lumenia/near/return-timer";
import { sendFunctionCall } from "./chain";
import { NEAR_CONTRACT_ID } from "./config";
import { describeError } from "./errors";

export { returnTimerFits };

export type ArmOutcome = { armed: true; txHash: string } | { armed: false; reason: string };

/** Never throws: a life too long for one timer, or a failed send, comes back as the reason. */
export async function armOwnReturn(o: { signerId: string; secretKey: KeyPairString; publicKeys: string[]; lifeS: number }): Promise<ArmOutcome> {
  if (!returnTimerFits(o.lifeS, o.publicKeys.length)) return { armed: false, reason: "the link lives longer than one return timer lasts" };
  try {
    const { txHash } = await sendFunctionCall({
      signerId: o.signerId,
      secretKey: o.secretKey,
      receiverId: NEAR_CONTRACT_ID,
      methodName: "arm_return",
      args: { public_keys: o.publicKeys },
      gasTgas: armReturnTgas(o.lifeS, o.publicKeys.length),
      depositYocto: 0n,
      waitUntil: "INCLUDED_FINAL",
    });
    return { armed: true, txHash };
  } catch (e) {
    return { armed: false, reason: describeError(e) };
  }
}
