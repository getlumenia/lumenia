/**
 * Restore self-test: email -> one-time code -> password, src/lib/restore.ts with the REAL recovery
 * client (apps/web/lib/recovery-api.ts) and the REAL box crypto (Argon2id + AES-GCM,
 * apps/web/lib/recovery.ts). Only `fetch` is faked, as the sponsor's /recovery-otp and
 * /recovery-fetch; `save` and `publicKeyOf` are plain functions.
 *
 *   [a] step 1, the mailed code: a bad address makes no request; the request is the trimmed address
 *       and nothing else, to the TESTNET Worker (recovery lives on that one host for both networks)
 *   [b] step 2, the code for the box: a code that is not six digits makes no request; the request
 *       carries SHA-256(trimmed lowercased email) and the code, never the email or a password; and
 *       every answer the server can give maps to one named failure
 *   [c] step 3, the password: wrong, out-of-bounds, wrong-length and unsaveable boxes fail closed,
 *       and the right one returns the account's key and keeps it exactly once
 *   [d] the whole flow end to end, and that nothing but ciphertext ever left the device
 *   [e] the same steps through src/background/account.ts: consent first, the state kept in the
 *       session, a retry after a wrong password, and a failed keystore write unlocking nothing
 *
 * RUN: pnpm --filter @lumenia/extension test:restore   (offline, no keys, no network)
 */
import { Keypair } from "@stellar/stellar-sdk";
import type { PasswordCopy, RecoveryBox } from "../src/core";
import type { RestoreDeps } from "../src/lib/restore";
import { installChrome } from "./chrome-fake";
import { hex, installBuildEnv, jsonResponse, ok, outcome, run, same, section, sha256hex } from "./_harness";

const TESTNET_WORKER = "https://lumenia-sponsor.avakit.workers.dev";
const MAINNET_WORKER = "https://lumenia-sponsor-mainnet.avakit.workers.dev";
const PASSWORD = "correct horse battery";
const EMAIL = "Ayse@Example.com";
const BOX_ID = sha256hex("ayse@example.com");
const CODE = "123456";

interface Call {
  url: string;
  path: string;
  method?: string;
  headers: Record<string, string>;
  init: RequestInit | undefined;
  raw: string;
  body: Record<string, unknown>;
}

