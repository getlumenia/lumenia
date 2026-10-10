/**
 * Account self-test: an account MADE in this extension, its email backup, its practice dollars, and
 * the guard that keeps its only copy from being forgotten by accident.
 *
 *   [a] createAccount: the website's password floor first; then a Phase-2 key record that opens
 *       with the password, the storage.local mirror, an unlocked session, and a backup copy (made
 *       from the same seed, opened by the same password) waiting as ciphertext; one account only,
 *       and nothing before the first-run agreement.
 *   [b] backup: email, then code; a wrong code, the sponsor's refusals and a locked extension change
 *       nothing; a stored backup carries this account's box, the email's id and a signature from the
 *       account, and afterwards the account no longer counts as "only in this browser".
 *   [c] practice dollars: a new account is opened (sponsored) before the faucet pays; an account
 *       without the dollar line gets the line; one that has it is paid straight away; real money is
 *       refused; a failure says what happened in words.
 *   [d] "Forget this account" refuses to delete an account that was never backed up unless the
 *       person chose to, and the mirror that scopes the link list is repaired from the keystore.
 *
 * And one email per account (LUMENIA ACCOUNT CONTRACT v1, sections 1, 2, 5.4, 5.5 and 6), against a
 * fake recovery host that keeps rows the way the contract says (bound to a key, or not yet; tickets
 * single use, for one id):
 *
 *   [e] the owner proofs: the golden links/testnet write, check and release messages and signatures;
 *   [f] a backup to an email that already backs up another account stores nothing and keeps the
 *       choice; "Bring that account here" is refused until the person says this browser's account
 *       goes (and its open links), then switches with settings and consent kept; the person's OWN
 *       older backup is tied to this account with one ticketed request and no code; "Replace it"
 *       needs REPLACE and a backup tied to no account; a ticket used up reads "That took too long";
 *   [g] a restore of a backup tied to no account ties it to the restored key with one request that
 *       carries the same box; a tied one is checked; the record keeps the email and the binding;
 *   [h] Add your backup email: a yes is recorded, a no and an older host are said as such;
 *   [i] Use another account: refused until this account's backup is confirmed; switching keeps each
 *       account's links in storage and shows them again when it comes back; settings stay;
 *   [j] an interrupted create (a key record with no backup marker) reads as needing its backup:
 *       Forget asks first, real money waits, and the next unlock rebuilds the backup copy;
 *   [k] Change backup email: the new email holds a backup tied to the account, and the old one is
 *       released with one signed request.
 *
 * Offline: the sponsor and IndexedDB are in memory; Argon2id runs for real (a few seconds).
 * RUN: pnpm --filter @lumenia/extension test:account
 */
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "buffer";
import { installChrome } from "./chrome-fake";
import { installIdb } from "./idb-fake";
import { hexId, installBuildEnv, jsonResponse, ok, outcome, run, same, sdk, section, sha256hex } from "./_harness";

const OURS = { id: "test-ext", url: "chrome-extension://test-ext/popup.html" } as chrome.runtime.MessageSender;
const STRONG = "correct horse battery";

