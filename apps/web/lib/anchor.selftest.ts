/**
 * Anchor self-test — the invariants of the SEP-1 / SEP-10 / SEP-6 / SEP-24 client, offline.
 *
 * WHAT THIS PROTECTS. lib/anchor.ts is the first code in this product that takes a transaction
 * from a third party and asks the user's own key to sign it. That is the most dangerous shape in
 * the whole codebase, so the properties below are the ones a regression must not be allowed to
 * quietly remove:
 *
 *   1. A SEP-10 challenge is verified against the SIGNING_KEY the anchor publishes in its OWN
 *      stellar.toml, BEFORE the signer is ever called. A challenge signed by anybody else, or by
 *      nobody, must be refused. This is the difference between signing in and signing away.
 *   2. A challenge issued for a different account is refused, so one person's session cannot be
 *      completed with another person's key.
 *   3. An anchor on the wrong network is refused before anything is signed.
 *   4. An unrecognised withdrawal status is reported as "waiting", never as finished. Calling an
 *      unknown state settled is the exact bug this codebase already shipped once on the link
 *      status reader, and it is not repeated here.
 *   5. Discovery refuses an anchor that does not publish what the flow needs, instead of carrying
 *      a half-configured anchor into the money path.
 *
 * The network is stubbed with a fake fetch, so this runs with no anchor, no keys and no internet.
 * The challenge transactions are built with the real SDK, so the verification being tested is the
 * real one and not a mock of it.
 *
 * RUN: pnpm --filter @lumenia/web test:anchor   (offline, no keys)
 */
