"use client";

/**
 * /add-money/base: bring USDC from Base into this Lumenia account with Circle CCTP (hackathon build,
 * 2026-09-19; D27 item 2.3, Circle is the primary partner). Test network only: Base Sepolia to
 * Stellar testnet.
 *
 * What happens, in the order the screen shows it:
 *   1. The person connects a wallet that holds USDC on Base (MetaMask or any injected wallet) and
 *      it is switched to Base Sepolia.
 *   2. They approve USDC once, then burn it with Circle's `depositForBurnWithHook`. The hook names
 *      THIS Lumenia account; the burn names Circle's Stellar CctpForwarder as the only party that
 *      may mint (lib/cctp.ts, golden-tested against the bytes that minted on 2026-09-19).
 *   3. Our sponsor relays the mint on Stellar (`POST /cctp-relay`): it reads Circle's attestation
 *      itself and pays the Stellar fee. The person holds no XLM and pays nothing on Stellar.
 *   4. The USDC is in the account, and leaves as a link like any other dollars.
 *
 * The EVM side is the person's own wallet: we never see a key, and the two Base transactions are
 * theirs to approve in their wallet. viem is loaded only when they tap Connect.
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../../lib/wallet";
import { loadBalance } from "../../../../lib/horizon";
import { prepareAccount } from "../../../../lib/sponsor";
import { isNeedsPassword } from "../../../../lib/signer-error";
import { sanitizeAmountInput } from "../../../../lib/money";
import { sendEvent } from "../../../../lib/events";
import { activeNetwork, explorerTx } from "../../../../lib/network";
import {
  askRelay,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  burnToStellar,
  ERC20_ABI,
  parseUsdc6,
} from "../../../../lib/cctp";
import { MoneyCard } from "../../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../../components/brand/PrimaryButton";
import type { Hex, PublicClient, WalletClient } from "viem";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

type Stage = "idle" | "approving" | "burning" | "attesting" | "stalled" | "done";

/* Circle's attestation takes tens of seconds, so asking every 4 s only spent the sponsor's per-IP
   allowance faster than the answer could change. At 8 s a whole 15-minute wait costs about 112
   asks, which leaves room for the rest of the room on the same venue Wi-Fi. */
const RELAY_POLL_MS = 8_000;
/** How long to stand down when the sponsor rate-limits us. Its window is a minute; waiting out half
 *  of it gets back in without abandoning a burn that has already happened on Base. */
