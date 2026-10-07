/**
 * Extension-seam self-test: the part of apps/web/lib that a browser extension's service worker reuses
 * for the SENDER side (make a link, keep it before sending it, ask the escrow, beacon an event),
 * held to what that worker actually has: no window, no localStorage, no document, no Next.js.
 *
 * What is pinned, and why each one is here:
 *
 *   [a] the modules LOAD with none of the browser globals present. A module that touches
 *       `window` or `localStorage` at import time would crash the worker before it does anything.
 *   [b] v2LinkUrl, byte for byte: a PRIVATE link (the default since D2) is the contract written out
 *       by hand, and a RICH one (the sender's explicit choice) is what createV2Link and
 *       createV2GroupLink used to build inline plus `&preview=rich` before `src`. The link is the
 *       product: a drifting character here is a link that claims the wrong thing.
 *   [c] what the URL is allowed to carry: the network label iff mainnet, the key material only
 *       after the '#', no amount and no name before it on a private link, the group count in the
 *       fragment too, and the claim readers getting back exactly what the builder wrote.
 *   [d] `src` is one to eight lowercase letters or it throws, so it can never smuggle a second
 *       parameter or a fragment into a link; and a key that could not be read back throws too.
 *   [e] createV2Link and createV2GroupLink end to end, with the RPC and the sponsor faked: the
 *       hook runs before the POST and is handed the link that comes back, a failing hook means
 *       nothing is posted, the network that was named is the one every read goes to, and a 202
 *       that cannot be confirmed is still the uncertain error and never a plain "try again".
 *   [f] sendEvent from a worker: the same body through a `keepalive` fetch when there is no
 *       sendBeacon AND no page, `src: "ext"` only when asked, and never a URL or a fragment. A page
 *       whose sendBeacon was switched off still sends nothing.
 *
 * RUN: pnpm --filter @lumenia/web test:extseam   (offline, no keys, no network)
 */