import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";
import {
  authenticate,
  readAnchorInfo,
  readWithdrawal,
  requestQuote,
  setBankAccount,
  startWithdrawal,
  type AnchorInfo,
} from "./anchor";
import { localSignerFromSeed } from "./signer";
import { formatIban, isValidIban, normalizeIban } from "./iban";
import { createAnchorAdapter } from "./offramp";
import type { NetworkConfig } from "./network";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}
async function throws(name: string, fn: () => Promise<unknown>, mustMention?: string) {
  try {
    await fn();
    ok(name, false, "it did NOT throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(name, mustMention ? msg.toLowerCase().includes(mustMention.toLowerCase()) : true, msg.slice(0, 70));
  }
}

const HOME = "anchor.example.com";
/** A stand-in issuer. Only its shape matters here: a SEP-38 asset id is `stellar:CODE:ISSUER`. */
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PASSPHRASE = Networks.TESTNET;
const NET: NetworkConfig = {
  id: "testnet",
  passphrase: PASSPHRASE,
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contract: "C".padEnd(56, "A"),
  legacyContracts: [],
  sponsorUrl: "https://sponsor.invalid",
  isMainnet: false,
};

const anchorKp = Keypair.random();
const impostorKp = Keypair.random();
const userSeed = new Uint8Array(32).fill(7);
const signer = localSignerFromSeed(userSeed);
const USER = signer.publicKey();

const INFO: AnchorInfo = {
  homeDomain: HOME,
  webAuthEndpoint: `https://${HOME}/auth`,
  transferServer: `https://${HOME}/sep24`,
  door: "sep24",
  signingKey: anchorKp.publicKey(),
  networkPassphrase: PASSPHRASE,
  currencies: ["USDC"],
  quoteServer: null,
  kycServer: null,
};

/**
 * A real SEP-10 challenge, signed by whoever we say.
 *
 * Built with the SDK's own `buildChallengeTx` rather than by hand, so the fixture cannot drift
 * away from what the verifier expects. Hand-rolling it once produced a challenge the verifier
 * rejected for the wrong reason, which would have made this whole suite prove nothing.
 */
function challenge(signWith: Keypair, clientAccount = USER, homeDomain = HOME): string {
  return WebAuth.buildChallengeTx(
    signWith,
    clientAccount,
    homeDomain,
    300,
    PASSPHRASE,
    HOME,
  );
}

/** Swap global fetch for a scripted one. Returns a restore function. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

console.log("============================================================");
console.log(" SELF-TEST — anchor client (SEP-1, SEP-10, SEP-6, SEP-24)");
console.log("============================================================\n");

async function main() {
  console.log("[sep-10] the challenge must be signed by the anchor's own published key");
  {
    let restore = stubFetch(() => ({ body: { transaction: challenge(anchorKp), network_passphrase: PASSPHRASE } }));
    let signCalls = 0;
    const counting = { ...signer, sign: async (tx: Parameters<typeof signer.sign>[0]) => (signCalls++, signer.sign(tx)) };
    try {
      await authenticate(INFO, counting, NET).catch(() => undefined);
      ok("a properly signed challenge reaches the signer", signCalls === 1, `sign called ${signCalls}x`);
    } finally {
      restore();
    }

    restore = stubFetch(() => ({ body: { transaction: challenge(impostorKp), network_passphrase: PASSPHRASE } }));
    signCalls = 0;
    try {
      await throws(
        "a challenge signed by SOMEBODY ELSE is refused",
        () => authenticate(INFO, counting, NET),
      );
      ok("and the user's key was never asked to sign it", signCalls === 0, `sign called ${signCalls}x`);
    } finally {
      restore();
    }
  }

  console.log("\n[sep-10] the challenge must be for THIS account and THIS network");
  {
    let restore = stubFetch(() => ({
      body: { transaction: challenge(anchorKp, Keypair.random().publicKey()), network_passphrase: PASSPHRASE },
    }));
    try {
      await throws("a challenge issued for a different account is refused", () => authenticate(INFO, signer, NET));
    } finally {
      restore();
    }

    restore = stubFetch(() => ({ body: { transaction: challenge(anchorKp), network_passphrase: Networks.PUBLIC } }));
    try {
      await throws(
        "an anchor answering on the wrong network is refused",
        () => authenticate(INFO, signer, NET),
        "different network",
      );
    } finally {
      restore();
    }

    await throws(
      "an anchor whose toml declares the wrong network is refused before any request",
      () => authenticate({ ...INFO, networkPassphrase: Networks.PUBLIC }, signer, NET),
      "different network",
    );
  }

  console.log("\n[sep-10] a missing or empty answer is an error, never a silent success");
  {
    const restore = stubFetch(() => ({ body: {} }));
    try {
      await throws("no challenge in the answer is refused", () => authenticate(INFO, signer, NET));
    } finally {
      restore();
    }
  }

  console.log("\n[sep-1] discovery refuses an anchor that cannot do the job");
  {
    const cases: Array<[string, string, string]> = [
      ["no WEB_AUTH_ENDPOINT", `TRANSFER_SERVER_SEP0024 = "https://x/y"\nSIGNING_KEY = "${anchorKp.publicKey()}"`, "sign-in"],
      ["neither transfer server", `WEB_AUTH_ENDPOINT = "https://x/a"\nSIGNING_KEY = "${anchorKp.publicKey()}"`, "transfer"],
      ["no SIGNING_KEY", `WEB_AUTH_ENDPOINT = "https://x/a"\nTRANSFER_SERVER_SEP0024 = "https://x/y"`, "signing key"],
    ];
    for (const [label, toml, mention] of cases) {
      const restore = stubFetch(() => ({ body: toml }));
      try {
        await throws(`${label} is refused`, () => readAnchorInfo(HOME), mention);
      } finally {
        restore();
      }
    }

    const good = `WEB_AUTH_ENDPOINT = "https://${HOME}/auth"
TRANSFER_SERVER_SEP0024 = "https://${HOME}/sep24"
SIGNING_KEY = "${anchorKp.publicKey()}"
NETWORK_PASSPHRASE = "${PASSPHRASE}"

[[CURRENCIES]]
code = "USDC"
[[CURRENCIES]]
code = "try"
`;
    const restore = stubFetch(() => ({ body: good }));
    try {
      const info = await readAnchorInfo(`https://${HOME}/`);
      ok("a complete toml parses", info.signingKey === anchorKp.publicKey());
      ok("the home domain is normalised (scheme and trailing slash stripped)", info.homeDomain === HOME, info.homeDomain);
      ok("currencies are reported upper-cased, as the anchor's claim", info.currencies.join(",") === "USDC,TRY", info.currencies.join(","));
    } finally {
      restore();
    }
  }

  console.log("\n[sep-1] which door: SEP-6 and SEP-24 are both discoverable, SEP-24 preferred");
  {
    const base = `WEB_AUTH_ENDPOINT = "https://${HOME}/auth"\nSIGNING_KEY = "${anchorKp.publicKey()}"`;
    const read = async (extra: string) => {
      const restore = stubFetch(() => ({ body: `${base}\n${extra}` }));
      try {
        return await readAnchorInfo(HOME);
      } finally {
        restore();
      }
    };

    // This is the shape the Turkish sandbox ramp publishes: SEP-6 only, plus a quote server.
    const sep6 = await read(
      `TRANSFER_SERVER = "https://${HOME}/sep6"\nANCHOR_QUOTE_SERVER = "https://${HOME}/sep38"`,
    );
    ok("an anchor with only TRANSFER_SERVER is accepted", sep6.door === "sep6", sep6.door);
    ok("...and its transfer server is the SEP-6 one", sep6.transferServer === `https://${HOME}/sep6`);
    ok("...and the quote server is picked up", sep6.quoteServer === `https://${HOME}/sep38`);

    const sep24 = await read(`TRANSFER_SERVER_SEP0024 = "https://${HOME}/sep24"`);
    ok("an anchor with only TRANSFER_SERVER_SEP0024 is accepted", sep24.door === "sep24", sep24.door);
    ok("...and with no quote server that field is null", sep24.quoteServer === null);

    const both = await read(
      `TRANSFER_SERVER = "https://${HOME}/sep6"\nTRANSFER_SERVER_SEP0024 = "https://${HOME}/sep24"`,
    );
    ok("an anchor offering both doors gets the hosted one", both.door === "sep24", both.door);
    ok("...and the matching transfer server", both.transferServer === `https://${HOME}/sep24`);
  }

  console.log("\n[sep-6] opening a withdrawal names the destination straight away");
  {
    const seen: string[] = [];
    const openWith = (body: unknown, params: Parameters<typeof startWithdrawal>[2]) => {
      const restore = stubFetch((url) => (seen.push(url), { body }));
      return startWithdrawal({ ...INFO, door: "sep6", transferServer: `https://${HOME}/sep6` }, "jwt", params).finally(
        restore,
      );
    };

    seen.length = 0;
    const opened = await openWith(
      { id: "tx-1", account_id: "GTREASURY", memo: "9182", memo_type: "id" },
      {
        assetCode: "USDC",
        assetIssuer: ISSUER,
        account: USER,
        amount: "10",
        destinationAsset: "iso4217:TRY",
        dest: "TR33...",
      },
    );
    ok("a SEP-6 withdrawal is ready to pay immediately, with no screen", opened.kind === "ready-to-pay");
    if (opened.kind === "ready-to-pay") {
      ok("the treasury account comes through", opened.destination === "GTREASURY");
      ok("the memo and its type come through", opened.memo === "9182" && opened.memoType === "id");
    }
    ok("a cross-currency exit uses withdraw-exchange", seen[0]?.includes("/withdraw-exchange?"), seen[0]?.slice(0, 90));
    ok("...and names what the person receives", seen[0]?.includes("destination_asset=iso4217%3ATRY"));
    ok("...and carries the account", seen[0]?.includes(`account=${USER}`));

    // Both of these were wrong in the first draft and were caught by probing the live Turkish
    // sandbox anchor, which answered 400 to each. Pinned here so they cannot come back.
    ok(
      "...and still sends asset_code, which -exchange requires as well, not instead",
      seen[0]?.includes("asset_code=USDC"),
      seen[0]?.slice(0, 120),
    );
    ok(
      "...and names the issuer in source_asset, because a bare stellar:USDC is not an asset",
      seen[0]?.includes(`source_asset=stellar%3AUSDC%3A${ISSUER}`),
      seen[0]?.slice(0, 160),
    );
    await throws(
      "a cross-currency exit with no issuer is refused before it can be rejected by the anchor",
      () =>
        openWith(
          { id: "tx-x", account_id: "GTREASURY" },
          { assetCode: "USDC", account: USER, destinationAsset: "iso4217:TRY" },
        ),
      "issuer",
    );

    seen.length = 0;
    await openWith({ id: "tx-2", account_id: "GTREASURY" }, { assetCode: "USDC", account: USER });
    ok("a same-asset withdrawal uses plain /withdraw", /\/withdraw\?/.test(seen[0] ?? ""), seen[0]?.slice(0, 70));
    ok("...and falls back to the bank_account type", seen[0]?.includes("type=bank_account"));
    ok("...and carries asset_code", seen[0]?.includes("asset_code=USDC"));
    ok("...and sends no source_asset, because nothing is being converted", !seen[0]?.includes("source_asset"));

    seen.length = 0;
    const quoted = await openWith(
      { id: "tx-3", account_id: "GTREASURY" },
      { assetCode: "USDC", assetIssuer: ISSUER, account: USER, destinationAsset: "iso4217:TRY", quoteId: "q-77" },
    );
    ok("a locked rate is passed through as quote_id", seen[0]?.includes("quote_id=q-77"));
    ok("...and the withdrawal still opens", quoted.kind === "ready-to-pay");

    await throws(
      "a withdrawal that names NO destination is refused, not paid to nowhere",
      () => openWith({ id: "tx-4" }, { assetCode: "USDC", account: USER }),
      "where to send",
    );
    await throws(
      "a withdrawal with no id at all is refused",
      () => openWith({ account_id: "GTREASURY" }, { assetCode: "USDC", account: USER }),
    );
    const oddMemo = await openWith(
      { id: "tx-5", account_id: "GTREASURY", memo: "x", memo_type: "invented" },
      { assetCode: "USDC", account: USER },
    );
    ok(
      "an unrecognised memo type is dropped rather than passed on",
      oddMemo.kind === "ready-to-pay" && oddMemo.memoType === null,
    );
  }

  console.log("\n[sep-24/sep-6] an unknown status is 'waiting', never 'settled'");
  {
    const state = (t: Record<string, unknown>) => {
      const restore = stubFetch(() => ({ body: { transaction: t } }));
      return readWithdrawal(INFO, "jwt", "id-1").finally(restore);
    };

    ok("completed maps to settled", (await state({ status: "completed" })).status === "settled");
    ok("refunded maps to refunded", (await state({ status: "refunded" })).status === "refunded");
    ok("error maps to failed", (await state({ status: "error", message: "no" })).status === "failed");

    for (const s of ["pending_anchor", "pending_stellar", "pending_external", "pending_user_transfer_complete", "something_an_anchor_invented", ""]) {
      const r = await state({ status: s });
      ok(`"${s || "(empty)"}" is NOT reported as finished`, r.status === "waiting", r.status);
    }

    const ready = await state({
      status: "pending_user_transfer_start",
      withdraw_anchor_account: "GABC",
      withdraw_memo: "12345",
      withdraw_memo_type: "id",
      amount_in: "10.0000000",
      amount_fee: "0.1000000",
    });
    ok("pending_user_transfer_start hands over a destination", ready.status === "ready-to-pay");
    if (ready.status === "ready-to-pay") {
      ok("the memo comes through", ready.memo === "12345" && ready.memoType === "id");
      ok("the amount comes through", ready.amountIn === "10.0000000");
    }

    const noDest = await state({ status: "pending_user_transfer_start" });
    ok("...but a hand-over with NO destination is 'waiting', not a payment to nowhere", noDest.status === "waiting");

    const badMemoType = await state({
      status: "pending_user_transfer_start",
      withdraw_anchor_account: "GABC",
      withdraw_memo: "x",
      withdraw_memo_type: "nonsense",
    });
    ok(
      "an unrecognised memo type is dropped rather than passed on as if understood",
      badMemoType.status === "ready-to-pay" && badMemoType.memoType === null,
    );

    const missing = await state({});
    ok("an answer with no transaction is 'waiting'", missing.status === "waiting");
  }

  console.log("\n[seam] the adapter, end to end: the anchor is paid exactly once");
  {
    // Everything above tests lib/anchor.ts directly. This tests the SEAM: the adapter in
    // lib/offramp.ts that production actually calls. Both bugs this block pins were live in the
    // adapter while every library test above was green, which is the whole reason it exists.
    const withdrawUrls: string[] = [];
    let txPolls = 0;

    const restore = stubFetch((url) => {
      if (url.includes("/.well-known/stellar.toml")) {
        return {
          body:
            `WEB_AUTH_ENDPOINT = "https://${HOME}/auth"\n` +
            `SIGNING_KEY = "${anchorKp.publicKey()}"\n` +
            `TRANSFER_SERVER = "https://${HOME}/sep6"\n` +
            `NETWORK_PASSPHRASE = "${PASSPHRASE}"\n`,
        };
      }
      if (url.includes("/auth")) {
        // GET returns a challenge; POST returns a token. One handler answers both because the
        // adapter drives them in order and only the shape matters here.
        return { body: { transaction: challenge(anchorKp), network_passphrase: PASSPHRASE, token: "jwt" } };
      }
      if (url.includes("/withdraw")) {
        withdrawUrls.push(url);
        return { body: { id: "w-1", account_id: "GTREASURY", memo: "556677", memo_type: "id" } };
      }
      if (url.includes("/transaction")) {
        txPolls++;
        // The real anchor sits here for about ten seconds while it watches the ledger. Answer
        // "ready to pay" three times, exactly as it does, then settle.
        const status = txPolls >= 4 ? "completed" : "pending_user_transfer_start";
        return {
          body: { transaction: { status, withdraw_anchor_account: "GTREASURY", withdraw_memo: "556677", withdraw_memo_type: "id" } },
        };
      }
      return { status: 404, body: {} };
    });

    const paid: { destination: string; memo: string | null; amount: string }[] = [];
    const statuses: string[] = [];
    try {
      const adapter = createAnchorAdapter(
        {
          signer,
          account: USER,
          assetCode: "USDC",
          assetIssuer: ISSUER,
          fiatAsset: "iso4217:TRY",
          fiatDestination: "TR330006100519786457841326",
          openInteractive: () => undefined,
          pay: async (r) => {
            paid.push({ destination: r.destination, memo: r.memo, amount: r.amount });
          },
        },
        HOME,
        { pollIntervalMs: 1, timeoutMs: 5_000 },
      );

      ok("the adapter is built when a home domain is configured", adapter !== null);
      await adapter?.start("10", (s) => statuses.push(s));

      ok(
        "the withdrawal reached the anchor with the issuer in source_asset",
        withdrawUrls[0]?.includes(`source_asset=stellar%3AUSDC%3A${ISSUER}`),
        withdrawUrls[0]?.slice(0, 130),
      );
      ok("...and with asset_code alongside it", withdrawUrls[0]?.includes("asset_code=USDC"));
      ok("...and the person's IBAN as the destination", withdrawUrls[0]?.includes("dest=TR330006100519786457841326"));

      // The one that matters. Before the latch this was 4 real payments to a pooled treasury.
      ok(`the treasury is paid EXACTLY once, not once per poll`, paid.length === 1, `paid ${paid.length}x`);
      ok("...to the account and memo the anchor named", paid[0]?.destination === "GTREASURY" && paid[0]?.memo === "556677");
      ok("...and the flow ends done", statuses[statuses.length - 1] === "done", statuses.join(" -> "));
    } finally {
      restore();
    }
  }

  console.log("\n[sep-1] the optional servers are read when published and null when not");
  {
    const base =
      `WEB_AUTH_ENDPOINT = "https://${HOME}/auth"\n` +
      `SIGNING_KEY = "${anchorKp.publicKey()}"\n` +
      `TRANSFER_SERVER = "https://${HOME}/sep6"\n`;
    let restore = stubFetch(() => ({ body: `${base}KYC_SERVER = "https://${HOME}/sep12/"\n` }));
    try {
      const info = await readAnchorInfo(HOME);
      ok("KYC_SERVER is parsed, trailing slash dropped", info.kycServer === `https://${HOME}/sep12`, String(info.kycServer));
    } finally {
      restore();
    }
    restore = stubFetch(() => ({ body: base }));
    try {
      const info = await readAnchorInfo(HOME);
      ok("no KYC_SERVER means null, not a guess", info.kycServer === null && info.quoteServer === null);
    } finally {
      restore();
    }
  }

  console.log("\n[sep-38] a firm quote, or a refusal");
  {
    const quoting: AnchorInfo = { ...INFO, quoteServer: `https://${HOME}/sep38` };
    const params = { sellAssetCode: "USDC", sellAssetIssuer: ISSUER, buyAsset: "iso4217:TRY", sellAmount: "5" };

    await throws("an anchor with no quote server is refused", () => requestQuote(INFO, "jwt", params), "quote");

    let seen: { url: string; init?: RequestInit } | null = null;
    let restore = stubFetch((url, init) => {
      seen = { url, init };
      return {
        status: 201,
        body: { id: "qt_1", sell_amount: "5", buy_amount: "240.94", price: "48.19", expires_at: "2026-09-06T17:13:30Z" },
      };
    });
    try {
      const q = await requestQuote(quoting, "jwt", params);
      const s = seen as { url: string; init?: RequestInit } | null;
      const body = JSON.parse(String(s?.init?.body ?? "{}")) as Record<string, string>;
      const headers = (s?.init?.headers ?? {}) as Record<string, string>;
      ok("the quote is POSTed to <quoteServer>/quote", s?.url === `https://${HOME}/sep38/quote` && s?.init?.method === "POST", s?.url);
      ok("...with the session token", headers.authorization === "Bearer jwt");
      ok(
        "...selling the pinned asset by code AND issuer, buying the fiat named",
        body.sell_asset === `stellar:USDC:${ISSUER}` && body.buy_asset === "iso4217:TRY" && body.sell_amount === "5",
        JSON.stringify(body),
      );
      ok("the anchor's id, figure and expiry come back as given", q.id === "qt_1" && q.buyAmount === "240.94" && q.expiresAt === "2026-09-06T17:13:30Z");
    } finally {
      restore();
    }

    restore = stubFetch(() => ({ status: 201, body: { price: "48.19" } }));
    try {
      await throws("an answer without an id or a figure is not a quote", () => requestQuote(quoting, "jwt", params), "usable");
    } finally {
      restore();
    }
  }

  console.log("\n[sep-12] a payout destination and nothing else");
  {
    const kyc: AnchorInfo = { ...INFO, kycServer: `https://${HOME}/sep12` };
    const params = { account: USER, bankAccountNumber: "TR330006100519786457841326" };

    await throws("an anchor with no SEP-12 server is refused", () => setBankAccount(INFO, "jwt", params), "destination");

    let seen: { url: string; init?: RequestInit } | null = null;
    // The real anchor answers 202 with a tiny body; an empty body must not be an error either.
    let restore = stubFetch((url, init) => {
      seen = { url, init };
      return { status: 202, body: "" };
    });
    try {
      await setBankAccount(kyc, "jwt", params);
      const s = seen as { url: string; init?: RequestInit } | null;
      const body = JSON.parse(String(s?.init?.body ?? "{}")) as Record<string, string>;
      const headers = (s?.init?.headers ?? {}) as Record<string, string>;
      ok("the destination is PUT to <kycServer>/customer", s?.url === `https://${HOME}/sep12/customer` && s?.init?.method === "PUT", s?.url);
      ok("...with the session token", headers.authorization === "Bearer jwt");
      ok(
        "...carrying exactly account, type and the bank account number",
        Object.keys(body).sort().join(",") === "account,bank_account_number,type" && body.bank_account_number === params.bankAccountNumber,
        Object.keys(body).join(","),
      );
      ok("...and no name, email, id number or document field, ever", !/name|email|id_number|tax|birth|photo|document/i.test(Object.keys(body).join(",")));
      ok("a 202 with an empty body is success", true);
    } finally {
      restore();
    }

    restore = stubFetch((url, init) => {
      seen = { url, init };
      return { status: 202, body: { id: "cus_1" } };
    });
    try {
      await setBankAccount(kyc, "jwt", { ...params, bankName: "Example Bank" });
      const s = seen as { url: string; init?: RequestInit } | null;
      const body = JSON.parse(String(s?.init?.body ?? "{}")) as Record<string, string>;
      ok("a bank name travels only when given", body.bank_name === "Example Bank" && Object.keys(body).length === 4, Object.keys(body).join(","));
    } finally {
      restore();
    }

    restore = stubFetch(() => ({ status: 400, body: { error: "invalid_iban" } }));
    try {
      await throws("the anchor's rejection surfaces with its reason", () => setBankAccount(kyc, "jwt", params), "invalid_iban");
    } finally {
      restore();
    }
  }

  console.log("\n[iban] a typo is caught on this device, before any rail sees it");
  {
    ok("the ISO example Turkish IBAN passes", isValidIban("TR33 0006 1005 1978 6457 8413 26"));
    ok("one wrong digit fails", !isValidIban("TR33 0006 1005 1978 6457 8413 27"));
    ok("a Turkish IBAN of the wrong length fails", !isValidIban("TR330006100519786457841"));
    ok("a German example IBAN passes", isValidIban("DE89 3704 0044 0532 0130 00"));
    ok("lower case and spaces are normalised", normalizeIban("tr33 0006 1005 1978 6457 8413 26") === "TR330006100519786457841326");
    ok("formatting groups by four", formatIban("TR330006100519786457841326") === "TR33 0006 1005 1978 6457 8413 26");
    ok("an empty string is not an IBAN", !isValidIban(""));
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} ANCHOR SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
