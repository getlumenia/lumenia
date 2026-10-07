/**
 * Send-pipeline self-test: src/background/send.ts (runSend) driven with fake dependencies, the way
 * the router drives it, and a FAKE createLink that behaves like the real one around its two
 * moments that matter: the `onPrepared` hook (signed, not yet posted) and the POST.
 *
 *   [a] the order of everything, and the success path
 *   [b] what each kind of failure AFTER the hook means for the money (failed vs uncertain)
 *   [c] failures BEFORE anything was kept: named, and nothing written, nothing sealed
 *   [d] a hook that cannot keep the link: nothing is posted
 *   [e] every gate that can be known before signing, refused before the key is even requested
 *   [f] the key and the balance
 *   [g] what createLink is handed
 *   [h] a worker that dies mid-send, and the settle pass that finishes the job without sending again
 *   [i] pilot.ts: the cached real-money answer, and canSendRealMoney
 *   [j] nothing secret ever reached storage
 *
 * The real createV2Link is exercised end to end, offline, in url.selftest.ts.
 *
 * RUN: pnpm --filter @lumenia/extension test:send   (offline, no keys, no network)
 */
import { Keypair } from "@stellar/stellar-sdk";
import type { NetworkConfig, PreparedDeposit, Signer, V2Link } from "../src/core";
import type { SendDeps, SendRequest } from "../src/background/send";
import type { BalanceInfo, LinkRecord, NetId, PilotInfo, Settings } from "../src/lib/types";
import { installChrome } from "./chrome-fake";
import { hexId, installBuildEnv, jsonResponse, ok, outcome, run, same, section, until } from "./_harness";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
/** How long the sponsor takes to answer the POST, so the answer is stamped later than the hook. */
const POST_MS = 4_000;
const ARROW = "\u2192"; // lumendrop.ts writes "/v2-deposit -> 403: ..." with this arrow
const HASH = "ab".repeat(32);
const WEB = "https://getlumenia.com";
const KP = Keypair.random();
const PUB = KP.publicKey();
const PASSWORD = "correct horse battery";

type CreateOpts = Parameters<SendDeps["createLink"]>[0];

type Behaviour =
  /** the POST is answered 200 */
  | { kind: "ok"; hash?: string }
  /** createLink fails before it calls the hook: nothing was signed and kept */
  | { kind: "before-hook"; error: unknown }
  /** the hook ran, the POST went out, and then it fails the way the real one would */
  | { kind: "after-post"; error: unknown }
  /** the hook ran, the POST went out, and the answer never comes back (the worker dies) */
  | { kind: "never-resolves" };

interface Cfg {
  settings?: Partial<Settings>;
  account?: { pubkey: string; phase: 1 | 2 } | null;
  pilot?: Partial<PilotInfo> | Error;
  balance?: BalanceInfo;
  signerError?: Error;
  create?: Behaviour;
  sealError?: Error;
  putError?: (r: LinkRecord, nth: number) => Error | null;
  /** the escrow's answer when runSend has to read it (an answer without a transaction hash) */
  landed?: boolean | "unknown" | Error;
  /** records already stored before this send (an earlier send that is not settled, say) */
  existing?: LinkRecord[];
}

const OK_REQ: SendRequest = { amount: "2.50", from: "Ayse" };
const MAIN: Cfg = { settings: { net: "public", mainnetAck: true }, account: { pubkey: PUB, phase: 2 } };

/** The JSON of every record any rig stored, for the sweep at the end. */
const everyPut: string[] = [];
const everySealedLinks: string[] = [];