run("ACCOUNT", "an account made here: create, back up, practice dollars, forget", async () => {
  installBuildEnv();
  const fake = installChrome();
  const idb = installIdb();
  const S = sdk();
  const storage = await import("../src/lib/storage");
  storage.useAreas(fake.local, fake.session);
  const { K } = storage;
  const account = await import("../src/background/account");
  const router = await import("../src/background/router");
  const core = await import("../src/core");
  const { ExtError } = await import("../src/lib/errors");
  const codeOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r ? (r.error instanceof ExtError ? r.error.code : `other: ${String(r.error)}`) : "returned");
  const consent = () => fake.local.set({ [K.settings]: { net: "testnet", autolockMin: 15, mainnetAck: false, consentAt: 1 } });
  const wipe = async () => {
    idb.dbs.clear();
    await fake.local.clear();
    await fake.session.clear();
  };

  /* ---------------------------------------- [a] ---------------------------------------- */
  section("a", "createAccount");
  await wipe();
  ok("before the first-run agreement: refused, nothing made", codeOf(await outcome(account.createAccount(STRONG))) === "needs-consent" && idb.dbs.size === 0);
  await consent();
  for (const [what, pw] of [
    ["nine characters", "abcdefgh1"],
    ["a common password with a suffix", "Password12"],
    ["one repeated character", "aaaaaaaaaaaa"],
    ["a keyboard run", "qwertyuiop12"],
  ] as const) {
    const r = await outcome(account.createAccount(pw));
    ok(`${what}: refused as weak-password, with the website's own reason, and nothing made`, codeOf(r) === "weak-password" && "error" in r && /[A-Z].*\./.test((r.error as Error).message) && !(await fake.local.get(K.account)));
  }
  const made = await account.createAccount(STRONG);
  const pub = made.pubkey;
  ok("a strong password: an account, whose public key comes back", S.StrKey.isValidEd25519PublicKey(pub));
  const active = await core.getActive();
  ok("  ...the keystore holds it as the active Phase-2 account", active?.pubkey === pub && active.phase === 2);
  const opened = await core.unlockPhase2(STRONG, pub);
  ok("  ...its key record opens with the password, to this account's key", S.Keypair.fromRawEd25519Seed(Buffer.from(opened.seed)).publicKey() === pub);
  ok("  ...and not with another password", "error" in (await outcome(core.unlockPhase2(`${STRONG}!`, pub))));
  ok("  ...the storage.local mirror names it (the link list is scoped to it)", (await fake.local.get<{ pubkey: string }>(K.account))?.pubkey === pub);
  ok("  ...the session is unlocked for it", (await fake.session.get(K.unlockedPubkey)) === pub && typeof (await fake.session.get(K.seed)) === "string");
  const box = await fake.local.get<{ formatVersion: number; copies: { kind: string }[] }>(K.pendingBackup);
  const copy = box ? core.findCopy(box as never, "password") : undefined;
  ok("  ...a backup box waits, with exactly one copy: the password copy", Boolean(box) && box!.copies.length === 1 && Boolean(copy));
  const fromBox = await core.unwrapWithPassword(copy as never, STRONG);
  ok("  ...that copy opens with the same password, to the same key", S.Keypair.fromRawEd25519Seed(Buffer.from(fromBox)).publicKey() === pub);
  ok("  ...and the box is ciphertext: no seed, no secret key in it", !JSON.stringify(box).includes(Buffer.from(opened.seed).toString("base64")) && !/S[A-Z2-7]{55}/.test(JSON.stringify(box)));
  ok("a second account in the same extension: refused", codeOf(await outcome(account.createAccount("another long passphrase"))) === "internal" && (await core.getActive())?.pubkey === pub);
  ok("the backup view says it lives only here", (await account.backupView()).needed === true);

  /* ---------------------------------------- [b] ---------------------------------------- */
  section("b", "backing it up");
  const realFetch = globalThis.fetch;
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let recoveryReply: () => Response = () => jsonResponse(200, { ok: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const path = new URL(url).pathname;
    posts.push({ path, body });
    if (path === "/recovery-otp") return jsonResponse(200, { ok: true });
    if (path === "/recovery") return recoveryReply();
    return jsonResponse(404, { error: "not found" });
  }) as typeof fetch;
  try {
    ok("a malformed email: bad-email, nothing sent", codeOf(await outcome(account.backupRequestCode("not-an-email"))) === "bad-email" && posts.length === 0);
    const sent = await account.backupRequestCode("  Someone@Example.com ");
    ok("a real email: the code is requested from the testnet Worker's /recovery-otp", posts.at(-1)?.path === "/recovery-otp" && posts.at(-1)?.body.email === "Someone@Example.com" && sent.codeSentAt > 0);
    ok("  ...and the backup view moves to the code step", (await account.backupView()).step === "code");
    ok("a code that is not six digits: bad-code, nothing stored", codeOf(await outcome(account.backupSubmitCode("12"))) === "bad-code" && posts.at(-1)?.path === "/recovery-otp");
    recoveryReply = () => jsonResponse(401, { error: "invalid or expired code" });
    ok("the server says the code is wrong: bad-code, the box still waits", codeOf(await outcome(account.backupSubmitCode("123456"))) === "bad-code" && (await account.backupView()).needed);
    recoveryReply = () => jsonResponse(400, { error: "That email already holds a backup for a different account. Use another email address for this one." });
    const refused = await outcome(account.backupSubmitCode("123456"));
    ok("the sponsor refuses (another account's email): backup-refused, in its own words", codeOf(refused) === "backup-refused" && "error" in refused && /different account/.test((refused.error as Error).message));
    ok("  ...and the box still waits", (await account.backupView()).needed);
    recoveryReply = () => jsonResponse(500, { error: "boom" });
    ok("a server error: not stored, said in plain words", codeOf(await outcome(account.backupSubmitCode("123456"))) === "internal" && (await account.backupView()).needed);
    const lockAt = await fake.session.get<number>(K.lockAt);
    await fake.session.set({ [K.lockAt]: Date.now() - 1 });
    const before = posts.length;
    ok("a locked extension: refused as locked before anything is sent", codeOf(await outcome(account.backupSubmitCode("123456"))) === "locked" && posts.length === before);
    // unlock again for the happy path (the lock wiped the seed)
    await fake.session.set({ [K.seed]: Buffer.from(opened.seed).toString("base64"), [K.unlockedPubkey]: pub, [K.lockAt]: lockAt ?? Date.now() + 600_000 });
    if (!(await fake.session.get(K.backup))) await account.backupRequestCode("someone@example.com");
    recoveryReply = () => jsonResponse(200, { ok: true });
    const stored = await account.backupSubmitCode("12 34 56");
    const sentBox = posts.at(-1)!;
    const wantId = createHash("sha256").update("someone@example.com").digest("hex");
    ok("the right code (typed with spaces): stored", sentBox.path === "/recovery" && stored.backedUpAt > 0);
    ok("  ...under the email's id (SHA-256 of the lowercased address), with the code", sentBox.body.id === wantId && sentBox.body.code === "123456");
    ok("  ...carrying exactly the box made with the account", JSON.stringify(sentBox.body.box) === JSON.stringify(box));
    const owner = sentBox.body.owner as { pubkey?: string; proof?: string } | undefined;
    ok("  ...and signed by the account itself (the row is bound to it)", owner?.pubkey === pub && typeof owner.proof === "string" && owner.proof.length > 40);
    ok("afterwards the account is no longer 'only in this browser', and the waiting box is gone", !(await account.backupView()).needed && !(await fake.local.get(K.pendingBackup)));
    const rec0 = await storage.backupRecordFor(pub);
    ok("  ...this browser records the email it is backed up with, as typed (an older host that does not say whether it is tied: bound null)", rec0?.email === "Someone@Example.com" && rec0.bound === null, JSON.stringify(rec0));
    ok("  ...a second backup is refused (nothing left to store)", codeOf(await outcome(account.backupRequestCode("someone@example.com"))) === "internal");
  } finally {
    globalThis.fetch = realFetch;
  }

  /* ---------------------------------------- [c] ---------------------------------------- */
  section("c", "practice dollars");
  const { addPracticeDollars } = await import("../src/background/practice");
  const testnet = core.testnetConfig();
  type Bal = { usd: string | null; missing: boolean; line?: boolean };
  const rig = (first: Bal, o: { prepareFails?: string; faucetFails?: string } = {}) => {
    const log: string[] = [];
    let n = 0;
    const deps = {
      balance: async () => (n++ === 0 ? first : { usd: "1.0000000", missing: false, line: true }),
      signer: async (p: string) => (log.push(`signer:${p === pub ? "held" : p}`), core.localSignerFromSeed(new Uint8Array(32))),
      prepare: async () => {
        log.push("prepare");
        if (o.prepareFails) throw new Error(o.prepareFails);
      },
      faucet: async () => {
        log.push("faucet");
        if (o.faucetFails) throw new Error(o.faucetFails);
      },
    };
    return { deps, log };
  };
  const brandNew = rig({ usd: null, missing: true, line: false });
  const got = await addPracticeDollars(brandNew.deps, pub, testnet);
  ok("a brand-new account: the key is asked for, the account is opened, then the faucet pays", brandNew.log.join(",") === "signer:held,prepare,faucet" && got.usd === "1.0000000");
  const noLine = rig({ usd: "0", missing: false, line: false });
  await addPracticeDollars(noLine.deps, pub, testnet);
  ok("an account without the dollar line: the line is added first", noLine.log.join(",") === "signer:held,prepare,faucet");
  const ready = rig({ usd: "0", missing: false, line: true });
  await addPracticeDollars(ready.deps, pub, testnet);
  ok("an account that can hold dollars: the faucet pays, nothing else is signed", ready.log.join(",") === "faucet");
  const real = rig({ usd: null, missing: true });
  ok("real money: refused, nothing asked of anyone", codeOf(await outcome(addPracticeDollars(real.deps, pub, { ...testnet, isMainnet: true }))) === "internal" && real.log.length === 0);
  const prepFail = rig({ usd: null, missing: true }, { prepareFails: "create-account -> 429: {}" });
  const pf = await outcome(addPracticeDollars(prepFail.deps, pub, testnet));
  ok("the account cannot be opened: sponsor-refused in plain words, and the faucet is not asked", codeOf(pf) === "sponsor-refused" && "error" in pf && /couldn't open your practice account/.test((pf.error as Error).message) && !prepFail.log.includes("faucet"));
  const fauFail = rig({ usd: "0", missing: false, line: true }, { faucetFails: "This address already got practice dollars today." });
  const ff = await outcome(addPracticeDollars(fauFail.deps, pub, testnet));
  ok("the faucet says no in a sentence: that sentence is shown", codeOf(ff) === "sponsor-refused" && "error" in ff && (ff.error as Error).message === "This address already got practice dollars today.");

  /* ---------------------------------------- [d] ---------------------------------------- */
  section("d", "forgetting an account that was never backed up");
  await wipe();
  await consent();
  const second = await account.createAccount(STRONG);
  const ask = (msg: unknown) => router.route(msg, OURS) as Promise<{ ok: boolean; code?: string; message?: string }>;
  const plain = await ask({ type: "forget", confirm: "FORGET" });
  ok("forget, not backed up: refused as not-backed-up, saying the money would be gone for good", plain.code === "not-backed-up" && /gone for good/.test(plain.message ?? ""));
  ok("  ...and the account is still here", (await core.getActive())?.pubkey === second.pubkey);
  ok("forget with 'lose the account' chosen: done, everything removed", (await ask({ type: "forget", confirm: "FORGET", loseAccount: true })).ok && !(await core.getActive()) && Object.keys(await fake.local.getAll()).length === 0);

  await consent();
  const third = await account.createAccount(STRONG);
  await fake.local.remove(K.account); // a mirror lost to a write that never finished
  const back = await account.currentAccount();
  ok("the storage.local mirror, if lost, is put back from the keystore", back?.pubkey === third.pubkey && (await fake.local.get<{ pubkey: string }>(K.account))?.pubkey === third.pubkey);

  /* ===================================== one email, one account ===================================== */

  const proofMod = await import("../src/lib/proof");
  const identity = await import("../src/lib/identity");
  const pilotK = (pk: string) => K.pilot(pk);

  /* ---------------------------------------- [e] ---------------------------------------- */
  section("e", "the owner proofs (golden vectors, LUMENIA ACCOUNT CONTRACT v1 section 1)");
  const goldenSigner = core.localSignerFromSeed(new Uint8Array(32).fill(1));
  const GOLDEN_PUB = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
  const GID = await identity.emailId("  Founder@Example.com ");
  ok("emailId trims and lowercases, then SHA-256 in hex", GID === "fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884" && GID === sha256hex("founder@example.com"));
  const FIXED = { ts: 1760000000, nonce: "0123456789abcdef" };
  const golden: [string, string, string, string][] = [
    [
      "write",
      GID,
      "lumenia-handle-links:v1:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:testnet",
      "h6zhlw5Gx5zDuK/kiRYEUAlrd8rRSz/V0AZhIeYBCtHwPGgVCdSoVGHmxP4DkJtFuDRfnSOSXZfymsBqkj07BA==",
    ],
    [
      "check",
      `check:${GID}`,
      "lumenia-handle-links:v1:check:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:testnet",
      "i5ORTu/1MEH2aIDhPQL8BrOWZfZk4Yiy8xMv/vkDU9WT+MC4sDrtiMBtUbu4QX2p/csnvdVoedEHYmQvvO2cDw==",
    ],
    [
      "release",
      `release:${GID}`,
      "lumenia-handle-links:v1:release:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:testnet",
      "SNdv504x5awpCGipDXOjfycaapxHt/xjxLZVukaKgwf/CORI1XwOgXItkWVKbMc0n40oXc010BYdDRZ1FK5BDQ==",
    ],
  ];
  for (const [what, name, msg, sig] of golden) {
    const built = proofMod.proofMessage("links", name, GOLDEN_PUB, FIXED.ts, FIXED.nonce, "testnet");
    const proof = await proofMod.ownerProof(goldenSigner, "links", name, "testnet", FIXED);
    ok(`the ${what} proof: the golden message`, built === msg, built);
    ok(`  ...and the golden signature`, proof.proof === sig && proof.pubkey === GOLDEN_PUB, proof.proof);
  }

  /* ------------------------------- a fake recovery host (contract 2) ------------------------------- */
  const CODE = "123456";
  interface Row {
    box: unknown;
    ownerHash?: string;
  }
  const H = {
    rows: new Map<string, Row>(),
    tickets: new Map<string, string>(),
    /** an older host: no `bound`, no ticket, adopts an untied row, 404 for the new routes */
    old: false,
    log: [] as { path: string; body: Record<string, unknown> }[],
  };
  const signedBy = (owner: unknown, name: string): string | null => {
    const o = owner as { pubkey?: string; ts?: number; nonce?: string; proof?: string } | undefined;
    if (!o?.pubkey || !o.proof) return null;
    const msg = proofMod.proofMessage("links", name, o.pubkey, Number(o.ts), String(o.nonce), "testnet");
    try {
      return S.Keypair.fromPublicKey(o.pubkey).verify(Buffer.from(msg), Buffer.from(o.proof, "base64")) ? o.pubkey : null;
    } catch {
      return null;
    }
  };
  const TAKEN = "That email already holds a backup for a different account. Use another email address for this one.";
  const host = (path: string, b: Record<string, unknown>): Response => {
    const id = String(b.id ?? "");
    const row = H.rows.get(id);
    switch (path) {
      case "/recovery-otp":
        return jsonResponse(200, { ok: true });
      case "/recovery": {
        if (b.ticket !== undefined) {
          if (b.code !== undefined) return jsonResponse(400, { error: "send a code or a ticket, not both" });
          const forId = H.tickets.get(String(b.ticket));
          H.tickets.delete(String(b.ticket));
          if (forId !== id) return jsonResponse(401, { error: "invalid or expired code" });
        } else if (b.code !== CODE) return jsonResponse(401, { error: "invalid or expired code" });
        const signer = b.owner ? signedBy(b.owner, id) : null;
        if (b.owner && !signer) return jsonResponse(400, { error: "We couldn't confirm this account signed the backup." });
        const hash = signer ? sha256hex(signer) : undefined;
        if (H.old) {
          if (row?.ownerHash && row.ownerHash !== hash) return jsonResponse(400, { error: TAKEN });
          H.rows.set(id, { box: b.box, ...(hash ? { ownerHash: hash } : {}) });
          return jsonResponse(200, { ok: true });
        }
        if (!row) {
          H.rows.set(id, { box: b.box, ...(hash ? { ownerHash: hash } : {}) });
          return jsonResponse(200, { ok: true, bound: Boolean(hash) });
        }
        if (row.ownerHash) {
          if (!hash) return jsonResponse(400, { error: "Replacing this backup needs a signature from the account it belongs to." });
          if (row.ownerHash === hash) {
            H.rows.set(id, { box: b.box, ownerHash: hash });
            return jsonResponse(200, { ok: true, bound: true });
          }
          return jsonResponse(409, { error: TAKEN, code: "email-taken", unbound: false, box: row.box });
        }
        if (hash && b.replace === true) {
          H.rows.set(id, { box: b.box, ownerHash: hash });
          return jsonResponse(200, { ok: true, bound: true });
        }
        const ticket = randomBytes(32).toString("hex");
        H.tickets.set(ticket, id);
        return jsonResponse(409, { error: TAKEN, code: "email-taken", unbound: true, box: row.box, ticket });
      }
      case "/recovery-fetch": {
        if (b.code !== CODE) return jsonResponse(401, { error: "invalid or expired code" });
        if (!row) return jsonResponse(404, { error: "not found" });
        if (H.old) return jsonResponse(200, { box: row.box });
        if (row.ownerHash) return jsonResponse(200, { box: row.box, bound: true });
        const ticket = randomBytes(32).toString("hex");
        H.tickets.set(ticket, id);
        return jsonResponse(200, { box: row.box, bound: false, ticket });
      }
      case "/recovery-check": {
        if (H.old) return jsonResponse(404, { error: "not found" });
        const signer = signedBy(b.owner, `check:${id}`);
        if (!signer) return jsonResponse(401, { error: "We couldn't confirm this account signed the request. Check your device clock and try again." });
        return jsonResponse(200, { mine: Boolean(row?.ownerHash) && row!.ownerHash === sha256hex(signer) });
      }
      case "/recovery-release": {
        if (H.old) return jsonResponse(404, { error: "not found" });
        const signer = signedBy(b.owner, `release:${id}`);
        if (!signer) return jsonResponse(401, { error: "We couldn't confirm this account signed the request. Check your device clock and try again." });
        if (!row?.ownerHash || row.ownerHash !== sha256hex(signer)) return jsonResponse(409, { error: "That email doesn't back up this account.", code: "not-yours" });
        H.rows.delete(id);
        return jsonResponse(200, { ok: true });
      }
      default:
        return jsonResponse(404, { error: "not found" });
    }
  };
  const TESTNET_HOST = "https://lumenia-sponsor.avakit.workers.dev";
  const realFetchE = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(`${TESTNET_HOST}/`)) throw new TypeError(`fetch failed (the test answers only the recovery host, not ${url})`);
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    H.log.push({ path, body });
    return host(path, body);
  }) as typeof fetch;
  const idOf = (email: string) => sha256hex(email.trim().toLowerCase());
  const askR = (msg: unknown) => router.route(msg, OURS) as Promise<{ ok: boolean; code?: string; message?: string; data?: unknown }>;
  /** A backup box of a fresh account, made the way every surface makes one, and that account's key. */
  const boxFor = async (password: string) => {
    const kp = S.Keypair.random();
    const box = core.putCopy(core.emptyBox(), await core.wrapWithPassword(new Uint8Array(kp.rawSecretKey()), password));
    return { pub: kp.publicKey(), box };
  };
  const linkOf = (n: number, sender: string, o: Record<string, unknown> = {}) => ({
    v: 1,
    net: "testnet",
    linkHex: hexId(n),
    sender,
    amount: "1.00",
    from: "",
    locked: false,
    createdAt: Date.now() - 60_000,
    expiry: Math.floor(Date.now() / 1000) + 6 * 86_400,
    retrySafeAfter: Date.now(),
    innerHash: "cd".repeat(32),
    phase: "confirmed",
    status: "pending",
    nextCheckAt: Date.now() + 60_000,
    ...o,
  });
  const linksMod = await import("../src/lib/links");
  const putLink = async (r: ReturnType<typeof linkOf>) => fake.local.set({ [linksMod.linkKey("testnet", r.linkHex)]: r });

  try {
    /* ---------------------------------------- [f] ---------------------------------------- */
    section("f", "a backup to an email that already backs up another account");
    await wipe();
    H.rows.clear();
    await consent();
    await fake.local.set({ [K.settings]: { net: "testnet", autolockMin: 60, mainnetAck: false, consentAt: 7 } });
    const PW_B = "bravo charlie delta";
    const B = await boxFor(PW_B);
    H.rows.set(idOf("taken@example.com"), { box: B.box, ownerHash: sha256hex(B.pub) });
    const A = await account.createAccount(STRONG);
    const pendingA = await fake.local.get(K.pendingBackup);
    await account.backupRequestCode("taken@example.com");
    H.log.length = 0;
    const conflict = await outcome(account.backupSubmitCode(CODE));
    ok("the email backs up another account (a tied row): email-taken, after the code", codeOf(conflict) === "email-taken" && H.log.length === 1 && H.log[0]!.body.code === CODE);
    ok("  ...nothing was stored: the row still holds the other account's backup, tied to it", same(H.rows.get(idOf("taken@example.com")), { box: B.box, ownerHash: sha256hex(B.pub) }));
    ok("  ...this account's backup copy still waits, unchanged", same(await fake.local.get(K.pendingBackup), pendingA) && (await account.backupView()).needed);
    const kept = await fake.session.get<{ email: string; box: unknown; unbound: boolean; ticket?: string }>(K.backupConflict);
    ok("  ...the choice is kept in the session: the email, that backup, tied (no ticket)", kept?.email === "taken@example.com" && same(kept.box, B.box) && kept.unbound === false && kept.ticket === undefined);
    const view = await account.backupView();
    ok("  ...and the popup sees it, without the box", same(view.conflict, { email: "taken@example.com", unbound: false, ticket: false, other: null }));

    // Bring that account here.
    const wrongPw = await askR({ type: "backup.useExisting", password: "not the password" });
    ok("Bring that account here, wrong password: bad-password, nothing changes", wrongPw.code === "bad-password" && (await core.getActive())?.pubkey === A.pubkey);
    const noSay = await askR({ type: "backup.useExisting", password: PW_B });
    ok("the right password, but this browser's account was never backed up: refused (not-backed-up) until the person says it goes", noSay.code === "not-backed-up" && /gone for good/.test(noSay.message ?? "") && (await core.getActive())?.pubkey === A.pubkey);
    ok("  ...the account it opened to is named for the popup", (await account.backupView()).conflict?.other === B.pub);
    await putLink(linkOf(1, A.pubkey));
    const openOnes = await askR({ type: "backup.useExisting", password: PW_B, loseAccount: true });
    ok("  ...and with this account's links still open: refused (open-links) until the person says those go too", openOnes.code === "open-links" && (await core.getActive())?.pubkey === A.pubkey);
    await fake.session.set({ [pilotK(A.pubkey)]: { pilot: true, approved: false, state: "none", used: 0, limit: 5, revoked: false, at: Date.now() } });
    H.log.length = 0;
    const moved = await askR({ type: "backup.useExisting", password: PW_B, loseAccount: true, leaveOpenLinks: true });
    const movedData = moved.data as { pubkey?: string; same?: boolean; bound?: boolean | null } | undefined;
    ok("with both said: this browser now holds the other account", moved.ok && movedData?.pubkey === B.pub && movedData.same === false && (await core.getActive())?.pubkey === B.pub, JSON.stringify(moved));
    ok("  ...unlocked, and named in the mirror that scopes the links", (await fake.session.get(K.unlockedPubkey)) === B.pub && (await fake.local.get<{ pubkey: string }>(K.account))?.pubkey === B.pub);
    const st1 = (await fake.local.get(K.settings)) as Record<string, unknown>;
    ok("  ...settings and consent are kept (the auto-lock, the agreement)", st1.autolockMin === 60 && st1.consentAt === 7, JSON.stringify(st1));
    ok("  ...the account that went, never backed up, leaves nothing behind: its key, its links, its record, its waiting copy", (await fake.local.get(linksMod.linkKey("testnet", hexId(1)))) === undefined && (await storage.backupRecordFor(A.pubkey)) === null && (await fake.local.get(K.pendingBackup)) === undefined && (await fake.session.get(pilotK(A.pubkey))) === undefined);
    const recB = await storage.backupRecordFor(B.pub);
    ok("  ...the account that came is recorded with its email, its backup checked and confirmed as its own", recB?.email === "taken@example.com" && recB.bound === true && H.log.some((x) => x.path === "/recovery-check"), JSON.stringify(recB));
    ok("  ...nothing was written to the backup row", same(H.rows.get(idOf("taken@example.com")), { box: B.box, ownerHash: sha256hex(B.pub) }) && !H.log.some((x) => x.path === "/recovery"));
    ok("  ...and the choice is gone", (await fake.session.get(K.backupConflict)) === undefined && (await account.backupView()).conflict === null);

    // The person's OWN older backup, tied to no account yet (an older website backup made without a signature).
    await wipe();
    H.rows.clear();
    H.tickets.clear();
    await consent();
    const A2 = await account.createAccount(STRONG);
    const ownBox = await fake.local.get(K.pendingBackup);
    H.rows.set(idOf("old@example.com"), { box: ownBox });
    await account.backupRequestCode("old@example.com");
    const untied = await outcome(account.backupSubmitCode(CODE));
    const keptU = await fake.session.get<{ unbound: boolean; ticket?: string }>(K.backupConflict);
    ok("an email holding a backup tied to no account: email-taken too, with a ticket kept for one more request", codeOf(untied) === "email-taken" && keptU?.unbound === true && /^[0-9a-f]{64}$/.test(keptU.ticket ?? ""));
    ok("  ...and the row was not taken over (nothing written)", same(H.rows.get(idOf("old@example.com")), { box: ownBox }));
    H.log.length = 0;
    const own = await askR({ type: "backup.useExisting", password: STRONG });
    const ownData = own.data as { same?: boolean; bound?: boolean | null } | undefined;
    const bind = H.log.filter((x) => x.path === "/recovery");
    ok("its password opens it to THIS account: tied to it with exactly one request", own.ok && ownData?.same === true && ownData.bound === true && bind.length === 1 && H.log.length === 1, JSON.stringify(H.log.map((x) => x.path)));
    ok("  ...that request carries the ticket and replace, and no code", bind[0]?.body.ticket === keptU?.ticket && bind[0]?.body.replace === true && !("code" in (bind[0]?.body ?? {})));
    ok("  ...signed by this account", (bind[0]?.body.owner as { pubkey?: string } | undefined)?.pubkey === A2.pubkey && H.rows.get(idOf("old@example.com"))?.ownerHash === sha256hex(A2.pubkey));
    const recA2 = await storage.backupRecordFor(A2.pubkey);
    ok("  ...the record names the email, tied; the waiting copy is gone; still the same account here", recA2?.email === "old@example.com" && recA2.bound === true && !(await account.backupView()).needed && (await core.getActive())?.pubkey === A2.pubkey);

    // Replace it: only for a backup tied to no account, only after REPLACE was typed.
    await wipe();
    H.rows.clear();
    H.tickets.clear();
    await consent();
    const A3 = await account.createAccount(STRONG);
    const boxA3 = await fake.local.get(K.pendingBackup);
    const C = await boxFor("charlie delta echo");
    H.rows.set(idOf("stale@example.com"), { box: C.box });
    await account.backupRequestCode("stale@example.com");
    await outcome(account.backupSubmitCode(CODE));
    const ticketR = (await fake.session.get<{ ticket?: string }>(K.backupConflict))?.ticket;
    for (const [what, msg] of [
      ["no confirmation word", { type: "backup.replace" }],
      ["the word in lower case", { type: "backup.replace", confirm: "replace" }],
      ["another word", { type: "backup.replace", confirm: "FORGET" }],
    ] as const) {
      const r = await askR(msg);
      ok(`Replace it with ${what}: refused before anything acts on it`, !r.ok && /not a request this extension knows/.test(r.message ?? ""));
    }
    H.log.length = 0;
    const replaced = await askR({ type: "backup.replace", confirm: "REPLACE" });
    const rep1 = H.log.filter((x) => x.path === "/recovery");
    ok("Replace it with REPLACE: this account's backup is stored in its place, tied to this account", replaced.ok && same(H.rows.get(idOf("stale@example.com")), { box: boxA3, ownerHash: sha256hex(A3.pubkey) }));
    ok("  ...with exactly one request carrying the ticket and replace, and no code", rep1.length === 1 && rep1[0]!.body.ticket === ticketR && rep1[0]!.body.replace === true && !("code" in rep1[0]!.body));
    ok("  ...and the record names the email, tied", same(await storage.backupRecordFor(A3.pubkey), { email: "stale@example.com", at: (await storage.backupRecordFor(A3.pubkey))!.at, bound: true }));

    // A tied row is never replaced, and a used ticket is "That took too long".
    await wipe();
    H.rows.clear();
    H.tickets.clear();
    await consent();
    await account.createAccount(STRONG);
    H.rows.set(idOf("taken@example.com"), { box: B.box, ownerHash: sha256hex(B.pub) });
    await account.backupRequestCode("taken@example.com");
    await outcome(account.backupSubmitCode(CODE));
    H.log.length = 0;
    const tiedReplace = await askR({ type: "backup.replace", confirm: "REPLACE" });
    ok("Replace it for a backup tied to another account: refused, nothing sent", tiedReplace.code === "email-taken" && H.log.length === 0);
    await account.backupCancel();
    H.rows.set(idOf("stale@example.com"), { box: C.box });
    await account.backupRequestCode("stale@example.com");
    await outcome(account.backupSubmitCode(CODE));
    H.tickets.clear(); // ten minutes went by
    const late = await askR({ type: "backup.replace", confirm: "REPLACE" });
    ok("a ticket that is used up or expired: 'That took too long. Send a new code and try again.'", late.code === "bad-code" && late.message === "That took too long. Send a new code and try again.", `${late.code}: ${late.message}`);
    ok("  ...and the row is untouched", same(H.rows.get(idOf("stale@example.com")), { box: C.box }));
    await account.backupCancel();
    ok("Use another email: back to the email step, the choice gone, the waiting copy still there", (await account.backupView()).conflict === null && (await account.backupView()).step === null && (await account.backupView()).needed);

    /* ---------------------------------------- [g] ---------------------------------------- */
    section("g", "restoring a backup tied to no account ties it to the restored key");
    await wipe();
    H.rows.clear();
    H.tickets.clear();
    await consent();
    H.rows.set(idOf("restore@example.com"), { box: B.box });
    await account.restoreRequestCode("restore@example.com");
    await account.restoreSubmitCode(CODE);
    H.log.length = 0;
    const restored = await account.restoreSubmitPassword(PW_B);
    const binds = H.log.filter((x) => x.path === "/recovery");
    ok("the restore brings the account here", restored.pubkey === B.pub && restored.same === false && (await core.getActive())?.pubkey === B.pub);
    ok("  ...and sends exactly one request: the bind", binds.length === 1 && H.log.length === 1, JSON.stringify(H.log.map((x) => x.path)));
    ok("  ...carrying the SAME box it restored from", same(binds[0]?.body.box, B.box));
    ok("  ...with the ticket, replace and the restored key's signature, and no code", typeof binds[0]?.body.ticket === "string" && binds[0]?.body.replace === true && !("code" in (binds[0]?.body ?? {})) && (binds[0]?.body.owner as { pubkey?: string }).pubkey === B.pub);
    ok("  ...the row is now tied to it", H.rows.get(idOf("restore@example.com"))?.ownerHash === sha256hex(B.pub));
    ok("  ...the answer and the record: the email, tied", restored.bound === true && restored.email === "restore@example.com" && same(await storage.backupRecordFor(B.pub), { email: "restore@example.com", at: (await storage.backupRecordFor(B.pub))!.at, bound: true }));
    ok("  ...WorkerState.account carries the email and the binding", same(await account.accountView(), { pubkey: B.pub, email: "restore@example.com", bound: true }));

    await wipe();
    H.tickets.clear();
    await consent();
    await account.restoreRequestCode("RESTORE@example.com ");
    await account.restoreSubmitCode(CODE);
    H.log.length = 0;
    const tied = await account.restoreSubmitPassword(PW_B);
    ok("a backup already tied: no bind, one signed check instead, and it is this account's own", tied.bound === true && H.log.length === 1 && H.log[0]!.path === "/recovery-check" && same(H.log[0]!.body.id, idOf("restore@example.com")));

    await wipe();
    H.old = true;
    await consent();
    await account.restoreRequestCode("restore@example.com");
    await account.restoreSubmitCode(CODE);
    const oldHost = await account.restoreSubmitPassword(PW_B);
    ok("an older host that says nothing about binding (and has no check route): restored, binding unknown (null), never 'no'", oldHost.bound === null && (await storage.backupRecordFor(B.pub))?.bound === null && (await storage.backupRecordFor(B.pub))?.email === "restore@example.com");
    H.old = false;

    /* ---------------------------------------- [h] ---------------------------------------- */
    section("h", "Add your backup email (a record from 0.1.3, which never kept it)");
    // 0.1.3 kept only {at}: the email and the binding are unknown.
    await fake.local.remove(K.backups);
    await fake.local.set({ [K.backedUp]: { at: 5 } });
    ok("a 0.1.3 record reads as this account's, email and binding unknown", same(await account.accountView(), { pubkey: B.pub, email: null, bound: null }) && !(await account.backupView()).needed);
    H.rows.set(idOf("someone.else@example.com"), { box: C.box, ownerHash: sha256hex(C.pub) });
    const notMine = await askR({ type: "account.checkBackupEmail", email: "someone.else@example.com" });
    ok("an email that backs up another account: backup-not-mine, nothing recorded", notMine.code === "backup-not-mine" && notMine.message === "That email doesn't back up this account." && (await account.accountView())?.email === null);
    ok("  ...asked with a signed check over that email's id, and no code", H.log.at(-1)?.path === "/recovery-check" && !("code" in (H.log.at(-1)?.body ?? {})));
    const mine = await askR({ type: "account.checkBackupEmail", email: " Restore@Example.com " });
    ok("this account's own email: recorded, with its binding confirmed", mine.ok && same(await account.accountView(), { pubkey: B.pub, email: "Restore@Example.com", bound: true }), JSON.stringify(await account.accountView()));
    ok("  ...and the 0.1.3 marker is folded into the new record", (await fake.local.get(K.backedUp)) === undefined);
    H.old = true;
    const oldCheck = await askR({ type: "account.checkBackupEmail", email: "restore@example.com" });
    ok("an older host (404): 'We couldn't check that just now. Try again later.'", oldCheck.code === "internal" && oldCheck.message === "We couldn't check that just now. Try again later.", `${oldCheck.code}: ${oldCheck.message}`);
    H.old = false;
    await fake.session.set({ [K.lockAt]: Date.now() - 1 });
    ok("locked: refused as locked", (await askR({ type: "account.checkBackupEmail", email: "restore@example.com" })).code === "locked");

    /* ---------------------------------------- [i] ---------------------------------------- */
    section("i", "Use another account");
    await wipe();
    H.rows.clear();
    H.tickets.clear();
    await consent();
    await fake.local.set({ [K.settings]: { net: "public", autolockMin: 60, mainnetAck: true, consentAt: 7 } });
    H.rows.set(idOf("b@example.com"), { box: B.box, ownerHash: sha256hex(B.pub) });
    H.rows.set(idOf("c@example.com"), { box: C.box, ownerHash: sha256hex(C.pub) });
    await account.restoreRequestCode("b@example.com");
    await account.restoreSubmitCode(CODE);
    await account.restoreSubmitPassword(PW_B);
    await putLink(linkOf(2, B.pub, { status: "claimed" }));
    await fake.session.set({ [pilotK(B.pub)]: { pilot: true, approved: true, state: "approved", used: 0, limit: 5, revoked: false, at: Date.now() } });
    const recs = async () => ((await askR({ type: "links.list" })).data as { linkHex: string }[]).map((r) => r.linkHex);
    ok("account B is here, with its one link listed", (await core.getActive())?.pubkey === B.pub && same(await recs(), [hexId(2)]));

    await storage.writeBackupRecord(B.pub, { email: "b@example.com", at: 1, bound: false });
    H.rows.set(idOf("b@example.com"), { box: B.box }); // the row is not tied to B (an older backup)
    H.log.length = 0;
    const notTied = await askR({ type: "restore.requestCode", email: "c@example.com", switching: true });
    ok(
      "its backup not tied to it (and the host, asked again, agrees): the switch is refused (needs-backup), and no code is mailed",
      notTied.code === "needs-backup" && notTied.message === "Back this account up first. It lives only in this browser." && !H.log.some((x) => x.path === "/recovery-otp"),
      `${notTied.code}: ${notTied.message}`,
    );
    H.rows.set(idOf("b@example.com"), { box: B.box, ownerHash: sha256hex(B.pub) });
    await storage.writeBackupRecord(B.pub, { email: null, at: 1, bound: null });
    const legacy = await askR({ type: "restore.requestCode", email: "c@example.com", switching: true });
    ok("a record with no email (0.1.3): refused with 'Add your backup email first.'", legacy.code === "needs-backup" && legacy.message === "Add your backup email first.");
    await storage.writeBackupRecord(B.pub, { email: "b@example.com", at: 1, bound: null });
    H.log.length = 0;
    const checked = await askR({ type: "restore.requestCode", email: "c@example.com", switching: true });
    ok("an email whose binding was never said: checked with the host first, then allowed (and recorded as confirmed)", checked.ok && H.log[0]?.path === "/recovery-check" && (await storage.backupRecordFor(B.pub))?.bound === true);
    await askR({ type: "restore.submitCode", code: CODE });
    const toC = await askR({ type: "restore.submitPassword", password: "charlie delta echo" });
    const toCData = toC.data as { pubkey?: string; same?: boolean; bound?: boolean | null } | undefined;
    ok("switched to C", toC.ok && toCData?.pubkey === C.pub && toCData.same === false && (await core.getActive())?.pubkey === C.pub, JSON.stringify(toC));
    ok("  ...one key here only (the other's record is gone from the keystore)", idb.dbs.get("lumenia")?.get("keys")?.has(B.pub) === false && idb.dbs.get("lumenia")?.get("keys")?.has(C.pub) === true);
    ok("  ...B's links are hidden, not deleted", same(await recs(), []) && (await fake.local.get(linksMod.linkKey("testnet", hexId(2)))) !== undefined);
    const st2 = (await fake.local.get(K.settings)) as Record<string, unknown>;
    ok("  ...settings and consent kept; the money goes back to practice (C's standing is its own)", st2.autolockMin === 60 && st2.consentAt === 7 && st2.net === "testnet", JSON.stringify(st2));
    ok("  ...B's cached pilot answer is dropped; B's record is kept (it can come back)", (await fake.session.get(pilotK(B.pub))) === undefined && (await storage.backupRecordFor(B.pub))?.email === "b@example.com");
    ok("  ...C is recorded with its email, confirmed", same(await account.accountView(), { pubkey: C.pub, email: "c@example.com", bound: true }));
    await askR({ type: "restore.requestCode", email: "b@example.com", switching: true });
    await askR({ type: "restore.submitCode", code: CODE });
    const backToB = await askR({ type: "restore.submitPassword", password: PW_B });
    ok("switching back to B: B's link shows again", backToB.ok && (await core.getActive())?.pubkey === B.pub && same(await recs(), [hexId(2)]));
    await askR({ type: "restore.requestCode", email: "b@example.com", switching: true });
    await askR({ type: "restore.submitCode", code: CODE });
    const sameB = await askR({ type: "restore.submitPassword", password: PW_B });
    ok("the same account brought in again: same, nothing changes", sameB.ok && (sameB.data as { same?: boolean }).same === true && (await core.getActive())?.pubkey === B.pub && same(await recs(), [hexId(2)]));

    /* ---------------------------------------- [j] ---------------------------------------- */
    section("j", "an interrupted create reads as needing its backup");
    await wipe();
    await consent();
    const D = await account.createAccount(STRONG);
    // What a worker that died between the key record and the backup copy left (0.1.3's order), or a lost write.
    await fake.local.remove(K.pendingBackup);
    ok("a key record with no backup copy and no backup record: needed", (await account.backupView()).needed === true);
    const fg = await askR({ type: "forget", confirm: "FORGET" });
    ok("  ...Forget asks first (not-backed-up), the account stays", fg.code === "not-backed-up" && (await core.getActive())?.pubkey === D.pubkey);
    const rm = await askR({ type: "network.set", net: "public" });
    ok("  ...real money waits for the backup (needs-backup)", rm.code === "needs-backup");
    await account.lock();
    await account.unlock(STRONG);
    const rebuilt = await fake.local.get<{ copies: unknown[] }>(K.pendingBackup);
    const rebuiltCopy = rebuilt ? core.findCopy(rebuilt as never, "password") : undefined;
    ok("  ...the next unlock rebuilds the backup copy from the typed password", Boolean(rebuiltCopy));
    const rebuiltSeed = rebuiltCopy ? await core.unwrapWithPassword(rebuiltCopy as never, STRONG) : new Uint8Array(32);
    ok("  ...and it opens to this very account", S.Keypair.fromRawEd25519Seed(Buffer.from(rebuiltSeed)).publicKey() === D.pubkey);
    // createAccount writes the copy and the mirror BEFORE the key record: a worker that dies in
    // between leaves no account at all, never one that reads as backed up.
    await wipe();
    await consent();
    const G = globalThis as unknown as { indexedDB: { open: (n: string, v?: number) => unknown } };
    const realIdb = G.indexedDB;
    G.indexedDB = {
      ...realIdb,
      open: (n: string, v?: number) => {
        if (n === "lumenia") throw new Error("the worker died before the key record was written");
        return realIdb.open(n, v);
      },
    };
    const died = await outcome(account.createAccount(STRONG));
    G.indexedDB = realIdb;
    ok("a create whose key record is never written: it fails", "error" in died);
    ok(
      "  ...the backup copy and the mirror were written first, and with no key record there is no account (never one that reads as backed up)",
      Boolean(await fake.local.get(K.pendingBackup)) && Boolean(await fake.local.get(K.account)) && (await core.getActive()) === null && (await account.accountView()) === null,
    );
    const again = await account.createAccount(STRONG);
    ok("  ...and the next create starts clean: its own copy, its own mirror", (await fake.local.get<{ pubkey: string }>(K.account))?.pubkey === again.pubkey && (await account.backupView()).needed);

    /* ---------------------------------------- [k] ---------------------------------------- */
    section("k", "Change backup email");
    await wipe();
    H.rows.clear();
    H.tickets.clear();
    await consent();
    const E = await account.createAccount(STRONG);
    await account.backupRequestCode("first@example.com");
    const firstB = await account.backupSubmitCode(CODE);
    ok("backed up with a first email: tied (bound true), recorded", firstB.bound === true && same(await account.accountView(), { pubkey: E.pubkey, email: "first@example.com", bound: true }));
    ok("a second backup without Change backup email: refused (nothing left to store)", codeOf(await outcome(account.backupRequestCode("second@example.com"))) === "internal");
    ok("Change backup email, wrong password: bad-password", codeOf(await outcome(account.backupAgain("not the password"))) === "bad-password" && !(await account.backupView()).again);
    await account.backupAgain(STRONG);
    ok("the right password: a new copy waits for the new email", (await account.backupView()).again === true && Boolean(await fake.session.get(K.rebackup)));
    await account.backupRequestCode("second@example.com");
    H.log.length = 0;
    const second = await account.backupSubmitCode(CODE);
    const stores = H.log.filter((x) => x.path === "/recovery");
    const releases = H.log.filter((x) => x.path === "/recovery-release");
    ok("the new email stores a backup tied to this account", second.bound === true && stores.length === 1 && H.rows.get(idOf("second@example.com"))?.ownerHash === sha256hex(E.pubkey));
    ok("  ...then exactly one release, for the OLD email's id", releases.length === 1 && releases[0]!.body.id === idOf("first@example.com"));
    const rel = releases[0]?.body.owner as { pubkey: string; ts: number; nonce: string; proof: string } | undefined;
    const relMsg = proofMod.proofMessage("links", `release:${idOf("first@example.com")}`, E.pubkey, Number(rel?.ts), String(rel?.nonce), "testnet");
    ok(
      "  ...signed as the contract's release message: lumenia-handle-links:v1:release:<id>:<G>:<ts>:<nonce>:testnet",
      rel?.pubkey === E.pubkey && /^[0-9a-f]{16}$/.test(String(rel?.nonce)) && relMsg.startsWith(`lumenia-handle-links:v1:release:${idOf("first@example.com")}:${E.pubkey}:`) && S.Keypair.fromPublicKey(E.pubkey).verify(Buffer.from(relMsg), Buffer.from(String(rel?.proof), "base64")),
    );
    ok("  ...the old email no longer opens it (its row is gone), and the record names the new email", !H.rows.has(idOf("first@example.com")) && same(await account.accountView(), { pubkey: E.pubkey, email: "second@example.com", bound: true }));
    ok("  ...and the new copy is no longer waiting", !(await account.backupView()).again && (await fake.session.get(K.rebackup)) === undefined);
  } finally {
    globalThis.fetch = realFetchE;
  }
});