import {
  Account,
  Address,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type FeeBumpTransaction,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { NetworkConfig } from "./network";
import type { PreparedDeposit, V2LinkParts } from "./lumendrop";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

/** A call's settled answer, so a rejection can be asserted on without a try/catch at every site. */
async function outcome<T>(p: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
}

function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/* ---------------------------------- [b] the references ----------------------------------
 * RICH. The template literals createV2Link and createV2GroupLink carried INLINE before v2LinkUrl
 * existed, pasted from `git show 61f351b:apps/web/lib/lumendrop.ts`, the last commit before the
 * builder was extracted (the one-to-one link is lines 241-243 of that file, the group link 376-378).
 * A rich link is exactly that link with `&preview=rich` at the end of its query, before any `&src=`.
 *
 * PRIVATE. The default since D2, written out by hand from the contract in v2LinkUrl's doc comment:
 * no amount anywhere, the public markers in the query, the key then the name, the `g` copy and the
 * lock marker after the '#'.
 *
 * Both are the spec. If this test and v2LinkUrl ever disagree, v2LinkUrl is the one that is wrong; do
 * not edit these to follow it.
 */
type RefNet = { isMainnet: boolean };

function oldSingleUrl(
  opts: { amount: string; from: string; webOrigin: string; seeded?: boolean },
  seed: Uint8Array | null,
  net: RefNet,
  link: Keypair,
  linkHex: string,
  passwordFragment: (seed: Uint8Array) => string,
): string {
  const q = `a=${encodeURIComponent(opts.amount)}&s=${encodeURIComponent(opts.from)}${seed ? "&p=1" : ""}${net.isMainnet ? "&n=public" : ""}${opts.seeded ? "&seeded=1" : ""}`;
  const fragment = seed ? passwordFragment(seed) : link.secret();
  const url = `${opts.webOrigin.replace(/\/$/, "")}/v2/c/${linkHex}?${q}#${fragment}`;
  return url;
}

function oldGroupUrl(
  opts: { perShare: string; from: string; slots: number; webOrigin: string; seeded?: boolean },
  seed: Uint8Array | null,
  net: RefNet,
  link: Keypair,
  linkHex: string,
  passwordFragment: (seed: Uint8Array) => string,
): string {
  const q = `a=${encodeURIComponent(opts.perShare)}&s=${encodeURIComponent(opts.from)}&g=${opts.slots}${seed ? "&p=1" : ""}${net.isMainnet ? "&n=public" : ""}${opts.seeded ? "&seeded=1" : ""}`;
  const fragment = `${seed ? passwordFragment(seed) : link.secret()}&g=${opts.slots}`;
  const url = `${opts.webOrigin.replace(/\/$/, "")}/v2/c/${linkHex}?${q}#${fragment}`;
  return url;
}

/** The rich link: the old one with the flag at the end of its query, then `src` if there is one. */
function richUrl(oldUrl: string, src?: string): string {
  const [query, fragment] = oldUrl.split("#");
  return `${query}&preview=rich${src !== undefined ? `&src=${src}` : ""}#${fragment}`;
}

/** The private link, as the D2 contract spells it. */
function privateUrl(o: {
  webOrigin: string;
  linkHex: string;
  from: string;
  key: string;
  slots?: number;
  locked: boolean;
  mainnet: boolean;
  seeded: boolean;
  src?: string;
}): string {
  const q = [
    o.slots !== undefined ? `g=${o.slots}` : "",
    o.mainnet ? "n=public" : "",
    o.seeded ? "seeded=1" : "",
    o.src !== undefined ? `src=${o.src}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const name = o.from.trim();
  const fragment = `${o.key}${name ? `&s=${encodeURIComponent(name)}` : ""}${o.slots !== undefined ? `&g=${o.slots}` : ""}${o.locked ? "&p=1" : ""}`;
  return `${o.webOrigin.replace(/\/$/, "")}/v2/c/${o.linkHex}${q ? `?${q}` : ""}#${fragment}`;
}

/**
 * Inputs that exercise the encoding, not just the happy path. Non-ASCII is spelled as escapes.
 * `shown` is the name a claim screen prints from it: no controls, trimmed, at most 24 characters.
 */
const FLAVORS = [
  { webOrigin: "https://getlumenia.com", amount: "2.50", from: "Ayse", shown: "Ayse" },
  { webOrigin: "https://getlumenia.com/", amount: "0.01", from: "Ayse's translation & tips = 100% #1", shown: "Ayse's translation & tip" },
  { webOrigin: "http://localhost:3000", amount: "1234.5678", from: "M\u00fcge \u2615 \u00e7\u015f?x=1&y=2", shown: "M\u00fcge \u2615 \u00e7\u015f?x=1&y=2" },
];

/* ------------------------------------- the faked world ------------------------------------- */

const WEB = "https://getlumenia.com";
const SPONSOR = "https://sponsor.ext-seam.test";
const HASH = "ab".repeat(32);
const EXPIRY = 1_900_000_000;

/** A mainnet-shaped network that is NOT the device's default, so a wrong fallback is visible. */
const EXT_NET: NetworkConfig = {
  id: "public",
  passphrase: Networks.PUBLIC,
  horizonUrl: "https://horizon.ext-seam.test",
  rpcUrl: "https://rpc.ext-seam.test",
  contract: StrKey.encodeContract(Buffer.alloc(32, 7)),
  legacyContracts: [],
  sponsorUrl: SPONSOR,
  isMainnet: true,
};

interface RpcCall {
  call: "getAccount" | "simulate";
  url: string;
  fn?: string;
  contract?: string;
  args?: xdr.ScVal[];
}

/** Which Soroban function a (simulated) transaction invokes, and on which contract. */
function invoked(tx: Transaction | FeeBumpTransaction): { fn: string; contract: string; args: xdr.ScVal[] } {
  const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
  const op = inner.operations[0] as Operation.InvokeHostFunction;
  const call = op.func.invokeContract();
  return {
    fn: call.functionName().toString(),
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    args: call.args(),
  };
}

/** A successful simulation that `rpc.assembleTransaction` accepts as it stands, answering `retval`. */
function simulation(retval: xdr.ScVal): rpc.Api.SimulateTransactionResponse {
  return {
    _parsed: true,
    id: "ext-seam",
    latestLedger: 1,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: "100",
    result: { auth: [], retval },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function main() {
  console.log("============================================================");
  console.log(" SELF-TEST - the extension seam (lib/ reused by a service worker)");
  console.log("============================================================\n");

  /* ---------------------------------------- [a] ---------------------------------------- */
  console.log("[a] the sender-side modules load with no window, localStorage or document");
  // The default network is read from the build environment when network.ts loads, and [e] asserts
  // against the testnet default. A developer's shell must not be able to change what it asserts.
  delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  const G = globalThis as unknown as Record<string, unknown>;
  for (const name of ["window", "localStorage", "document"]) {
    Reflect.deleteProperty(G, name);
    if (name in G) Object.defineProperty(G, name, { value: undefined, configurable: true, writable: true });
  }
  ok(
    "precondition: window, localStorage and document are all absent",
    typeof window === "undefined" && typeof localStorage === "undefined" && typeof document === "undefined",
  );

  async function attempt<T extends object>(name: string, load: () => Promise<T>): Promise<T | null> {
    try {
      const m = await load();
      ok(`${name} imports`, Object.keys(m).length > 0, `${Object.keys(m).length} exports`);
      return m;
    } catch (e) {
      ok(`${name} imports`, false, e instanceof Error ? e.message : String(e));
      return null;
    }
  }
  // Dynamic on purpose: a static import would run BEFORE the globals above were removed.
  const lumendrop = await attempt("lumendrop", () => import("./lumendrop"));
  const linkFragment = await attempt("link-fragment", () => import("./link-fragment"));
  const network = await attempt("network", () => import("./network"));
  const events = await attempt("events", () => import("./events"));
  const signer = await attempt("signer", () => import("./signer"));
  const claimPassword = await attempt("claim-password", () => import("./claim-password"));
  await attempt("recovery-api", () => import("./recovery-api"));
  await attempt("recovery", () => import("./recovery"));
  await attempt("keystore", () => import("./keystore"));
  await attempt("argon", () => import("./argon"));
  await attempt("money", () => import("./money"));
  await attempt("handles", () => import("./handles"));
  if (!lumendrop || !linkFragment || !network || !events || !signer || !claimPassword) {
    console.log("\nFAIL a module the rest of this test needs did not load");
    process.exit(1);
  }
  const { makeLinkSeed, passwordFragment, parseLinkFragment, unlockLink } = claimPassword;
  const testnet = network.testnetConfig();

  /* ---------------------------------------- [b] ---------------------------------------- */
  console.log("\n[b] v2LinkUrl against the contract (single and group x password x network x seeded x src x private / rich)");
  interface Case {
    group: boolean;
    password: boolean;
    mainnet: boolean;
    seeded: boolean;
    src: boolean;
    rich: boolean;
  }
  const cases: Case[] = [];
  for (const group of [false, true])
    for (const password of [false, true])
      for (const mainnet of [false, true])
        for (const seeded of [false, true])
          for (const src of [false, true])
            for (const rich of [false, true]) cases.push({ group, password, mainnet, seeded, src, rich });

  const SLOTS = 3;
  interface Built {
    c: Case;
    flavor: (typeof FLAVORS)[number];
    link: Keypair;
    linkHex: string;
    seed: Uint8Array | null;
    /** the pre-D2 link for the same inputs, without src: what a rich link is built from */
    old: string;
    reference: string;
    parts: V2LinkParts;
    url: string;
    /** the key material, the S... secret or the p1. seed */
    fragment: string;
  }
  const built: Built[] = [];
  for (const c of cases) {
    for (const flavor of FLAVORS) {
      const link = Keypair.random();
      const linkHex = hex(link.rawPublicKey());
      const seed = c.password ? makeLinkSeed() : null;
      const old = c.group
        ? oldGroupUrl({ perShare: flavor.amount, from: flavor.from, slots: SLOTS, webOrigin: flavor.webOrigin, seeded: c.seeded }, seed, { isMainnet: c.mainnet }, link, linkHex, passwordFragment)
        : oldSingleUrl({ amount: flavor.amount, from: flavor.from, webOrigin: flavor.webOrigin, seeded: c.seeded }, seed, { isMainnet: c.mainnet }, link, linkHex, passwordFragment);
      const fragment = seed ? passwordFragment(seed) : link.secret();
      const reference = c.rich
        ? richUrl(old, c.src ? "ext" : undefined)
        : privateUrl({
            webOrigin: flavor.webOrigin,
            linkHex,
            from: flavor.from,
            key: fragment,
            ...(c.group ? { slots: SLOTS } : {}),
            locked: Boolean(seed),
            mainnet: c.mainnet,
            seeded: c.seeded,
            ...(c.src ? { src: "ext" } : {}),
          });
      const parts: V2LinkParts = {
        webOrigin: flavor.webOrigin,
        linkHex,
        amount: flavor.amount,
        from: flavor.from,
        fragment,
        ...(c.group ? { slots: SLOTS } : {}),
        passwordLocked: Boolean(seed),
        mainnet: c.mainnet,
        seeded: c.seeded,
        ...(c.src ? { src: "ext" } : {}),
        ...(c.rich ? { preview: "rich" as const } : {}),
      };
      built.push({ c, flavor, link, linkHex, seed, old, reference, parts, url: lumendrop.v2LinkUrl(parts), fragment });
    }
  }
  const rich = built.filter((b) => b.c.rich);
  const priv = built.filter((b) => !b.c.rich);

  const richPlain = rich.filter((b) => !b.c.src);
  const richPlainWrong = richPlain.filter((b) => {
    const [oldQuery, oldFrag] = b.old.split("#");
    return b.url !== `${oldQuery}&preview=rich#${oldFrag}`;
  });
  ok(
    `rich, src absent: ${richPlain.length} links are the old inline templates plus exactly &preview=rich at the end of the query`,
    richPlainWrong.length === 0,
    richPlainWrong[0] ? `${richPlainWrong[0].url}  vs  ${richPlainWrong[0].old}` : "",
  );
  const richSrc = rich.filter((b) => b.c.src);
  const richSrcWrong = richSrc.filter((b) => {
    const [oldQuery, oldFrag] = b.old.split("#");
    return b.url !== `${oldQuery}&preview=rich&src=ext#${oldFrag}`;
  });
  ok(
    `rich, src "ext": ${richSrc.length} links are the old link plus exactly &preview=rich&src=ext at the end of the query`,
    richSrcWrong.length === 0,
    richSrcWrong[0] ? richSrcWrong[0].url : "",
  );
  ok(
    "  ...the old fragment does not change, and src is the LAST query parameter",
    richSrc.every((b) => {
      const u = new URL(b.url);
      const keys = [...u.searchParams.keys()];
      return u.hash === new URL(b.old).hash && keys[keys.length - 1] === "src" && keys.filter((k) => k === "src").length === 1 && b.url.split("&src=ext").length === 2;
    }),
  );
  ok(
    "  ...preview=rich follows seeded=1 when both are present, and src follows preview=rich",
    rich.filter((b) => b.c.seeded).every((b) => b.url.includes(`&seeded=1&preview=rich${b.c.src ? "&src=ext" : ""}#`)),
  );

  const privWrong = priv.filter((b) => b.url !== b.reference);
  ok(
    `private: ${priv.length} links are byte-identical to the contract written out by hand`,
    privWrong.length === 0,
    privWrong[0] ? `${privWrong[0].url}  vs  ${privWrong[0].reference}` : "",
  );
  ok(
    "  ...src is the LAST query parameter, exactly once, and follows seeded=1 when both are present",
    priv
      .filter((b) => b.c.src)
      .every((b) => {
        const keys = [...new URL(b.url).searchParams.keys()];
        return keys[keys.length - 1] === "src" && keys.filter((k) => k === "src").length === 1 && (!b.c.seeded || /[?&]seeded=1&src=ext#/.test(b.url));
      }),
  );
  ok(
    "  ...with no group, network, seeded or src marker there is no query at all, not even the '?'",
    priv
      .filter((b) => !b.c.group && !b.c.mainnet && !b.c.seeded && !b.c.src)
      .every((b) => !b.url.includes("?") && b.url.startsWith(`${b.flavor.webOrigin.replace(/\/$/, "")}/v2/c/${b.linkHex}#`)),
  );
  ok('  ...preview "private" is the default, byte for byte', priv.every((b) => lumendrop.v2LinkUrl({ ...b.parts, preview: "private" }) === b.url));
  ok(
    '  ...and anything but "rich" is private',
    priv.every((b) => lumendrop.v2LinkUrl({ ...b.parts, preview: "RICH" as unknown as "rich" }) === b.url && lumendrop.v2LinkUrl({ ...b.parts, preview: undefined }) === b.url),
  );
  ok(
    "src undefined is src absent, in both shapes",
    built.filter((b) => !b.c.src).every((b) => lumendrop.v2LinkUrl({ ...b.parts, src: undefined }) === b.url),
  );

  /* ---------------------------------------- [c] ---------------------------------------- */
  console.log("\n[c] what a link may carry");
  const networkWrong = built.filter((b) => {
    const sp = new URL(b.url).searchParams;
    return b.c.mainnet ? !(sp.get("n") === "public" && sp.getAll("n").length === 1) : sp.has("n");
  });
  ok("n=public is in the query iff the link is mainnet", networkWrong.length === 0, networkWrong[0]?.url ?? "");
  ok(
    "seeded=1 is in the query iff seeded; p=1 iff the key is password-locked, in the query of a rich link and only after the '#' of a private one",
    built.every((b) => {
      const sp = new URL(b.url).searchParams;
      const after = lumendrop.splitGroupHint(new URL(b.url).hash);
      if ((sp.get("seeded") === "1") !== b.c.seeded) return false;
      return b.c.rich ? (sp.get("p") === "1") === b.c.password && !after.passwordLocked : !sp.has("p") && after.passwordLocked === b.c.password;
    }),
  );
  ok(
    "the key material (the S... secret or the p1. seed) is only ever after the #, and first there",
    built.every((b) => {
      const u = new URL(b.url);
      const at = b.url.indexOf("#");
      return !(u.pathname + u.search).includes(b.fragment) && b.url.indexOf(b.fragment) > at && u.hash.slice(1).startsWith(b.fragment);
    }),
  );
  ok(
    "there is exactly one #, however odd the sender's name",
    built.every((b) => b.url.split("#").length === 2),
  );
  ok(
    "the link id is the whole path, and nothing else is",
    built.every((b) => new URL(b.url).pathname === `/v2/c/${b.linkHex}`),
  );
  const groups = built.filter((b) => b.c.group);
  ok(
    "a group link carries g=N in the query AND the &g=N copy in the fragment (at its very end on a rich link)",
    groups.every((b) => {
      const u = new URL(b.url);
      if (u.searchParams.get("g") !== String(SLOTS)) return false;
      return b.c.rich ? u.hash.slice(1) === `${b.fragment}&g=${SLOTS}` : u.hash.slice(1).split("&").includes(`g=${SLOTS}`);
    }),
  );
  ok(
    "a one-to-one link carries no g anywhere",
    built.filter((b) => !b.c.group).every((b) => !new URL(b.url).searchParams.has("g") && !new URL(b.url).hash.includes("&g=")),
  );
  ok(
    "the claim reader (splitGroupHint, parseLinkFragment, Keypair) gets back exactly what was written, the name included",
    built.every((b) => {
      const split = lumendrop.splitGroupHint(new URL(b.url).hash);
      if (split.slots !== (b.c.group ? SLOTS : null) || split.fragment !== b.fragment) return false;
      // A private fragment carries the name the claim screen prints; a rich one carries none.
      if (split.from !== (b.c.rich ? null : b.flavor.shown)) return false;
      const parsed = parseLinkFragment(split.fragment);
      if (b.seed) return parsed?.kind === "password" && hex(parsed.seed) === hex(b.seed);
      return parsed?.kind === "key" && Keypair.fromSecret(parsed.secret).publicKey() === b.link.publicKey();
    }),
  );
  ok(
    "the query reader (readClaimQuery): n, g and seeded from both shapes, the name and the lock only from a rich one",
    built.every((b) => {
      const q = linkFragment.readClaimQuery(new URL(b.url).search);
      const markers = q.mainnet === b.c.mainnet && q.slots === (b.c.group ? SLOTS : null) && q.seeded === b.c.seeded && q.rich === b.c.rich && q.legacy === b.c.rich;
      return markers && (b.c.rich ? q.queryName === b.flavor.shown && q.queryLocked === b.c.password : q.queryName === null && !q.queryLocked);
    }),
  );
  ok(
    "query parameters come in the documented order and no others",
    built.every((b) => {
      const want = b.c.rich
        ? ["a", "s", ...(b.c.group ? ["g"] : []), ...(b.c.password ? ["p"] : []), ...(b.c.mainnet ? ["n"] : []), ...(b.c.seeded ? ["seeded"] : []), "preview", ...(b.c.src ? ["src"] : [])]
        : [...(b.c.group ? ["g"] : []), ...(b.c.mainnet ? ["n"] : []), ...(b.c.seeded ? ["seeded"] : []), ...(b.c.src ? ["src"] : [])];
      return [...new URL(b.url).searchParams.keys()].join(",") === want.join(",");
    }),
  );
  ok(
    "a private link carries no amount anywhere and no a=, s= or preview= at all; its name only after the '#'",
    priv.every((b) => {
      const at = b.url.indexOf("#");
      return (
        !b.url.includes(b.flavor.amount) &&
        !b.url.includes("a=") &&
        !b.url.includes("preview=") &&
        !b.url.slice(0, at).includes("s=") &&
        b.url.indexOf(`&s=${encodeURIComponent(b.flavor.from.trim())}`) > at
      );
    }),
  );
  ok(
    "a rich link carries the amount as a= and the name as s=, exactly as typed, and preview=rich once",
    rich.every((b) => {
      const sp = new URL(b.url).searchParams;
      return sp.get("a") === b.flavor.amount && sp.get("s") === b.flavor.from && sp.getAll("preview").join(",") === "rich";
    }),
  );

  /* ---------------------------------------- [d] ---------------------------------------- */
  console.log("\n[d] src is one to eight lowercase letters, and the key is base32 or base64url, or it throws");
  const base: V2LinkParts = { webOrigin: WEB, linkHex: "ab".repeat(32), amount: "2.00", from: "Ayse", fragment: Keypair.random().secret() };
  const richBase: V2LinkParts = { ...base, preview: "rich" };
  for (const bad of ["EXT", "e x t", "toolongvalue", "", "ext1", "ext\n", "e-t", "\u00e9xt", "ext&n=public", "ext#x", "Ext", " ext"]) {
    ok(`v2LinkUrl refuses src ${JSON.stringify(bad)}, private and rich`, threw(() => lumendrop.v2LinkUrl({ ...base, src: bad })) && threw(() => lumendrop.v2LinkUrl({ ...richBase, src: bad })));
  }
  ok("  ...and null, which a loose regexp would read as the word null", threw(() => lumendrop.v2LinkUrl({ ...base, src: null as unknown as string })));
  for (const good of ["ext", "a", "abcdefgh"]) {
    ok(
      `v2LinkUrl accepts src ${JSON.stringify(good)}: the whole query of a plain private link, the end of a rich one`,
      lumendrop.v2LinkUrl({ ...base, src: good }).includes(`/v2/c/${base.linkHex}?src=${good}#`) && lumendrop.v2LinkUrl({ ...richBase, src: good }).includes(`&preview=rich&src=${good}#`),
    );
  }
  ok(
    "an accepted src can never add a second parameter or a fragment",
    [base, richBase].every((p) => !threw(() => lumendrop.v2LinkUrl({ ...p, src: "abcdefgh" })) && lumendrop.v2LinkUrl({ ...p, src: "abcdefgh" }).split("#").length === 2),
  );
  // The key goes into the link as written, first after the '#'. One that could be read back as a
  // parameter, a second fragment or nothing at all is a bug in the caller, refused before a link exists.
  const badKeys = ["", "S&p=1", "S=1", "S#x", "S x", `${base.fragment}&s=Mallory`];
  ok(
    `v2LinkUrl refuses ${badKeys.length} keys that could not be read back (empty, '&', '=', '#', a space), private and rich`,
    badKeys.every((k) => threw(() => lumendrop.v2LinkUrl({ ...base, fragment: k })) && threw(() => lumendrop.v2LinkUrl({ ...richBase, fragment: k }))),
  );

  /* ---------------------------------------- [e] ---------------------------------------- */
  console.log("\n[e] createV2Link and createV2GroupLink end to end, offline");
  const rpcCalls: RpcCall[] = [];
  const sent: { url: string; init: RequestInit }[] = [];
  const order: string[] = [];
  let viewAnswer: "empty" | "held" | "unreadable" = "empty";
  /** What a view returns when the escrow holds the link, and (when set) the only escrow that does. */
  let viewRecord: unknown = true;
  let viewOn: string | null = null;
  let reply: () => Response | Promise<Response> = () => json(200, { hash: HASH });

  const realGetAccount = rpc.Server.prototype.getAccount;
  const realSimulate = rpc.Server.prototype.simulateTransaction;
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  rpc.Server.prototype.getAccount = async function (this: rpc.Server, address: string) {
    rpcCalls.push({ call: "getAccount", url: this.serverURL.toString() });
    return new Account(address, "100");
  };
  rpc.Server.prototype.simulateTransaction = async function (this: rpc.Server, tx: Transaction | FeeBumpTransaction) {
    const { fn, contract, args } = invoked(tx);
    rpcCalls.push({ call: "simulate", url: this.serverURL.toString(), fn, contract, args });
    if (fn === "get_drop" || fn === "get_pool") {
      if (viewAnswer === "unreadable") throw new Error("rpc unreachable");
      // None means "this escrow holds nothing for that link"; anything else is a record.
      const holds = viewAnswer === "held" && (viewOn === null || contract === viewOn);
      return simulation(holds ? nativeToScVal(viewRecord) : xdr.ScVal.scvVoid());
    }
    return simulation(xdr.ScVal.scvVoid());
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    order.push("post");
    sent.push({ url: String(input), init: init ?? {} });
    return reply();
  }) as typeof fetch;

  const reset = () => {
    rpcCalls.length = 0;
    sent.length = 0;
    order.length = 0;
    viewAnswer = "empty";
    viewRecord = true;
    viewOn = null;
    reply = () => json(200, { hash: HASH });
  };
  const rpcUrl = (n: NetworkConfig) => new URL(n.rpcUrl).toString();
  const posted = (i = 0) => JSON.parse(String(sent[i]!.init.body)) as { xdr: string; senderPublicKey: string };

  const kp = Keypair.random();
  const sender = signer.localSignerFromSeed(kp.rawSecretKey());
  const common = { signer: sender, amount: "2.50", from: "Ayse", webOrigin: WEB, sponsorUrl: SPONSOR };

  try {
    // --- the default network is unchanged -----------------------------------------------------
    reset();
    const plain = await lumendrop.createV2Link({ ...common, expiry: EXPIRY });
    const plainUrl = new URL(plain.link);
    const plainKey = linkFragment.parseClaimFragment(plainUrl.hash).key;
    ok("no hook, no net, no src: the call returns the link, its id and the sponsor's hash", plain.hash === HASH && plain.link.startsWith(`${WEB}/v2/c/${plain.linkHex}#`));
    ok(
      "  ...built against the network this device is on (the testnet default), and no other",
      rpcCalls.length >= 2 && rpcCalls.every((c) => c.url === rpcUrl(testnet)),
      rpcCalls.map((c) => c.url).join(" "),
    );
    ok("  ...the deposit goes to that network's escrow", rpcCalls.find((c) => c.fn === "deposit")?.contract === testnet.contract);
    ok(
      "  ...exactly one POST, to the sponsor's /v2-deposit, carrying the signed transaction and the sender",
      sent.length === 1 && sent[0]!.url === `${SPONSOR}/v2-deposit` && sent[0]!.init.method === "POST" && posted().senderPublicKey === kp.publicKey(),
    );
    ok(
      "  ...and the link is the plain private one: no query at all, and after the '#' the key, then &s=Ayse, and nothing else",
      plainUrl.search === "" &&
        plain.link === `${WEB}/v2/c/${plain.linkHex}#${plainKey}&s=Ayse` &&
        /^S[A-Z2-7]{55}$/.test(plainKey) &&
        hex(Keypair.fromSecret(plainKey).rawPublicKey()) === plain.linkHex,
      plain.link.replace(plainKey, "<key>"),
    );

    // --- the persist-before-submit hook ----------------------------------------------------------
    reset();
    const seen: PreparedDeposit[] = [];
    let postsWhenKept = -1;
    const t0 = Date.now();
    const kept = await lumendrop.createV2Link({
      ...common,
      onPrepared: (p) => {
        order.push("prepared");
        postsWhenKept = sent.length;
        seen.push(p);
      },
    });
    const p1 = seen[0]!;
    ok("onPrepared runs once, BEFORE the POST", seen.length === 1 && order.join(",") === "prepared,post" && postsWhenKept === 0, order.join(","));
    ok("  ...and is handed the same link and id that the call returns", p1.link === kept.link && p1.linkHex === kept.linkHex);
    ok("  ...a single link: group false, the amount as typed, no slots and no total", p1.group === false && p1.amount === "2.50" && p1.slots === undefined && p1.total === undefined);
    const onChain = rpcCalls.find((c) => c.fn === "deposit")!;
    ok(
      "  ...expiry is unix seconds, the default seven days out, and is the figure escrowed on chain",
      Math.abs(p1.expiry - (t0 / 1000 + 7 * 24 * 3600)) < 30 && BigInt(scValToNative(onChain.args![3]!) as bigint) === BigInt(p1.expiry),
      String(p1.expiry),
    );
    ok("  ...the amount escrowed on chain is that amount in stroops", BigInt(scValToNative(onChain.args![2]!) as bigint) === 25_000_000n);
    ok("  ...retrySafeAfter is unix ms, about the 120 s the transaction stays includable", Math.abs(p1.retrySafeAfter - (Date.now() + 120_000)) < 5_000, String(p1.retrySafeAfter - Date.now()));
    const wire = TransactionBuilder.fromXDR(posted().xdr, testnet.passphrase);
    ok(
      "  ...innerHash is the hash of the exact signed inner transaction that was POSTed",
      /^[0-9a-f]{64}$/.test(p1.innerHash) && p1.innerHash === hex(wire.hash()) && wire.signatures.length === 1,
      p1.innerHash.slice(0, 16),
    );

    reset();
    const failing = await outcome(
      lumendrop.createV2Link({
        ...common,
        onPrepared: () => {
          throw new Error("disk full");
        },
      }),
    );
    ok("a hook that throws: the create function rethrows that same error", "error" in failing && failing.error instanceof Error && failing.error.message === "disk full");
    ok("  ...and nothing was POSTed, and the escrow was never asked about a deposit", sent.length === 0 && !rpcCalls.some((c) => c.fn === "get_drop" || c.fn === "get_pool"));
    reset();
    const failingAsync = await outcome(
      lumendrop.createV2Link({
        ...common,
        onPrepared: async () => {
          await Promise.resolve();
          throw new Error("quota exceeded");
        },
      }),
    );
    ok("  ...an async hook that rejects is the same", "error" in failingAsync && failingAsync.error instanceof Error && failingAsync.error.message === "quota exceeded" && sent.length === 0);

    // --- opts.net is honoured ------------------------------------------------------------------
    reset();
    const viaNet: PreparedDeposit[] = [];
    const made = await lumendrop.createV2Link({ ...common, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl, expiry: EXPIRY, onPrepared: (p) => void viaNet.push(p) });
    ok(
      "opts.net: every RPC call goes to the network named, not the device's",
      rpcCalls.length >= 2 && rpcCalls.every((c) => c.url === rpcUrl(EXT_NET)),
      rpcCalls.map((c) => c.url).join(" "),
    );
    ok("  ...the deposit is invoked on THAT network's escrow", rpcCalls.find((c) => c.fn === "deposit")?.contract === EXT_NET.contract);
    const wireNet = TransactionBuilder.fromXDR(posted().xdr, EXT_NET.passphrase);
    ok(
      "  ...and signed for THAT network's passphrase",
      viaNet[0]!.innerHash === hex(wireNet.hash()) && viaNet[0]!.innerHash !== hex(TransactionBuilder.fromXDR(posted().xdr, testnet.passphrase).hash()),
    );
    ok("  ...POSTed to the sponsor it was given", sent.length === 1 && sent[0]!.url === `${EXT_NET.sponsorUrl}/v2-deposit`);
    ok("  ...the explicit expiry is what is kept and what is escrowed", viaNet[0]!.expiry === EXPIRY && BigInt(scValToNative(rpcCalls.find((c) => c.fn === "deposit")!.args![3]!) as bigint) === BigInt(EXPIRY));
    ok("  ...and the link says it is real money, because the network named is mainnet", new URL(made.link).searchParams.get("n") === "public");

    // --- a deposit that cannot be confirmed --------------------------------------------------------
    reset();
    reply = () => json(202, { hash: HASH, confirmed: false });
    const keptUncertain: PreparedDeposit[] = [];
    const uncertain = await outcome(lumendrop.createV2Link({ ...common, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl, onPrepared: (p) => void keptUncertain.push(p) }));
    const uncertainErr = "error" in uncertain ? uncertain.error : null;
    ok("a 202 whose escrow read says not landed, before retrySafeAfter: DepositUncertainError", uncertainErr instanceof lumendrop.DepositUncertainError);
    ok(
      "  ...carrying the link the hook already saved, and the same deadline",
      uncertainErr instanceof lumendrop.DepositUncertainError &&
        uncertainErr.link === keptUncertain[0]!.link &&
        uncertainErr.linkHex === keptUncertain[0]!.linkHex &&
        uncertainErr.retrySafeAfter === keptUncertain[0]!.retrySafeAfter,
    );
    ok(
      "  ...having asked get_drop of the NAMED network's RPC and escrow (the net is threaded into the escrow read)",
      rpcCalls.some((c) => c.fn === "get_drop" && c.url === rpcUrl(EXT_NET) && c.contract === EXT_NET.contract) && rpcCalls.every((c) => c.url === rpcUrl(EXT_NET)),
      rpcCalls.map((c) => `${c.fn ?? c.call}@${c.url}`).join(" "),
    );

    reset();
    reply = () => json(202, { hash: HASH, confirmed: false });
    viewAnswer = "held";
    const landed202 = await lumendrop.createV2Link({ ...common, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl });
    ok("a 202 the escrow then shows as landed is a success, with the hash the sponsor gave", landed202.hash === HASH && landed202.link.includes(`/v2/c/${landed202.linkHex}`));

    reset();
    reply = () => json(202, { hash: HASH, confirmed: false });
    viewAnswer = "unreadable";
    const unreadable = await outcome(lumendrop.createV2Link({ ...common, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl }));
    ok("a 202 the escrow cannot be read for is the uncertain error too, never a plain failure", "error" in unreadable && unreadable.error instanceof lumendrop.DepositUncertainError);

    reset();
    reply = () => {
      throw new TypeError("fetch failed");
    };
    const dropped = await outcome(lumendrop.createV2Link({ ...common, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl }));
    ok("a dropped connection before the deadline is the uncertain error", "error" in dropped && dropped.error instanceof lumendrop.DepositUncertainError);
    ok("  ...and the escrow was asked on the named network", rpcCalls.some((c) => c.fn === "get_drop" && c.url === rpcUrl(EXT_NET)));
    reset();
    reply = () => {
      throw new TypeError("fetch failed");
    };
    viewAnswer = "held";
    const droppedButLanded = await lumendrop.createV2Link({ ...common, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl });
    ok("  ...unless the escrow shows it landed, which is a success with no hash", droppedButLanded.hash === "" && droppedButLanded.link.includes("/v2/c/"));

    reset();
    reply = () => json(202, { hash: HASH, confirmed: false });
    const afterDeadline = await outcome(
      lumendrop.createV2Link({
        ...common,
        net: EXT_NET,
        sponsorUrl: EXT_NET.sponsorUrl,
        // The signed transaction can no longer be included, so an empty escrow is now a settled answer.
        onPrepared: () => {
          Date.now = () => realNow() + 10 * 60_000;
        },
      }),
    );
    Date.now = realNow;
    ok(
      "past retrySafeAfter an empty escrow is proof nothing moved: a plain error, safe to retry",
      "error" in afterDeadline && afterDeadline.error instanceof Error && !(afterDeadline.error instanceof lumendrop.DepositUncertainError) && /not submitted/.test(afterDeadline.error.message),
    );

    // --- src, end to end ---------------------------------------------------------------------------------
    reset();
    const keptSrc: PreparedDeposit[] = [];
    const withExt = await lumendrop.createV2Link({ ...common, seeded: true, src: "ext", onPrepared: (p) => void keptSrc.push(p) });
    ok(
      "src: the link's query is seeded=1 then src=ext, the name rides after the key, and the hook saw the same link",
      /\/v2\/c\/[0-9a-f]{64}\?seeded=1&src=ext#S[A-Z2-7]{55}&s=Ayse$/.test(withExt.link) && keptSrc[0]!.link === withExt.link,
      withExt.link.split("#")[0],
    );
    reset();
    const keptRich: PreparedDeposit[] = [];
    const richExt = await lumendrop.createV2Link({ ...common, seeded: true, src: "ext", preview: "rich", onPrepared: (p) => void keptRich.push(p) });
    ok(
      'preview "rich" passes through createV2Link: the old query, then preview=rich, then src=ext, the bare key after the #, and the hook saw the same link',
      /\/v2\/c\/[0-9a-f]{64}\?a=2\.50&s=Ayse&seeded=1&preview=rich&src=ext#S[A-Z2-7]{55}$/.test(richExt.link) && keptRich[0]!.link === richExt.link,
      richExt.link.split("#")[0],
    );
    for (const bad of ["EXT", "e x t", "toolongvalue", ""]) {
      reset();
      const r = await outcome(lumendrop.createV2Link({ ...common, src: bad }));
      ok(
        `createV2Link refuses src ${JSON.stringify(bad)} before any RPC call or POST`,
        "error" in r && r.error instanceof Error && rpcCalls.length === 0 && sent.length === 0,
      );
    }

    // --- the password variant, through the real key derivation ------------------------------------------------
    reset();
    const keptPw: PreparedDeposit[] = [];
    const locked = await lumendrop.createV2Link({ ...common, password: "correct horse battery", onPrepared: (p) => void keptPw.push(p) });
    const lockedUrl = new URL(locked.link);
    const lockedSplit = lumendrop.splitGroupHint(lockedUrl.hash);
    const lockedFragment = parseLinkFragment(lockedSplit.fragment);
    ok(
      "a password link: the seed (p1.) first in the fragment, then &s=Ayse&p=1, no p in the query, and the hook saw it",
      !lockedUrl.searchParams.has("p") &&
        lockedUrl.search === "" &&
        lockedUrl.hash.startsWith("#p1.") &&
        lockedUrl.hash.endsWith("&s=Ayse&p=1") &&
        lockedSplit.passwordLocked &&
        lockedSplit.from === "Ayse" &&
        lockedFragment?.kind === "password" &&
        keptPw[0]!.link === locked.link,
    );
    ok(
      "  ...and the password opens exactly the link id that was escrowed",
      lockedFragment?.kind === "password" && (await unlockLink(lockedFragment.seed, "correct horse battery", locked.linkHex)).ok === true,
    );

    // --- the group link -------------------------------------------------------------------------------------------
    reset();
    const keptGroup: PreparedDeposit[] = [];
    const group = await lumendrop.createV2GroupLink({
      ...common,
      perShare: "2.50",
      slots: 3,
      net: EXT_NET,
      sponsorUrl: EXT_NET.sponsorUrl,
      src: "ext",
      expiry: EXPIRY,
      onPrepared: (p) => {
        order.push("prepared");
        keptGroup.push(p);
      },
    });
    const g1 = keptGroup[0]!;
    const groupWire = TransactionBuilder.fromXDR(posted().xdr, EXT_NET.passphrase);
    ok("group: the hook runs once, BEFORE the POST, with the link that comes back", keptGroup.length === 1 && order.join(",") === "prepared,post" && g1.link === group.link && g1.linkHex === group.linkHex, order.join(","));
    ok(
      "  ...group true, three slots, ONE share as the amount, and the whole pot as the total",
      g1.group === true && g1.slots === 3 && g1.amount === "2.50" && g1.total === "7.5000000" && group.total === g1.total,
      `${g1.amount} x ${g1.slots} = ${g1.total}`,
    );
    ok("  ...expiry and innerHash are the escrowed expiry and the hash of the POSTed transaction", g1.expiry === EXPIRY && g1.innerHash === hex(groupWire.hash()));
    const createDrop = rpcCalls.find((c) => c.fn === "create_drop")!;
    ok(
      "  ...create_drop on the named network, for the whole pot in stroops",
      createDrop.contract === EXT_NET.contract && createDrop.url === rpcUrl(EXT_NET) && BigInt(scValToNative(createDrop.args![2]!) as bigint) === 75_000_000n && scValToNative(createDrop.args![3]!) === 3,
    );
    const gu = new URL(group.link);
    ok(
      "  ...the link: g=3, n=public and src=ext (last) in the query and nothing else, the name then &g=3 after the key",
      [...gu.searchParams.keys()].join(",") === "g,n,src" &&
        gu.searchParams.get("n") === "public" &&
        gu.searchParams.get("g") === "3" &&
        gu.hash.endsWith("&s=Ayse&g=3") &&
        !group.link.includes("2.50") &&
        !group.link.includes("7.5"),
      group.link.split("#")[0],
    );

    reset();
    reply = () => json(202, { hash: HASH, confirmed: false });
    const groupUncertain = await outcome(lumendrop.createV2GroupLink({ ...common, perShare: "2.50", slots: 3, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl }));
    ok("group: a 202 not yet landed is the uncertain error", "error" in groupUncertain && groupUncertain.error instanceof lumendrop.DepositUncertainError);
    ok(
      "  ...asked of get_pool, on the NAMED network",
      rpcCalls.some((c) => c.fn === "get_pool" && c.url === rpcUrl(EXT_NET) && c.contract === EXT_NET.contract) && !rpcCalls.some((c) => c.fn === "get_drop"),
    );
    reset();
    const groupFails = await outcome(
      lumendrop.createV2GroupLink({
        ...common,
        perShare: "2.50",
        slots: 3,
        onPrepared: () => {
          throw new Error("disk full");
        },
      }),
    );
    ok("group: a hook that throws is rethrown and nothing is POSTed", "error" in groupFails && groupFails.error instanceof Error && groupFails.error.message === "disk full" && sent.length === 0);
    reset();
    const groupBad = await outcome(lumendrop.createV2GroupLink({ ...common, perShare: "2.50", slots: 3, src: "EXT" }));
    ok("group: a bad src is refused before any RPC call or POST", "error" in groupBad && rpcCalls.length === 0 && sent.length === 0);

    // --- the group link's other wiring: the dropped connection, the device network, seeded, the password ---
    reset();
    reply = () => {
      throw new TypeError("fetch failed");
    };
    const groupDropped = await outcome(lumendrop.createV2GroupLink({ ...common, perShare: "2.50", slots: 3, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl }));
    ok("group: a dropped connection before the deadline is the uncertain error", "error" in groupDropped && groupDropped.error instanceof lumendrop.DepositUncertainError);
    ok(
      "  ...asked of get_pool (never get_drop) on the NAMED network's RPC and escrow",
      rpcCalls.some((c) => c.fn === "get_pool" && c.url === rpcUrl(EXT_NET) && c.contract === EXT_NET.contract) &&
        !rpcCalls.some((c) => c.fn === "get_drop") &&
        rpcCalls.every((c) => c.url === rpcUrl(EXT_NET)),
      rpcCalls.map((c) => `${c.fn ?? c.call}@${c.url}`).join(" "),
    );

    reset();
    const keptPlainGroup: PreparedDeposit[] = [];
    const t1 = Date.now();
    const plainGroup = await lumendrop.createV2GroupLink({
      ...common,
      perShare: "2.50",
      slots: 3,
      seeded: true,
      password: "correct horse battery",
      onPrepared: (p) => void keptPlainGroup.push(p),
    });
    const pg = new URL(plainGroup.link);
    const pgSplit = lumendrop.splitGroupHint(pg.hash);
    ok(
      "group on the device's network (testnet): no n=public, seeded=1 in the query and p=1 after the '#' where asked, no src",
      !pg.searchParams.has("n") && !pg.searchParams.has("p") && pgSplit.passwordLocked && pg.searchParams.get("seeded") === "1" && !pg.searchParams.has("src"),
      plainGroup.link.split("#")[0],
    );
    ok(
      "  ...no a= and no s= anywhere in the query, the path is the returned id, g=3 in the query, and the name, &g=3 and &p=1 after the key",
      !pg.searchParams.has("a") &&
        !pg.searchParams.has("s") &&
        pg.pathname === `/v2/c/${plainGroup.linkHex}` &&
        pg.searchParams.get("g") === "3" &&
        pg.hash.endsWith("&s=Ayse&g=3&p=1") &&
        pgSplit.slots === 3 &&
        pgSplit.from === "Ayse",
    );
    ok("  ...the fragment carries the password seed (p1.), never a raw S... key", pg.hash.startsWith("#p1.") && !/#S[A-Z2-7]{55}/.test(plainGroup.link));
    ok(
      "  ...built on the testnet RPC and escrow",
      rpcCalls.length >= 2 && rpcCalls.every((c) => c.url === rpcUrl(testnet)) && rpcCalls.find((c) => c.fn === "create_drop")?.contract === testnet.contract,
    );
    ok(
      "  ...the hook's retrySafeAfter is unix ms, about the 120 s the transaction stays includable",
      keptPlainGroup.length === 1 && Math.abs(keptPlainGroup[0]!.retrySafeAfter - (t1 + 120_000)) < 5_000,
      String((keptPlainGroup[0]?.retrySafeAfter ?? 0) - t1),
    );
    const pgFrag = parseLinkFragment(lumendrop.splitGroupHint(pg.hash).fragment);
    ok(
      "  ...and the password opens exactly the pool id that was escrowed",
      pgFrag?.kind === "password" && (await unlockLink(pgFrag.seed, "correct horse battery", plainGroup.linkHex)).ok === true,
    );

    // The same pot, rich by the sender's choice: the pre-D2 group link plus the flag.
    reset();
    const richGroup = await lumendrop.createV2GroupLink({
      ...common,
      perShare: "2.50",
      slots: 3,
      seeded: true,
      password: "correct horse battery",
      preview: "rich",
    });
    const rg = new URL(richGroup.link);
    ok(
      'preview "rich" passes through createV2GroupLink: a= is ONE share, s= the sender, then g=3, p=1, seeded=1 and preview=rich in the query',
      [...rg.searchParams.keys()].join(",") === "a,s,g,p,seeded,preview" &&
        rg.searchParams.get("a") === "2.50" &&
        rg.searchParams.get("s") === "Ayse" &&
        rg.searchParams.get("g") === "3" &&
        rg.searchParams.get("p") === "1" &&
        rg.searchParams.get("preview") === "rich",
      richGroup.link.split("#")[0],
    );
    ok(
      "  ...and the old fragment: the p1. seed, then &g=3 at the very end, no name and no lock marker",
      /^#p1\.[A-Za-z0-9_-]{43}&g=3$/.test(rg.hash) && lumendrop.splitGroupHint(rg.hash).from === null && rg.pathname === `/v2/c/${richGroup.linkHex}`,
    );

    // The seat ceiling follows the network NAMED: six on real money, thirty on practice money.
    reset();
    const tooManyMainnet = await outcome(lumendrop.createV2GroupLink({ ...common, perShare: "1.00", slots: 7, net: EXT_NET, sponsorUrl: EXT_NET.sponsorUrl }));
    ok("group: seven shares on a NAMED mainnet network is refused before any RPC call or POST", "error" in tooManyMainnet && rpcCalls.length === 0 && sent.length === 0);
    reset();
    const sevenOnTestnet = await outcome(lumendrop.createV2GroupLink({ ...common, perShare: "1.00", slots: 7 }));
    ok("  ...while seven on the device's testnet is allowed", "value" in sevenOnTestnet && sent.length === 1);

    // --- the reads and the take-back name their network too ---------------------------------------------------
    console.log("\n[e2] the escrow reads and the take-back take the network named, not the device's");
    const LINK = "cd".repeat(32);
    const LEGACY = StrKey.encodeContract(Buffer.alloc(32, 9));
    const NET_WITH_LEGACY: NetworkConfig = { ...EXT_NET, legacyContracts: [LEGACY] };
    const named = (n: NetworkConfig) => rpcCalls.length > 0 && rpcCalls.every((c) => c.url === rpcUrl(n));
    const drop = (over: Record<string, unknown> = {}) => ({ amount: 25_000_000n, expiry: BigInt(EXPIRY), claimed: false, ...over });

    reset();
    viewAnswer = "held";
    ok("v2DepositLanded({ net }) asks get_drop of the named network and says it landed", (await lumendrop.v2DepositLanded(LINK, kp.publicKey(), { net: EXT_NET })) === true && named(EXT_NET) && rpcCalls.some((c) => c.fn === "get_drop" && c.contract === EXT_NET.contract));
    reset();
    const emptyAnswer = await lumendrop.v2DepositLanded(LINK, kp.publicKey(), { net: EXT_NET });
    viewAnswer = "unreadable";
    const unreadableAnswer = await lumendrop.v2DepositLanded(LINK, kp.publicKey(), { net: EXT_NET });
    ok("  ...an empty escrow is false, and an unreadable one is unknown", emptyAnswer === false && unreadableAnswer === "unknown");
    reset();
    viewAnswer = "held";
    await lumendrop.v2DepositLanded(LINK, kp.publicKey(), { group: true, net: EXT_NET });
    ok("  ...group: true asks get_pool instead, still on the named network", named(EXT_NET) && rpcCalls.some((c) => c.fn === "get_pool") && !rpcCalls.some((c) => c.fn === "get_drop"));
    reset();
    viewAnswer = "held";
    await lumendrop.v2DepositLanded(LINK, kp.publicKey());
    ok("  ...with no net it asks the device's own network", named(testnet) && rpcCalls.some((c) => c.fn === "get_drop" && c.contract === testnet.contract));

    reset();
    viewAnswer = "held";
    viewRecord = drop();
    ok("loadV2DropStatus({ net }): a held, unclaimed drop is pending, read from the named network", (await lumendrop.loadV2DropStatus(LINK, kp.publicKey(), { net: EXT_NET })) === "pending" && named(EXT_NET) && rpcCalls.some((c) => c.fn === "get_drop" && c.contract === EXT_NET.contract));
    reset();
    ok("  ...an empty escrow is settled", (await lumendrop.loadV2DropStatus(LINK, kp.publicKey(), { net: EXT_NET })) === "settled" && named(EXT_NET));
    reset();
    viewAnswer = "unreadable";
    ok("  ...and an unreadable one is unknown, never settled", (await lumendrop.loadV2DropStatus(LINK, kp.publicKey(), { net: EXT_NET })) === "unknown");
    reset();
    viewAnswer = "held";
    viewRecord = { sender: kp.publicKey(), amount_per: 25_000_000n, remaining: 50_000_000n, slots: 3, claimed: 1, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    ok("  ...group: an open pool is pending, read through get_pool on the named network", (await lumendrop.loadV2DropStatus(LINK, kp.publicKey(), { group: true, net: EXT_NET })) === "pending" && named(EXT_NET) && rpcCalls.some((c) => c.fn === "get_pool"));

    // loadDrop: the amount a private link no longer carries, read from the escrow with no account at
    // all (a recipient's phone has none yet), and the same three answers loadPool gives.
    reset();
    viewAnswer = "held";
    viewRecord = drop({ sender: kp.publicKey() });
    const heldDrop = await lumendrop.loadDrop(LINK, { net: EXT_NET });
    ok(
      "loadDrop({ net }): a held drop comes back with its amount in 7dp USDC, its expiry, its flag, its sender and its escrow",
      heldDrop !== null &&
        heldDrop.linkHex === LINK &&
        heldDrop.amount === "2.5000000" &&
        heldDrop.expiry === EXPIRY &&
        heldDrop.claimed === false &&
        heldDrop.sender === kp.publicKey() &&
        heldDrop.contract === EXT_NET.contract,
      JSON.stringify(heldDrop),
    );
    ok(
      "  ...read through get_drop on the named network, simulated from no account at all (no getAccount)",
      named(EXT_NET) && rpcCalls.some((c) => c.fn === "get_drop" && c.contract === EXT_NET.contract) && !rpcCalls.some((c) => c.call === "getAccount"),
    );
    reset();
    viewAnswer = "held";
    viewRecord = drop({ claimed: true });
    ok("  ...claimed, or taken back (the contract keeps one flag for both), comes through as claimed", (await lumendrop.loadDrop(LINK, { net: EXT_NET }))?.claimed === true);
    reset();
    ok("  ...every escrow answered and none holds it: null", (await lumendrop.loadDrop(LINK, { net: EXT_NET })) === null && named(EXT_NET));
    reset();
    viewAnswer = "unreadable";
    const blindDrop = await outcome(lumendrop.loadDrop(LINK, { net: EXT_NET }));
    ok("  ...an escrow that could not be asked THROWS, never null", "error" in blindDrop);
    reset();
    ok(
      "  ...a malformed id is null, and nothing is asked",
      (await lumendrop.loadDrop("not-a-link", { net: EXT_NET })) === null && (await lumendrop.loadDrop("ab".repeat(31), { net: EXT_NET })) === null && rpcCalls.length === 0,
    );
    reset();
    viewAnswer = "held";
    viewRecord = drop();
    viewOn = LEGACY;
    const superseded = await lumendrop.loadDrop(LINK, { net: NET_WITH_LEGACY });
    ok("  ...a drop only a SUPERSEDED escrow holds is found there, and says which", superseded?.contract === LEGACY && superseded.amount === "2.5000000" && named(NET_WITH_LEGACY));
    reset();
    viewAnswer = "held";
    viewRecord = drop();
    await lumendrop.loadDrop(LINK, { net: EXT_NET, sourceAccount: kp.publicKey() });
    ok("  ...with a sourceAccount it simulates from that account instead", rpcCalls.some((c) => c.call === "getAccount") && named(EXT_NET));

    // Reclaim: the old code resolved the escrow against the DEVICE's network (and its superseded
    // contracts) whatever was named. A drop that only the named network's legacy escrow holds proves it.
    reset();
    viewAnswer = "held";
    viewRecord = drop();
    viewOn = LEGACY;
    const reclaimed = await lumendrop.reclaimV2({ signer: sender, linkHex: LINK, sponsorUrl: NET_WITH_LEGACY.sponsorUrl, group: false, net: NET_WITH_LEGACY });
    const reclaimCall = rpcCalls.find((c) => c.fn === "reclaim");
    ok("reclaimV2({ net }) finds the drop in the named network's SUPERSEDED escrow and reclaims from it", reclaimCall?.contract === LEGACY && reclaimed.hash === HASH, reclaimCall?.contract ?? "no reclaim call");
    ok("  ...every RPC call on the named network, POSTed to that network's sponsor at /v2-reclaim", named(NET_WITH_LEGACY) && sent.length === 1 && sent[0]!.url === `${NET_WITH_LEGACY.sponsorUrl}/v2-reclaim` && posted().senderPublicKey === kp.publicKey());
    reset();
    await lumendrop.reclaimV2({ signer: sender, linkHex: LINK, sponsorUrl: EXT_NET.sponsorUrl, group: true, net: EXT_NET });
    ok("  ...a pool goes to reclaim_pool on the named escrow", named(EXT_NET) && rpcCalls.find((c) => c.fn === "reclaim_pool")?.contract === EXT_NET.contract);
    reset();
    viewAnswer = "held";
    viewRecord = { sender: kp.publicKey(), amount_per: 25_000_000n, remaining: 50_000_000n, slots: 3, claimed: 1, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    await lumendrop.reclaimV2({ signer: sender, linkHex: LINK, sponsorUrl: EXT_NET.sponsorUrl, net: EXT_NET });
    ok("  ...with group omitted the escrow is asked, on the named network, and it answers pool", named(EXT_NET) && rpcCalls.some((c) => c.fn === "get_pool") && rpcCalls.some((c) => c.fn === "reclaim_pool"));
    reset();
    await lumendrop.reclaimV2({ signer: sender, linkHex: LINK, sponsorUrl: SPONSOR, group: false });
    ok("  ...with no net it is the device's own network, as before", named(testnet) && rpcCalls.find((c) => c.fn === "reclaim")?.contract !== undefined && sent[0]!.url === `${SPONSOR}/v2-reclaim`);

    // onPosting: the line between "nothing was posted" and "the sponsor may have relayed it".
    reset();
    let postings = 0;
    let sentWhenCalled = -1;
    await lumendrop.reclaimV2({
      signer: sender,
      linkHex: LINK,
      sponsorUrl: EXT_NET.sponsorUrl,
      group: false,
      net: EXT_NET,
      onPosting: () => {
        postings++;
        sentWhenCalled = sent.length;
      },
    });
    ok("reclaimV2 onPosting: called once, right before the take-back is posted (nothing sent yet when it runs)", postings === 1 && sentWhenCalled === 0 && sent.length === 1);
    reset();
    let early = 0;
    const fakeGetAccount = rpc.Server.prototype.getAccount;
    rpc.Server.prototype.getAccount = async () => {
      throw new Error("rpc unreachable");
    };
    const pre = await outcome(lumendrop.reclaimV2({ signer: sender, linkHex: LINK, sponsorUrl: EXT_NET.sponsorUrl, group: false, net: EXT_NET, onPosting: () => void early++ }));
    rpc.Server.prototype.getAccount = fakeGetAccount;
    ok("  ...and not at all when it fails before anything is posted", "error" in pre && early === 0 && sent.length === 0);

    // loadReclaimableV2 keeps reading this device's own records; `net` only picks the escrow asked.
    // The records come from a stand-in storage, removed again straight after.
    const records = { a: { balanceId: LINK } };
    Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => JSON.stringify(records) }, configurable: true, writable: true });
    try {
      reset();
      viewAnswer = "held";
      viewRecord = drop({ expiry: BigInt(Math.floor(Date.now() / 1000) - 60) });
      const due = await lumendrop.loadReclaimableV2(kp.publicKey(), { net: EXT_NET });
      ok("loadReclaimableV2(sender, { net }) asks the named network's escrow and lists the expired drop", due.length === 1 && due[0]!.linkHex === LINK && due[0]!.usd === "2.5000000" && named(EXT_NET) && rpcCalls.some((c) => c.fn === "get_drop" && c.contract === EXT_NET.contract), JSON.stringify(due));
      reset();
      viewAnswer = "held";
      viewRecord = drop({ expiry: BigInt(Math.floor(Date.now() / 1000) - 60) });
      await lumendrop.loadReclaimableV2(kp.publicKey());
      ok("  ...with no net it asks the device's own network", named(testnet));
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
    ok("  ...and with no localStorage at all (a service worker) it is an empty list, never a throw", (await lumendrop.loadReclaimableV2(kp.publicKey(), { net: EXT_NET })).length === 0);
  } finally {
    rpc.Server.prototype.getAccount = realGetAccount;
    rpc.Server.prototype.simulateTransaction = realSimulate;
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }

  /* ---------------------------------------- [f] ---------------------------------------- */
  console.log("\n[f] sendEvent from a worker: no sendBeacon, so a keepalive fetch with the same body");
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setNavigator = (value: unknown) => Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true, enumerable: true });
  const fetched: { url: string; init: RequestInit }[] = [];
  let fetchBehaviour: () => Promise<Response> = async () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push({ url: String(input), init: init ?? {} });
    return fetchBehaviour();
  }) as typeof fetch;
  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown) => void unhandled.push(r);
  process.on("unhandledRejection", onUnhandled);

  // A claimId that is a whole link, fragment and all, and an account: the body must still hold neither.
  const SECRET = Keypair.random().secret();
  const leaky = `${WEB}/v2/c/${"ab".repeat(32)}#${SECRET}`;
  const account = Keypair.random().publicKey();
  try {
    setNavigator({ userAgent: "service-worker" });
    await events.sendEvent("send_link_created", leaky, account, { net: EXT_NET, src: "ext" });
    const f1 = fetched[0];
    const body1 = String(f1?.init.body ?? "");
    const parsed1 = (body1 ? JSON.parse(body1) : {}) as Record<string, unknown>;
    ok("no sendBeacon: the event goes out through fetch, once", fetched.length === 1);
    ok("  ...to the sponsor of the network named, at /events", f1?.url === `${EXT_NET.sponsorUrl}/events`, f1?.url);
    ok("  ...method POST with keepalive", f1?.init.method === "POST" && f1?.init.keepalive === true);
    ok(
      "  ...nothing else on the request: no headers (so no preflight), no credentials, no mode",
      f1 !== undefined && Object.keys(f1.init).sort().join(",") === "body,keepalive,method" && f1.init.headers === undefined,
      f1 ? Object.keys(f1.init).join(",") : "",
    );
    ok("  ...the body is a string, and so goes as text/plain", typeof f1?.init.body === "string");
    ok("  ...it carries the event, two hashed ids and src ext, and nothing more", Object.keys(parsed1).sort().join(",") === "aid,cid,event,src" && parsed1.event === "send_link_created" && parsed1.src === "ext", body1);
    ok("  ...the ids are 16 hex characters of a hash, not the link and not the account", /^[0-9a-f]{16}$/.test(String(parsed1.cid)) && /^[0-9a-f]{16}$/.test(String(parsed1.aid)));
    ok("  ...and it never contains a URL, a fragment, the secret or the address", !body1.includes("http") && !body1.includes("#") && !body1.includes(SECRET) && !body1.includes(account) && !body1.includes("/v2/c/"));

    fetched.length = 0;
    await events.sendEvent("claim_opened", "abc", undefined, { net: EXT_NET });
    const noSrc = JSON.parse(String(fetched[0]?.init.body ?? "{}")) as Record<string, unknown>;
    ok("without src the body has no src", fetched.length === 1 && !("src" in noSrc) && Object.keys(noSrc).sort().join(",") === "cid,event");
    fetched.length = 0;
    await events.sendEvent("claim_opened", "abc", undefined, { net: EXT_NET, src: "web" as unknown as "ext" });
    ok("  ...and nothing but the literal ext is ever sent as src", !("src" in (JSON.parse(String(fetched[0]?.init.body ?? "{}")) as object)));
    fetched.length = 0;
    await events.sendEvent("claim_succeeded", "abc", account, { net: EXT_NET, seeded: true, durationS: 12.7, src: "ext" });
    const rich = JSON.parse(String(fetched[0]?.init.body ?? "{}")) as Record<string, unknown>;
    ok("  ...the other options ride along as they always did", rich.seeded === 1 && rich.dur === 12 && rich.src === "ext");

    fetched.length = 0;
    await events.sendEvent("claim_opened", "abc");
    ok("with no net given it goes to the device's sponsor (the testnet default)", fetched[0]?.url === `${testnet.sponsorUrl}/events`, fetched[0]?.url);
    fetched.length = 0;
    await events.sendEvent("password_typed", "abc", account, { src: "ext" });
    ok("an event that is not on the allowlist is not sent", fetched.length === 0);

    // No navigator at all (an older runtime) is the same road.
    setNavigator(undefined);
    fetched.length = 0;
    await events.sendEvent("claim_opened", "abc", undefined, { net: EXT_NET, src: "ext" });
    ok("no navigator at all: still a fetch", fetched.length === 1 && fetched[0]?.init.keepalive === true);

    // Fire and forget: a request that never answers, or one that fails, must not hold up or break the caller.
    setNavigator({});
    fetched.length = 0;
    fetchBehaviour = () => new Promise<Response>(() => {});
    const quick = await Promise.race([events.sendEvent("claim_opened", "abc", undefined, { net: EXT_NET }).then(() => "resolved"), new Promise<string>((r) => setTimeout(() => r("held"), 500))]);
    ok("a fetch that never answers does not hold sendEvent up", quick === "resolved" && fetched.length === 1);
    fetchBehaviour = async () => {
      throw new TypeError("fetch failed");
    };
    const rejected = await outcome(events.sendEvent("claim_opened", "abc", undefined, { net: EXT_NET }));
    await new Promise((r) => setTimeout(r, 20));
    ok("a rejected fetch is swallowed: sendEvent resolves and nothing is left unhandled", "value" in rejected && unhandled.length === 0, String(unhandled[0] ?? ""));
    const realFetchForThrow = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new TypeError("synchronous failure");
    }) as unknown as typeof fetch;
    const syncThrow = await outcome(events.sendEvent("claim_opened", "abc", undefined, { net: EXT_NET }));
    globalThis.fetch = realFetchForThrow;
    ok("  ...and so is one that throws before it returns anything", "value" in syncThrow);

    // The page path is untouched: sendBeacon when it exists, and then fetch is not used at all.
    const beacons: { url: string; data: Blob }[] = [];
    setNavigator({
      sendBeacon(url: string, data: Blob) {
        beacons.push({ url, data });
        return true;
      },
    });
    fetchBehaviour = async () => new Response("{}", { status: 200 });
    fetched.length = 0;
    await events.sendEvent("send_link_created", leaky, account, { net: EXT_NET, src: "ext" });
    ok("with sendBeacon the beacon is used, and fetch is not", beacons.length === 1 && fetched.length === 0);
    ok("  ...to the same URL", beacons[0]?.url === `${EXT_NET.sponsorUrl}/events`);
    ok("  ...as a text/plain Blob", beacons[0]?.data.type === "text/plain");
    ok("  ...with the byte-identical body the worker path sends", (await beacons[0]!.data.text()) === body1);
    beacons.length = 0;
    await events.sendEvent("claim_opened", "abc", undefined, { net: EXT_NET });
    ok("  ...and without src it is the body it has always been", (await beacons[0]!.data.text()) === JSON.stringify({ event: "claim_opened", cid: noSrc.cid }));

    // A PAGE without sendBeacon is a browser where it was switched off on purpose (Firefox's
    // beacon.enabled=false). That opt-out stands: the worker's fetch road is not taken from a page.
    setNavigator({});
    fetched.length = 0;
    Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true, writable: true });
    const optedOut = await outcome(events.sendEvent("send_link_created", leaky, account, { net: EXT_NET, src: "ext" }));
    Reflect.deleteProperty(globalThis, "window");
    ok("a page whose sendBeacon was switched off sends nothing, not even through fetch", "value" in optedOut && fetched.length === 0);

    // Neither: nothing to send with, nothing thrown, and no work spent hashing ids for a send that cannot happen.
    setNavigator({});
    globalThis.fetch = undefined as unknown as typeof fetch;
    fetched.length = 0;
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let digests = 0;
    Object.defineProperty(crypto.subtle, "digest", {
      value: (...a: Parameters<SubtleCrypto["digest"]>) => {
        digests++;
        return realDigest(...a);
      },
      configurable: true,
      writable: true,
    });
    const neither = await outcome(events.sendEvent("claim_opened", "abc", undefined, { net: EXT_NET, src: "ext" }));
    Reflect.deleteProperty(crypto.subtle, "digest");
    ok("neither sendBeacon nor fetch: nothing is sent, nothing throws, and nothing is hashed", "value" in neither && fetched.length === 0 && digests === 0, `${digests} digests`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    globalThis.fetch = realFetch;
    if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
    else Reflect.deleteProperty(globalThis, "navigator");
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} EXT SEAM SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
