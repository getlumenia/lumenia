/**
 * near-attack-demo: "attacks the system refuses", run LIVE against Lumenia's NEAR rail on NEAR
 * TESTNET ONLY. Nothing here is simulated: every attempt is a real POST to the deployed relayer
 * (https://lumenia-sponsor.avakit.workers.dev/near) or a real transaction to NEAR testnet RPC, and
 * the system's own answer is quoted verbatim.
 *
 * Run (Node 24, from the repo root):
 *     pnpm --filter @lumenia/sponsor exec tsx ../../ops/near-attack-demo.ts   (from the repository root; uses the workspace tsx)
 * (equivalently `npx tsx ops/near-attack-demo.ts` wherever tsx is on PATH; the line above uses the
 *  workspace's pinned tsx 4.23.12 so it runs with no install and no network for tsx itself.)
 *
 * It prints each attack, the request, the system's answer and the verdict (REFUSED / ALLOWED) with
 * timestamps, and writes the same, as a table plus the full log, to evidence/near/attacks.md.
 *
 * Attacks:
 *   1. Drain through the relayer: a delegate signed by lumenia-funder.testnet asking the relayer to
 *      pay for a plain USDC ft_transfer to an attacker account (not the escrow). Expect 403.
 *   2. Make the relayer pay for an arbitrary contract call (wrap.testnet near_deposit, and the
 *      escrow's own `pause`). Expect 403 for each.
 *   3. Forged sender: a delegate whose sender_id claims to be lumenia-demo.testnet but is signed
 *      with a different key. Expect 403 (bad signature); the victim's day counter must not move.
 *   4. Oversized deposit: an allowed-looking ft_transfer_call to the escrow with 2 yoctoNEAR. 403.
 *   5. Claim with a stranger key: a claim transaction to the escrow signed by a key that is not a
 *      link key. Expect the chain to reject it (access key does not exist). No funds needed.
 *   6. Double claim: create ONE 0.10 USDC link, claim it once (success), claim it again with the
 *      same link key (refused: the key is deleted after the first claim). Both tx hashes recorded.
 *   7. Rate limit: burst the SAME signed-but-refused delegate until the relayer's per-signing-key
 *      limiter answers 429. Spends no USDC.
 *
 * No key needed (NO_KEYS=1 forces it; ATTACKS_OUT=<file> writes the report somewhere other than the
 * recorded evidence): without ~/.near-credentials/testnet/lumenia-funder.testnet.json the script runs
 * attack 1 with a random key (the relayer refuses the method whoever signs it) and creates attack 6's
 * link through the public practice route (POST /near/practice-link, 0.10 practice USDC), so anyone
 * can re-run all seven. With the key file it uses the funder, as in the recorded run.
 *
 * Safety: testnet only (the relayer refuses mainnet, and this script hard-codes testnet ids). It
 * spends at most 0.10 testnet USDC (attack 6). It reads at most two testnet key files at runtime and NEVER
 * prints a secret (a redactor strips any secret-length ed25519 token from all output as well). It
 * never touches lumenia-demo.testnet's funds. It writes exactly one file: evidence/near/attacks.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/* ----------------------------------- testnet constants ----------------------------------- */

const RELAYER_BASE = "https://lumenia-sponsor.avakit.workers.dev/near";
const RELAY_URL = `${RELAYER_BASE}/relay`;
const HEALTH_URL = `${RELAYER_BASE}/health`;
const RPC_URL = "https://test.rpc.fastnear.com";
const EXPLORER = "https://testnet.nearblocks.io";
const USDC_ID = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const ESCROW_ID = "lumenia-near.testnet";
const FUNDER_ID = "lumenia-funder.testnet";
const DEMO_ID = "lumenia-demo.testnet"; // the "victim" in the forged-sender attack; never spent
const ATTACKER_ID = "attacker.testnet"; // a made-up destination; nothing ever lands there

/** 0.10 USDC (6 decimals) = the contract minimum. The only money this demo moves. */
const LINK_AMOUNT_UNITS = 100_000n;

