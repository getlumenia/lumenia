/**
 * LIVE PAYOUT CHECK — the post-deploy smoke test for /payout, run over HTTP against the
 * DEPLOYED sponsor Worker. It proves the deployed configuration behaves, not just that
 * the code compiles: the anti-drain unit tests (test-antidrain.ts) run the validator in
 * memory, this runs the real endpoint, the real signer and a real testnet ledger.
 *
 * /payout is the cash-out leg: a 0-XLM user sends their own dollars to an address someone
 * gave them (an exchange deposit account). The thing that decides whether that money is
 * credited or lost in a shared pot is the MEMO, so the memo is what this checks hardest.
 *
 *   1. a 0-XLM sender really can pay out (the sponsor covers the fee)
 *   2. the MEMO the user typed is the memo that lands on the ledger  ← the deposit-credit invariant
 *   3. a muxed M… destination works with no memo at all (SEP-23)
 *   4. a declared destination that differs from the signed one is REJECTED (swap attempt)
 *   5. a declared amount that differs from the signed one is REJECTED
 *   6. a non-USDC payment is REJECTED (the sponsor only fee-sponsors the one asset)
 *   7. a sponsor-sourced payment is REJECTED (the classic drain)
 *   8. a second op in the same tx is REJECTED (payout is exactly one payment)
 *
 * NO SECRETS NEEDED. The sender is built from the sponsor's own public endpoints
 * (/create-account + /faucet) and the stand-in "exchange" account is friendbot-funded, so
 * anyone can run this against any deployment right after `wrangler deploy`.
 *
 * RUN: pnpm --filter @lumenia/sponsor check:live-payout
 *      [SPONSOR_URL=https://…]   (defaults to the deployed Worker)
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  MuxedAccount,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";

const SPONSOR = (process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
const NET = Networks.TESTNET;
const HZ = new Horizon.Server("https://horizon-testnet.stellar.org");

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A rejection check that proves WHY the request was refused.
 *
 * A plain "not 200" is not good enough here. The rate limiter also returns non-200, so
 * an attack shape that the policy would have HAPPILY ACCEPTED can look rejected simply
 * because the run was too fast — a green tick for a hole. This waits out a 429 (the
 * limiter is a 60s window) and then asserts the status AND the reason.
 */
async function expectRejected(name: string, path: string, body: unknown, reasonIncludes: string): Promise<void> {
  let res = await post(path, body);
  for (let i = 0; res.status === 429 && i < 4; i++) {
    process.stdout.write(`  … rate limited, waiting out the window before ${name}\n`);
    await sleep(20_000);
    res = await post(path, body);
  }
  if (res.status === 429) {
    check(name, false, "still rate limited — inconclusive, re-run");
    return;
  }
  const ok = res.status === 400 && res.text.toLowerCase().includes(reasonIncludes.toLowerCase());
  check(name, ok, `HTTP ${res.status} ${res.text.slice(0, 90)}`);
}

/** Same wait-out treatment for the calls that are SUPPOSED to succeed. */
async function postExpectingSuccess(path: string, body: unknown): Promise<{ status: number; text: string }> {
  let res = await post(path, body);
  for (let i = 0; res.status === 429 && i < 4; i++) {
    process.stdout.write("  … rate limited, waiting out the window\n");
    await sleep(20_000);
    res = await post(path, body);
  }
  return res;
}

