/**
 * ============================================================================
 *  TEST — recovery store namespaces (the OTP-bypass guard)
 * ============================================================================
 *
 *  "Find my money with Face ID" adds a fetch route that is NOT gated by an emailed code. That is
 *  safe only because the id it reads is 256 bits derived from a passkey, and it is stored in a
 *  DIFFERENT namespace from the email-keyed boxes.
 *
 *  The danger this file exists to catch: the server cannot tell the two ids apart. Both are 64
 *  lowercase hex and both satisfy ID_RE. If the alias route could ever read the email namespace,
 *  anyone who knows a victim's email address could compute SHA-256 of it and fetch their backup
 *  with no code at all. The first two checks below ARE that guarantee, in both directions.
 *
 *  RUN: pnpm --filter @lumenia/sponsor test:recovery-store   (no network, no keys)
 * ============================================================================
 */
import { putBox, getBox, putAliasBox, getAliasBox, validateBox } from "./lib/recovery-store.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}
async function rejects(name: string, fn: () => Promise<unknown>, expect?: string) {
  try {
    await fn();
    ok(name, false, "did NOT reject");
  } catch (e) {
    const msg = (e as Error).message;
    ok(name, expect ? msg.toLowerCase().includes(expect.toLowerCase()) : true, msg.slice(0, 70));
  }
}

const hex = (c: string) => c.repeat(64);
const EMAIL_ID = hex("a");
const ALIAS_ID = hex("b");
const BOX = {
  formatVersion: 1,
  copies: [
    { kind: "prf", iv: "AAAA", ct: "BBBB", hkdfSalt: "CCCC" },
    { kind: "password", iv: "AAAA", ct: "BBBB", salt: "CCCC", argon: { memMiB: 48, time: 2, parallelism: 1 } },
  ],
};

async function main(): Promise<void> {
  console.log("============================================================");
  console.log(" TEST — recovery store namespaces");
  console.log("============================================================\n");

  /* ---- THE INVARIANT. Everything else in this file is secondary. ---- */
  await putBox(EMAIL_ID, BOX);
  ok(
    "an EMAIL-keyed box is NOT readable through the alias route (no OTP bypass)",
    (await getAliasBox(EMAIL_ID)) === null,
  );

  await putAliasBox(ALIAS_ID, BOX);
  ok(
    "an ALIAS box is NOT readable through the email route (namespaces are separate)",
    (await getBox(ALIAS_ID)) === null,
  );

  ok("the email box round-trips in its own namespace", JSON.stringify(await getBox(EMAIL_ID)) === JSON.stringify(BOX));
  ok("the alias box round-trips in its own namespace", JSON.stringify(await getAliasBox(ALIAS_ID)) === JSON.stringify(BOX));
  ok("a missing alias id returns null, not an error", (await getAliasBox(hex("c"))) === null);

  /* ---- The alias path reuses the SAME validation, not a looser copy of it ---- */
  await rejects("alias put rejects a non-hex id", () => putAliasBox("not-a-hex-id", BOX), "64-char hex");
  await rejects("alias put rejects a short id", () => putAliasBox("abc", BOX), "64-char hex");
  await rejects("alias fetch rejects a non-hex id", () => getAliasBox("../../etc/passwd"), "64-char hex");
  await rejects(
    "alias put rejects a box carrying an extra field (the ciphertext-only guarantee)",
    () => putAliasBox(hex("d"), { ...BOX, seed: "oops" }),
    "unexpected fields",
  );
  await rejects(
    "alias put rejects a copy with a plaintext-looking extra key",
    () => putAliasBox(hex("e"), { formatVersion: 1, copies: [{ kind: "prf", iv: "A", ct: "B", hkdfSalt: "C", password: "hunter2" }] }),
    "invalid shape",
  );
  await rejects(
    "alias put rejects a weak Argon2id floor (a box that would be cheap to crack offline)",
    () => putAliasBox(hex("f"), { formatVersion: 1, copies: [{ kind: "password", iv: "A", ct: "B", salt: "C", argon: { memMiB: 1, time: 1, parallelism: 1 } }] }),
    "invalid shape",
  );

  /* ---- validateBox is genuinely SHARED, not re-implemented per namespace ---- */
  ok("validateBox accepts the good box", (() => {
    try {
      validateBox(BOX);
      return true;
    } catch {
      return false;
    }
  })());

  console.log(`\n${failed === 0 ? "✅" : "❌"} RECOVERY STORE TESTS ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("\n💥 recovery store test crashed:", e);
  process.exit(1);
});