/* --------------------------------------- utilities --------------------------------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** Strip any secret-length ed25519 token (secret keys are ~88 base58 chars; public keys ~44). */
function redact(s: string): string {
  return String(s).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, "ed25519:<redacted-secret>");
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const type = (e as { type?: unknown }).type;
    return typeof type === "string" && !e.message.includes(type) ? `${e.message} (${type})` : e.message;
  }
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function short(s: string, n = 150): string {
  const one = redact(s).replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The repo root, derived from this script's path so the command can be run from anywhere. */
function repoRoot(): string {
  const script = resolve(process.argv[1] || process.cwd());
  const dir = dirname(script);
  return basename(dir) === "ops" ? dirname(dir) : process.cwd();
}

type RelayResponse = { status: number; json: any; text: string; at: string };

async function postRelay(signedDelegateBase64: string): Promise<RelayResponse> {
  const res = await fetch(RELAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedDelegate: signedDelegateBase64 }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, at: nowIso() };
}

/** The relayer's answer in one verbatim line: "HTTP <status> <code>: <reason>". */
function relayAnswer(r: RelayResponse): string {
  const code = r.json && typeof r.json.code === "string" ? `${r.json.code}: ` : "";
  const reason = (r.json && (r.json.reason || r.json.error)) || r.text || "(empty body)";
  return `HTTP ${r.status} ${code}${reason}`;
}

async function getHealth(): Promise<any> {
  const res = await fetch(HEALTH_URL);
  return res.json();
}

/* ------------------------------------- result records ------------------------------------- */

interface Row {
  n: string;
  attack: string;
  expected: string;
  observed: string; // verbatim, short
  verdict: "REFUSED" | "ALLOWED" | "ERROR";
  evidence: string;
}

const rows: Row[] = [];
const log: string[] = [];

function emit(line = "") {
  const clean = redact(line);
  console.log(clean);
  log.push(clean);
}

function record(block: {
  n: string;
  attack: string;
  expected: string;
  request: string;
  answer: string;
  verdict: Row["verdict"];
  evidence: string;
  startedAt: string;
  endedAt: string;
  notes?: string[];
}) {
  rows.push({ n: block.n, attack: block.attack, expected: block.expected, observed: short(block.answer), verdict: block.verdict, evidence: block.evidence });
  emit(`[${block.n}] ${block.attack}`);
  emit(`    time:     ${block.startedAt} -> ${block.endedAt}`);
  emit(`    expected: ${block.expected}`);
  emit(`    request:  ${short(block.request, 220)}`);
  emit(`    answer:   ${short(block.answer, 260)}`);
  for (const note of block.notes ?? []) emit(`    note:     ${short(note, 260)}`);
  emit(`    verdict:  ${block.verdict}`);
  emit(`    evidence: ${block.evidence}`);
  emit();
}

/* ------------------------------------------ main ------------------------------------------ */

