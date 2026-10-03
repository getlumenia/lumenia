/**
 * The one import surface onto apps/web/lib. The extension re-implements nothing that moves money:
 * the deposit, the escrow reads, the take-back, the key wrap and the recovery client are the same
 * code the website runs, called with an explicit network because a service worker has no device
 * flag to read (see the `net` parameter in lumendrop.ts).
 */
export {
  createV2Link,
  v2DepositLanded,
  loadV2DropStatus,
  reclaimV2,
  v2LinkUrl,
  DepositUncertainError,
  type PreparedDeposit,
  type V2Link,
} from "../../../web/lib/lumendrop";
export {
  testnetConfig,
  mainnetConfig,
  explorerTxOn,
  USDC_ISSUER,
  type NetworkConfig,
  type NetworkId,
} from "../../../web/lib/network";
export { localSignerFromSeed, type Signer } from "../../../web/lib/signer";
export { requestRecoveryOtp, fetchRecoveryBox } from "../../../web/lib/recovery-api";
export { unwrapWithPassword, findCopy, type RecoveryBox, type PasswordCopy } from "../../../web/lib/recovery";
export { savePhase2, unlockPhase2, getActive, clearKeystore } from "../../../web/lib/keystore";
export { DEFAULT_ARGON } from "../../../web/lib/argon";
export { formatUsd, sanitizeAmountInput } from "../../../web/lib/money";
export { claimPasswordProblem } from "../../../web/lib/claim-password";
export { sendEvent } from "../../../web/lib/events";
export { copy } from "../../../web/lib/copy";
export { getTestMoney } from "../../../web/lib/receive";