async function main() {
  installBuildEnv();
  const fake = installChrome();
  const storage = await import("../src/lib/storage");
  storage.useAreas(fake.local, fake.session);
  const core = await import("../src/core");
  const recovery = await import("../../web/lib/recovery");
  const { startRestore, submitCode, openBox, validEmail, normalizeCode } = await import("../src/lib/restore");
  const { ExtError, MESSAGES } = await import("../src/lib/errors");
  const account = await import("../src/background/account");

  // A real account's seed, and real boxes made from it.
  const kp = Keypair.random();
  const seed = new Uint8Array(kp.rawSecretKey());
  const pwCopy = await recovery.wrapWithPassword(seed, PASSWORD);
  const prfCopy = await recovery.wrapWithPrf(seed, crypto.getRandomValues(new Uint8Array(32)));
  const goodBox: RecoveryBox = { formatVersion: 1, copies: [pwCopy, prfCopy] };
  const prfOnly: RecoveryBox = { formatVersion: 1, copies: [prfCopy] };

  /* ------------------------------------- the fake server ------------------------------------- */
  const calls: Call[] = [];
  const server = {
    boxes: new Map<string, unknown>(),
    otp: (_b: Record<string, unknown>): Response | Promise<Response> => jsonResponse(200, { ok: true }),
    fetch: (b: Record<string, unknown>): Response | Promise<Response> => {
      if (b.code !== CODE) return jsonResponse(401, { error: "That code is wrong or has expired." });
      const box = server.boxes.get(String(b.id));
      return box === undefined ? jsonResponse(404, { error: "no backup" }) : jsonResponse(200, { box });
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = String(init?.body ?? "");
    const path = new URL(url).pathname;
    const call: Call = { url, path, method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, init, raw, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
    calls.push(call);
    if (path === "/recovery-otp") return server.otp(call.body);
    if (path === "/recovery-fetch") return server.fetch(call.body);
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
  const reset = () => {
    calls.length = 0;
    server.boxes = new Map([[BOX_ID, goodBox]]);
    server.otp = () => jsonResponse(200, { ok: true });
    server.fetch = (b) => {
      if (b.code !== CODE) return jsonResponse(401, { error: "That code is wrong or has expired." });
      const box = server.boxes.get(String(b.id));
      return box === undefined ? jsonResponse(404, { error: "no backup" }) : jsonResponse(200, { box });
    };
  };

  // The deps are the real ones; the two simple functions are the account's key and the keystore stand-in.
  const saves: { pubkey: string; seedAtCall: Uint8Array; ref: Uint8Array; password: string }[] = [];
  let saveError: Error | null = null;
  let lastUnwrapped: Uint8Array | null = null;
  const deps: RestoreDeps = {
    requestOtp: core.requestRecoveryOtp,
    fetchBox: core.fetchRecoveryBox,
    findPasswordCopy: (box) => core.findCopy(box, "password"),
    unwrap: async (copy: PasswordCopy, password: string) => (lastUnwrapped = await core.unwrapWithPassword(copy, password)),
    publicKeyOf: (s) => Keypair.fromRawEd25519Seed(Buffer.from(s)).publicKey(),
    save: async (pubkey, s, password) => {
      saves.push({ pubkey, seedAtCall: Uint8Array.from(s), ref: s, password });
      if (saveError) throw saveError;
    },
  };
  const codeOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r ? (r.error instanceof ExtError ? r.error.code : `non-ExtError: ${String(r.error)}`) : "returned");
  const messageOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r && r.error instanceof Error ? r.error.message : "");

  /* ---------------------------------------- [a] ---------------------------------------- */
  section("a", "step 1: mail a code");
  reset();
  for (const bad of ["", "   ", "not an email", "a@b", "a b@c.de", "@c.de", "a@", "a@.de", `${"a".repeat(250)}@b.co`, "a@b@c.de"]) {
    const before = calls.length;
    const r = await outcome(startRestore(deps, bad));
    ok(`${JSON.stringify(bad.length > 20 ? `${bad.slice(0, 8)}...(${bad.length})` : bad)} -> bad-email, and no request is made`, codeOf(r) === "bad-email" && calls.length === before);
  }
  ok("validEmail agrees: ordinary addresses pass, with or without spaces around them", validEmail("ayse@example.com") && validEmail("  ayse@example.com  ") && !validEmail("ayse@"));

  reset();
  const otp = await outcome(startRestore(deps, `  ${EMAIL}  `));
  const c1 = calls[0];
  ok("a good address, padded with spaces: one request", codeOf(otp) === "returned" && calls.length === 1);
  ok("  ...to the TESTNET Worker's /recovery-otp, as a JSON POST", c1?.url === `${TESTNET_WORKER}/recovery-otp` && c1.method === "POST" && c1.headers["content-type"] === "application/json", c1?.url);
  ok("  ...carrying the trimmed address (case kept) and nothing else", same(c1?.body, { email: EMAIL }), c1?.raw);

  const otpFailures: [string, () => Response | Promise<Response>, string, RegExp?][] = [
    ["the connection fails", () => { throw new TypeError("fetch failed"); }, "offline"],
    ["the server says too many requests (429)", () => jsonResponse(429, { error: "Too many requests. Wait a minute." }), "rate-limited"],
    ["the server says rate limit", () => jsonResponse(429, { error: "rate limit exceeded" }), "rate-limited"],
    ["the server fails (500)", () => jsonResponse(500, { error: "boom" }), "internal", /couldn't send the code/i],
    ["the server answers with something that is not JSON", () => new Response("<html>oops</html>", { status: 502 }), "internal", /couldn't send the code/i],
  ];
  for (const [what, reply, code, text] of otpFailures) {
    reset();
    server.otp = reply;
    const r = await outcome(startRestore(deps, EMAIL));
    ok(`${what} -> ${code}`, codeOf(r) === code && (!text || text.test(messageOf(r))), `${codeOf(r)}: ${messageOf(r)}`);
  }

  /* ---------------------------------------- [b] ---------------------------------------- */
  section("b", "step 2: trade the code for the box");
  ok("normalizeCode strips every kind of whitespace", normalizeCode(" 123 456\n") === "123456" && normalizeCode("12\t34 56") === "123456");
  reset();
  for (const bad of ["", "   ", "12345", "1234567", "abcdef", "12345a", "12-345", "\u0661\u0662\u0663\u0664\u0665\u0666", "1 2 3 4 5"]) {
    const before = calls.length;
    const r = await outcome(submitCode(deps, EMAIL, bad));
    ok(`${JSON.stringify(bad)} -> bad-code, and no request is made`, codeOf(r) === "bad-code" && calls.length === before);
  }

  reset();
  const got = await outcome(submitCode(deps, `  ${EMAIL}  `, "123 456"));
  const f1 = calls[0];
  ok("a good code (pasted with a space) fetches the box and returns it", codeOf(got) === "returned" && "value" in got && same(got.value, goodBox) && calls.length === 1);
  ok("  ...from the TESTNET Worker's /recovery-fetch, as a JSON POST", f1?.url === `${TESTNET_WORKER}/recovery-fetch` && f1.method === "POST" && f1.headers["content-type"] === "application/json", f1?.url);
  ok("  ...the body is exactly { id, code }", same(Object.keys(f1?.body ?? {}).sort(), ["code", "id"]));
  ok("  ...id is SHA-256 of the trimmed, lower-cased email, in hex", f1?.body.id === BOX_ID && /^[0-9a-f]{64}$/.test(String(f1?.body.id)), String(f1?.body.id).slice(0, 12));
  ok("  ...code is the six digits with the space gone", f1?.body.code === CODE);
  ok("  ...the request holds no email, no password and no key material", !/ayse|example/i.test(f1?.raw ?? "") && !(f1?.raw ?? "").includes(PASSWORD));
  ok("  ...and nothing else rides on the request: only the content-type header, no credentials, no mode", same(Object.keys(f1?.init ?? {}).sort(), ["body", "headers", "method"]) && same(Object.keys(f1?.headers ?? {}), ["content-type"]));
  await outcome(submitCode(deps, "AYSE@EXAMPLE.COM", CODE));
  ok("  ...another spelling of the same address (upper case) asks for the very same box id", calls[1]?.body.id === BOX_ID);
  ok("fetching the box saves nothing and opens nothing", saves.length === 0 && lastUnwrapped === null);

  const fetchRows: [string, () => Response | Promise<Response>, string, RegExp?][] = [
    ["the server answers 401", () => jsonResponse(401, { error: "That code is wrong or has expired." }), "bad-code"],
    ["the server answers 404", () => jsonResponse(404, { error: "no backup" }), "no-backup"],
    ["the server answers 200 with no box at all", () => jsonResponse(200, {}), "no-backup"],
    ["the server answers 200 with a null box", () => jsonResponse(200, { box: null }), "no-backup"],
    ["a box with no copies array", () => jsonResponse(200, { box: { formatVersion: 1 } }), "unsupported-backup"],
    ["a box whose copies is not an array", () => jsonResponse(200, { box: { formatVersion: 1, copies: "x" } }), "unsupported-backup"],
    ["a box that is an array", () => jsonResponse(200, { box: [] }), "unsupported-backup"],
    ["a box that is a string", () => jsonResponse(200, { box: "nope" }), "unsupported-backup"],
    ["a passkey-only box (no password copy)", () => jsonResponse(200, { box: prfOnly }), "no-password-copy"],
    ["a box with an empty copies list", () => jsonResponse(200, { box: { formatVersion: 1, copies: [] } }), "no-password-copy"],
    ["the connection fails", () => { throw new TypeError("fetch failed"); }, "offline"],
    // A server fault is not the person's connection: only a request with no answer is "offline".
    ["the server answers 200 with a null body", () => jsonResponse(200, null), "internal"],
    ["the server says too many requests", () => jsonResponse(429, { error: "Too many requests" }), "rate-limited"],
    ["the server fails (500)", () => jsonResponse(500, { error: "boom" }), "internal", /couldn't reach your backup/i],
  ];
  for (const [what, reply, code, text] of fetchRows) {
    reset();
    server.fetch = reply;
    const r = await outcome(submitCode(deps, EMAIL, CODE));
    ok(`${what} -> ${code}`, codeOf(r) === code && (!text || text.test(messageOf(r))) && saves.length === 0, `${codeOf(r)}: ${messageOf(r)}`);
  }
  reset();
  server.fetch = () => jsonResponse(401, { error: "That code is wrong or has expired." });
  const wrongCode = await outcome(submitCode(deps, EMAIL, "000000"));
  ok("the person is told the code is wrong or has expired, in those words", codeOf(wrongCode) === "bad-code" && messageOf(wrongCode) === MESSAGES["bad-code"]);

  /* ---------------------------------------- [c] ---------------------------------------- */
  section("c", "step 3: open the box with the password");
  reset();
  saves.length = 0;
  const base = calls.length;
  const opened = await outcome(openBox(deps, goodBox, PASSWORD));
  const res = "value" in opened ? opened.value : null;
  ok("the right password returns the account's public key and seed", res !== null && res.pubkey === kp.publicKey() && res.pubkey === Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey());
  ok("  ...the seed is the 32 bytes that were wrapped", res !== null && res.seed.length === 32 && hex(res.seed) === hex(seed));
  ok("  ...save was called exactly once, with (public key, the 32-byte seed, the password)", saves.length === 1 && saves[0]!.pubkey === kp.publicKey() && hex(saves[0]!.seedAtCall) === hex(seed) && saves[0]!.seedAtCall.length === 32 && saves[0]!.password === PASSWORD);
  ok("  ...opening a box makes no request at all (the password never leaves the device)", calls.length === base);
  ok("  ...and the seed handed back is the very array save saw (the caller zeroes it)", res !== null && res.seed === saves[0]!.ref);

  saves.length = 0;
  const wrong = await outcome(openBox(deps, goodBox, "not the password"));
  ok("a wrong password -> bad-password, nothing saved", codeOf(wrong) === "bad-password" && saves.length === 0 && messageOf(wrong) === MESSAGES["bad-password"]);
  const empty = await outcome(openBox(deps, goodBox, ""));
  ok("an empty password -> bad-password too", codeOf(empty) === "bad-password" && saves.length === 0);
  const tamperedCt = await outcome(openBox(deps, { formatVersion: 1, copies: [{ ...pwCopy, ct: Buffer.from(new Uint8Array(48).fill(7)).toString("base64") }] }, PASSWORD));
  ok("a damaged ciphertext reads as a wrong password (AES-GCM refuses it), nothing saved", codeOf(tamperedCt) === "bad-password" && saves.length === 0);

  const tampered = (argon: Partial<PasswordCopy["argon"]>): RecoveryBox => ({ formatVersion: 1, copies: [{ ...pwCopy, argon: { ...pwCopy.argon, ...argon } }] });
  const bounds: [string, Partial<PasswordCopy["argon"]>][] = [
    ["memory 4 MiB (cheap to crack)", { memMiB: 4 }],
    ["memory 18 MiB (just under the floor)", { memMiB: 18 }],
    ["memory 257 MiB (just over the ceiling)", { memMiB: 257 }],
    ["memory 4000000 MiB (would hang the browser)", { memMiB: 4_000_000 }],
    ["time cost 1", { time: 1 }],
    ["time cost 17", { time: 17 }],
    ["parallelism 0", { parallelism: 0 }],
    ["parallelism 9", { parallelism: 9 }],
    ["memory 48.5 MiB (not a whole number)", { memMiB: 48.5 }],
  ];
  for (const [what, patch] of bounds) {
    saves.length = 0;
    const r = await outcome(openBox(deps, tampered(patch), PASSWORD));
    ok(`a password copy with ${what} -> unsupported-backup, nothing saved`, codeOf(r) === "unsupported-backup" && saves.length === 0, codeOf(r));
  }
  const atFloor = await outcome(openBox(deps, tampered({ memMiB: 19 }), PASSWORD));
  ok("the floor itself (19 MiB) is an accepted setting: the derived key is then simply wrong, so it reads as a wrong password", codeOf(atFloor) === "bad-password");

  const short = await recovery.wrapWithPassword(new Uint8Array(16), PASSWORD);
  saves.length = 0;
  lastUnwrapped = null;
  const shortRes = await outcome(openBox(deps, { formatVersion: 1, copies: [short] }, PASSWORD));
  ok("a box that opens to 16 bytes, not a 32-byte seed -> unsupported-backup, nothing saved", codeOf(shortRes) === "unsupported-backup" && saves.length === 0);
  ok("  ...and the bytes it opened are zeroed", lastUnwrapped !== null && (lastUnwrapped as Uint8Array).every((b) => b === 0));

  saves.length = 0;
  saveError = new Error("QuotaExceededError");
  lastUnwrapped = null;
  const saveFail = await outcome(openBox(deps, goodBox, PASSWORD));
  saveError = null;
  ok("the keystore refuses to keep it -> internal, in words that say it could not be kept here", codeOf(saveFail) === "internal" && /couldn't keep it in this browser/.test(messageOf(saveFail)));
  ok("  ...and the seed is zeroed, never handed back", saves.length === 1 && lastUnwrapped !== null && (lastUnwrapped as Uint8Array).every((b) => b === 0) && !("value" in saveFail));

  ok("a passkey-only box has no password copy to open -> no-password-copy", codeOf(await outcome(openBox(deps, prfOnly, PASSWORD))) === "no-password-copy");
  ok("a box with no copies array -> unsupported-backup", codeOf(await outcome(openBox(deps, { formatVersion: 1 } as unknown as RecoveryBox, PASSWORD))) === "unsupported-backup");

  /* ---------------------------------------- [d] ---------------------------------------- */
  section("d", "the whole flow, and what left the device");
  reset();
  saves.length = 0;
  await startRestore(deps, `  ${EMAIL.toUpperCase()} `);
  const flowBox = await submitCode(deps, `  ${EMAIL.toUpperCase()} `, "123 456");
  const flow = await openBox(deps, flowBox, PASSWORD);
  ok("email -> code -> password restores the account it was made from", flow.pubkey === kp.publicKey() && hex(flow.seed) === hex(seed) && saves.length === 1);
  ok("exactly two requests were made, in order: /recovery-otp then /recovery-fetch", same(calls.map((c) => c.path), ["/recovery-otp", "/recovery-fetch"]));
  ok("  ...both to the testnet Worker, and never to the real-money Worker", calls.every((c) => c.url.startsWith(`${TESTNET_WORKER}/`)) && calls.every((c) => !c.url.startsWith(MAINNET_WORKER)));
  const wire = calls.map((c) => c.raw).join("\n");
  ok(
    "  ...the password, the seed (hex, base64, base64url) and the key never appear in anything sent",
    !wire.includes(PASSWORD) && !wire.includes(hex(seed)) && !wire.includes(Buffer.from(seed).toString("base64")) && !wire.includes(Buffer.from(seed).toString("base64url")) && !wire.includes(kp.secret()) && !wire.includes(kp.publicKey()),
  );
  ok("  ...the address went out once, to be mailed a code; the box request has only its hash", calls[0]!.raw.includes(EMAIL.toUpperCase().trim()) && !calls[1]!.raw.toLowerCase().includes("example"));
  flow.seed.fill(0);

  /* ---------------------------------------- [e] ---------------------------------------- */
  section("e", "the same steps through account.ts (consent, session state, fail closed)");
  const L = storage.K;
  const clean = async () => {
    reset();
    await fake.local.clear();
    await fake.session.clear();
    fake.alarms.length = 0;
  };
  await clean();
  const noConsent = await outcome(account.restoreRequestCode("ayse@example.com"));
  ok("before the person has agreed to what the extension sends: needs-consent, and not a single request", codeOf(noConsent) === "needs-consent" && calls.length === 0);
  ok("  ...the same for the code and the password steps", codeOf(await outcome(account.restoreSubmitCode(CODE))) === "needs-consent" && codeOf(await outcome(account.restoreSubmitPassword(PASSWORD))) === "needs-consent" && calls.length === 0);

  for (const net of ["testnet", "public"] as const) {
    await clean();
    await storage.writeSettings({ consentAt: Date.now(), net });
    const t0 = Date.now();
    const r1 = await outcome(account.restoreRequestCode(`  ${EMAIL}  `));
    const kept1 = await fake.session.get<{ step: string; email: string; codeSentAt: number }>(L.restore);
    ok(
      `[${net}] step 1 sends the code, and the session remembers the step, the trimmed address and when`,
      codeOf(r1) === "returned" && same(Object.keys(kept1 ?? {}).sort(), ["codeSentAt", "email", "step"]) && kept1?.step === "code" && kept1.email === EMAIL && kept1.codeSentAt >= t0,
    );
    const r2 = await outcome(account.restoreSubmitCode(CODE));
    const st = await account.restoreState();
    const kept2 = await fake.session.get<{ box: unknown }>(L.restore);
    ok(`[${net}] step 2 keeps the (ciphertext) box in the session, and the state it reports never shows the box`, codeOf(r2) === "returned" && st?.step === "password" && !("box" in (st ?? {})) && same(kept2?.box, goodBox));
    ok(`[${net}] both requests went to the testnet Worker, never to the real-money Worker, whichever network is selected`, calls.length === 2 && calls.every((c) => c.url.startsWith(`${TESTNET_WORKER}/`)));
    const r3 = await outcome(account.restoreSubmitPassword("not the password"));
    ok(`[${net}] a wrong password: bad-password, the person can try again (the step and box stay), nothing is unlocked or remembered`, codeOf(r3) === "bad-password" && (await account.restoreState())?.step === "password" && (await fake.session.get(L.seed)) === undefined && (await fake.local.get(L.account)) === undefined);
    const r4 = await outcome(account.restoreSubmitPassword(PASSWORD));
    ok(
      `[${net}] the right password but the keystore cannot keep it (no IndexedDB here): internal, and NOTHING is unlocked, remembered or sent`,
      codeOf(r4) === "internal" && /couldn't keep it in this browser/.test(messageOf(r4)) && (await fake.session.get(L.seed)) === undefined && (await fake.session.get(L.unlockedPubkey)) === undefined && (await fake.local.get(L.account)) === undefined && calls.length === 2,
      `${codeOf(r4)}: ${messageOf(r4)}`,
    );
    await account.restoreCancel();
    ok(`[${net}] cancelling forgets the restore (and the box)`, (await account.restoreState()) === null && (await fake.session.get(L.restore)) === undefined);
  }
  await clean();
  await storage.writeSettings({ consentAt: Date.now() });
  ok("a code or a password with no restore in progress: told to start again", codeOf(await outcome(account.restoreSubmitCode(CODE))) === "internal" && codeOf(await outcome(account.restoreSubmitPassword(PASSWORD))) === "internal" && calls.length === 0);

  globalThis.fetch = realFetch;
}

run("RESTORE", "restore from backup (real recovery client + crypto, fake /recovery-fetch)", main);
