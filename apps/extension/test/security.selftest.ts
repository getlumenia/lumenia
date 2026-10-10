/**
 * Security self-test: the protections added after the 2026-10-03 security review, each held to the
 * failure it exists to stop.
 *
 *   [a] kept links: the key is DERIVED from the account seed and never stored; a record holds only an
 *       iv and a ciphertext; another account's key cannot open it; a record moved to another link id
 *       does not open (the id is authenticated); the same seed always opens its own links.
 *   [b] the paste function refuses a page whose host is not the one the person picked (a frame that
 *       navigated away between the right-click and the link being ready), before it touches anything.
 *   [c] a cached real-money approval stands in for a failed ask for five minutes at most, and an
 *       answer that does not say where the account stands (the pilot on with no state: what an older
 *       sponsor said when its store failed) is never read as "not approved" and never cached.
 *   [d] link records belong to the account this extension holds: another account's record is not
 *       listed, not returned, and cannot be written (a write throws, so a send stops before posting).
 *   [e] the key that opens kept links is refused while locked, and while unlocked it opens what the
 *       same seed sealed.
 *
 * RUN: pnpm --filter @lumenia/extension test:security   (offline, no keys, no network)
 */
import { Keypair } from "@stellar/stellar-sdk";
import { installChrome } from "./chrome-fake";
import { installBuildEnv, jsonResponse, ok, outcome, run, section } from "./_harness";

const MIN = 60_000;