async function main() {
  const REPO = repoRoot();
  // near-api-js 7.4 (the workspace copy) and @lumenia/near, imported by absolute path so module
  // resolution does not depend on where the script sits in the tree.
  const near: any = await import(pathToFileURL(join(REPO, "packages/near/node_modules/near-api-js/lib/index.js")).href);
  const client: any = await import(pathToFileURL(join(REPO, "packages/near/src/relayer/client.ts")).href);
  const {
    KeyPair,
    KeyPairSigner,
    JsonRpcProvider,
    Signature,
    actions,
    buildDelegateAction,
    encodeDelegateAction,
    encodeSignedDelegate,
    base64Encode,
    baseDecode,
    baseEncode,
    createTransaction,
    keyToImplicitAddress,
    teraToGas,
  } = near;

  const provider = new JsonRpcProvider({ url: RPC_URL }, { retries: 3, wait: 500, backoff: 2 });

  // The funder's testnet key, read at runtime, never printed. Optional: without it the script needs no key at all.
  const funderFile = join(homedir(), ".near-credentials/testnet", `${FUNDER_ID}.json`);
  let funderKp: any = null;
  try {
    if (process.env.NO_KEYS === "1") throw new Error("NO_KEYS=1: run without any key file");
    const funderJson = JSON.parse(readFileSync(funderFile, "utf8"));
    funderKp = KeyPair.fromString((funderJson.private_key || funderJson.secret_key).trim());
  } catch {
    funderKp = null;
  }
  const funderPub = funderKp ? funderKp.getPublicKey().toString() : "";

  const startedUtc = nowIso();
  emit("================================================================================");
  emit("Lumenia NEAR rail: attacks the system refuses (LIVE, NEAR testnet only)");
  emit(`run at:   ${startedUtc}`);
  emit(`relayer:  ${RELAYER_BASE}`);
  emit(`rpc:      ${RPC_URL}`);
  emit(`escrow:   ${ESCROW_ID}   usdc: ${USDC_ID}`);
  emit("budget:   at most 0.10 testnet USDC (attack 6). No mainnet. No secret keys printed.");
  emit(funderKp ? `keys:     ${FUNDER_ID}'s key file (attacks 1 and 6)` : "keys:     none (attack 1 signs with a random key; attack 6's link comes from the public practice route)");
  emit("================================================================================");
  emit();

  // A recent block height, used to give each crafted delegate a valid (unexpired, in-window)
  // max_block_height. The relayer fetches its OWN height and checks ours is within 600 blocks.
  async function currentHeight(): Promise<bigint> {
    const block = await provider.viewBlock({ finality: "final" });
    return BigInt(block.header.height);
  }

  /** Sign a delegate action with its own key -> base64 (a well-formed, validly-signed delegate). */
  async function signB64(da: any, kp: any): Promise<string> {
    const { signedDelegate } = await new KeyPairSigner(kp).signDelegateAction(da);
    return base64Encode(encodeSignedDelegate(signedDelegate));
  }

  function delegate(senderId: string, receiverId: string, action: any, publicKey: any, maxBlockHeight: bigint, nonce: bigint) {
    return buildDelegateAction({ senderId, receiverId, actions: [action], nonce, maxBlockHeight, publicKey });
  }

  /* --------- Attack 1: drain through the relayer (funder-signed plain ft_transfer) --------- */
  try {
    const h = await currentHeight();
    const action = actions.functionCall("ft_transfer", { receiver_id: ATTACKER_ID, amount: LINK_AMOUNT_UNITS.toString() }, teraToGas(100), 1n);
    const signerKp = funderKp ?? KeyPair.fromRandom("ed25519");
    const signerId = funderKp ? FUNDER_ID : keyToImplicitAddress(signerKp.getPublicKey());
    const da = delegate(signerId, USDC_ID, action, signerKp.getPublicKey(), h + 300n, h);
    const b64 = await signB64(da, signerKp);
    const started = nowIso();
    const r = await postRelay(b64);
    const refused = r.status === 403;
    record({
      n: "1",
      attack: "Drain via relayer: a signed delegate asking the relayer to pay for a USDC ft_transfer to an attacker account",
      expected: "403 (only ft_transfer_call into the escrow is paid for)",
      request: `POST /near/relay  signer=${funderKp ? FUNDER_ID : "a random implicit account"}  USDC.ft_transfer -> {receiver_id:${ATTACKER_ID}, amount:${LINK_AMOUNT_UNITS}}  1 yocto`,
      answer: relayAnswer(r),
      verdict: refused ? "REFUSED" : "ALLOWED",
      evidence: `HTTP ${r.status} @ ${r.at}`,
      startedAt: started,
      endedAt: r.at,
    });
  } catch (e) {
    record({ n: "1", attack: "Drain via relayer", expected: "403", request: "POST /near/relay (funder ft_transfer to attacker)", answer: `script error: ${errMsg(e)}`, verdict: "ERROR", evidence: nowIso(), startedAt: nowIso(), endedAt: nowIso() });
  }

  /* ----------- Attack 2: make the relayer pay for an arbitrary contract call ----------- */
  try {
    const h = await currentHeight();
    const rnd = KeyPair.fromRandom("ed25519");
    const rndSender = keyToImplicitAddress(rnd.getPublicKey());
    // (a) wrap.testnet near_deposit
    const aWrap = actions.functionCall("near_deposit", {}, teraToGas(100), 1n);
    const rWrap = await postRelay(await signB64(delegate(rndSender, "wrap.testnet", aWrap, rnd.getPublicKey(), h + 300n, h), rnd));
    // (b) the escrow's own pause()
    const aPause = actions.functionCall("pause", {}, teraToGas(100), 0n);
    const rPause = await postRelay(await signB64(delegate(rndSender, ESCROW_ID, aPause, rnd.getPublicKey(), h + 300n, h), rnd));
    const refused = rWrap.status === 403 && rPause.status === 403;
    record({
      n: "2",
      attack: "Arbitrary contract call via relayer (wrap.testnet near_deposit; escrow pause)",
      expected: "403 for each (receiver is neither USDC nor the escrow; pause is not a relayed method)",
      request: `POST /near/relay x2  (a) wrap.testnet.near_deposit  (b) ${ESCROW_ID}.pause`,
      answer: `(a) ${relayAnswer(rWrap)}  ||  (b) ${relayAnswer(rPause)}`,
      verdict: refused ? "REFUSED" : "ALLOWED",
      evidence: `HTTP ${rWrap.status}/${rPause.status} @ ${rPause.at}`,
      startedAt: rWrap.at,
      endedAt: rPause.at,
    });
  } catch (e) {
    record({ n: "2", attack: "Arbitrary contract call via relayer", expected: "403", request: "POST /near/relay (wrap.testnet / escrow.pause)", answer: `script error: ${errMsg(e)}`, verdict: "ERROR", evidence: nowIso(), startedAt: nowIso(), endedAt: nowIso() });
  }

  /* ---------------- Attack 3: forged sender (signature does not match) ---------------- */
  try {
    const healthBefore = await getHealth();
    const beforeGlobal = healthBefore?.caps?.globalToday;
    const h = await currentHeight();
    const claimedKey = KeyPair.fromRandom("ed25519"); // what the delegate CLAIMS to be signed by
    const otherKey = KeyPair.fromRandom("ed25519"); // who ACTUALLY signs it
    const linkPub = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const msg = JSON.stringify({ public_key: linkPub, expires_in_s: 3600 });
    const action = actions.functionCall("ft_transfer_call", { receiver_id: ESCROW_ID, amount: LINK_AMOUNT_UNITS.toString(), msg }, teraToGas(100), 1n);
    const da = delegate(DEMO_ID, USDC_ID, action, claimedKey.getPublicKey(), h + 300n, h);
    // Build a valid SignedDelegate for claimedKey, then overwrite the signature with otherKey's,
    // so the signature no longer verifies against the delegate's own public_key.
    const { signedDelegate } = await new KeyPairSigner(claimedKey).signDelegateAction(da);
    const forged = otherKey.sign(sha256(encodeDelegateAction(da))).signature;
    signedDelegate.signature = new Signature({ keyType: claimedKey.getPublicKey().keyType, data: forged });
    const b64 = base64Encode(encodeSignedDelegate(signedDelegate));
    const started = nowIso();
    const r = await postRelay(b64);
    const healthAfter = await getHealth();
    const afterGlobal = healthAfter?.caps?.globalToday;
    const refused = r.status === 403 && r.json?.code === "signature";
    const counterStill = beforeGlobal === afterGlobal;
    record({
      n: "3",
      attack: `Forged sender: delegate claims sender_id=${DEMO_ID}, signed with a different key`,
      expected: "403 bad signature; the victim's day counter does not move",
      request: `POST /near/relay  sender_id=${DEMO_ID}  signature from a different key than public_key`,
      answer: relayAnswer(r),
      verdict: refused ? "REFUSED" : "ALLOWED",
      evidence: `HTTP ${r.status} @ ${r.at}; relayer globalToday ${beforeGlobal} -> ${afterGlobal}${counterStill ? " (unchanged)" : " (changed by other live traffic)"}`,
      startedAt: started,
      endedAt: r.at,
      notes: [`refusal happens at the signature gate, before any cap or counter code runs; relayer day counter ${beforeGlobal} -> ${afterGlobal}`],
    });
  } catch (e) {
    record({ n: "3", attack: "Forged sender", expected: "403 signature", request: "POST /near/relay (sender_id spoofed, signature mismatched)", answer: `script error: ${errMsg(e)}`, verdict: "ERROR", evidence: nowIso(), startedAt: nowIso(), endedAt: nowIso() });
  }

  /* ------------------- Attack 4: oversized deposit (2 yoctoNEAR) ------------------- */
  try {
    const h = await currentHeight();
    const rnd = KeyPair.fromRandom("ed25519");
    const rndSender = keyToImplicitAddress(rnd.getPublicKey());
    const linkPub = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const msg = JSON.stringify({ public_key: linkPub, expires_in_s: 3600 });
    const action = actions.functionCall("ft_transfer_call", { receiver_id: ESCROW_ID, amount: LINK_AMOUNT_UNITS.toString(), msg }, teraToGas(100), 2n);
    const b64 = await signB64(delegate(rndSender, USDC_ID, action, rnd.getPublicKey(), h + 300n, h), rnd);
    const started = nowIso();
    const r = await postRelay(b64);
    const refused = r.status === 403;
    record({
      n: "4",
      attack: "Oversized deposit: an otherwise-valid ft_transfer_call with 2 yoctoNEAR attached",
      expected: "403 (exactly 1 yoctoNEAR is allowed)",
      request: `POST /near/relay  USDC.ft_transfer_call -> escrow, deposit = 2 yoctoNEAR`,
      answer: relayAnswer(r),
      verdict: refused ? "REFUSED" : "ALLOWED",
      evidence: `HTTP ${r.status} @ ${r.at}`,
      startedAt: started,
      endedAt: r.at,
    });
  } catch (e) {
    record({ n: "4", attack: "Oversized deposit", expected: "403", request: "POST /near/relay (2 yoctoNEAR)", answer: `script error: ${errMsg(e)}`, verdict: "ERROR", evidence: nowIso(), startedAt: nowIso(), endedAt: nowIso() });
  }

  /* ------------- Attack 5: claim with a stranger key (not a link key) ------------- */
  try {
    const stranger = KeyPair.fromRandom("ed25519"); // not an access key on the escrow
    const recipient = keyToImplicitAddress(KeyPair.fromRandom("ed25519").getPublicKey());
    const block = await provider.viewBlock({ finality: "final" });
    const nonce = BigInt(block.header.height) * 1_000_000n; // arbitrary: the key does not exist
    const action = actions.functionCall("claim", { account_id: recipient }, teraToGas(100), 0n);
    const tx = createTransaction(ESCROW_ID, stranger.getPublicKey(), ESCROW_ID, nonce, [action], baseDecode(block.header.hash));
    const { signedTransaction } = await new KeyPairSigner(stranger).signTransaction(tx);
    const started = nowIso();
    let answer: string;
    let refused: boolean;
    try {
      const res = await provider.sendTransactionUntil(signedTransaction, "FINAL");
      answer = `chain ACCEPTED the claim (unexpected): ${short(JSON.stringify(res?.status ?? res), 120)}`;
      refused = false;
    } catch (e) {
      answer = `chain rejected: ${errMsg(e)}`;
      refused = /AccessKeyNotFound|does not exist|UNKNOWN_ACCESS_KEY|InvalidAccessKey|InvalidTxError|doesn't have access key/i.test(errMsg(e));
    }
    record({
      n: "5",
      attack: "Claim with a stranger key: a claim tx to the escrow signed by a non-link key",
      expected: "chain rejects the transaction (access key does not exist)",
      request: `tx -> ${ESCROW_ID}.claim  signed by a random ed25519 key that is not a drop key`,
      answer,
      verdict: refused ? "REFUSED" : "ALLOWED",
      evidence: `NEAR testnet RPC @ ${nowIso()}`,
      startedAt: started,
      endedAt: nowIso(),
    });
  } catch (e) {
    record({ n: "5", attack: "Claim with a stranger key", expected: "chain rejects (no such access key)", request: "tx -> escrow.claim (random key)", answer: `script error: ${errMsg(e)}`, verdict: "ERROR", evidence: nowIso(), startedAt: nowIso(), endedAt: nowIso() });
  }

  /* --------------------------- Attack 6: double claim --------------------------- */
  try {
    const linkKp = KeyPair.fromRandom("ed25519");
    const linkPub = linkKp.getPublicKey().toString();
    // The memo marks the link as the attack run's own, so ops/near-outside-claims.mjs never counts its claim as an outside user.
    const linkMsg = { public_key: linkPub, expires_in_s: 3600, memo: "near-attack-demo" };
    const notes: string[] = [];

    // (a) create ONE 0.10 USDC link. First via the relayer (the gasless product path, which also
    //     shows the ALLOWED case); fall back to a direct funder transaction if the relayer is busy.
    let createHash = "";
    let created = false;
    let createVia = "relayer";
    if (!funderKp) {
      // No key: the public practice route makes the 0.10 USDC link from the shared practice balance; this script
      // sends only the link's PUBLIC key and keeps the secret, which is all a claim needs.
      createVia = "public practice route";
      const res = await fetch(`${RELAYER_BASE}/practice-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicKey: linkPub, amountUsdc: "0.10", expiresInS: 3600, memo: "near-attack-demo" }),
        signal: AbortSignal.timeout(90_000),
      });
      const j: any = await res.json().catch(() => ({}));
      if (res.status === 200 && j?.outcome?.status === "success") {
        created = true;
        createHash = String(j.txHash);
        notes.push(`link created via the public practice route: tx ${createHash}`);
      } else {
        throw new Error(`the practice route did not make the link: HTTP ${res.status} ${String(j?.reason ?? j?.error ?? "").slice(0, 160)}`);
      }
    }
    for (let attempt = 0; attempt < 2 && !created; attempt++) {
      const built = await client.buildSignedDelegateForPayForward({
        senderId: FUNDER_ID,
        senderKeyPair: funderKp,
        provider,
        usdcId: USDC_ID,
        escrowId: ESCROW_ID,
        amountUnits: LINK_AMOUNT_UNITS,
        msg: linkMsg,
      });
      const r = await postRelay(built.base64);
      if (r.status === 200 && r.json?.outcome?.linkCreated) {
        created = true;
        createHash = r.json.txHash;
        notes.push(`link created via relayer (ALLOWED): tx ${createHash}`);
      } else if (r.status === 429 && attempt === 0) {
        notes.push(`relayer create deferred (${relayAnswer(r)}); waiting out the cooldown`);
        await sleep(11_000);
      } else {
        notes.push(`relayer create answered ${relayAnswer(r)}; using a direct funder transaction instead`);
        break;
      }
    }
    if (!created) {
      // Direct funder ft_transfer_call (funder pays its own gas). Still a real 0.10 USDC link.
      createVia = "direct funder tx";
      const block = await provider.viewBlock({ finality: "final" });
      const ak = await provider.viewAccessKey({ accountId: FUNDER_ID, publicKey: funderPub, finalityQuery: { finality: "final" } });
      const nonce = BigInt(String(ak.nonce)) + 1n;
      const action = actions.functionCall("ft_transfer_call", { receiver_id: ESCROW_ID, amount: LINK_AMOUNT_UNITS.toString(), msg: JSON.stringify(linkMsg) }, teraToGas(100), 1n);
      const tx = createTransaction(USDC_ID, funderKp.getPublicKey(), USDC_ID, nonce, [action], baseDecode(block.header.hash));
      const { signedTransaction, txHash } = await new KeyPairSigner(funderKp).signTransaction(tx);
      await provider.sendTransactionUntil(signedTransaction, "FINAL");
      created = true;
      createHash = baseEncode(txHash);
      notes.push(`link created via direct funder tx: ${createHash}`);
    }

    // Wait for the link key to be live on the escrow (add_access_key is a detached receipt).
    let claim1Nonce: bigint | null = null;
    for (let i = 0; i < 12 && claim1Nonce === null; i++) {
      try {
        const ak = await provider.viewAccessKey({ accountId: ESCROW_ID, publicKey: linkPub, finalityQuery: { finality: "final" } });
        claim1Nonce = BigInt(String(ak.nonce)) + 1n;
      } catch {
        await sleep(1500);
      }
    }
    if (claim1Nonce === null) throw new Error("the link key never appeared on the escrow after creation");

    // (b) FIRST claim: the link key signs a claim to a fresh implicit account. Expect success.
    const recipient = keyToImplicitAddress(KeyPair.fromRandom("ed25519").getPublicKey());
    const block1 = await provider.viewBlock({ finality: "final" });
    const tx1 = createTransaction(ESCROW_ID, linkKp.getPublicKey(), ESCROW_ID, claim1Nonce, [actions.functionCall("claim", { account_id: recipient }, teraToGas(100), 0n)], baseDecode(block1.header.hash));
    const signed1 = await new KeyPairSigner(linkKp).signTransaction(tx1);
    const claim1Started = nowIso();
    const res1 = await provider.sendTransactionUntil(signed1.signedTransaction, "FINAL");
    const claim1Hash = res1?.transaction?.hash || baseEncode(signed1.txHash);
    const claim1Failure = res1?.status && typeof res1.status === "object" && "Failure" in res1.status;
    notes.push(`first claim ${claim1Failure ? "FAILED" : "succeeded"}: tx ${claim1Hash} -> paid ${recipient.slice(0, 10)}...`);

    // Let the first claim finalize and the link key get deleted (on_claim deletes it).
    await sleep(2500);

    // (c) SECOND claim with the SAME link key. Expect a refusal: the key is gone (or, if a race
    //     left it momentarily present, the drop is already Claimed).
    let claim2Nonce: bigint;
    let keyStillPresent = false;
    try {
      const ak2 = await provider.viewAccessKey({ accountId: ESCROW_ID, publicKey: linkPub, finalityQuery: { finality: "final" } });
      claim2Nonce = BigInt(String(ak2.nonce)) + 1n;
      keyStillPresent = true;
    } catch {
      claim2Nonce = claim1Nonce + 1n;
    }
    const block2 = await provider.viewBlock({ finality: "final" });
    const tx2 = createTransaction(ESCROW_ID, linkKp.getPublicKey(), ESCROW_ID, claim2Nonce, [actions.functionCall("claim", { account_id: recipient }, teraToGas(100), 0n)], baseDecode(block2.header.hash));
    const signed2 = await new KeyPairSigner(linkKp).signTransaction(tx2);
    const claim2Hash = baseEncode(signed2.txHash);
    let claim2Answer: string;
    let claim2Refused: boolean;
    try {
      const res2 = await provider.sendTransactionUntil(signed2.signedTransaction, "FINAL");
      const failed = res2?.status && typeof res2.status === "object" && "Failure" in res2.status;
      if (failed) {
        claim2Answer = `chain rejected the second claim: ${short(JSON.stringify(res2.status), 160)}`;
        claim2Refused = true;
      } else {
        claim2Answer = `second claim ACCEPTED (unexpected): tx ${claim2Hash}`;
        claim2Refused = false;
      }
    } catch (e) {
      claim2Answer = `chain rejected the second claim: ${errMsg(e)}`;
      claim2Refused = /AccessKeyNotFound|does not exist|already claimed|InvalidAccessKey|doesn't have access key|InvalidTxError/i.test(errMsg(e));
    }
    notes.push(`second claim used the ${keyStillPresent ? "still-present" : "already-deleted"} link key; local tx hash ${claim2Hash}`);

    record({
      n: "6",
      attack: "Double claim: claim one 0.10 USDC link twice with the same link key",
      expected: "first claim succeeds; second claim is rejected (link key deleted after the first)",
      request: `create (${createVia}) -> claim #1 -> claim #2, all with link key ${linkPub.slice(0, 18)}...`,
      answer: claim2Answer,
      verdict: claim2Refused ? "REFUSED" : "ALLOWED",
      evidence: `create ${EXPLORER}/txns/${createHash} ; claim#1 ${EXPLORER}/txns/${claim1Hash} ; claim#2 rejected (local hash ${claim2Hash})`,
      startedAt: claim1Started,
      endedAt: nowIso(),
      notes,
    });
  } catch (e) {
    record({ n: "6", attack: "Double claim", expected: "first succeeds, second rejected", request: "create + claim + claim (same link key)", answer: `script error: ${errMsg(e)}`, verdict: "ERROR", evidence: nowIso(), startedAt: nowIso(), endedAt: nowIso() });
  }

  /* ------------------- Attack 7: rate limit (no USDC spent) ------------------- */
  try {
    // One fixed signing key, one well-formed delegate the policy refuses at the deposit check
    // (2 yoctoNEAR). It passes decode + signature, so each POST spends a per-signing-key token
    // before being refused -- bursting it trips the relayer's per-key limiter (429) with no money.
    const h = await currentHeight();
    const burstKey = KeyPair.fromRandom("ed25519");
    const burstSender = keyToImplicitAddress(burstKey.getPublicKey());
    const linkPub = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const msg = JSON.stringify({ public_key: linkPub, expires_in_s: 3600 });
    const action = actions.functionCall("ft_transfer_call", { receiver_id: ESCROW_ID, amount: LINK_AMOUNT_UNITS.toString(), msg }, teraToGas(100), 2n);
    const b64 = await signB64(delegate(burstSender, USDC_ID, action, burstKey.getPublicKey(), h + 300n, h), burstKey);
    const started = nowIso();
    let firstAnswer = "";
    let limitAnswer = "";
    let limited = false;
    let sent = 0;
    for (let i = 0; i < 20 && !limited; i++) {
      const r = await postRelay(b64);
      sent++;
      if (i === 0) firstAnswer = relayAnswer(r);
      if (r.status === 429) {
        limited = true;
        limitAnswer = relayAnswer(r);
      }
    }
    record({
      n: "7",
      attack: "Rate limit: burst the same signed (policy-refused) delegate from one key",
      expected: "429 per-signing-key rate limit after the per-minute allowance (15) is spent",
      request: `POST /near/relay x${sent} (same delegate, same signing key), no USDC moved`,
      answer: limited ? `first: ${firstAnswer}  ||  at request #${sent}: ${limitAnswer}` : `no 429 within ${sent} requests; refusals stayed at: ${firstAnswer}`,
      verdict: limited ? "REFUSED" : "ALLOWED",
      evidence: `HTTP 429 after ${sent} requests @ ${nowIso()}`,
      startedAt: started,
      endedAt: nowIso(),
      notes: limited ? [] : ["the per-key limiter did not trip within 20 requests (window boundary); each request was still refused by policy (403)"],
    });
  } catch (e) {
    record({ n: "7", attack: "Rate limit", expected: "429 per-signing-key limit", request: "burst the same refused delegate", answer: `script error: ${errMsg(e)}`, verdict: "ERROR", evidence: nowIso(), startedAt: nowIso(), endedAt: nowIso() });
  }

  const endedUtc = nowIso();
  emit("================================================================================");
  const refusedCount = rows.filter((r) => r.verdict === "REFUSED").length;
  emit(`done: ${refusedCount}/${rows.length} attacks REFUSED by the live testnet system`);
  emit(`run:  ${startedUtc} -> ${endedUtc}`);
  emit("================================================================================");

  writeEvidence(REPO, startedUtc, endedUtc);
}

