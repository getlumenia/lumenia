/**
 * Wallets Kit adapter self-test: the seam between an external wallet and this app's `Signer`.
 *
 * The kit itself (Freighter, xBull, LOBSTR connectors and their modal) needs a browser and a real
 * wallet; nothing here loads it. What CAN be pinned offline is the adapter's contract, and it is
 * the part that would lose money if wrong: the transaction handed to the wallet must be the
 * transaction that comes back, signed by the address the person connected, and a wallet that
 * returns something else must be refused before the sponsor is asked to fee-bump it.
 *
 * RUN: pnpm --filter @lumenia/web test:walletkit   (offline, no keys)
 */
import { Account, Asset, BASE_FEE, FeeBumpTransaction, Keypair, Networks, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "./network";
import { externalWalletSigner, walletsKitEnabled, type SignXdr } from "./wallets-kit";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}
async function throws(name: string, fn: () => Promise<unknown>, mustMention?: string) {
  try {
    await fn();
    ok(name, false, "it did NOT throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(name, mustMention ? msg.toLowerCase().includes(mustMention.toLowerCase()) : true, msg.slice(0, 70));
  }
}

const NET: NetworkConfig = {
  id: "testnet",
  passphrase: Networks.TESTNET,
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contract: "C".padEnd(56, "A"),
  legacyContracts: [],
  sponsorUrl: "https://sponsor.invalid",
  isMainnet: false,
};

const wallet = Keypair.random();
const stranger = Keypair.random();

/** Two calls in the same second build the same transaction, so a different one needs a different amount. */
function unsignedTx(amount = "1"): Transaction {
  return new TransactionBuilder(new Account(wallet.publicKey(), "1"), { fee: BASE_FEE, networkPassphrase: NET.passphrase })
    .addOperation(Operation.payment({ destination: stranger.publicKey(), asset: Asset.native(), amount }))
    .setTimeout(60)
    .build();
}

function parseTx(xdr: string, passphrase: string): Transaction {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  if (tx instanceof FeeBumpTransaction) throw new Error("fee bump");
  return tx;
}

/** A wallet that behaves: parses the XDR it is given, signs it, hands the XDR back. */
const honest: SignXdr = async (xdr, opts) => {
  const tx = parseTx(xdr, opts.networkPassphrase);
  tx.sign(wallet);
  return { signedTxXdr: tx.toXDR() };
};

console.log("============================================================");
console.log(" SELF-TEST — Stellar Wallets Kit adapter (the Signer seam)");
console.log("============================================================\n");

async function main() {
  console.log("[flag] the control is off unless the deployment says so");
  {
    delete process.env.NEXT_PUBLIC_WALLETS_KIT;
    ok("off by default", walletsKitEnabled() === false);
    process.env.NEXT_PUBLIC_WALLETS_KIT = "1";
    ok("on when NEXT_PUBLIC_WALLETS_KIT=1", walletsKitEnabled() === true);
    process.env.NEXT_PUBLIC_WALLETS_KIT = "true";
    ok("...and only for the exact value 1", walletsKitEnabled() === false);
  }

  console.log("\n[sign] the wallet signs a copy; the adapter returns the signed copy");
  {
    const seen: { xdr: string; address: string; passphrase: string }[] = [];
    const spy: SignXdr = async (xdr, opts) => {
      seen.push({ xdr, address: opts.address, passphrase: opts.networkPassphrase });
      return honest(xdr, opts);
    };
    const signer = externalWalletSigner(wallet.publicKey(), NET, spy);
    ok("the signer reports the wallet's address", signer.publicKey() === wallet.publicKey());
    ok("...and its kind", signer.kind === "external-wallet");
    ok("...and offers no raw message signing", signer.signMessage === undefined);
    const tx = unsignedTx();
    const signed = await signer.sign(tx);
    ok("the wallet was given this transaction's XDR", seen[0]?.xdr === tx.toXDR());
    ok("...for this address on this network", seen[0]?.address === wallet.publicKey() && seen[0]?.passphrase === NET.passphrase);
    ok("the returned transaction is the same transaction", signed.hash().toString("hex") === tx.hash().toString("hex"));
    ok("...now carrying the wallet's signature", signed.signatures.length === 1 && wallet.verify(signed.hash(), signed.signatures[0]!.signature()));
    ok("the object passed in was NOT mutated (an external wallet cannot touch it)", tx.signatures.length === 0);
  }

  console.log("\n[refuse] anything but the same transaction, signed, is refused before the sponsor sees it");
  {
    const signer = (fn: SignXdr) => externalWalletSigner(wallet.publicKey(), NET, fn);
    await throws(
      "a wallet that returns a DIFFERENT transaction is refused",
      () => signer(async () => ({ signedTxXdr: (() => { const t = unsignedTx("2"); t.sign(wallet); return t.toXDR(); })() })).sign(unsignedTx("1")),
      "different transaction",
    );
    await throws(
      "a wallet that returns the transaction unsigned is refused",
      () => signer(async (xdr) => ({ signedTxXdr: xdr })).sign(unsignedTx()),
      "unsigned",
    );
    await throws(
      "a wallet that returns a fee-bump envelope is refused",
      () =>
        signer(async (xdr, opts) => {
          const inner = parseTx(xdr, opts.networkPassphrase);
          inner.sign(wallet);
          const bump = TransactionBuilder.buildFeeBumpTransaction(stranger, "1000", inner, opts.networkPassphrase);
          bump.sign(stranger);
          return { signedTxXdr: bump.toXDR() };
        }).sign(unsignedTx()),
      "fee-bump",
    );
    await throws(
      "a wallet that returns garbage is refused",
      () => signer(async () => ({ signedTxXdr: "not xdr" })).sign(unsignedTx()),
    );
    await throws(
      "a wallet that declines (throws) surfaces as a refusal, nothing signed",
      () => signer(async () => { throw new Error("User declined"); }).sign(unsignedTx()),
      "declined",
    );
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} WALLETS KIT ADAPTER SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
