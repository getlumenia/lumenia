// The escrow's return timer (contract `arm_return`, NEP-519 yield/resume): how much gas to arm it with.
//
// Once a link's timer is armed, nobody has to act again: NEAR wakes the escrow every 200 blocks
// (119 s on testnet and 113 s on mainnet, measured 2026-11-12) and, at the first wake-up after the
// expiry, the links still open go back to their funder in one transfer. A timer lives as long as the
// gas it was armed with: one wake-up burns about 2.3 Tgas for one link (the contract's sandbox tests,
// 27.2 Tgas over 12 wake-ups) and a little more for each extra link it watches; at every wake-up it
// keeps the gas of the return itself (the contract's floor, 40 Tgas plus 2 per link with the arm's own
// work). One transaction carries at most 1 PGas (`max_total_prepaid_gas`, protocol 88). What the timer
// does not burn is refunded to whoever armed it when it ends.

/** A wake-up every 200 blocks, counted as if blocks were faster than they are. */
export const RETURN_TIMER_WAKEUP_S = 100;
/** The gas of one wake-up for one link, rounded up from the 2.3 Tgas measured. */
export const RETURN_TIMER_TGAS_PER_WAKEUP = 3;
/** One transaction's prepaid-gas ceiling. */
export const RETURN_TIMER_MAX_TGAS = 1000;
/** Links one timer may watch: the escrow's limit, one funder's batch. */
export const RETURN_TIMER_MAX_LINKS = 30;

function linkCount(links: number): number {
  return Math.max(1, Math.min(RETURN_TIMER_MAX_LINKS, Math.floor(links)));
}

/** What the escrow asks `arm_return` to attach for `links` links before a single wake-up: 43 Tgas plus 2 per link. */
export function returnTimerFloorTgas(links = 1): number {
  return 43 + 2 * linkCount(links);
}

function perWakeupTgas(links: number): number {
  return RETURN_TIMER_TGAS_PER_WAKEUP + Math.ceil((linkCount(links) - 1) / 10);
}

/**
 * Gas to arm a timer over `links` links that outlives a life of `lifeS` seconds by two wake-ups, at most
 * 1 PGas. Compare with `returnTimerCoversS` to know whether the whole life is covered.
 */
export function armReturnTgas(lifeS: number, links = 1): number {
  const wakeups = Math.ceil(Math.max(0, lifeS) / RETURN_TIMER_WAKEUP_S) + 2;
  return Math.min(RETURN_TIMER_MAX_TGAS, returnTimerFloorTgas(links) + wakeups * perWakeupTgas(links));
}

/** The longest life, in seconds, a timer of `tgas` covers, counted the same careful way (two wake-ups of margin). */
export function returnTimerCoversS(tgas: number, links = 1): number {
  const wakeups = Math.floor((tgas - returnTimerFloorTgas(links)) / perWakeupTgas(links)) - 2;
  return Math.max(0, wakeups) * RETURN_TIMER_WAKEUP_S;
}

/** True when one transaction can arm a timer that outlives `lifeS`: the money then comes home with no further signature. */
export function returnTimerFits(lifeS: number, links = 1): boolean {
  return returnTimerCoversS(RETURN_TIMER_MAX_TGAS, links) >= lifeS;
}