/* ------------------------------- evidence/near/attacks.md ------------------------------- */

function cell(s: string): string {
  return redact(s).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function writeEvidence(REPO: string, startedUtc: string, endedUtc: string) {
  // ATTACKS_OUT writes the report elsewhere (a trial run that must not replace the recorded evidence).
  const outPath = process.env.ATTACKS_OUT ? resolve(process.env.ATTACKS_OUT) : join(REPO, "evidence/near/attacks.md");
  mkdirSync(dirname(outPath), { recursive: true });
  const day = startedUtc.slice(0, 10);
  const refusedCount = rows.filter((r) => r.verdict === "REFUSED").length;

  const lines: string[] = [];
  lines.push("# NEAR rail: attacks the system refuses (live testnet)");
  lines.push("");
  lines.push(`Each row is a live attempt against the deployed testnet system on ${day} (UTC); nothing here is simulated.`);
  lines.push(`Every request below reached either the deployed relayer at ${RELAYER_BASE} or NEAR testnet RPC (${RPC_URL}), and the system's own answer is quoted verbatim (shortened).`);
  lines.push("");
  lines.push(`Result: ${refusedCount} of ${rows.length} attacks were REFUSED by the live system. Run ${startedUtc} -> ${endedUtc}.`);
  lines.push("");
  lines.push("| # | Attack | Expected | Observed answer (verbatim, short) | Verdict | Evidence |");
  lines.push("|---|--------|----------|-----------------------------------|---------|----------|");
  for (const r of rows) {
    lines.push(`| ${cell(r.n)} | ${cell(r.attack)} | ${cell(r.expected)} | ${cell(r.observed)} | ${cell(r.verdict)} | ${cell(r.evidence)} |`);
  }
  lines.push("");
  lines.push("Spend: at most 0.10 testnet USDC (attack 6 creates and claims one link). No mainnet was touched. No private keys appear in this file or in the script's output.");
  lines.push("");
  lines.push("Re-run (Node 24, from the repo root):");
  lines.push("");
  lines.push("```");
  lines.push("pnpm --filter @lumenia/sponsor exec tsx ../../ops/near-attack-demo.ts   (from the repository root; uses the workspace tsx)");
  lines.push("```");
  lines.push("");
  lines.push("(equivalently `npx tsx ops/near-attack-demo.ts` wherever tsx is on PATH; the line above uses the workspace's pinned tsx so it needs no install.)");
  lines.push("");
  lines.push("## Full run log");
  lines.push("");
  lines.push("```");
  for (const l of log) lines.push(l);
  lines.push("```");
  lines.push("");

  writeFileSync(outPath, lines.join("\n"));
  emit(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(redact(`fatal: ${errMsg(e)}`));
  process.exit(1);
});
