/**
 * URL-contract self-test: the link the extension hands a person, produced by the REAL createV2Link
 * exactly as the extension calls it (through runSend, on a network chosen by the settings), with only
 * the Soroban RPC and the sponsor's POST faked. For practice money and for real money:
 *
 *   - the link is the private one (D2, apps/web/lib/lumendrop.ts v2LinkUrl):
 *       https://getlumenia.com/v2/c/<linkHex>?[n=public&]src=ext#<key>&s=<name>[&p=1]
 *     with no amount anywhere in it, and the sender's name and the lock marker only after the '#'
 *   - `src=ext` is the last query parameter and appears once, whatever the sender's name contains
 *   - `n=public` is in the query if and only if the link is real money
 *   - the key (the S... secret, or the p1. seed of a password-locked link) is only ever after the '#',
 *     first there, never in the path or the query, and the password is nowhere at all
 *   - the name rides after the key exactly as typed, and cannot add a parameter however it is spelled
 *   - the POST goes to that network's sponsor at /v2-deposit, every RPC call goes to that network's RPC
 *     node, and the deposit invokes that network's escrow, signed for that network's passphrase
 *   - the website's own claim reader resolves the link to the same escrow the deposit went to
 *
 *   [a] preconditions: the fakes reach the code under test, the build environment is the shipped one,
 *       and every host the configs use is a host the manifests grant
 *   [b] one run per (network x plain / password-locked / hostile sender name)
 *   [c] the same pipeline when the sponsor's answer is not a plain 200 (202, a dropped connection, the
 *       403 / 429 / 503 / 400 refusals), on both networks: the real error text must still be read
 *       correctly, and every escrow question must go to the network that was named
 *   [d] the settle loop wired as the router wires it, with the real escrow readers: each record is read
 *       on its OWN network, from the RPC only, never from the sponsor
 *   [e] the patched globals are restored
 *
 * RUN: pnpm --filter @lumenia/extension test:url   (offline, no keys, no network)
 */
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import type { FeeBumpTransaction, Operation, Transaction, rpc as RpcNs, xdr as XdrNs } from "@stellar/stellar-sdk";
import type { SendDeps } from "../src/background/send";
import type { LinkRecord, NetId } from "../src/lib/types";
import { installChrome } from "./chrome-fake";
import { BUILD_ENV, hex, installBuildEnv, jsonResponse, ok, outcome, run, same, sdk, section, show, type Sdk } from "./_harness";

const WEB = "https://getlumenia.com";
const HASH = "ab".repeat(32);
const PASSWORD = "correct horse battery";
/** A sender name written to break a link: a second src, a network switch, a lock flag, a fragment, non-ASCII. */
const HOSTILE = "Ay\u015fe&n=public&src=web&p=1#S";

/** What the shipped config says, written out by hand so a drift in config.ts or the env cannot hide. */
const EXPECT = {
  testnet: {
    sponsor: "https://lumenia-sponsor.avakit.workers.dev",
    rpc: "https://soroban-testnet.stellar.org/",
    contract: "CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3",
    mainnet: false,
  },
  public: {
    sponsor: "https://lumenia-sponsor-mainnet.avakit.workers.dev",
    rpc: "https://mainnet.sorobanrpc.com/",
    contract: "CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4",
    mainnet: true,
  },
} as const;

type RpcServer = InstanceType<Sdk["rpc"]["Server"]>;
interface RpcCall {
  call: "getAccount" | "simulate";
  url: string;
  address?: string;
  fn?: string;
  contract?: string;
  args?: XdrNs.ScVal[];
}
interface Post {
  url: string;
  method?: string;
  headers?: unknown;
  body: string;
}

