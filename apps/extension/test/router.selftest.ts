/**
 * Router self-test: the worker's front door, driven through route() exactly as a popup message is.
 *
 *   [a] who may ask: only this extension's own pages (its id AND its extension-origin URL);
 *   [b] what they may ask: the zod contract refuses unknown requests, extra keys and wrong types;
 *   [c] "Forget this account" refuses while links are still open (this browser holds the only list
 *       of them and the only way to take them back), unless the person chose to forget anyway, and
 *       then it removes everything: the key record, the kept links, the records, the session;
 *   [d] one take-back per link at a time: a second tap while the first is on the wire is refused,
 *       so the sponsor never relays the same take-back twice, and "Forget" waits for it too;
 *   [e] one send at a time: a second send while the first is in flight is refused as busy;
 *   [f] an account made here and never backed up cannot switch to real money (needs-backup), with
 *       nothing asked of the sponsor; practice money is never blocked;
 *   [g] the worker keeps no default "from" name: settings refuse one, the state carries none, and the
 *       name an older version kept on disk is removed (a link carries a name only when it is typed).
 *   [h] the switch to real money says each standing as itself (LUMENIA ACCOUNT CONTRACT v1, 4):
 *       waiting, declined, taken off and "could not check" are refused in their own words, and an
 *       approved account with no sends left still switches (its balance and take-backs are there);
 *   [i] "Ask to join" for THIS extension's key (contract 1, 3.2): refused before any request while
 *       there is nothing it could do, signed by the account (the golden pilot vector), sent only to
 *       the real-money server, a mailed code when the server asks for one, the standing read again
 *       afterwards, and an older server's bare {ok:true} handled;
 *   [j] "Open it on real money" (an approved account that never received real money): refused
 *       before anything is asked of the sponsor while it cannot be done, then opened once, with the
 *       real-money network and the account's own key.
 *
 * Offline: the RPC node and fetch are replaced with promises the test holds, IndexedDB is in memory.
 * RUN: pnpm --filter @lumenia/extension test:router
 */
import { Buffer } from "buffer";
import { installChrome } from "./chrome-fake";
import { installIdb } from "./idb-fake";
import { hexId, installBuildEnv, jsonResponse, ok, outcome, run, sdk, section, until } from "./_harness";

const OURS = { id: "test-ext", url: "chrome-extension://test-ext/popup.html" } as chrome.runtime.MessageSender;

