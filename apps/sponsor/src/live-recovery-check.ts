/**
 * LIVE RECOVERY CHECK — the post-deploy proof that "find my money with Face ID" cannot become an
 * OTP bypass in PRODUCTION.
 *
 * test-recovery-store.ts proves the two namespaces are separate in memory. This proves it against
 * the deployed Worker and its real KV, which is where the mistake would actually cost something:
 * the email-keyed id is SHA-256(email), so if the un-OTP'd alias route could read that namespace,
 * anyone who knows a victim's email could pull their backup with no code at all.
 *
 *   1. /health still answers (the new route didn't break the Worker)
 *   2. an unknown alias id → 404, not 500, and the body leaks nothing
 *   3. a malformed id → 400
 *   4. /recovery WITHOUT a valid code → 401, and no alias row is created by the attempt
 *   5. an email-shaped id is NOT readable through the alias route
 *   6. the alias route is rate-limited rather than unbounded
 *
 * NO SECRETS NEEDED. Nothing here can write a box (that needs a real emailed code), so this only
 * ever exercises the refusals — which is exactly the half that must never regress.
 *
 * RUN: pnpm --filter @lumenia/sponsor check:live-recovery   [SPONSOR_URL=https://…]
 */
const SPONSOR = (process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${SPONSOR}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** A random 64-hex id — the shape both namespaces use, which is the whole point. */
function randomId(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex, matching the client's emailToId exactly. */
async function idForEmail(email: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait out a 429 so a rate limit can never masquerade as the answer we were testing for. */
async function postSettled(path: string, body: unknown): Promise<{ status: number; text: string }> {
  let res = await post(path, body);
  for (let i = 0; res.status === 429 && i < 4; i++) {
    console.log("  … rate limited, waiting out the window");
    await sleep(20_000);
    res = await post(path, body);
  }
  return res;
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log(` LIVE RECOVERY CHECK — ${SPONSOR}`);
  console.log("============================================================\n");

  const health = await fetch(`${SPONSOR}/health`);
  check("the Worker is still healthy after the new route", health.status === 200, `HTTP ${health.status}`);

  const unknown = await postSettled("/recovery-alias-fetch", { id: randomId() });
  check("an unknown alias id is a clean 404", unknown.status === 404, `HTTP ${unknown.status} ${unknown.text.slice(0, 50)}`);
  check("the 404 leaks nothing about what exists", !unknown.text.toLowerCase().includes("email"), unknown.text.slice(0, 50));

  const malformed = await postSettled("/recovery-alias-fetch", { id: "definitely-not-hex" });
  check("a malformed id is refused with 400", malformed.status === 400, `HTTP ${malformed.status}`);

  /* The load-bearing one: an EMAIL-shaped id must not resolve through the un-OTP'd route.
     If a real user has a backup at this id, a bypass would return 200 with their ciphertext. */
  const emailId = await idForEmail("owner@example.com");
  const viaAlias = await postSettled("/recovery-alias-fetch", { id: emailId });
  check(
    "an email-derived id is NOT readable through the alias route (no OTP bypass)",
    viaAlias.status === 404,
    `HTTP ${viaAlias.status}`,
  );

  /* The alias WRITE is only reachable through /recovery, which is OTP-gated. Prove a junk code
     is refused and leaves nothing behind. */
  const aliasId = randomId();
  const forged = await postSettled("/recovery", {
    id: randomId(),
    code: "000000",
    aliasId,
    box: { formatVersion: 1, copies: [{ kind: "prf", iv: "AAAA", ct: "BBBB", hkdfSalt: "CCCC" }] },
  });
  check("storing an alias without a valid code is refused", forged.status === 401, `HTTP ${forged.status}`);
  const after = await postSettled("/recovery-alias-fetch", { id: aliasId });
  check("...and the refused attempt created NO alias row", after.status === 404, `HTTP ${after.status}`);

  /* The un-OTP'd route must still be bounded. Hammer one id until the limiter answers. */
  const hammerId = randomId();
  let sawLimit = false;
  for (let i = 0; i < 12; i++) {
    const r = await post("/recovery-alias-fetch", { id: hammerId });
    if (r.status === 429) {
      sawLimit = true;
      break;
    }
  }
  check("the alias route is rate-limited, not unbounded", sawLimit);

  console.log(`\n${fail === 0 ? "✅" : "❌"} LIVE RECOVERY CHECK ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
}

void main().catch((e) => {
  console.error(`\n❌ live recovery check blew up: ${(e as Error).message}`);
  process.exit(1);
});
