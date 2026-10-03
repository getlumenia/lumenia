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
 *   [e] one send at a time: a second send while the first is in flight is refused as busy.
 *
 * Offline: the RPC node and fetch are replaced with promises the test holds, IndexedDB is in memory.
 * RUN: pnpm --filter @lumenia/extension test:router
 */
import { Buffer } from "buffer";
import { installChrome } from "./chrome-fake";
import { installIdb } from "./idb-fake";
import { hexId, installBuildEnv, ok, run, sdk, section, until } from "./_harness";

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
      [K.settings]: { net: "testnet", autolockMin: 15, from: "", mainnetAck: false, consentAt: 1 },
      [K.account]: { pubkey: PUB, restoredAt: 1 },
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
});