run("ROUTER", "the worker's front door (who may ask, what, and the guards on forget, take-back and send)", async () => {
  installBuildEnv();
  const fake = installChrome();
  const idb = installIdb();
  const S = sdk();
  const storage = await import("../src/lib/storage");
  storage.useAreas(fake.local, fake.session);
  const { K } = storage;
  const router = await import("../src/background/router");
  const links = await import("../src/lib/links");

  type Answer = { ok: true; data: unknown } | { ok: false; code: string; message: string };
  const ask = (msg: unknown, sender: chrome.runtime.MessageSender = OURS) => router.route(msg, sender) as Promise<Answer>;
  const codeOf = (a: Answer) => (a.ok ? "ok" : a.code);

  // One restored, password-locked account, unlocked for fifteen minutes.
  const kp = S.Keypair.random();
  const PUB = kp.publicKey();
  const seedKeystore = () =>
    idb.dbs.set(
      "lumenia",
      new Map([
        [
          "keys",
          new Map<string, Record<string, unknown>>([
            ["__home__", { id: "__home__", pubkey: PUB }],
            [PUB, { id: PUB, formatVersion: 1, pubkey: PUB, phase: 2, iv: new Uint8Array(12), ciphertext: new Uint8Array(48), salt: new Uint8Array(16), argon: {}, kind: "user" }],
          ]),
        ],
      ]),
    );
  const setUp = async () => {
    seedKeystore();
    await fake.local.clear();
    await fake.session.clear();
    await fake.local.set({
      [K.settings]: { net: "testnet", autolockMin: 15, mainnetAck: false, consentAt: 1 },
      [K.account]: { pubkey: PUB, restoredAt: 1 },
      // Restored from its backup: this browser knows the email and that the backup is tied to it.
      [K.backups]: { [PUB]: { email: "ayse@example.com", at: 1, bound: true } },
    });
    await fake.session.set({ [K.seed]: Buffer.from(kp.rawSecretKey()).toString("base64"), [K.unlockedPubkey]: PUB, [K.lockAt]: Date.now() + 15 * 60_000 });
  };
  const now = Date.now();
  const record = (n: number, o: Record<string, unknown> = {}) => ({
    v: 1,
    net: "testnet",
    linkHex: hexId(n),
    sender: PUB,
    amount: "1.00",
    from: "A",
    locked: false,
    createdAt: now - 8 * 86_400_000,
    expiry: Math.floor(now / 1000) - 3600,
    retrySafeAfter: now - 8 * 86_400_000 + 120_000,
    innerHash: "cd".repeat(32),
    hash: "ab".repeat(32),
    phase: "confirmed",
    status: "pending",
    nextCheckAt: now + 60_000,
    ...o,
  });
  const store = async (r: ReturnType<typeof record>) => fake.local.set({ [links.linkKey("testnet", r.linkHex)]: r });

  /* ---------------------------------------- [a] ---------------------------------------- */
  section("a", "who may ask");
  ok("this extension's popup (its id, its own origin): trusted", router.trustedSender(OURS));
  ok("this extension's id with no URL: refused", !router.trustedSender({ id: "test-ext" } as chrome.runtime.MessageSender));
  ok("this extension's id from a web page (the injected paste function reports the page's URL): refused", !router.trustedSender({ id: "test-ext", url: "https://web.whatsapp.com/" } as chrome.runtime.MessageSender));
  ok("another extension: refused", !router.trustedSender({ id: "other-ext", url: "chrome-extension://other-ext/popup.html" } as chrome.runtime.MessageSender));
  ok("our id with another extension's origin: refused", !router.trustedSender({ id: "test-ext", url: "chrome-extension://other-ext/x.html" } as chrome.runtime.MessageSender));
  const outsider = await ask({ type: "state" }, { id: "other-ext", url: "chrome-extension://other-ext/p.html" } as chrome.runtime.MessageSender);
  ok("  ...and route() answers an outsider with a refusal, doing nothing", !outsider.ok && /not from this extension/.test(outsider.message));

  /* ---------------------------------------- [b] ---------------------------------------- */
  section("b", "what they may ask");
  await setUp();
  const refusals: [string, unknown][] = [
    ["an unknown request", { type: "wallet.export" }],
    ["a known request with an extra key", { type: "lock", now: true }],
    ["a network switch smuggled into settings", { type: "settings.set", patch: { net: "public" } }],
    ["the real-money note set to false", { type: "settings.set", patch: { mainnetAck: false } }],
    ["forget without its confirmation word", { type: "forget" }],
    ["forget with leaveOpenLinks false", { type: "forget", confirm: "FORGET", leaveOpenLinks: false }],
    ["a send whose amount is a number", { type: "send", amount: 5, from: "A" }],
    ["a send with anyway: false", { type: "send", amount: "5", from: "A", anyway: false }],
    ["a take-back of an id that is not 64 hex", { type: "links.reclaim", linkHex: "ab" }],
    ["not an object at all", "send"],
  ];
  for (const [what, msg] of refusals) {
    const a = await ask(msg);
    ok(`${what}: refused before anything acts on it`, !a.ok && /not a request this extension knows/.test(a.message));
  }

  /* ---------------------------------------- [c] ---------------------------------------- */
  section("c", "Forget this account, with links still open");
  await setUp();
  await store(record(1, { amount: "1.00" }));
  await store(record(2, { amount: "0.50", phase: "uncertain", status: undefined }));
  await store(record(3, { amount: "9.99", status: "claimed" }));
  const refused = await ask({ type: "forget", confirm: "FORGET" });
  ok("two open links (one waiting, one unconfirmed): refused as open-links", codeOf(refused) === "open-links");
  ok("  ...naming how many and how much ($1.50; the claimed one is not counted)", !refused.ok && /2 links that are still open \(\$1\.50 in all\)/.test(refused.message), refused.ok ? "" : refused.message);
  ok("  ...and nothing was removed: the records, the account, the session and the key record are all there", (await fake.local.get(K.account)) !== undefined && (await fake.session.get(K.seed)) !== undefined && Object.keys(await fake.local.getAll()).filter((k) => k.startsWith("links:")).length === 3 && idb.dbs.get("lumenia")?.get("keys")?.size === 2);
  idb.dbs.set("lumenia-ext-links", new Map([["links", new Map([[hexId(1), { id: hexId(1), v: 2 }]])]]));
  const anyway = await ask({ type: "forget", confirm: "FORGET", leaveOpenLinks: true });
  ok("with 'forget anyway': done", codeOf(anyway) === "ok");
  ok("  ...the records, the account mirror and the settings are gone", Object.keys(await fake.local.getAll()).length === 0);
  ok("  ...the session (the unlocked key) is gone", Object.keys(await fake.session.getAll()).length === 0);
  ok("  ...the key record is gone and the kept links' database is deleted", idb.dbs.get("lumenia")?.get("keys")?.size === 0 && !idb.dbs.has("lumenia-ext-links"));
  await setUp();
  await store(record(4, { status: "claimed" }));
  await store(record(5, { phase: "failed", status: undefined, failReason: "It did not go through." }));
  ok("only settled links (claimed, failed for good): forgotten without the extra question", codeOf(await ask({ type: "forget", confirm: "FORGET" })) === "ok");
  await setUp();
  await store(record(6, { phase: "failed", status: undefined, failReason: "It did not go through.", recheckAt: now + 3_600_000 }));
  ok("a failed link that still owes its last check counts as open (it may have landed)", codeOf(await ask({ type: "forget", confirm: "FORGET" })) === "open-links");

  /* ---------------------------------------- [d] ---------------------------------------- */
  section("d", "one take-back per link at a time");
  await setUp();
  const target = record(7);
  await store(target);
  const proto = S.rpc.Server.prototype;
  const realGetAccount = proto.getAccount;
  // The node answers nothing until the test lets it, then fails every read: the take-back stops
  // before anything is posted.
  let release!: () => void;
  let hold = true;
  let reads = 0;
  proto.getAccount = async function () {
    reads++;
    if (hold) await new Promise<void>((r) => (release = r));
    throw new Error("rpc unreachable (released by the test)");
  };
  const realFetch0 = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async () => {
    posts++;
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const first = ask({ type: "links.reclaim", linkHex: target.linkHex });
    await until(() => reads === 1, "the first take-back to start reading the escrow");
    const second = await ask({ type: "links.reclaim", linkHex: target.linkHex });
    ok("a second take-back of the same link while the first is on the wire: busy", codeOf(second) === "busy" && !second.ok && /already being taken back/.test(second.message));
    const forgetMeanwhile = await ask({ type: "forget", confirm: "FORGET", leaveOpenLinks: true });
    ok("  ...and Forget waits for it (busy), even when asked to forget anyway", codeOf(forgetMeanwhile) === "busy" && (await fake.local.get(K.account)) !== undefined);
    ok("  ...the escrow was asked once, by the first request only", reads === 1);
    hold = false;
    release();
    const firstOut = await first;
    ok("the first one finished on its own terms: nothing was posted, and it says nothing moved", !firstOut.ok && firstOut.code !== "uncertain" && posts === 0);
    const after = (await fake.local.get(links.linkKey("testnet", target.linkHex))) as Record<string, unknown>;
    ok("  ...and the record does not keep the attempt open (a later claim will read Claimed)", after.reclaimOpenAt === undefined && after.reclaimAttemptAt === undefined);
    ok("once it has finished, the link can be asked for again", codeOf(await ask({ type: "links.reclaim", linkHex: target.linkHex })) !== "busy");
  } finally {
    proto.getAccount = realGetAccount;
    globalThis.fetch = realFetch0;
  }

  /* ---------------------------------------- [e] ---------------------------------------- */
  section("e", "one send at a time");
  await setUp();
  const realFetch = globalThis.fetch;
  let unblock!: () => void;
  let block = true;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    if (block) await new Promise<void>((r) => (unblock = r));
    throw new TypeError("fetch failed (released by the test)");
  }) as typeof fetch;
  try {
    const sendOne = ask({ type: "send", amount: "1", from: "A" });
    await until(() => fetches === 1, "the first send to reach the balance read");
    const sendTwo = await ask({ type: "send", amount: "1", from: "A" });
    ok("a second send while the first is in flight: busy, and it made no request of its own", codeOf(sendTwo) === "busy" && fetches === 1);
    block = false;
    unblock();
    const one = await sendOne;
    ok("  ...the first one still finished on its own terms (here: the balance could not be read)", codeOf(one) !== "busy");
  } finally {
    globalThis.fetch = realFetch;
  }

  /* ---------------------------------------- [f] ---------------------------------------- */
  section("f", "real money needs this account backed up first (the pilot's approval no longer stands in the way)");
  await setUp();
  // An account made here keeps its backup box locally until it is backed up with an email.
  await fake.local.set({ [K.pendingBackup]: { v: 1, copies: [] } });
  const realFetchF = globalThis.fetch;
  const askedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    askedUrls.push(String(input));
    throw new TypeError("fetch failed (the test answers nothing)");
  }) as typeof fetch;
  try {
    const refusedSwitch = await ask({ type: "network.set", net: "public" });
    ok("never backed up: the switch to real money is refused as needs-backup", codeOf(refusedSwitch) === "needs-backup");
    ok(
      "  ...before the pilot is asked (no /pilot-status request)",
      !askedUrls.some((u) => u.includes("/pilot-status")),
      askedUrls.join(" | "),
    );
    ok("  ...and the money stays practice", ((await fake.local.get(K.settings)) as { net?: string }).net === "testnet");
    ok("practice money is never blocked by it", codeOf(await ask({ type: "network.set", net: "testnet" })) === "ok");
    await fake.local.remove(K.pendingBackup);
    const backedUp = await ask({ type: "network.set", net: "public" });
    ok("backed up: past the backup rule, on to the pilot's answer (here: none, offline)", codeOf(backedUp) !== "needs-backup" && codeOf(backedUp) !== "ok", codeOf(backedUp));
  } finally {
    globalThis.fetch = realFetchF;
  }

  /* ---------------------------------------- [g] ---------------------------------------- */
  section("g", "no default sender name: a link carries a name only when one is typed for it");
  await setUp();
  const smuggled = await ask({ type: "settings.set", patch: { from: "Ayse" } });
  ok("a default name sent to settings: refused before anything acts on it", !smuggled.ok && /not a request this extension knows/.test(smuggled.message));
  const state = await ask({ type: "state" });
  ok("  ...and the state the popup reads carries no name to fill the From field with", state.ok && !("from" in ((state.data as { settings: object }).settings)));
  // What 0.1.2 left on disk after a send from "Ayse".
  await fake.local.set({ [K.settings]: { net: "public", autolockMin: 60, from: "Ayse", mainnetAck: true, consentAt: 7 } });
  ok("an older version's kept name: removed from disk", (await storage.dropLegacyDefaultName()) === true);
  const kept = (await fake.local.get(K.settings)) as Record<string, unknown>;
  ok(
    "  ...and every other setting is kept as it was",
    !("from" in kept) && kept.net === "public" && kept.autolockMin === 60 && kept.mainnetAck === true && kept.consentAt === 7,
    JSON.stringify(kept),
  );
  ok("  ...once: with nothing to remove, nothing is written", (await storage.dropLegacyDefaultName()) === false);
  await fake.local.remove(K.settings);
  ok("  ...and a browser with no settings yet is left alone", (await storage.dropLegacyDefaultName()) === false && (await fake.local.get(K.settings)) === undefined);

  /* ---------------------------------------- [h] ---------------------------------------- */
  section("h", "the switch to real money says each standing as itself");
  const MAIN_HOST = "https://lumenia-sponsor-mainnet.avakit.workers.dev";
  const TEST_HOST = "https://lumenia-sponsor.avakit.workers.dev";
  const SHORT = `${PUB.slice(0, 6)}...${PUB.slice(-6)}`;
  const realFetchH = globalThis.fetch;
  let statusReply: () => Response = () => jsonResponse(200, { pilot: true, state: "none", approved: false, used: 0, limit: 5, revoked: false });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`${MAIN_HOST}/pilot-status`)) return statusReply();
    throw new TypeError(`fetch failed (unexpected ${url})`);
  }) as typeof fetch;
  try {
    const switchRows: [string, () => Response, string, RegExp?][] = [
      ["never asked (none)", () => jsonResponse(200, { pilot: true, state: "none", approved: false, used: 0, limit: 5, revoked: false }), "not-approved"],
      ["waiting (pending)", () => jsonResponse(200, { pilot: true, state: "pending", approved: false, used: 0, limit: 5, revoked: false }), "pilot-pending", new RegExp(`^You're on the list\\. We'll email you when this account \\(${SHORT.replace(/\./g, "\\.")}\\) is approved\\.$`)],
      ["declined", () => jsonResponse(200, { pilot: true, state: "rejected", approved: false, used: 1, limit: 5, revoked: false }), "pilot-declined", /^Not approved for now\./],
      ["taken off", () => jsonResponse(200, { pilot: true, state: "rejected", approved: false, used: 1, limit: 5, revoked: true }), "pilot-revoked", /^Real money is off for this account\./],
      ["the pilot on with no state (could not check)", () => jsonResponse(200, { pilot: true, approved: false }), "pilot-unknown"],
      ["the server's store down (503)", () => jsonResponse(503, { error: "pilot store unavailable" }), "pilot-unknown"],
    ];
    for (const [what, reply, code, text] of switchRows) {
      await setUp();
      await fake.local.set({ [K.settings]: { net: "testnet", autolockMin: 15, mainnetAck: true, consentAt: 1 } });
      statusReply = reply;
      const a = await ask({ type: "network.set", net: "public" });
      ok(`${what}: the switch is refused as ${code}`, codeOf(a) === code && (!text || (!a.ok && text.test(a.message))), a.ok ? "ok" : `${a.code}: ${a.message}`);
      ok(`  ...and the money stays practice`, ((await fake.local.get(K.settings)) as { net?: string }).net === "testnet");
    }
    await setUp();
    await fake.local.set({ [K.settings]: { net: "testnet", autolockMin: 15, mainnetAck: true, consentAt: 1 } });
    statusReply = () => jsonResponse(200, { pilot: true, state: "approved", approved: true, used: 5, limit: 5, revoked: false });
    const spent = await ask({ type: "network.set", net: "public" });
    ok("approved with all 5 of 5 sends used: the switch is allowed (the balance and the take-backs are still there)", codeOf(spent) === "ok" && ((await fake.local.get(K.settings)) as { net?: string }).net === "public", codeOf(spent));
    await setUp();
    await fake.local.set({ [K.settings]: { net: "testnet", autolockMin: 15, mainnetAck: true, consentAt: 1 } });
    statusReply = () => jsonResponse(200, { pilot: true, state: "approved", approved: true, used: 2, limit: 5, revoked: false });
    ok("approved with sends left: allowed", codeOf(await ask({ type: "network.set", net: "public" })) === "ok");
  } finally {
    globalThis.fetch = realFetchH;
  }

  /* ---------------------------------------- [i] ---------------------------------------- */
  section("i", "Ask to join, for the key this extension holds");
  const core = await import("../src/core");
  const proofMod = await import("../src/lib/proof");
  const identity = await import("../src/lib/identity");

  // The contract's golden pilot vector (TEST-ONLY seed of 32 bytes of 0x01).
  const goldenSigner = core.localSignerFromSeed(new Uint8Array(32).fill(1));
  const GOLDEN_PUB = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
  const goldenId = await identity.emailId("  Founder@Example.com ");
  ok("the golden seed's key, and the golden email id", goldenSigner.publicKey() === GOLDEN_PUB && goldenId === "fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884");
  const pilotMsg = proofMod.proofMessage("pilot", goldenId, GOLDEN_PUB, 1760000000, "0123456789abcdef", "mainnet");
  ok(
    "the pilot message builder gives the golden message",
    pilotMsg === "lumenia-handle-pilot:v1:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:mainnet",
    pilotMsg,
  );
  const goldenProof = await proofMod.ownerProof(goldenSigner, "pilot", goldenId, "mainnet", { ts: 1760000000, nonce: "0123456789abcdef" });
  ok(
    "  ...and the golden signature",
    goldenProof.proof === "kZuq86B7rr9BIoSE0Mb2wqfQ2dgxLoRRVLRbT5JHnAvZuizmWtof0me3rY80wPHUfwA0XYWChj4FA8vtTEGnDg==" && goldenProof.pubkey === GOLDEN_PUB && goldenProof.ts === 1760000000 && goldenProof.nonce === "0123456789abcdef",
    goldenProof.proof,
  );
  const fresh = await proofMod.ownerProof(goldenSigner, "pilot", goldenId, "mainnet");
  const freshMsg = proofMod.proofMessage("pilot", goldenId, GOLDEN_PUB, fresh.ts, fresh.nonce, "mainnet");
  ok(
    "a freshly built proof: now, 16 lowercase hex of nonce, and Keypair.verify accepts it",
    Math.abs(fresh.ts - Math.floor(Date.now() / 1000)) <= 5 && /^[0-9a-f]{16}$/.test(fresh.nonce) && S.Keypair.fromPublicKey(GOLDEN_PUB).verify(Buffer.from(freshMsg), Buffer.from(fresh.proof, "base64")),
  );
  ok("  ...and not over another network's message", !S.Keypair.fromPublicKey(GOLDEN_PUB).verify(Buffer.from(freshMsg.replace(/:mainnet$/, ":testnet")), Buffer.from(fresh.proof, "base64")));

  type Sent = { url: string; method: string; body: Record<string, unknown> };
  const sent: Sent[] = [];
  const realFetchI = globalThis.fetch;
  let status: "none" | "pending" = "none";
  let askReply: (b: Record<string, unknown>) => Response = (b) => {
    if (b.code === undefined) return jsonResponse(401, { error: "Confirm your email with a code first.", code: "code-required" });
    if (b.code !== "123456") return jsonResponse(401, { error: "That code is wrong or has expired.", code: "bad-code" });
    status = "pending";
    return jsonResponse(200, { ok: true, state: "pending", filed: true });
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, method: init?.method ?? "GET", body });
    if (url.startsWith(`${MAIN_HOST}/pilot-status`)) return jsonResponse(200, { pilot: true, state: status, approved: false, used: 0, limit: 5, revoked: false });
    if (url === `${MAIN_HOST}/pilot-request`) return askReply(body);
    if (url === `${MAIN_HOST}/recovery-otp`) return jsonResponse(200, { ok: true });
    throw new TypeError(`fetch failed (unexpected ${url})`);
  }) as typeof fetch;
  try {
    const EMAIL = "ayse@example.com";
    // Refused before any request: each case on its own fresh set-up.
    const refusals: [string, () => Promise<void>, string][] = [
      ["before the first-run agreement", async () => void (await fake.local.set({ [K.settings]: { net: "testnet", autolockMin: 15, mainnetAck: false, consentAt: null } })), "needs-consent"],
      ["while locked", async () => void (await fake.session.clear()), "locked"],
      ["while this account still needs its backup (made here, never backed up)", async () => void (await fake.local.set({ [K.pendingBackup]: { formatVersion: 1, copies: [] } })), "needs-backup"],
      ["with no backup this browser knows of", async () => void (await fake.local.remove(K.backups)), "needs-backup"],
      [
        "when the account is already approved with sends left",
        async () => void (await fake.session.set({ [K.pilot(PUB)]: { pilot: true, approved: true, state: "approved", used: 1, limit: 5, revoked: false, at: Date.now() } })),
        "internal",
      ],
      ["when real money is open to everyone", async () => void (await fake.session.set({ [K.pilot(PUB)]: { pilot: false, approved: true, state: "open", used: 0, limit: 0, revoked: false, at: Date.now() } })), "internal"],
    ];
    for (const [what, arrange, code] of refusals) {
      for (const type of ["pilot.request", "pilot.requestCode"] as const) {
        await setUp();
        await arrange();
        sent.length = 0;
        const a = await ask({ type, email: EMAIL });
        ok(`${type} ${what}: refused as ${code}, and nothing was sent`, codeOf(a) === code && sent.length === 0, `${codeOf(a)} ${sent.map((x) => x.url).join(" ")}`);
      }
    }
    await setUp();
    await fake.session.set({ [K.pilot(PUB)]: { pilot: true, approved: true, state: "approved", used: 5, limit: 5, revoked: false, at: Date.now() } });
    sent.length = 0;
    status = "none";
    askReply = () => jsonResponse(200, { ok: true, state: "approved", filed: true, already: true });
    const more = await ask({ type: "pilot.request", email: EMAIL });
    ok("an approved account with no sends left may ask (for more sends)", codeOf(more) === "ok" && sent.some((x) => x.url === `${MAIN_HOST}/pilot-request`));

    // The road: no code first, the server wants one, the code is mailed from the SAME host, then the ask again.
    await setUp();
    sent.length = 0;
    status = "none";
    askReply = (b) => {
      if (b.code === undefined) return jsonResponse(401, { error: "Confirm your email with a code first.", code: "code-required" });
      if (b.code !== "123456") return jsonResponse(401, { error: "That code is wrong or has expired.", code: "bad-code" });
      status = "pending";
      return jsonResponse(200, { ok: true, state: "pending", filed: true });
    };
    const first = await ask({ type: "pilot.request", email: ` ${EMAIL} ` });
    const firstPost = sent.find((x) => x.url === `${MAIN_HOST}/pilot-request`);
    ok("the first ask, with no code: the server asks for one (pilot-code-required)", codeOf(first) === "pilot-code-required", codeOf(first));
    ok("  ...it went to the real-money server only, as a POST", sent.length === 1 && firstPost?.method === "POST" && sent.every((x) => x.url.startsWith(MAIN_HOST)), sent.map((x) => x.url).join(" "));
    const body = firstPost?.body ?? {};
    const owner = body.owner as { pubkey?: string; ts?: number; nonce?: string; proof?: string } | undefined;
    ok("  ...carrying the held account's key, the trimmed email, src 'ext' and no code", body.pubkey === PUB && body.email === EMAIL && body.src === "ext" && !("code" in body), JSON.stringify(Object.keys(body)));
    const signedMsg = proofMod.proofMessage("pilot", await identity.emailId(EMAIL), PUB, Number(owner?.ts), String(owner?.nonce), "mainnet");
    ok(
      "  ...signed by that account: a pilot proof over the email's id, for the real-money server's network",
      owner?.pubkey === PUB && S.Keypair.fromPublicKey(PUB).verify(Buffer.from(signedMsg), Buffer.from(String(owner?.proof), "base64")),
    );
    ok("  ...and the request holds no password, no seed, no secret key", !JSON.stringify(body).includes(Buffer.from(kp.rawSecretKey()).toString("base64")) && !JSON.stringify(body).includes(kp.secret()));
    sent.length = 0;
    const code = await ask({ type: "pilot.requestCode", email: EMAIL });
    ok(
      "pilot.requestCode: the code is mailed by the real-money server, with purpose 'pilot'",
      codeOf(code) === "ok" && sent.length === 1 && sent[0]!.url === `${MAIN_HOST}/recovery-otp` && sent[0]!.method === "POST" && sent[0]!.body.email === EMAIL && sent[0]!.body.purpose === "pilot",
      JSON.stringify(sent),
    );
    sent.length = 0;
    const wrong = await ask({ type: "pilot.request", email: EMAIL, code: "000000" });
    ok("a wrong code: bad-code", codeOf(wrong) === "bad-code");
    sent.length = 0;
    const filed = await ask({ type: "pilot.request", email: EMAIL, code: "123 456" });
    const withCode = sent.find((x) => x.url === `${MAIN_HOST}/pilot-request`);
    ok("the ask again, with the code (typed with a space): filed", codeOf(filed) === "ok" && withCode?.body.code === "123456", codeOf(filed));
    const out = filed.ok ? (filed.data as { state: string; filed: boolean; already: boolean; standing: string }) : null;
    ok("  ...the answer says pending, filed, and where the account stands now: pending", out?.state === "pending" && out.filed === true && out.already === false && out.standing === "pending", JSON.stringify(out));
    ok(
      "  ...the standing was read again from /pilot-status afterwards (the old cached answer dropped), and now reads pending",
      sent.some((x) => x.url === `${MAIN_HOST}/pilot-status?pubkey=${encodeURIComponent(PUB)}`) && ((await fake.session.get(K.pilot(PUB))) as { state?: string } | undefined)?.state === "pending",
    );
    ok("  ...and nothing ever went to the practice server", sent.every((x) => !x.url.startsWith(TEST_HOST)));

    // An older server: a bare {ok:true}, and nothing tells whether it recorded anything but the standing.
    await setUp();
    sent.length = 0;
    status = "none";
    askReply = () => jsonResponse(200, { ok: true });
    const silent = await ask({ type: "pilot.request", email: EMAIL });
    ok("an older server's {ok:true} while the standing still reads none: told it didn't go through", codeOf(silent) === "internal" && !silent.ok && silent.message === "Your request didn't go through. Try again later.", silent.ok ? "ok" : silent.message);
    await setUp();
    status = "pending";
    askReply = () => jsonResponse(200, { ok: true, already: true });
    const oldOk = await ask({ type: "pilot.request", email: EMAIL });
    const oldOut = oldOk.ok ? (oldOk.data as { state: string; already: boolean; standing: string }) : null;
    ok("an older server's {ok:true, already:true} with the standing reading pending: pending, already asked", oldOut?.state === "pending" && oldOut.already === true && oldOut.standing === "pending", JSON.stringify(oldOut));

    // The server's own refusals, in its words where it gives them.
    const mapRows: [string, () => Response, string, RegExp?][] = [
      ["409 email-taken", () => jsonResponse(409, { error: "That email backs up another Lumenia account. Ask with the email that backs up this one.", code: "email-taken" }), "email-taken", /^That email backs up another Lumenia account\./],
      ["401 bad-proof", () => jsonResponse(401, { error: "We couldn't confirm this account signed the request. Check your device clock and try again.", code: "bad-proof" }), "internal", /device clock/],
      ["400 proof-required", () => jsonResponse(400, { error: "Reload the page and ask again.", code: "proof-required" }), "internal"],
      ["429", () => jsonResponse(429, { error: "rate limited" }), "rate-limited"],
      ["503 store-unavailable", () => jsonResponse(503, { error: "We couldn't record that just now. Try again in a minute.", code: "store-unavailable" }), "pilot-unknown"],
    ];
    for (const [what, reply, code, text] of mapRows) {
      await setUp();
      status = "none";
      askReply = reply;
      const a = await ask({ type: "pilot.request", email: EMAIL });
      ok(`${what} -> ${code}`, codeOf(a) === code && (!text || (!a.ok && text.test(a.message))), a.ok ? "ok" : `${a.code}: ${a.message}`);
    }
  } finally {
    globalThis.fetch = realFetchI;
  }

  /* ---------------------------------------- [j] ---------------------------------------- */
  section("j", "Open it on real money");
  const openReal = await import("../src/background/open-real");
  const realFetchJ = globalThis.fetch;
  const touched: string[] = [];
  let pilotJ: () => Response = () => jsonResponse(200, { pilot: true, state: "none", approved: false, used: 0, limit: 5, revoked: false });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    touched.push(url);
    if (url.startsWith(`${MAIN_HOST}/pilot-status`)) return pilotJ();
    throw new TypeError(`fetch failed (unexpected ${url})`);
  }) as typeof fetch;
  try {
    await setUp();
    await fake.session.clear();
    touched.length = 0;
    ok("locked: refused as locked, before anything is asked of anyone", codeOf(await ask({ type: "account.openReal" })) === "locked" && touched.length === 0, touched.join(" "));
    await setUp();
    await fake.local.set({ [K.pendingBackup]: { formatVersion: 1, copies: [] } });
    touched.length = 0;
    ok("never backed up: refused as needs-backup, before anything is asked of anyone", codeOf(await ask({ type: "account.openReal" })) === "needs-backup" && touched.length === 0);
    await setUp();
    touched.length = 0;
    pilotJ = () => jsonResponse(200, { pilot: true, state: "none", approved: false, used: 0, limit: 5, revoked: false });
    const notIn = await ask({ type: "account.openReal" });
    ok(
      "not approved: refused as not-approved after a fresh pilot answer, and the sponsor is never asked to open anything",
      codeOf(notIn) === "not-approved" && touched.length === 1 && touched[0]!.startsWith(`${MAIN_HOST}/pilot-status`),
      `${codeOf(notIn)} ${touched.join(" ")}`,
    );
    await setUp();
    touched.length = 0;
    pilotJ = () => jsonResponse(200, { pilot: true, state: "pending", approved: false, used: 0, limit: 5, revoked: false });
    ok("waiting: refused as pilot-pending, nothing opened", codeOf(await ask({ type: "account.openReal" })) === "pilot-pending" && touched.every((u) => u.includes("/pilot-status")));
  } finally {
    globalThis.fetch = realFetchJ;
  }

  const mainnet = core.mainnetConfig()!;
  type Bal = { usd: string | null; missing: boolean; line?: boolean };
  const rigJ = (o: { first?: Bal; pilot?: Record<string, unknown>; prepareFails?: string; phase?: 1 | 2; backupNeeded?: boolean } = {}) => {
    const log: string[] = [];
    const prepared: { net: string; key: string }[] = [];
    let reads = 0;
    const deps = {
      consentAt: async () => 1,
      account: async () => ({ pubkey: PUB, phase: o.phase ?? (2 as 1 | 2) }),
      backupNeeded: async () => (log.push("backup"), o.backupNeeded ?? false),
      signer: async (p: string) => (log.push(`signer:${p === PUB ? "held" : p}`), core.localSignerFromSeed(new Uint8Array(kp.rawSecretKey()))),
      pilot: async () => (log.push("pilot"), { pilot: true, approved: true, state: "approved", used: 0, limit: 5, revoked: false, at: Date.now(), ...o.pilot }),
      balance: async (_p: string, n: { id: string }) => {
        log.push(`balance:${n.id}`);
        return reads++ === 0 ? (o.first ?? { usd: null, missing: true, line: false }) : { usd: "0.0000000", missing: false, line: true };
      },
      prepare: async (signer: { publicKey(): string }, n: { id: string; isMainnet: boolean }) => {
        log.push("prepare");
        prepared.push({ net: n.id, key: signer.publicKey() });
        if (o.prepareFails) throw new Error(o.prepareFails);
      },
      net: mainnet,
    };
    return { deps, log, prepared };
  };
  const opened = rigJ();
  const after = await openReal.runOpenReal(opened.deps as never);
  ok("approved, missing on real money: the key, a fresh pilot answer, the balance, then prepare", opened.log.join(",") === "backup,signer:held,pilot,balance:public,prepare,balance:public", opened.log.join(","));
  ok("  ...prepare is called once, with the real-money network and the held key", opened.prepared.length === 1 && opened.prepared[0]!.net === "public" && opened.prepared[0]!.key === PUB && mainnet.isMainnet);
  ok("  ...and the next balance read is not missing", after.missing === false && after.line === true);
  const noLine = rigJ({ first: { usd: "0", missing: false, line: false } });
  await openReal.runOpenReal(noLine.deps as never);
  ok("there without the dollar line: the line is added (prepare once)", noLine.prepared.length === 1);
  const spentJ = rigJ({ pilot: { used: 5, limit: 5 } });
  await openReal.runOpenReal(spentJ.deps as never);
  ok("approved with no sends left: still opened (money can arrive and links can be taken back)", spentJ.prepared.length === 1);
  const openJ = rigJ({ pilot: { pilot: false, approved: true, state: "open", limit: 0 } });
  await openReal.runOpenReal(openJ.deps as never);
  ok("real money open to everyone: opened", openJ.prepared.length === 1);
  for (const [what, o, code] of [
    ["already open, with the line", { first: { usd: "1", missing: false, line: true } }, "internal"],
    ["a balance that could not be read", { first: { usd: null, missing: false } }, "internal"],
    ["declined", { pilot: { approved: false, state: "rejected" } }, "pilot-declined"],
    ["no password lock", { phase: 1 as const }, "needs-password"],
    ["a backup still owed", { backupNeeded: true }, "needs-backup"],
  ] as const) {
    const r = rigJ(o as never);
    const res = await outcome(openReal.runOpenReal(r.deps as never));
    const c = "error" in res && res.error instanceof Error && "code" in res.error ? String((res.error as { code: string }).code) : "returned";
    ok(`${what}: refused as ${code}, nothing opened`, c === code && r.prepared.length === 0, `${c} ${r.log.join(",")}`);
  }
  const failJ = rigJ({ prepareFails: "create-account -> 429: {}" });
  const failed = await outcome(openReal.runOpenReal(failJ.deps as never));
  ok("the sponsor refuses: sponsor-refused in plain words", "error" in failed && (failed.error as { code?: string }).code === "sponsor-refused" && /couldn't open your account on real money/.test((failed.error as Error).message));
  const practice = rigJ();
  const onPractice = await outcome(openReal.runOpenReal({ ...practice.deps, net: core.testnetConfig() } as never));
  ok("the practice path is unchanged: this opens on real money only, nothing asked", "error" in onPractice && practice.log.length === 0 && practice.prepared.length === 0);
  await setUp();
  await fake.local.set({ [K.settings]: { net: "public", autolockMin: 15, mainnetAck: true, consentAt: 1 } });
  ok("  ...and practice dollars are still refused on real money", codeOf(await ask({ type: "testmoney" })) === "internal");
});