async function main() {
  installBuildEnv();
  const fake = installChrome();
  const storage = await import("../src/lib/storage");
  storage.useAreas(fake.local, fake.session);
  const core = await import("../src/core");
  const config = await import("../src/config");
  const { runSend } = await import("../src/background/send");
  const { settleOnce } = await import("../src/background/settle");
  const { ExtError, MESSAGES, NOTHING_MOVED } = await import("../src/lib/errors");
  const pilot = await import("../src/background/pilot");
  const { CLOCK_MARGIN_MS } = await import("../src/lib/links");

  // Offline by contract. Only section [i] installs a fake fetch of its own.
  const realFetch = globalThis.fetch;
  let strayFetches = 0;
  globalThis.fetch = (async () => {
    strayFetches++;
    throw new Error("the send self-test must not touch the network");
  }) as typeof fetch;

  const signerObj: Signer = core.localSignerFromSeed(KP.rawSecretKey());
  let idSeq = 1000;

  interface Rig {
    deps: SendDeps;
    log: string[];
    puts: LinkRecord[];
    store: Map<string, LinkRecord>;
    sealed: Map<string, string>;
    creates: CreateOpts[];
    prepared: PreparedDeposit[];
    beacons: { event: string; pubkey: string; net: NetworkConfig }[];
    balanceCalls: { pubkey: string; net: NetworkConfig }[];
    signerCalls: string[];
    clock: { now: number };
  }

  function makeRig(cfg: Cfg = {}): Rig {
    const clock = { now: T0 };
    const rig: Rig = {
      deps: null as unknown as SendDeps,
      log: [],
      puts: [],
      store: new Map((cfg.existing ?? []).map((r) => [r.linkHex, structuredClone(r)])),
      sealed: new Map(),
      creates: [],
      prepared: [],
      beacons: [],
      balanceCalls: [],
      signerCalls: [],
      clock,
    };
    const settings: Settings = { net: "testnet", autolockMin: 15, from: "", mainnetAck: false, consentAt: 1, ...cfg.settings };
    const account = cfg.account === undefined ? { pubkey: PUB, phase: 2 as const } : cfg.account;
    let putN = 0;

    const createLink: SendDeps["createLink"] = async (opts) => {
      rig.log.push("createLink");
      rig.creates.push(opts);
      const how: Behaviour = cfg.create ?? { kind: "ok" };
      if (how.kind === "before-hook") throw how.error;
      const linkHex = hexId(idSeq++);
      const link = core.v2LinkUrl({
        webOrigin: opts.webOrigin,
        linkHex,
        amount: opts.amount,
        from: opts.from,
        fragment: Keypair.random().secret(),
        passwordLocked: Boolean(opts.password),
        mainnet: opts.net?.isMainnet,
        src: opts.src,
        preview: opts.preview,
      });
      const p: PreparedDeposit = {
        link,
        linkHex,
        retrySafeAfter: clock.now + 120_000,
        innerHash: hexId(idSeq++),
        expiry: opts.expiry ?? Math.floor(clock.now / 1000) + 7 * 86400,
        group: false,
        amount: opts.amount,
      };
      rig.prepared.push(p);
      // Like the real one: a hook that throws stops the call here, before anything is posted.
      await opts.onPrepared?.(p);
      rig.log.push("post");
      clock.now += POST_MS;
      if (how.kind === "never-resolves") return new Promise<V2Link>(() => {});
      if (how.kind === "after-post") throw how.error;
      return { link, linkHex, hash: how.hash ?? HASH };
    };

    rig.deps = {
      now: () => clock.now,
      settings: async () => ({ ...settings }),
      account: async () => account,
      signer: async (pubkey) => {
        rig.log.push("signer");
        rig.signerCalls.push(pubkey);
        if (cfg.signerError) throw cfg.signerError;
        return signerObj;
      },
      pilot: async () => {
        rig.log.push("pilot");
        if (cfg.pilot instanceof Error) throw cfg.pilot;
        return { pilot: true, approved: true, state: "approved", used: 0, limit: 5, at: clock.now, ...cfg.pilot };
      },
      balance: async (pubkey, net) => {
        rig.log.push("balance");
        rig.balanceCalls.push({ pubkey, net });
        return cfg.balance ?? { usd: "100.0000000", missing: false };
      },
      netConfig: (id: NetId) => config.netConfig(id),
      createLink,
      landed: async () => {
        rig.log.push("landed");
        if (cfg.landed instanceof Error) throw cfg.landed;
        return cfg.landed ?? true;
      },
      records: async () => [...rig.store.values()].map((r) => structuredClone(r)),
      seal: async (linkHex, link) => {
        rig.log.push("seal");
        if (cfg.sealError) throw cfg.sealError;
        rig.sealed.set(linkHex, link);
        everySealedLinks.push(link);
      },
      putRecord: async (r) => {
        rig.log.push(`put:${r.phase}`);
        const err = cfg.putError?.(r, ++putN) ?? null;
        if (err) throw err;
        const copy = structuredClone(r);
        rig.puts.push(copy);
        rig.store.set(r.linkHex, copy);
        everyPut.push(JSON.stringify(r));
      },
      beacon: (event, pubkey, net) => {
        rig.log.push(`beacon:${event}`);
        rig.beacons.push({ event, pubkey, net });
      },
    };
    return rig;
  }

  const send = (rig: Rig, req: SendRequest = OK_REQ) => outcome(runSend(rig.deps, req));
  const codeOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r ? (r.error instanceof ExtError ? r.error.code : `non-ExtError: ${String(r.error)}`) : "returned");
  const messageOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r && r.error instanceof Error ? r.error.message : "");
  const relay = (status: number, body: string) => new Error(`/v2-deposit ${ARROW} ${status}: ${body}`);
  const untouched = (rig: Rig) => rig.creates.length === 0 && rig.puts.length === 0 && rig.sealed.size === 0 && rig.beacons.length === 0 && !rig.log.includes("signer") && !rig.log.includes("balance");

  /* ---------------------------------------- [a] ---------------------------------------- */
  section("a", "order, and the success path");
  const a = makeRig();
  const aRes = await send(a);
  const aOut = "value" in aRes ? aRes.value : null;
  ok(
    "the whole pipeline in order: key, balance, 'started', createLink, SEAL, SUBMITTED record, POST, confirmed record, 'created'",
    same(a.log, ["signer", "balance", "beacon:send_started", "createLink", "seal", "put:submitted", "post", "put:confirmed", "beacon:send_link_created"]),
    a.log.join(" > "),
  );
  ok("exactly one createLink call for one send", a.creates.length === 1);
  const p = a.prepared[0]!;
  ok("the link is sealed BEFORE the record is written, and both BEFORE the POST", a.log.indexOf("seal") < a.log.indexOf("put:submitted") && a.log.indexOf("put:submitted") < a.log.indexOf("post"));
  ok("  ...sealed under its own id, with the full link exactly as createLink built it (fragment included)", a.sealed.size === 1 && a.sealed.get(p.linkHex) === p.link && p.link.includes("#S"));
  const sub = a.puts[0]!;
  ok(
    "  ...the first record is the submitted one: phase, network, sender, amount, sender name, not locked, created now",
    sub.phase === "submitted" && sub.net === "testnet" && sub.sender === PUB && sub.amount === "2.50" && sub.from === "Ayse" && sub.locked === false && sub.createdAt === T0 && sub.v === 1,
  );
  ok("  ...with the deposit's own expiry, deadline and signed-transaction hash, and a first read due in a minute", sub.expiry === p.expiry && sub.retrySafeAfter === p.retrySafeAfter && sub.innerHash === p.innerHash && sub.nextCheckAt === T0 + MIN);
  ok("  ...and no status, hash or reason yet", sub.status === undefined && sub.hash === undefined && sub.failReason === undefined);
  const fin = a.puts[1]!;
  ok("success: the record becomes confirmed / pending with the sponsor's hash", fin.phase === "confirmed" && fin.status === "pending" && fin.hash === HASH && fin.failReason === undefined && fin.linkHex === sub.linkHex);
  ok("  ...stamped with the time of the ANSWER (not of the hook), the next read a minute after that", fin.lastCheckedAt === T0 + POST_MS && fin.nextCheckAt === T0 + POST_MS + MIN && fin.createdAt === T0);
  ok("the outcome carries the id, the full link and the final record", aOut !== null && aOut.linkHex === p.linkHex && aOut.link === p.link && same(aOut.record, fin));
  ok(
    "the beacons are send_started then send_link_created, for this account and this network's config",
    same(a.beacons.map((b) => b.event), ["send_started", "send_link_created"]) && a.beacons.every((b) => b.pubkey === PUB && b.net === config.netConfig("testnet")),
  );
  ok("  ...'started' is before createLink and 'created' is after the confirmed record", a.log.indexOf("beacon:send_started") < a.log.indexOf("createLink") && a.log.indexOf("put:confirmed") < a.log.indexOf("beacon:send_link_created"));
  ok("a practice-money send never asks the real-money sponsor anything (no pilot call)", !a.log.includes("pilot"));
  const noHash = makeRig({ create: { kind: "ok", hash: "" } });
  await send(noHash);
  ok("a deposit confirmed only by the escrow (no hash) is confirmed with no hash field at all", noHash.puts[1]!.phase === "confirmed" && !("hash" in noHash.puts[1]!));
  const main2 = makeRig(MAIN);
  const m2 = await send(main2, { amount: "5", from: "Ayse" });
  ok(
    "a real-money send asks the pilot once, first, then runs the same pipeline",
    codeOf(m2) === "returned" && same(main2.log, ["pilot", "signer", "balance", "beacon:send_started", "createLink", "seal", "put:submitted", "post", "put:confirmed", "beacon:send_link_created"]),
    main2.log.join(" > "),
  );
  ok("  ...as a public-network record", main2.puts[0]!.net === "public" && main2.creates[0]!.net === config.netConfig("public"));

  /* ---------------------------------------- [b] ---------------------------------------- */
  section("b", "failures AFTER the link was kept: failed only when provably nothing moved, otherwise uncertain");
  const HEX = hexId(7);
  const URL_ = `${WEB}/v2/c/${HEX}?src=ext#${KP.secret()}&s=Ayse`;
  type Row = { name: string; err: unknown; code: string; phase: "failed" | "uncertain"; text?: RegExp; cfg?: Cfg };
  const rows: Row[] = [
    { name: "DepositUncertainError (a 202 not yet seen, or a dropped connection)", err: new core.DepositUncertainError(HEX, URL_, T0 + 120_000), code: "uncertain", phase: "uncertain" },
    { name: "403, not on the pilot allowlist", err: relay(403, '{"error":"this wallet is not on the pilot allowlist yet"}'), code: "not-approved", phase: "failed" },
    { name: "403, pilot limit reached", err: relay(403, '{"error":"pilot limit reached: 5 transactions used"}'), code: "slots-used", phase: "failed", text: /pilot limit reached: 5 transactions used/ },
    { name: "403, allowlist unavailable (fail-closed)", err: relay(403, '{"error":"pilot allowlist unavailable (fail-closed)"}'), code: "halted", phase: "failed" },
    { name: "403, allowlist unreadable (fail-closed)", err: relay(403, '{"error":"pilot allowlist unreadable (fail-closed): kv down"}'), code: "halted", phase: "failed" },
    { name: "403, counter unavailable (fail-closed)", err: relay(403, '{"error":"pilot counter unavailable (fail-closed): kv down"}'), code: "halted", phase: "failed" },
    { name: "403, some other sentence", err: relay(403, '{"error":"daily budget used"}'), code: "sponsor-refused", phase: "failed", text: /Daily budget used\. Nothing moved\./ },
    // The status alone proves nothing: only the sponsor's own JSON refusal was raised before the submit.
    { name: "403, empty body (not the sponsor's refusal)", err: relay(403, ""), code: "uncertain", phase: "uncertain" },
    { name: "403, a body that is not JSON (a platform page)", err: relay(403, "Forbidden"), code: "uncertain", phase: "uncertain" },
    { name: "429, rate limited", err: relay(429, '{"error":"rate limit"}'), code: "rate-limited", phase: "failed" },
    { name: "429 with a platform page, not the sponsor's JSON", err: relay(429, "<html>Too Many Requests</html>"), code: "uncertain", phase: "uncertain" },
    { name: "503, halted", err: relay(503, '{"error":"paused"}'), code: "halted", phase: "failed" },
    { name: "503 from the platform mid-run (Workers error 1102), not the sponsor's JSON", err: relay(503, "<html>Error 1102 Worker exceeded resource limits</html>"), code: "uncertain", phase: "uncertain" },
    { name: "503 with JSON that carries no error sentence", err: relay(503, '{"ok":false}'), code: "uncertain", phase: "uncertain" },
    { name: "400 on testnet, the shared daily cap (a stated refusal, before the submit)", err: relay(400, '{"error":"canary cap: daily escrow cap of 50 USDC reached; try again tomorrow"}'), code: "sponsor-refused", phase: "failed", text: /limit for today is reached\. Nothing moved/ },
    { name: "400 on real money, the shared daily cap", cfg: MAIN, err: relay(400, '{"error":"canary cap: daily escrow cap of 50 USDC reached; try again tomorrow"}'), code: "sponsor-refused", phase: "failed", text: /limit for today is reached\. Nothing moved/ },
    { name: "400 on real money, the per-link cap", cfg: MAIN, err: relay(400, '{"error":"canary cap: amount 5.5 USDC exceeds the per-drop cap of 5 USDC"}'), code: "over-cap", phase: "failed" },
    { name: "400 on real money, the caps cannot be read (fail-closed)", cfg: MAIN, err: relay(400, '{"error":"canary cap: daily cap counter unavailable (fail-closed): kv down"}'), code: "halted", phase: "failed" },
    { name: "400 on real money, any other stated sentence (only stated refusals survive the redaction)", cfg: MAIN, err: relay(400, '{"error":"xdr and senderPublicKey are required"}'), code: "sponsor-refused", phase: "failed", text: /Nothing moved/ },
    { name: "400 on real money, the redaction", cfg: MAIN, err: relay(400, '{"error":"request failed","ref":"1a2b3c4d"}'), code: "uncertain", phase: "uncertain" },
    { name: "400 on real money, not JSON", cfg: MAIN, err: relay(400, "Bad Request"), code: "uncertain", phase: "uncertain" },
    { name: "400, the mainnet redaction", err: relay(400, '{"error":"request failed"}'), code: "uncertain", phase: "uncertain" },
    { name: "400, the redaction with its reference", err: relay(400, '{"error":"request failed","ref":"1a2b3c4d"}'), code: "uncertain", phase: "uncertain" },
    { name: "400, a testnet reason (an RPC error after the submit was accepted reads the same)", err: relay(400, '{"error":"submit failed: tx_bad_seq"}'), code: "uncertain", phase: "uncertain" },
    { name: "401", err: relay(401, "{}"), code: "uncertain", phase: "uncertain" },
    { name: "404", err: relay(404, '{"error":"not found"}'), code: "uncertain", phase: "uncertain" },
    { name: "500", err: relay(500, "boom"), code: "uncertain", phase: "uncertain" },
    { name: "502", err: relay(502, "bad gateway"), code: "uncertain", phase: "uncertain" },
    { name: "504", err: relay(504, "timeout"), code: "uncertain", phase: "uncertain" },
    // One read at the bare deadline is a hint, not proof (a clock or a node can lag): the settle loop
    // decides with a margin and a second read.
    { name: "202 and the escrow was still empty at the deadline ('not submitted')", err: new Error(`/v2-deposit ${ARROW} not submitted: {"hash":"${HASH}","confirmed":false}`), code: "uncertain", phase: "uncertain" },
    { name: "the connection failed and, at the deadline, the escrow is empty", err: new Error("couldn't reach the sponsor"), code: "uncertain", phase: "uncertain" },
    { name: "a 403 from the WRONG route (/v2-reclaim) is not a deposit refusal", err: new Error(`/v2-reclaim ${ARROW} 403: {"error":"this wallet is not on the pilot allowlist yet"}`), code: "uncertain", phase: "uncertain" },
    { name: "a raw network error after the hook (not the proven kind above)", err: new TypeError("Failed to fetch"), code: "uncertain", phase: "uncertain" },
    { name: "a 200 whose body was not JSON", err: new SyntaxError("Unexpected token < in JSON"), code: "uncertain", phase: "uncertain" },
    { name: "something that is not even an Error", err: "kaboom", code: "uncertain", phase: "uncertain" },
  ];
  for (const row of rows) {
    const rig = makeRig({ ...row.cfg, create: { kind: "after-post", error: row.err } });
    const res = await send(rig);
    const rec = [...rig.store.values()][0];
    const verdict = row.phase === "uncertain"
      ? rec?.phase === "uncertain" && typeof rec.lastError === "string" && rec.failReason === undefined && rec.nextCheckAt === T0 + POST_MS + MIN
      : rec?.phase === "failed" && rec.failReason === messageOf(res) && !("nextCheckAt" in rec) && rec.recheckAt === rec.retrySafeAfter + 3_600_000;
    ok(
      `${row.name} -> ${row.code}, record ${row.phase}`,
      codeOf(res) === row.code && rig.puts.map((r) => r.phase).join() === `submitted,${row.phase}` && verdict && (!row.text || row.text.test(messageOf(res))),
      `${codeOf(res)} ${rig.puts.map((r) => r.phase).join(">")}`,
    );
    ok(
      "  ...exactly one createLink call (never retried), the link stayed sealed, no 'created' beacon",
      rig.creates.length === 1 && rig.sealed.size === 1 && same(rig.beacons.map((b) => b.event), ["send_started"]),
    );
    if (row.phase === "uncertain") {
      ok("  ...never written as failed, and the person is told to wait, in the words for it", !rig.puts.some((r) => r.phase === "failed") && messageOf(res) === MESSAGES.uncertain);
    }
  }
  const row = (prefix: string): Row => rows.find((r) => r.name.startsWith(prefix))!;
  const sentences: [Row, string][] = [
    [row("403, not on the pilot allowlist"), MESSAGES["not-approved"]],
    [row("429"), MESSAGES["rate-limited"]],
    [row("503, halted"), MESSAGES.halted],
  ];
  for (const [r, sentence] of sentences) {
    const rig = makeRig({ create: { kind: "after-post", error: r.err } });
    ok(`a ${r.code} refusal uses its own sentence`, messageOf(await send(rig)) === sentence);
  }
  const notSubmitted = makeRig({ create: { kind: "after-post", error: row("202 and the escrow").err } });
  ok("'not submitted' is told to wait, never 'nothing moved' (the settle loop decides)", messageOf(await send(notSubmitted)) === MESSAGES.uncertain && NOTHING_MOVED !== MESSAGES.uncertain);

  /* An answer with no transaction hash: the sponsor's 200 always has one, so the escrow decides. */
  const answers: [string, boolean | "unknown" | Error, string][] = [
    ["the escrow holds the drop", true, "returned"],
    ["the escrow is empty", false, "uncertain"],
    ["the escrow cannot be read", "unknown", "uncertain"],
    ["the read throws", new Error("rpc down"), "uncertain"],
  ];
  for (const [what, landed, code] of answers) {
    const rig = makeRig({ create: { kind: "ok", hash: "" }, landed });
    const res = await send(rig);
    const rec = [...rig.store.values()][0];
    ok(
      `a 2xx with no transaction hash, ${what}: ${code === "returned" ? "confirmed (no hash on file)" : "uncertain, never confirmed"}`,
      codeOf(res) === code && rig.log.includes("landed") && (code === "returned" ? rec?.phase === "confirmed" && rec.hash === undefined : rec?.phase === "uncertain"),
      `${codeOf(res)} ${rec?.phase}`,
    );
  }
  const hashed = makeRig();
  await send(hashed);
  ok("a 200 that names its transaction is confirmed without reading the escrow", !hashed.log.includes("landed") && [...hashed.store.values()][0]?.hash === HASH);
  ok("  ...and the record keeps the escrow it was made on", [...hashed.store.values()][0]?.contract === config.netConfig("testnet").contract);

  /* ---------------------------------------- [c] ---------------------------------------- */
  section("c", "failures BEFORE the link was kept: nothing can have moved, so nothing is written");
  const pre: [string, unknown, string][] = [
    ["a simulation that ran out of balance (#10)", new Error("deposit simulation failed: HostError: Error(Contract, #10)"), "not-enough-money"],
    ["a simulation with no trustline (#13)", new Error("deposit simulation failed: HostError: Error(Contract, #13)"), "account-not-found"],
    ["a simulation that says insufficient", new Error("deposit simulation failed: insufficient balance for transfer"), "not-enough-money"],
    ["a simulation that says trustline", new Error("deposit simulation failed: trustline entry is missing"), "account-not-found"],
    ["any other simulation failure", new Error("deposit simulation failed: HostError: Error(Auth, InvalidAction)"), "simulation-failed"],
    ["an unknown account from the RPC", new Error("Account not found: " + PUB), "account-not-found"],
    ["a network error", new TypeError("Failed to fetch"), "offline"],
    ["a 'NetworkError' message", new Error("NetworkError when attempting to fetch resource."), "offline"],
    ["an error nobody expected", new Error("weird"), "internal"],
    ["something that is not an Error", "boom", "internal"],
    ["an ExtError raised inside (kept as it is)", new ExtError("busy", MESSAGES.busy), "busy"],
  ];
  for (const [name, err, code] of pre) {
    const rig = makeRig({ create: { kind: "before-hook", error: err } });
    const res = await send(rig);
    ok(`${name} -> ${code}, no record written, nothing sealed`, codeOf(res) === code && rig.puts.length === 0 && rig.store.size === 0 && rig.sealed.size === 0 && !rig.log.includes("post"), codeOf(res));
  }
  const sim = makeRig({ create: { kind: "before-hook", error: new Error("deposit simulation failed: HostError: Error(Contract, #10)") } });
  const simRes = await send(sim);
  ok("the pre-submit refusal says the money has not moved", /hasn't moved|not enough|more than you have/i.test(messageOf(simRes)), messageOf(simRes));
  ok("  ...and no 'created' beacon was sent", !sim.beacons.some((b) => b.event === "send_link_created"));

  /* ---------------------------------------- [d] ---------------------------------------- */
  section("d", "a hook that cannot keep the link stops the send");
  const sealFail = makeRig({ sealError: new Error("the link could not be kept on this device") });
  const sf = await send(sealFail);
  ok("seal throws inside onPrepared: the fake createLink does not POST", !sealFail.log.includes("post") && sealFail.log.at(-1) === "seal", sealFail.log.join(" > "));
  ok("  ...runSend reports a failure (the money has not moved) and no record was written", codeOf(sf) === "internal" && /hasn't moved/.test(messageOf(sf)) && sealFail.puts.length === 0 && sealFail.store.size === 0);
  ok("  ...and the seal is the FIRST thing the hook does: no record was even attempted", !sealFail.log.some((l) => l.startsWith("put:")));
  const putFail = makeRig({ putError: (r) => (r.phase === "submitted" ? new Error("quota exceeded") : null) });
  const pf = await send(putFail);
  ok("the submitted record cannot be stored: nothing is posted, nothing is stored, a failure is reported", !putFail.log.includes("post") && putFail.store.size === 0 && codeOf(pf) === "internal");
  const lateFail = makeRig({ putError: (r) => (r.phase === "confirmed" ? new Error("disk full") : null) });
  const lf = await send(lateFail);
  ok(
    "the deposit was accepted but the confirming write fails: never 'failed' (uncertain, with the record kept for the settle loop)",
    codeOf(lf) === "uncertain" && lateFail.puts.map((r) => r.phase).join() === "submitted,uncertain" && lateFail.creates.length === 1,
    lateFail.puts.map((r) => r.phase).join(">"),
  );
  ok("  ...and no 'created' beacon", !lateFail.beacons.some((b) => b.event === "send_link_created"));

  /* ---------------------------------------- [e] ---------------------------------------- */
  section("e", "the gates: each refused before the key is requested and before createLink");
  interface Gate { name: string; cfg: Cfg; req?: SendRequest; code: string; pilotAsked?: boolean }
  const pw = (password: string): SendRequest => ({ ...OK_REQ, password });
  const gates: Gate[] = [
    { name: "no consent", cfg: { settings: { consentAt: null } }, code: "needs-consent" },
    { name: "no account", cfg: { account: null }, code: "no-account" },
    { name: "no consent and no account: consent is asked first", cfg: { settings: { consentAt: null }, account: null }, code: "needs-consent" },
    { name: "mainnet, an account with no password lock (phase 1)", cfg: { ...MAIN, account: { pubkey: PUB, phase: 1 } }, code: "needs-password", pilotAsked: false },
    { name: "mainnet, the real-money note not accepted", cfg: { ...MAIN, settings: { net: "public", mainnetAck: false } }, code: "not-approved", pilotAsked: false },
    { name: "mainnet, the account is not approved", cfg: { ...MAIN, pilot: { approved: false, state: "none" } }, code: "not-approved", pilotAsked: true },
    { name: "mainnet, all five sends used (used == limit)", cfg: { ...MAIN, pilot: { used: 5, limit: 5 } }, code: "slots-used", pilotAsked: true },
    { name: "mainnet, more than the limit used", cfg: { ...MAIN, pilot: { used: 9, limit: 5 } }, code: "slots-used", pilotAsked: true },
    { name: "mainnet, the pilot answer is unknown (never read as 'not approved')", cfg: { ...MAIN, pilot: new ExtError("pilot-unknown", MESSAGES["pilot-unknown"]) }, code: "pilot-unknown", pilotAsked: true },
    { name: "mainnet, amount 5.01", cfg: MAIN, req: { amount: "5.01", from: "A" }, code: "over-cap", pilotAsked: false },
    { name: "mainnet, amount 500", cfg: MAIN, req: { amount: "500", from: "A" }, code: "over-cap", pilotAsked: false },
    { name: "mainnet, a weak link password", cfg: MAIN, req: pw("12345"), code: "weak-link-password", pilotAsked: false },
    { name: "testnet, amount 100.01", cfg: {}, req: { amount: "100.01", from: "A" }, code: "bad-amount" },
    { name: "testnet, amount 1000000000 (ten digits)", cfg: {}, req: { amount: "1000000000", from: "A" }, code: "bad-amount" },
    { name: "amount 0", cfg: {}, req: { amount: "0", from: "A" }, code: "bad-amount" },
    { name: "amount 0.00", cfg: {}, req: { amount: "0.00", from: "A" }, code: "bad-amount" },
    { name: "amount 0.004 (cut, never rounded up to a cent)", cfg: {}, req: { amount: "0.004", from: "A" }, code: "bad-amount" },
    { name: "amount 0.009 (cut to 0.00, not rounded up to 0.01)", cfg: {}, req: { amount: "0.009", from: "A" }, code: "bad-amount" },
    { name: "an empty amount", cfg: {}, req: { amount: "", from: "A" }, code: "bad-amount" },
    { name: "an amount with no digits", cfg: {}, req: { amount: "abc", from: "A" }, code: "bad-amount" },
    { name: "a lone separator", cfg: {}, req: { amount: ".", from: "A" }, code: "bad-amount" },
    // Text the amount field can never show: the keystroke sanitizer would have read these as 5, 13, 10 and 1.23.
    { name: "a negative amount", cfg: {}, req: { amount: "-5", from: "A" }, code: "bad-amount" },
    { name: "an exponent", cfg: {}, req: { amount: "1e3", from: "A" }, code: "bad-amount" },
    { name: "a hex number", cfg: {}, req: { amount: "0x10", from: "A" }, code: "bad-amount" },
    { name: "a thousands separator", cfg: {}, req: { amount: "1,234.50", from: "A" }, code: "bad-amount" },
    { name: "two separators", cfg: {}, req: { amount: "1.2.3", from: "A" }, code: "bad-amount" },
    { name: "a link password of five digits", cfg: {}, req: pw("12345"), code: "weak-link-password" },
    { name: "a link password of seven digits", cfg: {}, req: pw("1234567"), code: "weak-link-password" },
    { name: "a link password of one repeated character", cfg: {}, req: pw("aaaaaaaa"), code: "weak-link-password" },
  ];
  for (const g of gates) {
    const rig = makeRig(g.cfg);
    const res = await send(rig, g.req);
    const asked = rig.log.includes("pilot");
    ok(
      `${g.name} -> ${g.code}`,
      codeOf(res) === g.code && untouched(rig) && (g.pilotAsked === undefined || asked === g.pilotAsked),
      `${codeOf(res)} log=[${rig.log.join(",")}]`,
    );
  }

  const amounts: [string, NetId, string][] = [
    ["1,50", "testnet", "1.50"],
    ["2", "testnet", "2.00"],
    ["2.5", "testnet", "2.50"],
    ["0.01", "testnet", "0.01"],
    ["1.239", "testnet", "1.23"],
    ["00.50", "testnet", "0.50"],
    ["100", "testnet", "100.00"],
    ["100.00", "testnet", "100.00"],
    ["5", "public", "5.00"],
    ["5.00", "public", "5.00"],
    ["4,99", "public", "4.99"],
  ];
  for (const [typed, net, sent] of amounts) {
    const rig = makeRig(net === "public" ? MAIN : {});
    const res = await send(rig, { amount: typed, from: "A" });
    ok(`${net === "public" ? "real money" : "practice"}: ${JSON.stringify(typed)} is sent as ${sent}`, codeOf(res) === "returned" && rig.creates[0]?.amount === sent && rig.puts[0]?.amount === sent, rig.creates[0]?.amount ?? codeOf(res));
  }
  const okPw = makeRig();
  ok("a link password that passes the floor is accepted", codeOf(await send(okPw, pw(PASSWORD))) === "returned");

  /* An earlier send that is posted and not settled: a new one needs "send a new one anyway". */
  const earlier = (o: Partial<LinkRecord>): LinkRecord => ({
    v: 1,
    net: "testnet",
    linkHex: hexId(9000),
    sender: PUB,
    amount: "1.00",
    from: "",
    locked: false,
    createdAt: T0 - 60_000,
    expiry: Math.floor(T0 / 1000) + 7 * 86400,
    retrySafeAfter: T0 + 60_000,
    innerHash: hexId(9001),
    phase: "uncertain",
    ...o,
  });
  const openCases: [string, LinkRecord, boolean][] = [
    ["an uncertain send a minute ago", earlier({}), true],
    ["a send still being made (submitted)", earlier({ phase: "submitted" }), true],
    ["an uncertain send on the other network", earlier({ net: "public" }), false],
    ["an uncertain send seven hours ago", earlier({ createdAt: T0 - 7 * 3_600_000 }), false],
    ["a confirmed earlier send", earlier({ phase: "confirmed", status: "pending" }), false],
    ["a failed earlier send", earlier({ phase: "failed", failReason: "It did not go through." }), false],
  ];
  for (const [what, prior, blocks] of openCases) {
    const rig = makeRig({ existing: [prior] });
    const res = await send(rig);
    ok(
      `${what}: ${blocks ? "a new send is refused as open-send before the key or the balance is touched" : "a new send goes through"}`,
      blocks ? codeOf(res) === "open-send" && untouched(rig) : codeOf(res) === "returned",
      codeOf(res),
    );
  }
  const anyway = makeRig({ existing: [earlier({})] });
  ok("with 'send a new one anyway' the same send goes through", codeOf(await send(anyway, { ...OK_REQ, anyway: true })) === "returned" && anyway.creates.length === 1);

  /* ---------------------------------------- [f] ---------------------------------------- */
  section("f", "the key and the balance");
  const locked = makeRig({ signerError: new ExtError("locked", MESSAGES.locked) });
  const lk = await send(locked);
  ok("a locked key stops the send: locked, nothing written, createLink uncalled, no balance read, no beacon", codeOf(lk) === "locked" && locked.creates.length === 0 && locked.puts.length === 0 && !locked.log.includes("balance") && locked.beacons.length === 0);
  ok("  ...the key was requested for the account that sends", same(locked.signerCalls, [PUB]));
  const miss = makeRig({ balance: { usd: null, missing: true } });
  ok("an account that does not exist on the network: account-not-found, createLink uncalled", codeOf(await send(miss)) === "account-not-found" && untouchedByBalance(miss));
  function untouchedByBalance(r: Rig): boolean {
    return r.creates.length === 0 && r.puts.length === 0 && r.sealed.size === 0 && r.beacons.length === 0;
  }
  const poor = makeRig({ balance: { usd: "0.5000000", missing: false } });
  ok("a balance of 0.50 with 1.00 to send: not-enough-money, before anything is signed", codeOf(await send(poor, { amount: "1", from: "A" })) === "not-enough-money" && untouchedByBalance(poor));
  const edges: [string, string, boolean][] = [
    ["1.0000000", "1.00", true],
    ["0.9999999", "1.00", false],
    ["1.0100000", "1.01", true],
    ["1.0099999", "1.01", false],
    ["100.0000000", "100", true],
    ["0.0000000", "0.01", false],
  ];
  for (const [bal, amt, allowed] of edges) {
    const rig = makeRig({ balance: { usd: bal, missing: false } });
    const res = await send(rig, { amount: amt, from: "A" });
    ok(`balance ${bal} with ${amt} to send: ${allowed ? "allowed" : "refused (never more than the account holds)"}`, allowed ? codeOf(res) === "returned" : codeOf(res) === "not-enough-money");
  }
  const unknownBal = makeRig({ balance: { usd: null, missing: false } });
  ok("a balance that could not be read does not block the send (the escrow decides)", codeOf(await send(unknownBal)) === "returned" && unknownBal.creates.length === 1);
  ok("the balance is read for the sending account on the chosen network's config", a.balanceCalls.length === 1 && a.balanceCalls[0]!.pubkey === PUB && a.balanceCalls[0]!.net === config.netConfig("testnet") && main2.balanceCalls[0]!.net === config.netConfig("public"));

  /* ---------------------------------------- [g] ---------------------------------------- */
  section("g", "what createLink is handed");
  const o = a.creates[0]!;
  ok("net is the very config object of the chosen network, and the sponsor is that network's", o.net === config.netConfig("testnet") && o.sponsorUrl === config.netConfig("testnet").sponsorUrl);
  ok("  ...for real money, the public network's", main2.creates[0]!.net === config.netConfig("public") && main2.creates[0]!.sponsorUrl === config.netConfig("public").sponsorUrl && main2.creates[0]!.net!.isMainnet);
  ok("src is 'ext' and the web origin is https://getlumenia.com", o.src === "ext" && o.webOrigin === WEB);
  ok("expiry is now + seven days, in unix seconds", o.expiry === Math.floor(T0 / 1000) + 7 * 24 * 3600, String(o.expiry));
  ok("the signer is the one the key dependency returned, and the amount is the parsed one", o.signer === signerObj && o.amount === "2.50");
  ok("no password when none was given; a hook is passed; the link is not marked seeded", o.password === undefined && typeof o.onPrepared === "function" && o.seeded === undefined);
  const withPw = makeRig();
  await send(withPw, pw(PASSWORD));
  ok("a password is passed only when given, and the record says the link is locked", withPw.creates[0]!.password === PASSWORD && withPw.puts[0]!.locked === true && withPw.puts[1]!.locked === true);
  ok("  ...the password is in no stored record, no sealed link and no log line", ![...withPw.store.values()].some((r) => JSON.stringify(r).includes(PASSWORD)) && ![...withPw.sealed.values()].some((l) => l.includes(PASSWORD)) && !withPw.log.some((l) => l.includes(PASSWORD)));
  const emptyPw = makeRig();
  await send(emptyPw, { ...OK_REQ, password: "" });
  ok("an empty password string means no password", emptyPw.creates[0]!.password === undefined && emptyPw.puts[0]!.locked === false);
  const fromRows: [string, string, string, string][] = [
    ["left empty", "", "Someone", ""],
    ["only spaces", "   ", "Someone", ""],
    ["with spaces around it", "  Ayse  ", "Ayse", "Ayse"],
    ["sixty characters long", "x".repeat(60), "x".repeat(40), "x".repeat(40)],
  ];
  for (const [what, typed, linkName, recordName] of fromRows) {
    const rig = makeRig();
    await send(rig, { amount: "1", from: typed });
    ok(`a sender name ${what}: createLink gets ${linkName.length > 10 ? "the first forty characters" : JSON.stringify(linkName)}, the record keeps ${recordName ? "the trimmed name" : "nothing"}`, rig.creates[0]!.from === linkName && rig.puts[0]!.from === recordName);
  }
  const mainPw = makeRig(MAIN);
  await send(mainPw, pw(PASSWORD));
  ok("real money with a link password: allowed, and the record is public-network and locked", mainPw.puts[0]!.net === "public" && mainPw.puts[0]!.locked === true);

  /* ---------------------------------------- [h] ---------------------------------------- */
  section("h", "the worker dies mid-send: the settle pass finishes it, and nothing is sent again");
  async function killedMidSend() {
    const rig = makeRig({ create: { kind: "never-resolves" } });
    void runSend(rig.deps, OK_REQ); // never awaited: this worker is gone
    await until(() => rig.log.includes("post"), "the hook to finish and the POST to go out");
    const stored = [...rig.store.values()][0]!;
    return { rig, stored };
  }
  function settleDeps(rig: Rig, at: number, answer: boolean | "unknown", inFlight = false) {
    return {
      now: () => at,
      records: async () => [...rig.store.values()].map((r) => structuredClone(r)),
      get: async (linkHex: string) => (rig.store.has(linkHex) ? structuredClone(rig.store.get(linkHex)!) : null),
      put: async (r: LinkRecord) => void rig.store.set(r.linkHex, structuredClone(r)),
      netConfig: (id: NetId) => config.netConfig(id),
      landed: async () => answer,
      dropStatus: async (): Promise<"pending" | "settled" | "unknown"> => {
        throw new Error("a submitted record is not read as a drop");
      },
      inFlight: () => inFlight,
    };
  }
  const k1 = await killedMidSend();
  ok("at the moment of the kill the only trace is a submitted record and a sealed link", k1.stored.phase === "submitted" && k1.rig.sealed.size === 1 && k1.rig.store.size === 1);
  await settleOnce(settleDeps(k1.rig, T0 + 90_000, true));
  ok("a new worker's settle pass with 'it landed': the record is confirmed / pending", [...k1.rig.store.values()][0]!.phase === "confirmed" && [...k1.rig.store.values()][0]!.status === "pending");
  ok("  ...and createLink was called exactly once overall, with exactly one POST", k1.rig.creates.length === 1 && k1.rig.log.filter((l) => l === "post").length === 1);

  const k2 = await killedMidSend();
  const past = k2.stored.retrySafeAfter + CLOCK_MARGIN_MS + 1;
  await settleOnce(settleDeps(k2.rig, past, false), { force: true });
  ok("'not there' once past the deadline and the clock margin: still uncertain (one read could be a lagging node)", [...k2.rig.store.values()][0]!.phase === "uncertain");
  await settleOnce(settleDeps(k2.rig, past + MIN, false), { force: true });
  const f2 = [...k2.rig.store.values()][0]!;
  ok("'not there' a second time a minute later: failed, with a reason that says nothing moved", f2.phase === "failed" && /Nothing moved/.test(f2.failReason ?? ""));
  ok("  ...and still one createLink call, one POST: nothing was retried", k2.rig.creates.length === 1 && k2.rig.log.filter((l) => l === "post").length === 1);

  const k3 = await killedMidSend();
  await settleOnce(settleDeps(k3.rig, k3.stored.retrySafeAfter - 1, false));
  ok("'not there' a ms before the deadline: still open as uncertain (it may yet be included)", [...k3.rig.store.values()][0]!.phase === "uncertain");

  const k4 = await killedMidSend();
  await settleOnce(settleDeps(k4.rig, k4.stored.retrySafeAfter + 400 * 86_400_000, "unknown"));
  ok("an unreadable escrow a year later: still uncertain, never failed", [...k4.rig.store.values()][0]!.phase === "uncertain" && k4.rig.creates.length === 1);

  const k5 = await killedMidSend();
  const reads5 = { n: 0 };
  const d5 = settleDeps(k5.rig, T0 + 90_000, true, true);
  d5.landed = async () => (reads5.n++, true);
  await settleOnce(d5, { force: true });
  ok("while the send is still running in this worker, the settle pass leaves its record alone", reads5.n === 0 && [...k5.rig.store.values()][0]!.phase === "submitted");

  /* ---------------------------------------- [i] ---------------------------------------- */
  section("i", "pilot.ts: the cached answer to 'is this account approved for real money?'");
  const MAIN_URL = "https://lumenia-sponsor-mainnet.avakit.workers.dev";
  const asks: { url: string; init: RequestInit | undefined }[] = [];
  let reply: () => Response | Promise<Response> = () => jsonResponse(200, { pilot: true, approved: true, state: "approved", used: 2, limit: 5 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asks.push({ url: String(input), init });
    return reply();
  }) as typeof fetch;
  const fresh = async () => {
    await fake.session.clear();
    asks.length = 0;
    reply = () => jsonResponse(200, { pilot: true, approved: true, state: "approved", used: 2, limit: 5 });
  };

  await fresh();
  const first = await pilot.pilotStatus(PUB, { now: T0 });
  ok("the first ask goes to the MAINNET sponsor's /pilot-status with the public key, as a plain GET", asks.length === 1 && asks[0]!.url === `${MAIN_URL}/pilot-status?pubkey=${encodeURIComponent(PUB)}` && asks[0]!.init === undefined, asks[0]?.url);
  ok("  ...the answer is read field by field and stamped", same(first, { pilot: true, approved: true, state: "approved", used: 2, limit: 5, at: T0 }));
  ok("  ...and kept in the session under the account's own key", same(await fake.session.get(storage.K.pilot(PUB)), first) && same(await pilot.cachedPilot(PUB), first));
  await pilot.pilotStatus(PUB, { now: T0 + 59_999 });
  ok("a second ask a ms inside the minute is answered from the cache: no request", asks.length === 1);
  await pilot.pilotStatus(PUB, { now: T0 + 60_000 });
  ok("  ...at the minute it asks again", asks.length === 2);
  await fresh();
  await pilot.pilotStatus(PUB, { now: T0 });
  await pilot.pilotStatus(PUB, { now: T0 + 9_999, force: true });
  ok("a forced ask still waits ten seconds after the last one", asks.length === 1);
  await pilot.pilotStatus(PUB, { now: T0 + 10_000, force: true });
  ok("  ...and then goes through", asks.length === 2);

  await fresh();
  await pilot.pilotStatus(PUB, { now: T0 });
  reply = () => {
    throw new TypeError("fetch failed");
  };
  const stale = await pilot.pilotStatus(PUB, { now: T0 + 5 * MIN });
  ok("the ask fails (offline) with an old answer on file: the old answer is returned, not 'not approved'", stale.approved === true && stale.at === T0);
  await fresh();
  reply = () => {
    throw new TypeError("fetch failed");
  };
  ok("  ...with none on file: pilot-unknown, never 'not approved'", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 }))) === "pilot-unknown");
  // A 200 that is not the sponsor's answer (a captive portal, a proxy page) is "could not ask".
  await fresh();
  reply = () => new Response("<html>Sign in to this Wi-Fi</html>", { status: 200, headers: { "content-type": "text/html" } });
  ok("a 200 that is not JSON, nothing on file: pilot-unknown, never 'not approved'", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 }))) === "pilot-unknown");
  ok("  ...and nothing is cached from it", (await pilot.cachedPilot(PUB)) === null);
  await fresh();
  await pilot.pilotStatus(PUB, { now: T0 });
  reply = () => jsonResponse(200, { hello: "world" });
  ok("a 200 whose body has no approved field, with an answer on file: the old answer stands", (await pilot.pilotStatus(PUB, { now: T0 + 5 * MIN })).approved === true);
  await fresh();
  reply = () => jsonResponse(429, { error: "rate limit" });
  ok("a 429 with nothing on file: rate-limited", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 }))) === "rate-limited");
  await fresh();
  await pilot.pilotStatus(PUB, { now: T0 });
  reply = () => jsonResponse(429, { error: "rate limit" });
  ok("  ...with an old answer on file the old answer is returned", (await pilot.pilotStatus(PUB, { now: T0 + 5 * MIN })).at === T0);
  await fresh();
  reply = () => jsonResponse(500, { error: "boom" });
  ok("a 500 with nothing on file: pilot-unknown", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 }))) === "pilot-unknown");
  await fresh();
  await pilot.pilotStatus(PUB, { now: T0 });
  reply = () => jsonResponse(500, { error: "boom" });
  ok("  ...with an old answer on file the old answer is returned", (await pilot.pilotStatus(PUB, { now: T0 + 5 * MIN })).approved === true);
  await fresh();
  reply = () => jsonResponse(200, { pilot: false, approved: false });
  ok("a sponsor that is not running a pilot: not a pilot, not approved, state none, zeroes", same(await pilot.pilotStatus(PUB, { now: T0 }), { pilot: false, approved: false, state: "none", used: 0, limit: 0, at: T0 }));
  await fresh();
  reply = () => jsonResponse(200, { pilot: true, approved: true });
  ok("approved without a state reads as state approved", (await pilot.pilotStatus(PUB, { now: T0 })).state === "approved");
  await fresh();
  reply = () => jsonResponse(200, { pilot: true, approved: "yes", used: "3", limit: "abc" });
  ok("an answer whose approved is not a boolean is not an answer: pilot-unknown, and nothing cached", codeOf(await outcome(pilot.pilotStatus(PUB, { now: T0 }))) === "pilot-unknown" && (await pilot.cachedPilot(PUB)) === null);
  await fresh();
  reply = () => jsonResponse(200, { pilot: true, approved: false, used: "3", limit: "abc" });
  const loose = await pilot.pilotStatus(PUB, { now: T0 });
  ok("  ...the numbers of a real answer are read strictly: numbers only if numbers", loose.approved === false && loose.used === 3 && loose.limit === 0);

  const approvedP = (o: Partial<PilotInfo>): PilotInfo => ({ pilot: true, approved: true, state: "approved", used: 0, limit: 5, at: T0, ...o });
  ok("canSendRealMoney: approved with sends left", pilot.canSendRealMoney(approvedP({ used: 0 })) && pilot.canSendRealMoney(approvedP({ used: 4 })));
  ok("  ...not at the limit, not past it, not when unapproved", !pilot.canSendRealMoney(approvedP({ used: 5 })) && !pilot.canSendRealMoney(approvedP({ used: 6 })) && !pilot.canSendRealMoney(approvedP({ approved: false })));
  ok("  ...a limit the sponsor did not report (0) does not block: the sponsor still enforces its own", pilot.canSendRealMoney(approvedP({ limit: 0, used: 3 })));

  globalThis.fetch = (async () => {
    strayFetches++;
    throw new Error("the send self-test must not touch the network");
  }) as typeof fetch;

  /* ---------------------------------------- [j] ---------------------------------------- */
  section("j", "nothing secret ever reached storage");
  const sweep = everyPut.join("\n");
  ok(`${everyPut.length} stored records, across every scenario above, hold no '#', no URL, no /v2/c/ path and no S... key`, everyPut.length > 50 && !sweep.includes("#") && !sweep.includes("https://") && !sweep.includes("/v2/c/") && !/S[A-Z2-7]{55}/.test(sweep), `${everyPut.length} records`);
  ok("  ...and not the link password", !sweep.includes(PASSWORD));
  // The private fragment is the key, then the sender's name, then the lock marker when there is one
  // (apps/web/lib/lumendrop.ts v2LinkUrl), and nothing else.
  ok(
    "  ...while every sealed link does carry its fragment (the link is kept where it can be read back)",
    everySealedLinks.length > 50 && everySealedLinks.every((l) => /#S[A-Z2-7]{55}&s=[A-Za-z0-9%._~!*'()-]+(&p=1)?$/.test(l)),
    `${everySealedLinks.length} sealed`,
  );
  ok("the whole suite made no network request outside its own fake", strayFetches === 0, `${strayFetches} stray fetches`);

  globalThis.fetch = realFetch;
}

run("SEND", "the send pipeline (runSend, pilot gate, restart)", main);