run("SECURITY", "kept links, the paste guard, the stale pilot bound, record scoping", async () => {
  installBuildEnv();
  const fake = installChrome();
  const storage = await import("../src/lib/storage");
  storage.useAreas(fake.local, fake.session);
  const { K } = storage;
  const sealed = await import("../src/lib/sealed");
  const { insertLinkIntoFocused } = await import("../src/content/insert");
  const pilot = await import("../src/background/pilot");
  const records = await import("../src/background/records");
  const links = await import("../src/lib/links");
  const account = await import("../src/background/account");
  const { ExtError } = await import("../src/lib/errors");
  const codeOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r ? (r.error instanceof ExtError ? r.error.code : `other: ${String(r.error)}`) : "returned");

  /* ---------------------------------------- [a] ---------------------------------------- */
  section("a", "kept links: a key derived from the seed, never stored, bound to the link id");
  const kp = Keypair.random();
  const seed = new Uint8Array(kp.rawSecretKey());
  const other = new Uint8Array(Keypair.random().rawSecretKey());
  const ID = "ab".repeat(32);
  const LINK = `https://getlumenia.com/v2/c/${ID}?src=ext#${Keypair.random().secret()}&s=Ayse`;
  const k1 = await sealed.linksKeyFromSeed(seed);
  const rec = await sealed.encryptLink(k1, ID, LINK);
  ok("the key cannot be exported (it never leaves WebCrypto)", "error" in (await outcome(crypto.subtle.exportKey("raw", k1))));
  ok("the stored record is only an iv (12 bytes) and a ciphertext: no key, no plaintext", Object.keys(rec).sort().join(",") === "ciphertext,iv" && rec.iv.length === 12 && !Buffer.from(rec.ciphertext).toString("latin1").includes("getlumenia"));
  const k2 = await sealed.linksKeyFromSeed(new Uint8Array(seed));
  ok("the same seed derives a key that opens it (after a restart, after a re-unlock)", (await sealed.decryptLink(k2, ID, rec)) === LINK);
  const kOther = await sealed.linksKeyFromSeed(other);
  ok("another account's key cannot open it", "error" in (await outcome(sealed.decryptLink(kOther, ID, rec))));
  ok("the record moved under another link id does not open (the id is authenticated)", "error" in (await outcome(sealed.decryptLink(k1, "cd".repeat(32), rec))));
  const flipped = { iv: rec.iv, ciphertext: Uint8Array.from(rec.ciphertext, (b, i) => (i === 3 ? b ^ 1 : b)) };
  ok("a ciphertext changed by one bit does not open", "error" in (await outcome(sealed.decryptLink(k1, ID, flipped))));
  const rec2 = await sealed.encryptLink(k1, ID, LINK);
  ok("two seals of the same link never share an iv", Buffer.from(rec2.iv).toString("hex") !== Buffer.from(rec.iv).toString("hex"));

  /* ---------------------------------------- [b] ---------------------------------------- */
  section("b", "the paste function refuses a page that is not the one picked");
  const G = globalThis as unknown as Record<string, unknown>;
  let touched = 0;
  G.location = { host: "web.whatsapp.com" };
  G.document = new Proxy({}, { get: () => (touched++, undefined) });
  const moved = await insertLinkIntoFocused(LINK, "mail.google.com");
  ok("expected mail.google.com, the frame is now web.whatsapp.com: refused as page-changed", moved.ok === false && moved.how === "page-changed");
  ok("  ...before the page's document was touched at all", touched === 0);
  const same = await insertLinkIntoFocused(LINK, "web.whatsapp.com");
  ok("the right host goes on to look for the focused box (here there is none)", same.ok === false && same.how === "no-focused-field" && touched > 0);
  delete G.location;
  delete G.document;

  /* ---------------------------------------- [c] ---------------------------------------- */
  section("c", "a cached approval stands in for a failed ask for five minutes at most");
  const PUB = kp.publicKey();
  const T0 = 1_800_000_000_000;
  const realFetch = globalThis.fetch;
  let reply: () => Response | Promise<Response> = () => jsonResponse(200, { pilot: true, approved: true, state: "approved", used: 1, limit: 5 });
  globalThis.fetch = (async () => reply()) as typeof fetch;
  try {
    await fake.session.clear();
    await pilot.pilotStatus(PUB, { now: T0 });
    reply = () => {
      throw new TypeError("fetch failed");
    };
    ok("the ask fails 4 minutes later: the cached yes stands", (await pilot.pilotStatus(PUB, { now: T0 + 4 * MIN })).approved === true);
    ok("the ask fails 5 minutes and 1 ms later: unknown, never the stale yes", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 + pilot.PILOT_STALE_MAX_MS + 1 }))) === "pilot-unknown");
    reply = () => jsonResponse(429, { error: "rate limit" });
    ok("  ...the same after a 429: rate-limited, not the stale yes", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 + 30 * MIN }))) === "rate-limited");
    reply = () => jsonResponse(503, { error: "down" });
    ok("  ...and after a 503", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 + 30 * MIN }))) === "pilot-unknown");
    ok("the bound is five minutes", pilot.PILOT_STALE_MAX_MS === 5 * MIN);

    // LUMENIA ACCOUNT CONTRACT v1, section 4: "pilot true without a string state" is a failed ask.
    await fake.session.clear();
    reply = () => jsonResponse(200, { pilot: true, approved: false });
    ok("200 {pilot:true, approved:false} with no state: pilot-unknown, never 'not approved'", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 }))) === "pilot-unknown");
    ok("  ...and nothing is cached from it", (await pilot.cachedPilot(PUB)) === null && (await fake.session.get(K.pilot(PUB))) === undefined);
    reply = () => jsonResponse(200, { pilot: true, approved: true, state: "approved", used: 1, limit: 5 });
    await pilot.pilotStatus(PUB, { now: T0 });
    reply = () => jsonResponse(200, { pilot: true, approved: false });
    const kept = await pilot.pilotStatus(PUB, { now: T0 + 2 * MIN });
    ok("  ...with a real answer on file, that answer stands, with its own age", kept.approved === true && kept.at === T0);
    ok("  ...and the cache still holds the real answer, not the empty one", (await pilot.cachedPilot(PUB))?.state === "approved");
    reply = () => jsonResponse(200, { pilot: "yes", approved: false, state: "none" });
    await fake.session.clear();
    ok("a pilot field that is not a boolean: pilot-unknown, nothing cached", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 }))) === "pilot-unknown" && (await pilot.cachedPilot(PUB)) === null);
  } finally {
    globalThis.fetch = realFetch;
  }

  /* ---------------------------------------- [d] ---------------------------------------- */
  section("d", "link records belong to the account this extension holds");
  const mine = links.fromPrepared(
    { link: "", linkHex: "11".repeat(32), retrySafeAfter: T0 + 120_000, innerHash: "22".repeat(32), expiry: Math.floor(T0 / 1000) + 7 * 86400, group: false, amount: "1.00" },
    { net: "testnet", sender: PUB, from: "", locked: false, now: T0 },
  );
  const theirs = { ...mine, linkHex: "33".repeat(32), sender: Keypair.random().publicKey() };
  await fake.local.clear();
  const refused = await outcome(records.putRecord(mine));
  ok("with no account held, a write throws and nothing is stored", "error" in refused && Object.keys(await fake.local.getAll()).length === 0);
  await fake.local.set({ [K.account]: { pubkey: PUB, restoredAt: T0 } });
  await records.putRecord(mine);
  ok("the held account's record is written and listed", (await records.allRecords()).length === 1 && (await records.getRecord(mine.linkHex))?.linkHex === mine.linkHex);
  ok("another account's record cannot be written (a send would stop before posting)", "error" in (await outcome(records.putRecord(theirs))));
  await fake.local.set({ [links.linkKey("testnet", theirs.linkHex)]: theirs });
  ok("  ...and one already in storage is neither listed nor returned", (await records.allRecords()).every((r) => r.sender === PUB) && (await records.getRecord(theirs.linkHex)) === null);

  /* ---------------------------------------- [e] ---------------------------------------- */
  section("e", "the key that opens kept links is refused while locked");
  await fake.session.clear();
  ok("locked (no session): refused as locked", codeOf(await outcome(account.linksKeyForSession())) === "locked");
  await fake.session.set({ [K.seed]: Buffer.from(seed).toString("base64"), [K.unlockedPubkey]: PUB, [K.lockAt]: Date.now() - 1 });
  ok("past the deadline with the seed still stored: refused, and the seed is wiped", codeOf(await outcome(account.linksKeyForSession())) === "locked" && (await fake.session.get(K.seed)) === undefined);
  await fake.session.set({ [K.seed]: Buffer.from(seed).toString("base64"), [K.unlockedPubkey]: PUB, [K.lockAt]: Date.now() + 10 * MIN });
  const live = await account.linksKeyForSession();
  ok("unlocked: the key opens what this seed sealed", (await sealed.decryptLink(live, ID, rec)) === LINK);
  await fake.session.set({ [K.seed]: Buffer.from(other).toString("base64") });
  ok("a stored seed that is not the unlocked account's: refused", codeOf(await outcome(account.linksKeyForSession())) === "internal");
});
