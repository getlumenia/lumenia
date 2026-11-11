import { describe, expect, it } from "vitest";
import {
  buildQuoteRequest,
  NO_TESTNET_NOTE,
  ONECLICK_ASSETS,
  OneClickError,
  PLACEHOLDERS,
  requestDryQuote,
  summarizeQuote,
} from "../src/oneclick.js";

const now = new Date("2026-11-11T12:00:00.000Z");

describe("buildQuoteRequest (golden)", () => {
  it("matches the 1Click /v0/quote shape for Stellar USDC", () => {
    expect(buildQuoteRequest({ amountUnits: 10_000_000n, destination: "stellar", now })).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
      amount: "10000000",
      refundTo: "0000000000000000000000000000000000000000000000000000000000000000",
      refundType: "ORIGIN_CHAIN",
      recipient: PLACEHOLDERS.recipient.stellar,
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-11T12:30:00.000Z",
      referral: "lumenia",
    });
  });

  it("matches for Base USDC and honours a caller recipient", () => {
    const req = buildQuoteRequest({ amountUnits: 250_000n, destination: "base", now, recipient: "0x000000000000000000000000000000000000beef" });
    expect(req.destinationAsset).toBe(ONECLICK_ASSETS.baseUsdc);
    expect(req.amount).toBe("250000");
    expect(req.recipient).toBe("0x000000000000000000000000000000000000beef");
    expect(req.dry).toBe(true);
  });

  it("always sends an integer amount string and a dry flag", () => {
    const req = buildQuoteRequest({ amountUnits: 1n, destination: "base", now });
    expect(req.amount).toMatch(/^\d+$/);
    expect(JSON.parse(JSON.stringify(req)).dry).toBe(true);
  });

  it("rejects other destinations and zero amounts", () => {
    expect(() => buildQuoteRequest({ amountUnits: 1n, destination: "solana" as never, now })).toThrow(OneClickError);
    expect(() => buildQuoteRequest({ amountUnits: 0n, destination: "base", now })).toThrow(OneClickError);
  });
});

describe("requestDryQuote + summarizeQuote", () => {
  const sample = {
    correlationId: "8312b627-fece-43ce-bdf8-7d545f76bef6",
    quote: {
      amountIn: "10000000",
      amountInFormatted: "10.0",
      amountInUsd: "9.99",
      minAmountIn: "10000000",
      amountOut: "99832909",
      amountOutFormatted: "9.9832909",
      amountOutUsd: "9.97",
      minAmountOut: "98834579",
      timeEstimate: 35,
      withdrawFee: "146891",
      refundFee: "0",
    },
  };

  it("posts JSON to <base>/v0/quote and summarises the answer", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify(sample), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const req = buildQuoteRequest({ amountUnits: 10_000_000n, destination: "stellar", now });
    const res = await requestDryQuote("https://1click.example/", req, fetchImpl);
    expect(seen.url).toBe("https://1click.example/v0/quote");
    expect(seen.init?.method).toBe("POST");
    expect(JSON.parse(String(seen.init?.body))).toEqual(req);
    const q = summarizeQuote(req, "stellar", res);
    expect(q).toMatchObject({
      destination: "stellar",
      dry: true,
      amountInUsdc: "10.00",
      amountOutFormatted: "9.9832909",
      minAmountOutFormatted: "9.8834579",
      timeEstimateSeconds: 35,
      recipientIsPlaceholder: true,
      note: NO_TESTNET_NOTE,
      correlationId: sample.correlationId,
    });
  });

  it("surfaces 1Click's own message on a 4xx", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "Destination address does not have a trustline for this asset." }), { status: 400 })) as typeof fetch;
    const req = buildQuoteRequest({ amountUnits: 1_000_000n, destination: "stellar", now });
    await expect(requestDryQuote("https://1click.example", req, fetchImpl)).rejects.toThrow(/trustline/);
  });

  it("explains an unreachable API without pretending anything was spent", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const req = buildQuoteRequest({ amountUnits: 1_000_000n, destination: "base", now });
    await expect(requestDryQuote("https://1click.example", req, fetchImpl)).rejects.toThrow(/unreachable.*nothing was spent/i);
  });
});
