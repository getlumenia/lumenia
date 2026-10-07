/**
 * Link-privacy self-test (D2 private links): what a claim link, and everything sent about it, may
 * say about the money and the person behind it. Offline, no keys, no escrow.
 *
 *   [a] the URL. A private link (the default) carries no amount anywhere and the sender's name only
 *       after the '#'; a rich one (the sender's explicit choice) is the pre-D2 link plus
 *       `preview=rich` before `src`. Every shape is held byte for byte to the contract written out by
 *       hand, and round-trips through the readers the claim pages use (parseClaimFragment,
 *       readClaimQuery, splitGroupHint). A hostile name comes back as the literal name it is, and
 *       never as a parameter.
 *   [b] the beacon. What lib/events.ts sends about a claim or a send: an event name, hashed ids and
 *       counters, never a URL, a fragment, a name or an amount, whatever the caller hands it.
 *   [c] the headers. The claim routes answer no-referrer and noindex (next.config.ts), so a claim page
 *       never hands its URL to a third party and never lands in a search index.
 *
 * RUN: pnpm --filter @lumenia/web test:linkprivacy   (offline, no keys, no network)
 */
import { Keypair } from "@stellar/stellar-sdk";
import nextConfig from "../next.config";
import { makeLinkSeed, parseLinkFragment, passwordFragment } from "./claim-password";
import { sendEvent } from "./events";
import {
  MAX_POOL_SLOTS,
  MIN_POOL_SLOTS,
  RICH_PREVIEW_PARAM,
  RICH_PREVIEW_VALUE,
  claimFragment,
  parseClaimFragment,
  parseSlots,
  readClaimQuery,
  sanitizeSenderName,
} from "./link-fragment";
import * as preview from "./link-preview";
import * as lumendrop from "./lumendrop";
import { testnetConfig } from "./network";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
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

/* ------------------------------------ [a] the references ------------------------------------
 * Written out by hand from SPEC section 1 / the v2LinkUrl doc comment. If this test and v2LinkUrl
 * disagree, v2LinkUrl is the one that is wrong; do not edit these to follow it.
 */
interface Shape {
  webOrigin: string;
  linkHex: string;
  amount: string;
  from: string;
  key: string;
  slots?: number;
  locked: boolean;
  mainnet: boolean;
  seeded: boolean;
  src?: string;
}

