"use client";

/**
 * Stellar Wallets Kit: "fund this link from a wallet you already have" (Freighter, xBull, LOBSTR,
 * Hot Wallet). Second partner on the money-in path (decision D7; HACKATHON_DURING.md 2.4).
 *
 * WHAT IT IS AND IS NOT. The external wallet is the SENDER of an ordinary LumenDrop deposit: the
 * app builds the same sender-sourced `deposit` transaction it builds for a Lumenia account, the
 * external wallet signs it, and the sponsor fee-bumps it through /v2-deposit exactly as before.
 * Nothing about the escrow, the link or the claim changes; the only new thing is WHO signs. The
 * recipient still needs no wallet, no app and no XLM. On mainnet the external wallet must be on
 * the pilot allowlist like any sender (PILOT_MODE); testnet is open.
 *
 * LOADED ON DEMAND. The kit ships every wallet's connector (Ledger, WalletConnect, ...) and a
 * Lit-based modal. None of it belongs in the claim route or the first paint of /send, so the
 * import happens inside the click handler, and only the four modules named above are registered
 * (each is its own subpath export, so nothing else is pulled in).
 *
 * PACKAGE. The kit lives on JSR; pnpm 9 has no `jsr:` specifier, so package.json aliases
 * `@creit-tech/stellar-wallets-kit` to `npm:@jsr/creit-tech__stellar-wallets-kit@2.5.0` through
 * the JSR npm-compat registry (`.npmrc`). 2.5.0 is the last release on stellar-sdk ^16; 2.6.0 moved
 * to ^17, which this repo does not use (16.3.0, pinned in both apps).
 *
 * FEATURE FLAG. `NEXT_PUBLIC_WALLETS_KIT=1` shows the control on /send. Off by default so a
 * deployment that has not been through a wallet on a real device does not advertise it.
 */
import { FeeBumpTransaction, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "./network";
import type { Signer } from "./signer";

export function walletsKitEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WALLETS_KIT === "1";
}

/** What the kit gives back once a person picked a wallet and it handed over its address. */
export interface ExternalWallet {
  address: string;
}

let initialised: string | null = null;

/**
 * Open the kit's wallet picker and return the chosen wallet's address.
 *
 * The kit is a static singleton: `init` once per network passphrase, then `authModal` opens the
 * picker and asks the wallet for its public key. Re-initialising on a network switch is cheap and
 * keeps `setNetwork` and the module list in step with the device's active network.
 */
export async function connectExternalWallet(net: NetworkConfig): Promise<ExternalWallet> {
  const [{ StellarWalletsKit }, { FreighterModule }, { xBullModule }, { LobstrModule }, { HotWalletModule }] = await Promise.all([
    import("@creit-tech/stellar-wallets-kit/sdk"),
    import("@creit-tech/stellar-wallets-kit/modules/freighter"),
    import("@creit-tech/stellar-wallets-kit/modules/xbull"),
    import("@creit-tech/stellar-wallets-kit/modules/lobstr"),
    import("@creit-tech/stellar-wallets-kit/modules/hotwallet"),
  ]);
  if (initialised !== net.passphrase) {
    StellarWalletsKit.init({
      modules: [new FreighterModule(), new xBullModule(), new LobstrModule(), new HotWalletModule()],
      // The kit's own enum holds the same passphrase strings; passing ours keeps one source.
      network: net.passphrase as unknown as Parameters<typeof StellarWalletsKit.setNetwork>[0],
      authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
    });
    initialised = net.passphrase;
  }
  const { address } = await StellarWalletsKit.authModal();
  if (!address) throw new Error("the wallet did not hand over an address");
  return { address };
}

/** Forget the connected wallet. Nothing on chain changes; the kit only clears its memory. */
export async function disconnectExternalWallet(): Promise<void> {
  try {
    const { StellarWalletsKit } = await import("@creit-tech/stellar-wallets-kit/sdk");
    await StellarWalletsKit.disconnect();
  } catch {
    /* nothing to forget */
  } finally {
    initialised = null;
  }
}

/** The one call the adapter needs from the kit: XDR in, signed XDR out. Injectable for tests. */
export type SignXdr = (xdr: string, opts: { networkPassphrase: string; address: string }) => Promise<{ signedTxXdr: string }>;

async function kitSign(xdr: string, opts: { networkPassphrase: string; address: string }): Promise<{ signedTxXdr: string }> {
  const { StellarWalletsKit } = await import("@creit-tech/stellar-wallets-kit/sdk");
  return StellarWalletsKit.signTransaction(xdr, opts);
}

/**
 * A `Signer` backed by an external wallet.
 *
 * The wallet signs a COPY: it receives XDR and returns XDR, so the transaction object the caller
 * passed in is never mutated. Callers must therefore use the transaction this returns, not the one
 * they passed (lib/lumendrop.ts::createV2Link does). The returned envelope is re-parsed with this
 * app's SDK against the expected passphrase and checked to be the same transaction (same hash
 * before signatures), so a wallet that swapped the envelope is refused here rather than relayed.
 *
 * No `signMessage`: an external wallet's message signing is not the raw-Ed25519 shape the
 * identity routes verify, and nothing on the funding path needs it.
 */
export function externalWalletSigner(address: string, net: NetworkConfig, signXdr: SignXdr = kitSign): Signer {
  return {
    kind: "external-wallet",
    publicKey: () => address,
    sign: async (tx: Transaction) => {
      const expectedHash = tx.hash().toString("hex");
      const { signedTxXdr } = await signXdr(tx.toXDR(), { networkPassphrase: net.passphrase, address });
      const signed = TransactionBuilder.fromXDR(signedTxXdr, net.passphrase);
      if (signed instanceof FeeBumpTransaction) throw new Error("the wallet returned a fee-bump envelope, not the transaction it was given");
      if (signed.hash().toString("hex") !== expectedHash) throw new Error("the wallet returned a different transaction than the one it was given");
      if (signed.signatures.length === 0) throw new Error("the wallet returned the transaction unsigned");
      return signed;
    },
  };
}