async function friendbot(pub: string): Promise<void> {
  const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${pub}: ${r.status}`);
}

async function usdcBalance(pub: string, usdc: Asset): Promise<string> {
  const acc = await HZ.loadAccount(pub);
  const line = acc.balances.find(
    (b) => "asset_code" in b && b.asset_code === usdc.getCode() && b.asset_issuer === usdc.getIssuer(),
  );
  return line && "balance" in line ? line.balance : "0";
}

/** Build + sign the payout inner tx exactly the way apps/web/lib/payout.ts does. */
async function buildPayout(
  sender: Keypair,
  usdc: Asset,
  opts: { destination: string; amount: string; memo?: string; asset?: Asset; source?: string; extraOp?: xdr.Operation },
): Promise<string> {
  const acc = await HZ.loadAccount(sender.publicKey());
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET }).addOperation(
    Operation.payment({
      destination: opts.destination,
      asset: opts.asset ?? usdc,
      amount: opts.amount,
      source: opts.source ?? sender.publicKey(),
    }),
  );
  if (opts.extraOp) b.addOperation(opts.extraOp);
  if (opts.memo) b.addMemo(Memo.text(opts.memo));
  const tx = b.setTimeout(180).build();
  tx.sign(sender);
  return tx.toXDR();
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log(` LIVE PAYOUT CHECK — ${SPONSOR}`);
  console.log("============================================================\n");

  const health = (await (await fetch(`${SPONSOR}/health`)).json()) as {
    sponsorPublicKey: string;
    usdcCode: string;
    usdcIssuer: string;
  };
  const USDC = new Asset(health.usdcCode, health.usdcIssuer);
  console.log(`  sponsor ${health.sponsorPublicKey}\n  usdc    ${USDC.getCode()}:${health.usdcIssuer.slice(0, 8)}…\n`);

  /* --- the sender: a real sponsored 0-XLM account, exactly what a claimer ends up with --- */
  const sender = Keypair.random();
  const created = await post("/create-account", { recipientPublicKey: sender.publicKey() });
  if (created.status !== 200) throw new Error(`/create-account ${created.status}: ${created.text}`);
  const sandwich = TransactionBuilder.fromXDR(
    (JSON.parse(created.text) as { xdr: string }).xdr,
    NET,
  ) as Transaction;
  sandwich.sign(sender);
  await HZ.submitTransaction(sandwich);

  const funded = await post("/faucet", { recipientPublicKey: sender.publicKey() });
  if (funded.status !== 200) throw new Error(`/faucet ${funded.status}: ${funded.text}`);

  const senderXlm = (await HZ.loadAccount(sender.publicKey())).balances.find((b) => b.asset_type === "native");
  check(
    "sender holds 0 XLM (so every payout below is genuinely sponsored)",
    Number.parseFloat(senderXlm && "balance" in senderXlm ? senderXlm.balance : "-1") === 0,
    `${senderXlm && "balance" in senderXlm ? senderXlm.balance : "?"} XLM`,
  );

  /* --- the destination: a stand-in for an exchange's shared deposit account --- */
  const exchange = Keypair.random();
  await friendbot(exchange.publicKey());
  {
    const acc = await HZ.loadAccount(exchange.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET })
      .addOperation(Operation.changeTrust({ asset: USDC }))
      .setTimeout(60)
      .build();
    tx.sign(exchange);
    await HZ.submitTransaction(tx);
  }

  /* --- 1 + 2: the happy path, and the memo that decides whether a deposit is credited --- */
  const TAG = `LUMENIA-${Date.now().toString().slice(-8)}`;
  const before = await usdcBalance(exchange.publicKey(), USDC);
  const happy = await postExpectingSuccess("/payout", {
    xdr: await buildPayout(sender, USDC, { destination: exchange.publicKey(), amount: "3.00", memo: TAG }),
    senderPublicKey: sender.publicKey(),
    destination: exchange.publicKey(),
    amount: "3.00",
  });
  check("a 0-XLM sender can pay out (sponsor covers the fee)", happy.status === 200, `HTTP ${happy.status}`);

  const after = await usdcBalance(exchange.publicKey(), USDC);
  check(
    "the dollars actually arrived at the destination",
    Number.parseFloat(after) - Number.parseFloat(before) === 3,
    `${before} → ${after}`,
  );

  if (happy.status === 200) {
    const { hash } = JSON.parse(happy.text) as { hash: string };
    // Read the memo back off the LEDGER, not off our own request. This is the whole
    // point: a fee-bump that dropped the memo would make every exchange deposit
    // unattributable, and nothing else in the stack would notice.
    const landed = await HZ.transactions().transaction(hash).call();
    check(
      "the memo the user typed is the memo on the ledger (deposit-credit invariant)",
      landed.memo === TAG && landed.memo_type === "text",
      `${landed.memo_type}:${String(landed.memo ?? "")}`,
    );
  } else {
    check("the memo the user typed is the memo on the ledger (deposit-credit invariant)", false, "payout failed");
  }

  /* --- 3: a muxed destination — the shape where the memo cannot be got wrong --- */
  const muxed = new MuxedAccount(new Account(exchange.publicKey(), "0"), "80085").accountId();
  const beforeMux = await usdcBalance(exchange.publicKey(), USDC);
  const muxedRes = await postExpectingSuccess("/payout", {
    xdr: await buildPayout(sender, USDC, { destination: muxed, amount: "1.50" }),
    senderPublicKey: sender.publicKey(),
    destination: muxed,
    amount: "1.50",
  });
  check("a muxed M… destination is accepted with no memo at all", muxedRes.status === 200, `HTTP ${muxedRes.status}`);
  check(
    "the muxed payout landed on the underlying account",
    Number.parseFloat(await usdcBalance(exchange.publicKey(), USDC)) - Number.parseFloat(beforeMux) === 1.5,
  );

  /* --- 4-8: the rejections. Each must be refused by the deployed POLICY, with its own
         reason — never merely by the rate limiter (see expectRejected). --- */
  const attacker = Keypair.random();

  await expectRejected(
    "a destination swap (declared ≠ signed) is rejected",
    "/payout",
    {
      xdr: await buildPayout(sender, USDC, { destination: attacker.publicKey(), amount: "1.00" }),
      senderPublicKey: sender.publicKey(),
      destination: exchange.publicKey(), // declared ≠ signed
      amount: "1.00",
    },
    "declared destination",
  );

  await expectRejected(
    "an amount mismatch is rejected",
    "/payout",
    {
      xdr: await buildPayout(sender, USDC, { destination: exchange.publicKey(), amount: "9.00" }),
      senderPublicKey: sender.publicKey(),
      destination: exchange.publicKey(),
      amount: "1.00",
    },
    "declared",
  );

  await expectRejected(
    "a non-USDC payout is rejected",
    "/payout",
    {
      xdr: await buildPayout(sender, USDC, {
        destination: exchange.publicKey(),
        amount: "1.00",
        asset: Asset.native(),
      }),
      senderPublicKey: sender.publicKey(),
      destination: exchange.publicKey(),
      amount: "1.00",
    },
    "not the expected USDC",
  );

  await expectRejected(
    "a sponsor-sourced payment is rejected (the classic drain)",
    "/payout",
    {
      xdr: await buildPayout(sender, USDC, {
        destination: attacker.publicKey(),
        amount: "1.00",
        source: health.sponsorPublicKey, // spend the SPONSOR's dollars
      }),
      senderPublicKey: sender.publicKey(),
      destination: attacker.publicKey(),
      amount: "1.00",
    },
    "sourced from sponsor",
  );

  await expectRejected(
    "a smuggled second payment op is rejected",
    "/payout",
    {
      xdr: await buildPayout(sender, USDC, {
        destination: exchange.publicKey(),
        amount: "1.00",
        extraOp: Operation.payment({
          destination: attacker.publicKey(),
          asset: USDC,
          amount: "1.00",
          source: sender.publicKey(),
        }),
      }),
      senderPublicKey: sender.publicKey(),
      destination: exchange.publicKey(),
      amount: "1.00",
    },
    "exactly one payment op",
  );

  console.log(`\n${fail === 0 ? "✅" : "❌"} LIVE PAYOUT CHECK ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
}

void main().catch((e) => {
  console.error(`\n❌ live payout check blew up: ${(e as Error).message}`);
  process.exit(1);
});
