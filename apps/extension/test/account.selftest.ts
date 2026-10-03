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
 * Offline: the sponsor and IndexedDB are in memory; Argon2id runs for real (a few seconds).
 * RUN: pnpm --filter @lumenia/extension test:account
 */
import { createHash } from "node:crypto";
import { Buffer } from "buffer";
import { installChrome } from "./chrome-fake";
import { installIdb } from "./idb-fake";
import { installBuildEnv, jsonResponse, ok, outcome, run, sdk, section } from "./_harness";

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
  const consent = () => fake.local.set({ [K.settings]: { net: "testnet", autolockMin: 15, from: "", mainnetAck: false, consentAt: 1 } });
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
    ok("afterwards the account is no longer 'only in this browser', and the waiting box is gone", !(await account.backupView()).needed && !(await fake.local.get(K.pendingBackup)) && Boolean(await fake.local.get(K.backedUp)));
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
});