/** PRIVATE: the public markers in the query (no '?' when there are none), the rest after the '#'. */
function privateRef(o: Shape): string {
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

/** RICH: the pre-D2 query, then `preview=rich`, then `src`; the pre-D2 fragment (the key and the `g` copy). */
function richRef(o: Shape): string {
  const q =
    `a=${encodeURIComponent(o.amount)}&s=${encodeURIComponent(o.from)}` +
    `${o.slots !== undefined ? `&g=${o.slots}` : ""}${o.locked ? "&p=1" : ""}${o.mainnet ? "&n=public" : ""}${o.seeded ? "&seeded=1" : ""}` +
    `&preview=rich${o.src !== undefined ? `&src=${o.src}` : ""}`;
  const fragment = o.slots !== undefined ? `${o.key}&g=${o.slots}` : o.key;
  return `${o.webOrigin.replace(/\/$/, "")}/v2/c/${o.linkHex}?${q}#${fragment}`;
}

/**
 * Names a sender can type, and the name a claim screen may print for each: no bidi or control
 * character, trimmed, at most 24 UTF-16 units and never half an emoji, null when nothing is left.
 * Non-ASCII is spelled as escapes.
 */
const NAMES: { from: string; shown: string | null; why: string }[] = [
  { from: "Ayse", shown: "Ayse", why: "a plain name" },
  { from: "Ayse's", shown: "Ayse's", why: "an apostrophe" },
  { from: "Ay&p=1#S", shown: "Ay&p=1#S", why: "a lock marker and a second fragment" },
  { from: "x&g=6", shown: "x&g=6", why: "a share count" },
  { from: "100% #1 & a=5", shown: "100% #1 & a=5", why: "an amount, and a percent sign" },
  { from: "Ali n=public&src=web", shown: "Ali n=public&src=web", why: "a network switch and a second src" },
  { from: "x&preview=rich&s=Mallory", shown: "x&preview=rich&s=Mallory", why: "the rich flag and a second name" },
  { from: "\u202Eevil\u202C Corp", shown: "evil Corp", why: "a right-to-left override" },
  { from: "A\u200Fy\u2066s\u2069e\u061C", shown: "Ayse", why: "bidi marks and isolates" },
  { from: "Ay\u0000s\u0007e\u0085\u009F", shown: "Ayse", why: "C0 and C1 controls" },
  { from: "A".repeat(300), shown: "A".repeat(24), why: "300 characters" },
  { from: "A".repeat(23) + "\u{1F600}", shown: "A".repeat(23), why: "an emoji cut in half at 24" },
  { from: "\u{1F600}".repeat(12), shown: "\u{1F600}".repeat(12), why: "twelve emoji, exactly 24 units" },
  { from: "M\u00FCge \u2615 \u00E7\u015F?x=1&y=2", shown: "M\u00FCge \u2615 \u00E7\u015F?x=1&y=2", why: "non-ASCII, a '?' and an '='" },
  { from: "  Ayse  ", shown: "Ayse", why: "surrounding spaces" },
  { from: "", shown: null, why: "empty" },
  { from: "   ", shown: null, why: "blank" },
];

const ORIGINS = ["https://getlumenia.com", "https://getlumenia.com/", "http://localhost:3000"];
const AMOUNTS = ["2.50", "0.2000000", "1234.5678"];
const SLOTS = 3;

/* ---------------------------------------- [a] ---------------------------------------- */
function sectionA() {
  console.log("[a] the URL: private by default, rich only by choice, and every reader gets back what was written");

  interface Case {
    group: boolean;
    locked: boolean;
    mainnet: boolean;
    seeded: boolean;
    src: boolean;
    rich: boolean;
  }
  const cases: Case[] = [];
  for (const group of [false, true])
    for (const locked of [false, true])
      for (const mainnet of [false, true])
        for (const seeded of [false, true])
          for (const src of [false, true])
            for (const rich of [false, true]) cases.push({ group, locked, mainnet, seeded, src, rich });

  interface Built {
    c: Case;
    name: (typeof NAMES)[number];
    shape: Shape;
    link: Keypair;
    seed: Uint8Array | null;
    url: string;
    reference: string;
  }
  const built: Built[] = [];
  let i = 0;
  for (const c of cases) {
    for (const name of NAMES) {
      const link = Keypair.random();
      const seed = c.locked ? makeLinkSeed() : null;
      const shape: Shape = {
        webOrigin: ORIGINS[i % ORIGINS.length]!,
        linkHex: hex(link.rawPublicKey()),
        amount: AMOUNTS[i % AMOUNTS.length]!,
        from: name.from,
        key: seed ? passwordFragment(seed) : link.secret(),
        ...(c.group ? { slots: SLOTS } : {}),
        locked: c.locked,
        mainnet: c.mainnet,
        seeded: c.seeded,
        ...(c.src ? { src: "ext" } : {}),
      };
      i++;
      const url = lumendrop.v2LinkUrl({
        webOrigin: shape.webOrigin,
        linkHex: shape.linkHex,
        amount: shape.amount,
        from: shape.from,
        fragment: shape.key,
        ...(c.group ? { slots: SLOTS } : {}),
        passwordLocked: c.locked,
        mainnet: c.mainnet,
        seeded: c.seeded,
        ...(c.src ? { src: "ext" } : {}),
        ...(c.rich ? { preview: "rich" as const } : {}),
      });
      built.push({ c, name, shape, link, seed, url, reference: c.rich ? richRef(shape) : privateRef(shape) });
    }
  }
  const priv = built.filter((b) => !b.c.rich);
  const rich = built.filter((b) => b.c.rich);
  const beforeHash = (u: string) => u.slice(0, u.indexOf("#"));
  const afterHash = (u: string) => u.slice(u.indexOf("#") + 1);

  // --- byte for byte ---
  const privWrong = priv.filter((b) => b.url !== b.reference);
  ok(`private: ${priv.length} links (single and group x locked x network x seeded x src x ${NAMES.length} names) are the contract, byte for byte`, privWrong.length === 0, privWrong[0] ? `${privWrong[0].url}  vs  ${privWrong[0].reference}` : "");
  const richWrong = rich.filter((b) => b.url !== b.reference);
  ok(`rich: ${rich.length} links are the pre-D2 link plus preview=rich before src, byte for byte`, richWrong.length === 0, richWrong[0] ? `${richWrong[0].url}  vs  ${richWrong[0].reference}` : "");
  // The fragment is what the claim page splits, so a parser that re-escaped any of it would move the
  // name or the key. (A rich query is the pre-D2 one, where a URL parser escapes an apostrophe to
  // %27; URLSearchParams reads it back the same, and the round trip below holds it.)
  ok(
    "a URL parser keeps every private link exactly as built, so a browser's location.hash is these bytes",
    priv.every((b) => new URL(b.url).href === b.url && new URL(b.url).hash === `#${afterHash(b.url)}`),
  );

  // --- what a private link may not carry ---
  ok(
    "the amount, in any spelling, and 'a=' are absent from every private link",
    priv.every((b) => !b.url.includes(b.shape.amount) && !b.url.includes(encodeURIComponent(b.shape.amount)) && !b.url.includes("a=")),
  );
  ok(
    "the sender's name never appears before the '#' of a private link, raw or encoded",
    priv.every((b) => {
      const name = b.shape.from.trim();
      return !name || (!beforeHash(b.url).includes(encodeURIComponent(name)) && !beforeHash(b.url).includes(name));
    }),
  );
  ok("no private link carries s=, p=, a= or preview= in its query", priv.every((b) => [...new URL(b.url).searchParams.keys()].every((k) => !["a", "s", "p", "preview"].includes(k))));
  ok(
    "a private link with nothing public to say has no query at all, not even the '?'",
    priv.filter((b) => !b.c.group && !b.c.mainnet && !b.c.seeded && !b.c.src).every((b) => !b.url.includes("?")),
  );
  ok(
    "an empty or blank name puts no &s= in the fragment",
    priv.filter((b) => b.name.from.trim() === "").every((b) => !afterHash(b.url).includes("&s=")),
  );

  // --- what every link must hold to ---
  ok(
    "the key (the S... secret or the p1. seed) is only after the '#', first there, and nowhere else",
    built.every((b) => afterHash(b.url).startsWith(b.shape.key) && b.url.indexOf(b.shape.key) === b.url.indexOf("#") + 1 && b.url.split(b.shape.key).length === 2),
  );
  ok("there is exactly one '#', whatever the name", built.every((b) => b.url.split("#").length === 2));
  ok("the path is the link id and nothing else", built.every((b) => new URL(b.url).pathname === `/v2/c/${b.shape.linkHex}`));
  ok(
    "n=public is in the query iff the link is mainnet, once, in both shapes",
    built.every((b) => {
      const all = new URL(b.url).searchParams.getAll("n");
      return b.c.mainnet ? all.length === 1 && all[0] === "public" : all.length === 0;
    }),
  );
  ok(
    "src is the LAST query parameter and appears once, whenever it is there",
    built.filter((b) => b.c.src).every((b) => {
      const keys = [...new URL(b.url).searchParams.keys()];
      return keys[keys.length - 1] === "src" && keys.filter((k) => k === "src").length === 1 && /[?&]src=ext#/.test(b.url);
    }),
  );
  ok(
    "the query is g, n, seeded, src (private) or a, s, g, p, n, seeded, preview, src (rich): in that order, each only when it applies",
    built.every((b) => {
      const c = b.c;
      const want = c.rich
        ? ["a", "s", ...(c.group ? ["g"] : []), ...(c.locked ? ["p"] : []), ...(c.mainnet ? ["n"] : []), ...(c.seeded ? ["seeded"] : []), "preview", ...(c.src ? ["src"] : [])]
        : [...(c.group ? ["g"] : []), ...(c.mainnet ? ["n"] : []), ...(c.seeded ? ["seeded"] : []), ...(c.src ? ["src"] : [])];
      return [...new URL(b.url).searchParams.keys()].join(",") === want.join(",");
    }),
  );

  // --- the readers the claim pages use ---
  const fragWrong = built.filter((b) => {
    const f = parseClaimFragment(new URL(b.url).hash);
    if (f.key !== b.shape.key || f.slots !== (b.c.group ? SLOTS : null)) return true;
    // A rich fragment is the pre-D2 one: no name and no lock in it (both are in its query).
    return b.c.rich ? f.from !== null || f.passwordLocked : f.from !== b.name.shown || f.passwordLocked !== b.c.locked;
  });
  ok(
    "parseClaimFragment reads back the key, the share count and, from a private link, the name as shown and the lock",
    fragWrong.length === 0,
    fragWrong[0] ? `${fragWrong[0].name.why}: ${JSON.stringify(parseClaimFragment(new URL(fragWrong[0].url).hash).from)}` : "",
  );
  const queryWrong = built.filter((b) => {
    const q = readClaimQuery(new URL(b.url).search);
    const markers = q.mainnet === b.c.mainnet && q.slots === (b.c.group ? SLOTS : null) && q.seeded === b.c.seeded && q.rich === b.c.rich && q.legacy === b.c.rich;
    return !(markers && (b.c.rich ? q.queryName === b.name.shown && q.queryLocked === b.c.locked : q.queryName === null && !q.queryLocked));
  });
  ok(
    "readClaimQuery: n, g and seeded from every link; the name and the lock only from a rich query, and the name as shown",
    queryWrong.length === 0,
    queryWrong[0] ? `${queryWrong[0].name.why} ${queryWrong[0].c.rich ? "rich" : "private"}` : "",
  );
  ok(
    "splitGroupHint (the claim button's reader) agrees with parseClaimFragment on every link",
    built.every((b) => {
      const s = lumendrop.splitGroupHint(new URL(b.url).hash);
      const f = parseClaimFragment(new URL(b.url).hash);
      return s.fragment === f.key && s.slots === f.slots && s.from === f.from && s.passwordLocked === f.passwordLocked;
    }),
  );
  ok(
    "the key that comes back opens exactly what was escrowed (the secret, or the same seed)",
    built.every((b) => {
      const parsed = parseLinkFragment(parseClaimFragment(new URL(b.url).hash).key);
      if (b.seed) return parsed?.kind === "password" && hex(parsed.seed) === hex(b.seed);
      return parsed?.kind === "key" && Keypair.fromSecret(parsed.secret).publicKey() === b.link.publicKey();
    }),
  );
  const hostile = (name: string) => priv.filter((b) => b.name.from === name);
  ok(
    "a hostile name injects nothing: Ay&p=1#S locks nothing, x&g=6 adds no share count, a=5 no amount, n=public no network, preview=rich no preview",
    hostile("Ay&p=1#S").every((b) => b.c.locked || !parseClaimFragment(new URL(b.url).hash).passwordLocked) &&
      hostile("x&g=6").every((b) => b.c.group || parseClaimFragment(new URL(b.url).hash).slots === null) &&
      hostile("100% #1 & a=5").every((b) => !new URL(b.url).searchParams.has("a") && !readClaimQuery(new URL(b.url).search).legacy) &&
      hostile("Ali n=public&src=web").every((b) => b.c.mainnet || !readClaimQuery(new URL(b.url).search).mainnet) &&
      hostile("x&preview=rich&s=Mallory").every((b) => !readClaimQuery(new URL(b.url).search).rich && parseClaimFragment(new URL(b.url).hash).from === "x&preview=rich&s=Mallory"),
  );

  // --- the pieces, one at a time ---
  const nameWrong = NAMES.filter((n) => sanitizeSenderName(encodeURIComponent(n.from)) !== n.shown);
  ok(`sanitizeSenderName prints each of ${NAMES.length} names as the table says`, nameWrong.length === 0, nameWrong.map((n) => n.why).join(", "));
  ok(
    "  ...and what it prints is always well formed (it can be encoded again) and at most 24 units",
    NAMES.every((n) => n.shown === null || (!threw(() => encodeURIComponent(n.shown!)) && n.shown.length <= 24)),
  );
  ok(
    "  ...null and undefined are no name, and malformed percent-encoding is no name",
    sanitizeSenderName(null) === null && sanitizeSenderName(undefined) === null && sanitizeSenderName("%E0%A4%A") === null && sanitizeSenderName("100%") === null,
  );
  const empty = parseClaimFragment("");
  ok(
    'parseClaimFragment("") and ("#") are no key, no name, no count, no lock',
    [empty, parseClaimFragment("#")].every((f) => f.key === "" && f.from === null && f.slots === null && f.passwordLocked === false),
  );
  const secret = Keypair.random().secret();
  ok(
    "  ...the first of a repeated parameter wins, unknown ones and bare words are ignored",
    (() => {
      const f = parseClaimFragment(`${secret}&s=Ayse&x=1&s=Mallory&bare&=v&p=0&p=1&g=4&g=6`);
      return f.key === secret && f.from === "Ayse" && f.passwordLocked === false && f.slots === 4;
    })(),
  );
  ok(
    "  ...a malformed name is no name and leaves the key and the rest alone",
    (() => {
      const f = parseClaimFragment(`${secret}&s=%E0%A4%A&g=6&p=1`);
      return f.key === secret && f.from === null && f.slots === 6 && f.passwordLocked;
    })(),
  );
  ok(
    "  ...the count goes through parseSlots (6x, 0x6, 600 and 1 are no count) and p is locked only for exactly 1",
    ["6x", "0x6", "600", "1", "6.0", ""].every((g) => parseClaimFragment(`${secret}&g=${g}`).slots === null) &&
      ["true", "01", "", "yes"].every((p) => !parseClaimFragment(`${secret}&p=${p}`).passwordLocked),
  );
  ok(
    "claimFragment builds the key, then &s=, then &g=, then &p=1, each only when it applies",
    claimFragment({ key: secret }) === secret &&
      claimFragment({ key: secret, from: "  " }) === secret &&
      claimFragment({ key: secret, from: " Ay&e ", slots: 6, passwordLocked: true }) === `${secret}&s=Ay%26e&g=6&p=1` &&
      claimFragment({ key: secret, slots: 6 }) === `${secret}&g=6`,
  );
  ok(
    "claimFragment refuses a key that is empty or could be read back as something else",
    ["", "S&p=1", "a=b", "S#x", "S x", "S\n", "S%26", `${secret}&s=x`].every((bad) => threw(() => claimFragment({ key: bad }))),
  );

  const want = readClaimQuery("?a=5&s=Ay%20se&g=3&p=1&n=public&seeded=1&preview=rich&src=ext");
  ok(
    "readClaimQuery reads location.search, a bare query string, a URLSearchParams and a Next.js record the same way",
    [
      readClaimQuery("a=5&s=Ay%20se&g=3&p=1&n=public&seeded=1&preview=rich&src=ext"),
      readClaimQuery(new URLSearchParams("a=5&s=Ay%20se&g=3&p=1&n=public&seeded=1&preview=rich&src=ext")),
      readClaimQuery({ a: "5", s: ["Ay se", "Mallory"], g: "3", p: "1", n: "public", seeded: "1", preview: "rich", src: "ext", unrelated: undefined }),
    ].every((q) => JSON.stringify(q) === JSON.stringify(want)) &&
      want.mainnet && want.slots === 3 && want.seeded && want.rich && want.legacy && want.queryName === "Ay se" && want.queryLocked,
    JSON.stringify(want),
  );
  ok(
    "  ...it answers with the seven fields and nothing else: the amount in `a` is never handed back",
    Object.keys(want).sort().join(",") === "legacy,mainnet,queryLocked,queryName,rich,seeded,slots",
  );
  ok(
    "  ...a private link with ?s= or ?p=1 appended gets no name and no lock from them",
    (() => {
      const q = readClaimQuery("?g=3&s=Mallory&p=1");
      return q.queryName === null && q.queryLocked === false && q.slots === 3 && !q.legacy && !q.rich;
    })(),
  );
  ok(
    "  ...a legacy link (the query carries a, even empty) is believed about its name and its lock",
    readClaimQuery("?a=&s=Ayse&p=1").legacy && readClaimQuery("?a=&s=Ayse&p=1").queryName === "Ayse" && readClaimQuery("?a=&s=Ayse&p=1").queryLocked,
  );
  ok(
    "  ...a legacy name with a percent sign comes back intact (decoded once, not twice)",
    readClaimQuery(`?a=1&s=${encodeURIComponent("100% #1")}`).queryName === "100% #1" && readClaimQuery({ a: "1", s: "100% #1" }).queryName === "100% #1",
  );
  ok(
    "  ...a fragment handed in by mistake is never read as a value",
    (() => {
      const q = readClaimQuery(`?g=3#${secret}&s=Mallory&p=1`);
      return q.slots === 3 && q.queryName === null && !q.queryLocked;
    })(),
  );
  ok(
    "the rich flag is preview=rich, the same constants in link-fragment and link-preview",
    RICH_PREVIEW_PARAM === "preview" && RICH_PREVIEW_VALUE === "rich" && preview.RICH_PREVIEW_PARAM === RICH_PREVIEW_PARAM && preview.RICH_PREVIEW_VALUE === RICH_PREVIEW_VALUE,
  );
  ok(
    "lumendrop re-exports the pool bounds and parseSlots from link-fragment, unchanged",
    lumendrop.parseSlots === parseSlots && lumendrop.MIN_POOL_SLOTS === MIN_POOL_SLOTS && lumendrop.MAX_POOL_SLOTS === MAX_POOL_SLOTS && MIN_POOL_SLOTS === 2 && MAX_POOL_SLOTS === 30,
  );
}

/* ---------------------------------------- [b] ---------------------------------------- */
async function sectionB() {
  console.log("\n[b] the beacon: an event name, hashed ids and counters, never a link, a name or an amount");
  const realFetch = globalThis.fetch;
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const bodies: { event: string; claimId: string; body: string }[] = [];
  let current = { event: "", claimId: "" };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push({ ...current, body: String(init?.body ?? "") });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  // No page and no sendBeacon: the worker road, a keepalive fetch whose body is the beacon's body
  // byte for byte (lib/ext-seam.selftest.ts [f] holds the two to each other).
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true, enumerable: true });
  try {
    const net = testnetConfig();
    const kp = Keypair.random();
    const linkHex = hex(kp.rawPublicKey());
    const account = Keypair.random().publicKey();
    const privateLink = lumendrop.v2LinkUrl({ webOrigin: "https://getlumenia.com", linkHex, amount: "2.50", from: "Ayse", fragment: kp.secret(), mainnet: true, seeded: true, src: "ext" });
    const richLink = lumendrop.v2LinkUrl({ webOrigin: "https://getlumenia.com", linkHex, amount: "2.50", from: "Ayse", fragment: kp.secret(), preview: "rich" });
    // What the claim pages and the send screens pass, and what a careless caller might pass instead.
    const fired: [string, string, string | undefined, Parameters<typeof sendEvent>[3]][] = [
      ["claim_opened", linkHex, undefined, { net, seeded: true }],
      ["claim_succeeded", linkHex, account, { net, seeded: true, durationS: 12.7, src: "ext" }],
      ["claim_failed", linkHex, account, { net }],
      ["send_started", account, account, { net }],
      ["send_link_created", account, account, { net, src: "ext" }],
      ["link_shared", linkHex, account, { net }],
      ["claim_opened", privateLink, undefined, { net }],
      ["claim_opened", richLink, privateLink, { net }],
    ];
    for (const [event, claimId, acct, opts] of fired) {
      current = { event, claimId };
      await sendEvent(event, claimId, acct, opts);
    }
    current = { event: "claim_amount_shown", claimId: linkHex };
    await sendEvent("claim_amount_shown", linkHex, account, { net });

    ok(`${fired.length} allowlisted events made ${fired.length} bodies, and an event off the allowlist made none`, bodies.length === fired.length, `${bodies.length} bodies`);
    const parsed = bodies.map((b) => ({ ...b, json: JSON.parse(b.body) as Record<string, unknown> }));
    const allowed = new Set(["event", "cid", "aid", "seeded", "dur", "src"]);
    ok("every body's keys are a subset of event, cid, aid, seeded, dur and src", parsed.every((p) => Object.keys(p.json).every((key) => allowed.has(key))), parsed.map((p) => Object.keys(p.json).join("+")).join(" "));
    ok("  ...and `event` is the event that was fired", parsed.every((p) => p.json.event === p.event));
    ok(
      "the ids are 16 hex characters of a hash: never the raw id, never a piece of it",
      parsed.every((p) => /^[0-9a-f]{16}$/.test(String(p.json.cid)) && p.json.cid !== p.claimId && !p.body.includes(p.claimId) && (p.json.aid === undefined || /^[0-9a-f]{16}$/.test(String(p.json.aid)))),
    );
    ok(
      'no body holds a URL, a fragment or a dollar sign: no "http", no "#", no "$", no "/v2/c/"',
      parsed.every((p) => !p.body.includes("http") && !p.body.includes("#") && !p.body.includes("$") && !p.body.includes("/v2/c/")),
    );
    ok(
      "no body holds an amount (no decimal number at all), the name, the key or the account",
      parsed.every((p) => !/\d\.\d/.test(p.body) && !p.body.includes("2.50") && !p.body.includes("Ayse") && !p.body.includes(kp.secret()) && !p.body.includes(account)),
    );
    ok("a duration is whole seconds, never the decimal it was measured as", parsed.filter((p) => "dur" in p.json).every((p) => p.json.dur === 12));
    ok(
      "a link handed in as the claim id hashes to an id like any other (the link itself never leaves)",
      parsed.slice(-2).every((p) => /^[0-9a-f]{16}$/.test(String(p.json.cid)) && !p.body.includes("preview") && !p.body.includes("s=") && !p.body.includes("n=public")),
    );
  } finally {
    globalThis.fetch = realFetch;
    if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

/* ---------------------------------------- [c] ---------------------------------------- */
async function sectionC() {
  console.log("\n[c] the headers: the claim routes send no referrer and ask not to be indexed");
  const entries = (await nextConfig.headers?.()) ?? [];
  const baseline = entries.findIndex((e) => e.source === "/:path*");
  ok("next.config.ts answers headers(), with the site-wide baseline", entries.length > 0 && baseline >= 0, `${entries.length} entries`);
  for (const source of ["/c/:id", "/c/:id/:path*", "/v2/c/:linkHex"]) {
    const at = entries.findIndex((e) => e.source === source);
    const h = new Map((entries[at]?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
    ok(
      `${source}: Referrer-Policy no-referrer and X-Robots-Tag noindex, nofollow`,
      at >= 0 && h.get("referrer-policy") === "no-referrer" && /\bnoindex\b/.test(h.get("x-robots-tag") ?? "") && /\bnofollow\b/.test(h.get("x-robots-tag") ?? ""),
      at >= 0 ? JSON.stringify(Object.fromEntries(h)) : "missing",
    );
    ok("  ...and it comes after the baseline, so its Referrer-Policy is the one that stands", at > baseline);
  }
}

async function main() {
  console.log("============================================================");
  console.log(" SELF-TEST - link privacy (D2 private links)");
  console.log("============================================================\n");
  sectionA();
  await sectionB();
  await sectionC();
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} LINK PRIVACY SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