async function main() {
  installBuildEnv();
  const fake = installChrome();
  const storage = await import("../src/lib/storage");
  storage.useAreas(fake.local, fake.session);
  const S = sdk();
  const core = await import("../src/core");
  const config = await import("../src/config");
  const { runSend } = await import("../src/background/send");
  const { ExtError } = await import("../src/lib/errors");
  const claimPw = await import("../../web/lib/claim-password");
  const lumendrop = await import("../../web/lib/lumendrop");
  const linkFragment = await import("../../web/lib/link-fragment");
  const network = await import("../../web/lib/network");

  /* ---------------------------------------- [a] ---------------------------------------- */
  section("a", "preconditions");
  const req = createRequire(import.meta.url);
  const webReq = createRequire(new URL("../../web/lib/lumendrop.ts", import.meta.url));
  const here = realpathSync(req.resolve("@stellar/stellar-sdk"));
  const there = realpathSync(webReq.resolve("@stellar/stellar-sdk"));
  ok("the Stellar SDK this test patches is the very file apps/web/lib loads", here === there, here.split("/node_modules/").pop());
  ok("  ...and it is already in the module cache, loaded by the web modules (so the patches below are what createV2Link calls)", Object.prototype.hasOwnProperty.call(req.cache, req.resolve("@stellar/stellar-sdk")));

  const buildSrc = readFileSync(new URL("../build.mjs", import.meta.url), "utf8");
  const start = buildSrc.indexOf("const ENV = {");
  const envBlock = buildSrc.slice(start, buildSrc.indexOf("\n};", start));
  const fromBuild = new Map<string, string | undefined>();
  for (const m of envBlock.matchAll(/^\s*(NEXT_PUBLIC_[A-Z0-9_]+):\s*(?:"([^"]*)"|(undefined))/gm)) fromBuild.set(m[1]!, m[3] ? undefined : m[2]);
  ok("build.mjs's ENV block was found and read", start >= 0 && fromBuild.size >= 10, `${fromBuild.size} NEXT_PUBLIC keys`);
  const buildStrings = [...fromBuild].filter(([, v]) => v !== undefined).map(([k, v]) => [k, v] as const);
  ok(
    "the environment these self-tests install is exactly the one build.mjs bakes into the bundle (update test/_harness.ts BUILD_ENV if this fails)",
    buildStrings.length === Object.keys(BUILD_ENV).length && buildStrings.every(([k, v]) => BUILD_ENV[k] === v),
    show(buildStrings.filter(([k, v]) => BUILD_ENV[k] !== v).map(([k]) => k)),
  );
  ok("  ...and the keys build.mjs defines as undefined are not set here", [...fromBuild].filter(([, v]) => v === undefined).every(([k]) => process.env[k] === undefined));

  const nets = { testnet: config.netConfig("testnet"), public: config.netConfig("public") };
  for (const id of ["testnet", "public"] as const) {
    const n = nets[id];
    const e = EXPECT[id];
    ok(
      `${id}: the shipped config is the expected sponsor, RPC node and escrow`,
      n.id === id && n.isMainnet === e.mainnet && n.sponsorUrl === e.sponsor && new URL(n.rpcUrl).toString() === e.rpc && n.contract === e.contract,
      `${n.sponsorUrl} ${n.rpcUrl} ${n.contract.slice(0, 8)}`,
    );
  }
  ok("the two networks share no sponsor, no RPC node, no escrow and no passphrase", nets.testnet.sponsorUrl !== nets.public.sponsorUrl && nets.testnet.rpcUrl !== nets.public.rpcUrl && nets.testnet.contract !== nets.public.contract && nets.testnet.passphrase !== nets.public.passphrase);
  const origin = (u: string) => `${new URL(u).origin}/*`;
  const used = new Set(Object.values(nets).flatMap((n) => [origin(n.sponsorUrl), origin(n.rpcUrl), origin(n.horizonUrl)]));
  ok("every host a network config talks to is in config.API_HOSTS, and API_HOSTS holds nothing else", used.size === 6 && same([...used].sort(), [...config.API_HOSTS].sort()));
  for (const file of ["manifest.chrome.json", "manifest.firefox.json"]) {
    const m = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as { host_permissions?: string[] };
    ok(`${file} grants exactly those six hosts`, same([...(m.host_permissions ?? [])].sort(), [...config.API_HOSTS].sort()));
  }
  ok("the link origin is the website and the marker is ext", config.WEB_ORIGIN === WEB && config.SRC === "ext");

  /* ------------------------------------ the faked world ------------------------------------ */
  const realGetAccount = S.rpc.Server.prototype.getAccount;
  const realSimulate = S.rpc.Server.prototype.simulateTransaction;
  const realFetch = globalThis.fetch;
  const realNow = Date.now;

  function invoked(tx: Transaction | FeeBumpTransaction): { fn: string; contract: string; args: XdrNs.ScVal[] } {
    const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
    const op = inner.operations[0] as Operation.InvokeHostFunction;
    const call = op.func.invokeContract();
    return { fn: call.functionName().toString(), contract: S.Address.fromScAddress(call.contractAddress()).toString(), args: call.args() };
  }
  function simulation(retval: XdrNs.ScVal): RpcNs.Api.SimulateTransactionResponse {
    return {
      _parsed: true,
      id: "url-selftest",
      latestLedger: 1,
      events: [],
      transactionData: new S.SorobanDataBuilder(),
      minResourceFee: "100",
      result: { auth: [], retval },
    } as unknown as RpcNs.Api.SimulateTransactionResponse;
  }
  interface World {
    rpcCalls: RpcCall[];
    posts: Post[];
    stray: string[];
    /** what the escrow's get_drop / get_pool answer: nothing, a record (everywhere, or where heldOn says so), or a throw */
    view: "empty" | "held" | "unreadable";
    heldOn: ((rpcUrl: string, contract: string, linkId: string) => boolean) | null;
    /** how the sponsor answers the POST */
    reply: () => Response | Promise<Response>;
    /** milliseconds added to Date.now(), to step past a deadline */
    shift: number;
    restore(): void;
  }
  function patchWorld(): World {
    const w: World = { rpcCalls: [], posts: [], stray: [], view: "empty", heldOn: null, reply: () => jsonResponse(200, { hash: HASH }), shift: 0, restore };
    S.rpc.Server.prototype.getAccount = async function (this: RpcServer, address: string) {
      w.rpcCalls.push({ call: "getAccount", url: this.serverURL.toString(), address });
      return new S.Account(address, "100");
    };
    S.rpc.Server.prototype.simulateTransaction = async function (this: RpcServer, tx: Transaction | FeeBumpTransaction) {
      const { fn, contract, args } = invoked(tx);
      const url = this.serverURL.toString();
      w.rpcCalls.push({ call: "simulate", url, fn, contract, args });
      if (fn === "get_drop" || fn === "get_pool") {
        if (w.view === "unreadable") throw new Error("rpc unreachable");
        const linkId = Buffer.from(S.scValToNative(args[0]!) as Uint8Array).toString("hex");
        const holds = w.view === "held" && (w.heldOn === null || w.heldOn(url, contract, linkId));
        const drop = { amount: 25_000_000n, expiry: BigInt(Math.floor(realNow() / 1000) + 7 * 86400), claimed: false };
        return simulation(holds ? S.nativeToScVal(drop) : S.xdr.ScVal.scvVoid());
      }
      return simulation(S.xdr.ScVal.scvVoid());
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v2-deposit")) {
        w.posts.push({ url, method: init?.method, headers: init?.headers, body: String(init?.body ?? "") });
        return w.reply();
      }
      w.stray.push(url);
      throw new Error(`unexpected request to ${url}`);
    }) as typeof fetch;
    Date.now = () => realNow() + w.shift;
    function restore() {
      S.rpc.Server.prototype.getAccount = realGetAccount;
      S.rpc.Server.prototype.simulateTransaction = realSimulate;
      globalThis.fetch = realFetch;
      Date.now = realNow;
    }
    return w;
  }

  const kp = S.Keypair.random();
  const PUB = kp.publicKey();
  const signer = core.localSignerFromSeed(kp.rawSecretKey());

  /* ---------------------------------------- [b] ---------------------------------------- */
  interface RunCfg {
    label: string;
    net: NetId;
    from: string;
    /** the name the claim screen prints for it: the website's sanitiser cuts it at 24 characters */
    shown: string;
    password?: string;
  }
  const HOSTILE_SHOWN = "Ay\u015fe&n=public&src=web&p=";
  const runs: RunCfg[] = [
    { label: "practice money", net: "testnet", from: "Ayse", shown: "Ayse" },
    { label: "practice money, password-locked", net: "testnet", from: "Ayse", shown: "Ayse", password: PASSWORD },
    { label: "practice money, hostile sender name", net: "testnet", from: HOSTILE, shown: HOSTILE_SHOWN },
    { label: "real money", net: "public", from: "Ayse", shown: "Ayse" },
    { label: "real money, password-locked", net: "public", from: "Ayse", shown: "Ayse", password: PASSWORD },
    { label: "real money, hostile sender name", net: "public", from: HOSTILE, shown: HOSTILE_SHOWN },
  ];

  for (const cfg of runs) {
    section("b", cfg.label);
    const e = EXPECT[cfg.net];
    const net = nets[cfg.net];
    const other = nets[cfg.net === "testnet" ? "public" : "testnet"];
    const sealed: [string, string][] = [];
    const puts: LinkRecord[] = [];
    const deps: SendDeps = {
      now: () => Date.now(),
      settings: async () => ({ net: cfg.net, autolockMin: 15, from: "", mainnetAck: true, consentAt: 1 }),
      account: async () => ({ pubkey: PUB, phase: 2 }),
      backupNeeded: async () => false,
      signer: async () => signer,
      pilot: async () => ({ pilot: true, approved: true, state: "approved", used: 0, limit: 5, at: Date.now() }),
      balance: async () => ({ usd: "100.0000000", missing: false }),
      netConfig: config.netConfig,
      createLink: core.createV2Link, // the real one
      landed: (linkHex, sender, n) => core.v2DepositLanded(linkHex, sender, { net: n }),
      records: async () => puts,
      seal: async (linkHex, link) => void sealed.push([linkHex, link]),
      putRecord: async (r) => void puts.push(structuredClone(r)),
      beacon: () => {},
    };
    const world = patchWorld();
    const t0 = Date.now();
    let res: Awaited<ReturnType<typeof outcome<Awaited<ReturnType<typeof runSend>>>>>;
    try {
      res = await outcome(runSend(deps, { amount: "2.50", from: cfg.from, password: cfg.password }));
    } finally {
      world.restore();
    }
    const out = "value" in res ? res.value : null;
    ok("the send succeeds through the real createV2Link", out !== null && typeof out.link === "string", "error" in res ? (res.error instanceof ExtError ? `${res.error.code}: ${res.error.message}` : String(res.error)) : "");
    if (!out?.link) continue;

    const link = out.link;
    const linkHex = out.linkHex;
    const hash = link.indexOf("#");
    const beforeHash = link.slice(0, hash);
    const fragment = link.slice(hash + 1);
    const url = new URL(link);
    const sp = url.searchParams;
    const lock = Boolean(cfg.password);
    // The key is the fragment's first segment; the sender's name and the lock marker ride behind it.
    const carried = linkFragment.parseClaimFragment(fragment);
    const key = carried.key;
    const sentName = fragment.split("&").find((part) => part.startsWith("s="))?.slice(2);
    ok("the link starts with https://getlumenia.com/v2/c/<linkHex>? and the id is 64 lowercase hex", link.startsWith(`${WEB}/v2/c/${linkHex}?`) && /^[0-9a-f]{64}$/.test(linkHex) && url.pathname === `/v2/c/${linkHex}`);
    ok("exactly one '#', with something after it (a sender name cannot start a second fragment)", link.split("#").length === 2 && fragment.length > 0);
    ok("the query ends with src=ext, and src is there exactly once", /[?&]src=ext$/.test(beforeHash) && sp.getAll("src").length === 1 && sp.get("src") === "ext" && (beforeHash.match(/[?&]src=/g) ?? []).length === 1);
    ok("the query is n (if real money), then src: in that order and nothing else", same([...sp.keys()], [...(e.mainnet ? ["n"] : []), "src"]), [...sp.keys()].join(","));
    ok(
      "no amount anywhere in the link (no a=, no 2.50), and the sender's name nowhere before the '#'",
      !link.includes("a=") && !link.includes("2.50") && !beforeHash.includes("s=") && !beforeHash.includes(encodeURIComponent(cfg.from)),
    );
    ok(
      "after the key, s= carries the sender's name exactly as typed, and the claim reader prints it as the screen will",
      sentName !== undefined && decodeURIComponent(sentName) === cfg.from && carried.from === cfg.shown,
      JSON.stringify(carried.from),
    );
    ok(`n=public is ${e.mainnet ? "present, once" : "absent"} (real money only)`, same(sp.getAll("n"), e.mainnet ? ["public"] : []));
    ok(
      `p=1 is ${lock ? "after the '#', once" : "absent"} (only a password-locked link), and never in the query`,
      !sp.has("p") && carried.passwordLocked === lock && (lock ? fragment.endsWith("&p=1") && fragment.split("&p=").length === 2 : !fragment.includes("&p=")),
    );
    ok("no seeded marker and no group marker (an extension link is a plain one-to-one link)", !sp.has("seeded") && !sp.has("g") && !fragment.includes("&g=") && carried.slots === null);

    // The key.
    if (!lock) {
      ok("the fragment starts with an S... secret, and the name rides behind it", /^S[A-Z2-7]{55}$/.test(key) && fragment.startsWith(`${key}&s=`));
      ok("  ...and it is the secret of the key that was escrowed (its public half is the link id)", S.Keypair.fromSecret(key).rawPublicKey().toString("hex") === linkHex);
      ok("  ...and no S... string appears in the path or the query", !/S[A-Z2-7]{55}/.test(beforeHash) && !(url.pathname + url.search).includes(key));
    } else {
      ok("the fragment starts with the p1. seed, not a key", key.startsWith("p1.") && fragment.startsWith(`${key}&s=`) && !/S[A-Z2-7]{55}/.test(link));
      const parsed = claimPw.parseLinkFragment(key);
      ok("  ...the right password opens exactly the escrowed link id", parsed?.kind === "password" && (await claimPw.unlockLink(parsed.seed, PASSWORD, linkHex)).ok === true);
      ok("  ...a wrong password does not", parsed?.kind === "password" && (await claimPw.unlockLink(parsed.seed, "not the password", linkHex)).ok === false);
      ok("  ...the password appears nowhere in the link, in any encoding", !link.includes(PASSWORD) && !link.includes(encodeURIComponent(PASSWORD)) && !link.includes(PASSWORD.replace(/ /g, "+")));
    }

    // The claim page reads it back.
    const split = lumendrop.splitGroupHint(url.hash);
    ok(
      "the website's claim reader finds the key where it was put, the name and the lock behind it, and no group hint",
      split.slots === null && split.fragment === key && split.from === cfg.shown && split.passwordLocked === lock,
    );
    const resolved = network.resolveNetwork(sp.get("n"));
    ok("  ...and the claim page's own network resolution (n) lands on the same escrow and sponsor the deposit went to", resolved.contract === net.contract && resolved.sponsorUrl === net.sponsorUrl && resolved.id === cfg.net);

    // Where the request and the reads went.
    ok("exactly one POST, to this network's sponsor at /v2-deposit", world.posts.length === 1 && world.posts[0]!.url === `${net.sponsorUrl}/v2-deposit` && world.posts[0]!.url === `${e.sponsor}/v2-deposit`, world.posts.map((p) => p.url).join(" "));
    const post = world.posts[0]!;
    const body = JSON.parse(post.body) as { xdr: string; senderPublicKey: string };
    ok("  ...a JSON POST of the signed transaction and the sender, and nothing else", post.method === "POST" && same(Object.keys(body).sort(), ["senderPublicKey", "xdr"]) && body.senderPublicKey === PUB);
    ok("  ...it carries neither the link's key nor the password", !post.body.includes(key) && !(cfg.password && post.body.includes(cfg.password)) && !post.body.includes(linkHex.toUpperCase()));
    ok("every RPC call went to this network's node, and none anywhere else", world.rpcCalls.length >= 2 && world.rpcCalls.every((c) => c.url === e.rpc), world.rpcCalls.map((c) => c.url).join(" "));
    ok("  ...no request left for anything but the sponsor's /v2-deposit", world.stray.length === 0, world.stray.join(" "));
    ok(`  ...and none of this network's traffic touched the ${cfg.net === "testnet" ? "real-money" : "practice"} hosts`, [...world.posts.map((p) => p.url), ...world.rpcCalls.map((c) => c.url)].every((u) => !u.startsWith(other.sponsorUrl) && !u.startsWith(new URL(other.rpcUrl).origin)));

    const dep = world.rpcCalls.find((c) => c.fn === "deposit");
    ok("the deposit invokes this network's escrow", dep?.contract === net.contract && dep?.contract === e.contract, dep?.contract);
    const stroops = dep ? (S.scValToNative(dep.args![2]!) as bigint) : 0n;
    const escrowedKey = dep ? Buffer.from(S.scValToNative(dep.args![1]!) as Uint8Array).toString("hex") : "";
    const escrowedExpiry = dep ? BigInt(S.scValToNative(dep.args![3]!) as bigint) : 0n;
    ok("  ...from the sender, for 2.50 in stroops, behind exactly the key whose id is in the link", dep !== undefined && S.Address.fromScVal(dep.args![0]!).toString() === PUB && stroops === 25_000_000n && escrowedKey === linkHex);

    const first = puts[0];
    const last = puts[puts.length - 1];
    ok("the first record kept is the submitted one, for this network and this sender, and the last is confirmed", puts.length === 2 && first?.phase === "submitted" && first.net === cfg.net && first.sender === PUB && last?.phase === "confirmed" && last.hash === HASH && last.linkHex === linkHex);
    ok(
      "  ...its expiry is now + 7 days, and that is the figure escrowed on chain",
      first !== undefined && Math.abs(first.expiry - (Math.floor(t0 / 1000) + 7 * 86400)) < 60 && BigInt(first.expiry) === escrowedExpiry,
      String(first?.expiry),
    );
    const wire = S.TransactionBuilder.fromXDR(body.xdr, net.passphrase) as Transaction;
    const wireOther = S.TransactionBuilder.fromXDR(body.xdr, other.passphrase) as Transaction;
    ok(
      "  ...the record's innerHash is the hash of the transaction that was POSTed, signed once, for THIS network's passphrase",
      first !== undefined && first.innerHash === hex(wire.hash()) && first.innerHash !== hex(wireOther.hash()) && wire.signatures.length === 1 && wire.source === PUB,
    );
    ok("  ...the link was sealed under its own id exactly as returned", sealed.length === 1 && sealed[0]![0] === linkHex && sealed[0]![1] === link);
    // The sender's own display name is stored as typed (it may legitimately hold a '#'), so it is set aside.
    const stored = JSON.stringify(puts.map((r) => ({ ...r, from: "" })));
    ok("  ...and no record holds the link, its key, a URL or the password (the typed sender name aside)", !stored.includes(key) && !stored.includes("https://") && !stored.includes("#") && !(cfg.password && stored.includes(cfg.password)) && puts.every((r) => r.from === cfg.from));
  }

  /* ---------------------------------------- [c] ---------------------------------------- */
  const records = await import("../src/background/records");
  const router = await import("../src/background/router");
  const links = await import("../src/lib/links");
  const { NOTHING_MOVED } = await import("../src/lib/errors");
  const codeOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r ? (r.error instanceof ExtError ? r.error.code : `non-ExtError: ${String(r.error)}`) : "returned");
  const refusal = (status: number, body: string) => () => new Response(body, { status });

  /** One send on `netId` through the real createLink, with the real record store, in a fresh world set up by `setup`. */
  async function attempt(netId: NetId, setup: (w: World) => void, stepPastDeadline = false) {
    await fake.local.clear();
    await fake.local.set({ [storage.K.account]: { pubkey: PUB, restoredAt: 1 } }); // the account this extension holds
    const sealed: string[] = [];
    const world = patchWorld();
    setup(world);
    const deps: SendDeps = {
      now: () => Date.now(),
      settings: async () => ({ net: netId, autolockMin: 15, from: "", mainnetAck: true, consentAt: 1 }),
      account: async () => ({ pubkey: PUB, phase: 2 }),
      backupNeeded: async () => false,
      signer: async () => signer,
      pilot: async () => ({ pilot: true, approved: true, state: "approved", used: 0, limit: 5, at: Date.now() }),
      balance: async () => ({ usd: "100.0000000", missing: false }),
      netConfig: config.netConfig,
      createLink: core.createV2Link,
      landed: (linkHex, sender, n) => core.v2DepositLanded(linkHex, sender, { net: n }),
      records: records.allRecords,
      seal: async (_id, link) => {
        sealed.push(link);
        if (stepPastDeadline) world.shift = 10 * 60_000; // the signed deposit can no longer be included
      },
      putRecord: records.putRecord,
      beacon: () => {},
    };
    let res: Awaited<ReturnType<typeof outcome<Awaited<ReturnType<typeof runSend>>>>>;
    try {
      res = await outcome(runSend(deps, { amount: "2.50", from: "Ayse" }));
    } finally {
      world.restore();
    }
    return { res, world, sealed, stored: await records.allRecords() };
  }

  for (const netId of ["testnet", "public"] as const) {
    const net = nets[netId];
    const e = EXPECT[netId];
    const where = (w: World) => w.rpcCalls.length > 0 && w.rpcCalls.every((c) => c.url === e.rpc) && w.stray.length === 0;
    const asked = (w: World) => w.rpcCalls.some((c) => c.fn === "get_drop" && c.url === e.rpc && c.contract === net.contract);
    section("c", `${netId === "testnet" ? "practice" : "real"} money: the sponsor's answer is not a plain 200`);

    const t1 = await attempt(netId, (w) => {
      w.reply = () => jsonResponse(202, { hash: HASH, confirmed: false });
      w.view = "held";
    });
    ok("202, and the escrow then holds the drop: a success, with the sponsor's hash", codeOf(t1.res) === "returned" && t1.stored[0]?.phase === "confirmed" && t1.stored[0].hash === HASH && t1.sealed.length === 1);
    ok("  ...the escrow was asked on this network's RPC node and escrow, and nothing went anywhere else", asked(t1.world) && where(t1.world) && t1.world.posts.length === 1);

    const t2 = await attempt(netId, (w) => {
      w.reply = () => jsonResponse(202, { hash: HASH, confirmed: false });
    });
    ok("202, and the escrow is still empty before the deadline: uncertain, never failed", codeOf(t2.res) === "uncertain" && t2.stored.length === 1 && t2.stored[0]!.phase === "uncertain" && t2.sealed.length === 1);
    ok("  ...asked of this network's escrow, one POST only (nothing is sent again)", asked(t2.world) && where(t2.world) && t2.world.posts.length === 1);

    const t3 = await attempt(netId, (w) => {
      w.reply = () => jsonResponse(202, { hash: HASH, confirmed: false });
      w.view = "unreadable";
    });
    ok("202, and the escrow cannot be read: uncertain", codeOf(t3.res) === "uncertain" && t3.stored[0]?.phase === "uncertain");

    const t4 = await attempt(netId, (w) => {
      w.reply = () => {
        throw new TypeError("fetch failed");
      };
    });
    ok("the connection drops after the POST and the escrow is empty before the deadline: uncertain", codeOf(t4.res) === "uncertain" && t4.stored[0]?.phase === "uncertain" && asked(t4.world));

    const t5 = await attempt(netId, (w) => {
      w.reply = () => {
        throw new TypeError("fetch failed");
      };
      w.view = "held";
    });
    ok("the connection drops but the escrow holds the drop: a success with no hash", codeOf(t5.res) === "returned" && t5.stored[0]?.phase === "confirmed" && !("hash" in t5.stored[0]));

    const t6 = await attempt(netId, (w) => (w.reply = () => jsonResponse(202, { hash: HASH, confirmed: false })), true);
    ok(
      "202 and, at the deadline, the escrow is still empty: uncertain, not yet 'nothing moved' (the settle loop decides with a margin and a second read)",
      codeOf(t6.res) === "uncertain" && t6.stored[0]?.phase === "uncertain" && t6.stored[0].failReason === undefined,
      `${codeOf(t6.res)} ${t6.stored[0]?.phase}`,
    );

    const t7 = await attempt(
      netId,
      (w) =>
        (w.reply = () => {
          throw new TypeError("fetch failed");
        }),
      true,
    );
    ok("the connection drops and, at the deadline, the escrow is empty: uncertain as well, never sent again", codeOf(t7.res) === "uncertain" && t7.stored[0]?.phase === "uncertain" && t7.world.posts.length === 1);

    // The real error text, as createV2Link writes it, read by the extension.
    const rows: [string, () => Response, string, "failed" | "uncertain"][] = [
      ["403 from the pilot gate (not on the allowlist)", refusal(403, '{"error":"this wallet is not on the pilot allowlist yet"}'), "not-approved", "failed"],
      ["403, pilot limit reached", refusal(403, '{"error":"pilot limit reached: 5 transactions used"}'), "slots-used", "failed"],
      ["429", refusal(429, '{"error":"rate limit"}'), "rate-limited", "failed"],
      ["503, the operator's halt", refusal(503, '{"error":"sponsor temporarily halted"}'), "halted", "failed"],
      ["503, the network is busy", refusal(503, '{"error":"the network is busy; try again shortly"}'), "network-busy", "failed"],
      ["400, the mainnet redaction", refusal(400, '{"error":"request failed","ref":"1a2b3c4d"}'), "uncertain", "uncertain"],
      ["500", refusal(500, "boom"), "uncertain", "uncertain"],
    ];
    for (const [what, reply, code, phase] of rows) {
      const t = await attempt(netId, (w) => (w.reply = reply));
      ok(`${what}, through the real createV2Link -> ${code}, record ${phase}`, codeOf(t.res) === code && t.stored.length === 1 && t.stored[0]!.phase === phase && t.world.posts.length === 1 && t.sealed.length === 1, `${codeOf(t.res)} ${t.stored[0]?.phase}`);
    }
  }

  /* ---------------------------------------- [d] ---------------------------------------- */
  section("d", "the settle loop, wired as the router wires it, reads each record on its own network");
  const pending = (netId: NetId, id: number, phase: "submitted" | "confirmed") => {
    const r = links.fromPrepared(
      { link: "", linkHex: id.toString(16).padStart(64, "0"), retrySafeAfter: Date.now() + 120_000, innerHash: id.toString(16).padStart(64, "f"), expiry: Math.floor(Date.now() / 1000) + 7 * 86400, group: false, amount: "2.50" },
      { net: netId, sender: PUB, from: "Ayse", locked: false, now: Date.now() - 5 * 60_000 },
    );
    return phase === "submitted" ? r : links.confirm(r, HASH, Date.now() - 5 * 60_000);
  };
  const idOf = (r: LinkRecord) => r.linkHex;
  const T = { sub: pending("testnet", 1, "submitted"), cnf: pending("testnet", 2, "confirmed"), gone: pending("testnet", 5, "confirmed") };
  const P = { sub: pending("public", 3, "submitted"), cnf: pending("public", 4, "confirmed"), gone: pending("public", 6, "confirmed") };
  await fake.local.clear();
  await fake.local.set({ [storage.K.account]: { pubkey: PUB, restoredAt: 1 } });
  for (const r of [T.sub, T.cnf, T.gone, P.sub, P.cnf, P.gone]) await records.putRecord(r);
  const testnetContracts = [nets.testnet.contract, ...nets.testnet.legacyContracts];
  const settleWorld = patchWorld();
  // Each network's escrow holds that network's submitted deposit and its still-unclaimed drop; the other
  // confirmed drop of each network is gone from its escrow (claimed). Nothing is held on the OTHER network,
  // so a read sent to the wrong one would come back empty and read as claimed or as not landed.
  settleWorld.view = "held";
  settleWorld.heldOn = (url, contract, id) =>
    (url === EXPECT.testnet.rpc && contract === nets.testnet.contract && (id === idOf(T.sub) || id === idOf(T.cnf))) ||
    (url === EXPECT.public.rpc && contract === nets.public.contract && (id === idOf(P.sub) || id === idOf(P.cnf)));
  let after: LinkRecord[];
  try {
    after = await router.runSettle({ force: true });
  } finally {
    settleWorld.restore();
  }
  const byId = new Map(after.map((r) => [r.linkHex, r]));
  ok("a submitted testnet deposit that the testnet escrow holds becomes confirmed", byId.get(idOf(T.sub))?.phase === "confirmed" && byId.get(idOf(T.sub))?.status === "pending");
  ok("  ...and so does a submitted mainnet deposit that the MAINNET escrow holds", byId.get(idOf(P.sub))?.phase === "confirmed" && byId.get(idOf(P.sub))?.status === "pending");
  ok("a confirmed testnet drop the testnet escrow still holds stays pending", byId.get(idOf(T.cnf))?.status === "pending");
  ok("  ...and so does a confirmed mainnet drop the MAINNET escrow still holds", byId.get(idOf(P.cnf))?.status === "pending");
  ok("a confirmed drop its own escrow no longer holds reads Claimed, on either network", byId.get(idOf(T.gone))?.status === "claimed" && byId.get(idOf(P.gone))?.status === "claimed");
  const reads = settleWorld.rpcCalls.filter((c): c is RpcCall & { contract: string } => c.fn === "get_drop" && c.contract !== undefined);
  const crossed = reads.filter((c) => (c.url === EXPECT.testnet.rpc) !== testnetContracts.includes(c.contract) || (c.url === EXPECT.public.rpc) !== (c.contract === nets.public.contract));
  ok("every escrow read pairs a network's RPC node with that same network's escrows, and never the other's", reads.length >= 6 && crossed.length === 0, show(crossed.map((c) => `${c.url} ${c.contract.slice(0, 6)}`)));
  ok("  ...both networks were really read", reads.some((c) => c.url === EXPECT.testnet.rpc) && reads.some((c) => c.url === EXPECT.public.rpc));
  ok("  ...every read used the record's sender as its source account", settleWorld.rpcCalls.filter((c) => c.call === "getAccount").every((c) => c.address === PUB));
  ok("  ...and the loop sent nothing: no POST, no request to any sponsor or any other host", settleWorld.posts.length === 0 && settleWorld.stray.length === 0);
  const alarmsMade = fake.alarms.filter((a) => a.op === "create" && a.name === "settle");
  ok("  ...open records keep the once-a-minute settle alarm running", alarmsMade.length >= 1 && same(alarmsMade[alarmsMade.length - 1]!.info, { periodInMinutes: 1 }));
  await fake.local.clear();
  await fake.local.set({ [storage.K.account]: { pubkey: PUB, restoredAt: 1 } });
  fake.alarms.length = 0;
  await records.putRecord(links.onDropRead(pending("testnet", 9, "confirmed"), "settled", Date.now()));
  const quiet = patchWorld();
  try {
    await router.runSettle({ force: true });
  } finally {
    quiet.restore();
  }
  ok("  ...and once every record is final the alarm is cleared and no escrow is read", fake.alarms.some((a) => a.op === "clear" && a.name === "settle") && !fake.alarms.some((a) => a.op === "create") && quiet.rpcCalls.length === 0);

  // An uncertain record made by a real send, finished by the real loop.
  for (const netId of ["testnet", "public"] as const) {
    const e = EXPECT[netId];
    const mk = async () => {
      const t = await attempt(netId, (w) => (w.reply = () => jsonResponse(202, { hash: HASH, confirmed: false })));
      return t.stored[0]!;
    };
    const settleOnce = async (view: World["view"], shift: number) => {
      const w = patchWorld();
      w.view = view;
      w.shift = shift;
      try {
        return { after: await router.runSettle({ force: true }), w };
      } finally {
        w.restore();
      }
    };
    const rec1 = await mk();
    const held = await settleOnce("held", 0);
    ok(`[${netId}] an uncertain record, the escrow now holds it: confirmed (no hash, the sponsor never said), read on this network only`, held.after[0]?.phase === "confirmed" && held.after[0].linkHex === rec1.linkHex && !("hash" in held.after[0]) && held.w.rpcCalls.every((c) => c.url === e.rpc) && held.w.rpcCalls.length > 0);
    await mk();
    const gone1 = await settleOnce("empty", 10 * 60_000);
    const gone = await settleOnce("empty", 11 * 60_000);
    ok(
      `[${netId}] an uncertain record, the escrow empty twice past the deadline and the margin: failed, nothing moved (one last check owed)`,
      gone1.after[0]?.phase === "uncertain" && gone.after[0]?.phase === "failed" && gone.after[0].failReason === NOTHING_MOVED && typeof gone.after[0].recheckAt === "number",
    );
    await mk();
    const early = await settleOnce("empty", 0);
    ok(`[${netId}] ...the escrow empty but the deadline not yet passed: still uncertain`, early.after[0]?.phase === "uncertain");
    await mk();
    const blind = await settleOnce("unreadable", 400 * 86_400_000);
    ok(`[${netId}] ...the escrow unreadable a year later: still uncertain, never failed`, blind.after[0]?.phase === "uncertain" && blind.after[0].lastError !== undefined);
  }

  /* ---------------------------------------- [e] ---------------------------------------- */
  section("e", "the patched globals are back");
  ok("rpc.Server.prototype.getAccount and simulateTransaction are the SDK's own again", S.rpc.Server.prototype.getAccount === realGetAccount && S.rpc.Server.prototype.simulateTransaction === realSimulate);
  ok("globalThis.fetch and Date.now are the originals again", globalThis.fetch === realFetch && Date.now === realNow);
}

run("URL", "the link URL contract (real createV2Link, both networks)", main);
