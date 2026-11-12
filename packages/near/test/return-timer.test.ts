import { describe, expect, it } from "vitest";
import { armReturnTgas, returnTimerCoversS, returnTimerFits, returnTimerFloorTgas, RETURN_TIMER_MAX_TGAS } from "../src/return-timer.js";

describe("return timer gas", () => {
  it("starts from the escrow's own floor: 43 Tgas plus 2 per link", () => {
    expect(returnTimerFloorTgas(1)).toBe(45);
    expect(returnTimerFloorTgas(30)).toBe(103);
    // the contract asks arm_return for return_gas(n) + 15 = 40 + 2n: the floor here is 3 Tgas above it
    for (const n of [1, 2, 10, 30]) expect(returnTimerFloorTgas(n)).toBeGreaterThan(40 + 2 * n);
  });

  it("adds a wake-up every 100 s of life, plus two, at 3 Tgas each for one link", () => {
    expect(armReturnTgas(120)).toBe(45 + 4 * 3);
    expect(armReturnTgas(3600)).toBe(45 + 38 * 3);
    expect(armReturnTgas(0)).toBe(45 + 2 * 3);
  });

  it("charges a little more per wake-up for a batch, and never more than one transaction carries", () => {
    expect(armReturnTgas(3600, 30)).toBe(103 + 38 * 6);
    expect(armReturnTgas(7 * 86_400)).toBe(RETURN_TIMER_MAX_TGAS);
  });

  it("knows which lives one transaction covers: about 8 hours for a link, 4 for a batch of 30", () => {
    expect(returnTimerFits(8 * 3600)).toBe(true);
    expect(returnTimerFits(24 * 3600)).toBe(false);
    expect(returnTimerFits(4 * 3600, 30)).toBe(true);
    expect(returnTimerFits(8 * 3600, 30)).toBe(false);
    // the gas armed for a life always covers that life
    for (const life of [120, 600, 3600, 4 * 3600, 8 * 3600]) expect(returnTimerCoversS(armReturnTgas(life), 1)).toBeGreaterThanOrEqual(life);
  });
});