const RELAY_THROTTLE_MS = 30_000;
const RELAY_WAIT_MS = 15 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function BringFromBasePage() {
  const { status, account, getSigner } = useWallet();
  const router = useRouter();
  const net = activeNetwork();

  const [evmAddress, setEvmAddress] = useState<Hex | null>(null);
  const [baseUsdc, setBaseUsdc] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [burnHash, setBurnHash] = useState<Hex | null>(null);
  const [mintHash, setMintHash] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const clients = useRef<{ wallet: WalletClient; pub: PublicClient } | null>(null);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  function provider(): Eip1193 | null {
    return typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;
  }

  async function connect() {
    setError("");
    const eth = provider();
    if (!eth) return setError("No Base wallet was found in this browser. Open this page where MetaMask (or another Base wallet) is installed.");
    try {
      const [{ createPublicClient, createWalletClient, custom, formatUnits }, { baseSepolia }] = await Promise.all([import("viem"), import("viem/chains")]);
      const [addr] = (await eth.request({ method: "eth_requestAccounts" })) as Hex[];
      if (!addr) throw new Error("the wallet shared no account");
      const wallet = createWalletClient({ account: addr, chain: baseSepolia, transport: custom(eth) });
      try {
        await wallet.switchChain({ id: BASE_SEPOLIA_CHAIN_ID });
      } catch (e) {
        // 4902: the wallet does not know Base Sepolia yet. Offer it, then switch.
        if ((e as { code?: number })?.code === 4902 || /4902|unrecognized chain/i.test(String((e as Error)?.message))) {
          await wallet.addChain({ chain: baseSepolia });
          await wallet.switchChain({ id: BASE_SEPOLIA_CHAIN_ID });
        } else throw e;
      }
      const pub = createPublicClient({ chain: baseSepolia, transport: custom(eth) });
      clients.current = { wallet, pub: pub as PublicClient };
      setEvmAddress(addr);
      const bal = (await pub.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] })) as bigint;
      setBaseUsdc(formatUnits(bal, 6));
    } catch (e) {
      setError(e instanceof Error ? `The wallet said: ${e.message.split("\n")[0]}` : "Couldn't connect the wallet.");
    }
  }

  /**
   * Ask the sponsor to mint until it has. Separate from the burn so a dropped connection after the
   * burn can be retried without burning again: the burn is on Base, and only the Stellar side is
   * left.
   */
  async function relay(burn: Hex) {
    setError("");
    setStage("attesting");
    setDetail("Circle is attesting the transfer…");
    const started = Date.now();
    const deadline = started + RELAY_WAIT_MS;
    /* askRelay turns every refusal into a message and loses the status, but the sponsor's 429 is
       not a refusal of the mint: the burn is done on Base and Circle will still attest. Read the
       status off the response through askRelay's own fetch seam, so a rate limit is waited out
       rather than shown to the person as a stall over money that is already in flight. */
    let lastStatus = 0;
    const observed: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      lastStatus = res.status;
      return res;
    };
    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error("Circle has not attested yet. The USDC is safe; try the relay again in a minute.");
        let r;
        lastStatus = 0;
        try {
          r = await askRelay(net.sponsorUrl, burn, observed);
        } catch (e) {
          // A dropped request is not a refusal: ask again. A refusal from the relay is final.
          if (e instanceof TypeError) {
            await sleep(RELAY_POLL_MS);
            continue;
          }
          if (lastStatus === 429) {
            setDetail("The relay is busy right now. Waiting, then asking again…");
            await sleep(RELAY_THROTTLE_MS);
            continue;
          }
          throw e;
        }
        if (r.status === "minted") {
          setMintHash(r.hash);
          setSeconds(Math.round((Date.now() - started) / 1000));
          setStage("done");
          void sendEvent("cctp_funded", burn, account!.address);
          return;
        }
        setDetail(`${r.detail}…`);
        await sleep(RELAY_POLL_MS);
      }
    } catch (e) {
      console.error("[add-money/base] relay", e);
      setStage("stalled");
      setError(e instanceof Error ? e.message.split("\n")[0] : "The relay did not answer.");
    }
  }

  async function bring() {
    setError("");
    if (!clients.current || !evmAddress) return;
    let burned: Hex | null = null;
    let units: bigint;
    try {
      units = parseUsdc6(amount);
    } catch (e) {
      return setError((e as Error).message);
    }
    try {
      // The mint goes to this account on its Circle USDC trustline. Every account the sponsor opens
      // has it; an older practice account gets it here first, on the sponsor's reserve. loadBalance
      // answers null for an address Horizon 404s, which is an account that does not exist at all
      // and so cannot hold the mint either; that case needs the repair most, not least.
      const bal = await loadBalance(account!.address);
      if (!bal || !bal.issuer) {
        let signer;
        try {
          signer = await getSigner();
        } catch (e) {
          if (isNeedsPassword(e)) throw e;
          router.push(`/unlock?next=${encodeURIComponent("/add-money/base")}`);
          return;
        }
        await prepareAccount({ sponsorUrl: net.sponsorUrl, signer });
      }

      setStage("approving");
      const burn = await burnToStellar({
        wallet: clients.current.wallet,
        publicClient: clients.current.pub,
        account: evmAddress,
        recipient: account!.address,
        units,
        onProgress: (s) => {
          if (s === "approving") setDetail("Approve the USDC in your wallet (once).");
          if (s === "burning") {
            setStage("burning");
            setDetail("Confirm the transfer in your wallet.");
          }
        },
      });
      burned = burn;
      setBurnHash(burn);
      await relay(burn);
    } catch (e) {
      console.error("[add-money/base]", e);
      setStage(burned ? "stalled" : "idle");
      setError(e instanceof Error ? e.message.split("\n")[0] : "Something went wrong. Nothing left your wallet unless a burn is shown below.");
    }
  }

  if (net.isMainnet) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">Bring USDC from Base</h1>
        <p className="text-sm text-ink-soft">This runs on the test network for now (Base Sepolia to Stellar testnet). Switch to practice money to try it.</p>
        <Link href="/add-money" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Other ways to add money
        </Link>
      </div>
    );
  }

  if (stage === "done" && mintHash) {
    return (
      <div className="flex flex-col gap-4 py-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Test network</p>
        <h1 className="text-xl font-bold text-ink">Your USDC arrived from Base</h1>
        <p className="text-sm text-ink-soft">
          {seconds !== null ? `${seconds} s after the burn. ` : ""}Circle took its small Fast-transfer fee on Base; the Stellar side was paid by
          Lumenia, so you paid nothing there.
        </p>
        <MoneyCard className="p-4">
          <p className="text-sm text-ink">Burn on Base Sepolia</p>
          <a href={`https://sepolia.basescan.org/tx/${burnHash}`} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-xs text-money">
            {burnHash}
          </a>
          <p className="mt-3 text-sm text-ink">Mint on Stellar, into your account</p>
          <a href={explorerTx(mintHash)} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-xs text-money">
            {mintHash}
          </a>
        </MoneyCard>
        <PrimaryButton onClick={() => router.push("/send")}>Send it as a link</PrimaryButton>
        <Link href="/home" className="text-center text-sm text-ink-soft underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  const working = stage === "approving" || stage === "burning" || stage === "attesting";

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Test network, Circle CCTP</p>
        <h1 className="text-xl font-bold text-ink">Bring USDC from Base</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Your USDC on Base moves into this account through Circle&apos;s own bridge: it is burned on Base
          and minted here. You approve two things in your Base wallet; the Stellar side is on us.
        </p>
      </header>

      {!evmAddress ? (
        <PrimaryButton onClick={() => void connect()}>Connect a Base wallet</PrimaryButton>
      ) : (
        <>
          <MoneyCard className="p-4">
            <p className="text-sm text-ink-soft">Base Sepolia wallet</p>
            <p className="break-all font-mono text-xs text-ink">{evmAddress}</p>
            <p className="mt-2 text-sm text-ink">{baseUsdc !== null ? `${baseUsdc} USDC on Base` : "Reading the balance…"}</p>
          </MoneyCard>

          <label className="text-sm text-ink-soft">
            Amount
            <div className="mt-1 flex items-center rounded-[14px] border border-line bg-surface px-3">
              <input
                inputMode="decimal"
                value={amount}
                disabled={working}
                onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
                placeholder="0.00"
                className="w-full bg-transparent px-2 py-3 text-lg text-ink outline-none"
              />
              <span className="shrink-0 text-lg text-ink-soft">USDC</span>
            </div>
          </label>

          {working && (
            <MoneyCard className="p-4">
              <p className="text-sm text-ink">{detail || "Working…"}</p>
              {burnHash && (
                <a href={`https://sepolia.basescan.org/tx/${burnHash}`} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-xs text-money">
                  burn {burnHash}
                </a>
              )}
            </MoneyCard>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          {stage === "stalled" && burnHash && (
            <MoneyCard className="p-4">
              <p className="text-sm text-ink">The burn is done on Base; only the Stellar side is left. Nothing burns again.</p>
              <a href={`https://sepolia.basescan.org/tx/${burnHash}`} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-xs text-money">
                burn {burnHash}
              </a>
              <button
                type="button"
                onClick={() => void relay(burnHash)}
                className="mt-3 inline-flex h-10 items-center rounded-full border border-money px-4 text-sm font-medium text-money"
              >
                Try the relay again
              </button>
            </MoneyCard>
          )}

          <PrimaryButton loading={working} loadingLabel="Moving your USDC…" disabled={!(Number.parseFloat(amount) > 0) || stage === "stalled"} onClick={() => void bring()}>
            Bring it to Lumenia
          </PrimaryButton>
        </>
      )}
      {!evmAddress && error && <p className="text-sm text-danger">{error}</p>}

      <p className="text-xs text-ink-soft">
        It lands in {account.address.slice(0, 6)}…{account.address.slice(-4)}, this account. Circle&apos;s Fast transfer
        charges about 0.013% on Base; nothing is charged on Stellar.
      </p>
    </div>
  );
}
