"use client";

/**
 * /add-money/convert - turn the XLM in this account into the dollars every rail here settles in.
 *
 * WHY THIS SCREEN EXISTS. Lumenia moves dollars: a link, a cash-out and the lira rail all speak
 * USDC and refuse everything else. So XLM that lands in a Lumenia account - someone paid in
 * lumens, or the account was funded from a wallet that only sends them - is money on the ledger
 * that no product surface can touch. One path payment, quoted first and bounded, turns it into
 * dollars in this same account, and then every rail will take it.
 *
 * WHAT HAPPENS, in order: the price is read from Stellar's own order books (a read, nothing is
 * moved), a floor is put under it, the account's OWN key signs one operation whose destination is
 * the account itself, and the browser submits it straight to Horizon. The ledger enforces the
 * floor: below it the transaction fails rather than settling. Nothing is held anywhere at any
 * point, by us or by anyone else.
 *
 * THE FEE IS THE PERSON'S, and this is the one screen in the product where that is true. The
 * sponsor is not involved: it never signs a path payment, which keeps the anti-drain validator and
 * the watchdog exactly as they are. The conversion is only offered to an account that already
 * holds XLM, so it can always pay.
 *
 * Test network only, like the two rails either side of it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useWallet } from "../../../../lib/wallet";
import { loadBalance, loadXlmBalance, type XlmBalance } from "../../../../lib/horizon";
import { prepareAccount } from "../../../../lib/sponsor";
import { isNeedsPassword } from "../../../../lib/signer-error";
import { formatUsd, sanitizeAmountInput } from "../../../../lib/money";
import { activeNetwork, explorerTx } from "../../../../lib/network";
import {
  classifySwapFailure,
  defaultSlippageBps,
  engineLabel,
  floorFor,
  formatXlm,
  isStale,
  quoteStrictSend,
  repriceDecision,
  retryAllowed,
  runConversion,
  shouldOfferConversion,
  spendableXlm,
  toStroops,
  watchUntil,
  type SwapFailure,
  type SwapQuote,
} from "../../../../lib/swap";
import { MoneyCard } from "../../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../../components/brand/PrimaryButton";
import type { Signer } from "../../../../lib/signer";

/** The amount survives the unlock detour, this tab only. The conversion itself never resumes. */
const DRAFT_KEY = "lumenia.convert.draft";
/** How long the price on screen may sit before it is read again. */
const QUOTE_DEBOUNCE_MS = 500;
const WATCH_POLL_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Stage = "idle" | "converting" | "watching" | "done";

/**
 * Half-typed input is not an amount. "1." is what the field legitimately holds mid-keystroke, and
 * every comparison against it has to answer "not yet" rather than throw inside a render.
 */
function stroopsOrNull(dec: string): bigint | null {
  try {
    return toStroops(dec);
  } catch {
    return null;
  }
}

export default function ConvertPage() {
  const { status, account, getSigner } = useWallet();
  const router = useRouter();
  const net = activeNetwork();
  const slippageBps = defaultSlippageBps(net);

  const [usd, setUsd] = useState<string | null>(null);
  const [hasDollarLine, setHasDollarLine] = useState<boolean | null>(null);
  const [xlm, setXlm] = useState<XlmBalance | null>(null);
  const [readError, setReadError] = useState("");
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [bound, setBound] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [repriced, setRepriced] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [detail, setDetail] = useState("");
  const [failure, setFailure] = useState<SwapFailure | null>(null);
  const [hash, setHash] = useState("");
  const [repairing, setRepairing] = useState(false);
  const [canRetry, setCanRetry] = useState(true);

  /** One conversion at a time: a second tap inside the first await would be a second conversion. */
  const inFlight = useRef(false);
  /** What was handed over, so a lost answer can still be resolved against the ledger. */
  const handed = useRef<{ hash: string; retrySafeAfter: number } | null>(null);
  /** Leaving the screen ends the balance watch instead of writing into an unmounted tree. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const readBalances = useCallback(async () => {
    if (!account) return;
    try {
      const [dollars, lumens] = await Promise.all([loadBalance(account.address), loadXlmBalance(account.address)]);
      if (!alive.current) return;
      setUsd(dollars?.usd ?? "0");
      // The account can hold dollars only if it trusts the one THIS BUILD moves. loadBalance sets
      // `issuer` only for the pinned line, so its absence is the missing trustline, and a null
      // record is an account Horizon has never seen - which needs the same repair, not less of it.
      setHasDollarLine(Boolean(dollars?.issuer));
      setXlm(lumens);
      setReadError("");
    } catch (e) {
      if (!alive.current) return;
      // A read that did not complete is never rendered as an empty account.
      setReadError(e instanceof Error ? e.message.split("\n")[0]! : "Couldn't read this account just now.");
    }
  }, [account]);

  useEffect(() => {
    void readBalances();
  }, [readBalances]);

  /** Come back from the unlock detour with the amount still in the field. */
  useEffect(() => {
    try {
      const draft = sessionStorage.getItem(DRAFT_KEY);
      if (draft) {
        setAmount(draft);
        setTouched(true);
      }
    } catch {
      /* storage blocked - the field just starts at what is spendable */
    }
  }, []);

  const spendable = xlm ? spendableXlm(xlm) : "0.0000000";
  const offered = shouldOfferConversion(spendable);

  /** Start at everything spendable, truncated by the same filter every amount field uses. */
  useEffect(() => {
    if (!touched && offered) setAmount(sanitizeAmountInput(spendable));
  }, [touched, offered, spendable]);

  const typed = stroopsOrNull(amount);
  const overSpendable = typed !== null && typed > toStroops(spendable);
  const amountOk = typed !== null && typed > 0n && !overSpendable;
  const working = stage === "converting" || stage === "watching";

  /**
   * Bring "Try again" back once the attempt that is still in flight can no longer be included.
   * Until then the button stays down: a conversion whose answer never arrived is not a conversion
   * that did not happen.
   */
  useEffect(() => {
    if (canRetry) return;
    const at = handed.current?.retrySafeAfter;
    if (!at || !Number.isFinite(at)) return;
    const timer = setTimeout(() => setCanRetry(true), Math.max(1_000, at - Date.now() + 1_000));
    return () => clearTimeout(timer);
  }, [canRetry]);

  /** Read the price whenever the amount settles. A read moves nothing, so it is safe to repeat. */
  useEffect(() => {
    if (!amountOk || working || stage === "done") return;
    let current = true;
    const timer = setTimeout(async () => {
      setQuoting(true);
      setQuoteError("");
      try {
        const q = await quoteStrictSend(net, amount);
        if (!current || !alive.current) return;
        setQuote(q);
        setBound(q ? floorFor(q, slippageBps) : "");
        if (!q) setQuoteError("There is no market for this right now.");
      } catch (e) {
        if (!current || !alive.current) return;
        setQuote(null);
        setBound("");
        setQuoteError(e instanceof Error ? e.message.split("\n")[0]! : "Couldn't read a price just now.");
      } finally {
        if (current && alive.current) setQuoting(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, amountOk, working, stage, net.id, slippageBps]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading...</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  /** Ask the sponsor to open the dollar line, the same repair the other add-money screens do. */
  async function repair() {
    setRepairing(true);
    setReadError("");
    try {
      let signer: Signer;
      try {
        signer = await getSigner();
      } catch (e) {
        if (isNeedsPassword(e)) throw e;
        router.push(`/unlock?next=${encodeURIComponent("/add-money/convert")}`);
        return;
      }
      await prepareAccount({ sponsorUrl: net.sponsorUrl, signer });
      await readBalances();
    } catch (e) {
      setReadError(e instanceof Error ? e.message.split("\n")[0]! : "Couldn't open the dollar line just now.");
    } finally {
      setRepairing(false);
    }
  }

  /**
   * Watch the balance after an answer that decided nothing. This says what LANDED; it never says
   * where the money is on the strength of a request that was never answered.
   */
  async function watchBalance(before: string) {
    const handedOver = handed.current;
    const deadline = watchUntil(handedOver?.retrySafeAfter ?? Date.now(), Date.now());
    setStage("watching");
    setCanRetry(false);
    setDetail("We lost the connection while that was going through. Checking what landed...");
    /* Whether the ledger ever actually answered. "Nothing landed" is a statement about somebody's
       money, so it is only ever said on the strength of a read that came back -- a watch that
       could not reach Horizon at all knows nothing and says so. */
    let heard = false;
    for (;;) {
      await sleep(WATCH_POLL_MS);
      if (!alive.current) return;
      let now: string | null = null;
      try {
        now = (await loadBalance(account!.address))?.usd ?? null;
        heard = heard || now !== null;
      } catch {
        /* a failed read is not an answer - ask again until the deadline */
      }
      if (!alive.current) return;
      if (now !== null && toStroops(now) > toStroops(before)) {
        setUsd(now);
        setHash(handedOver?.hash ?? "");
        setStage("done");
        void readBalances();
        return;
      }
      if (Date.now() > deadline) {
        setStage("idle");
        setDetail("");
        setFailure({
          kind: "undecided",
          terminal: false,
          message: heard
            ? "Nothing landed. Your XLM is still here."
            : "We couldn't reach the ledger to check. Open this screen again when you have a connection, before trying anything else.",
          action: "check-balance",
        });
        setCanRetry(retryAllowed(handedOver?.retrySafeAfter ?? 0, Date.now()));
        void readBalances();
        return;
      }
    }
  }

  async function convert() {
    if (inFlight.current || !quote || !bound) return;
    setFailure(null);
    setDetail("");
    // This attempt's own identity only. A previous attempt's record must never decide what this
    // one is told about where the money is.
    handed.current = null;
    const before = usd ?? "0";

    // A price older than its window is read again before anything is signed. If the floor has
    // moved further than the tolerance, the screen re-renders and waits for a second tap: nobody
    // signs a different transaction than the one they were looking at.
    let live = quote;
    let liveBound = bound;
    if (isStale(quote, Date.now())) {
      setQuoting(true);
      try {
        const fresh = await quoteStrictSend(net, amount);
        if (!fresh) {
          setQuoteError("There is no market for this right now.");
          return;
        }
        live = fresh;
        liveBound = floorFor(fresh, slippageBps);
        setQuote(fresh);
        setBound(liveBound);
        if (repriceDecision(bound, liveBound) === "reprice") {
          setRepriced(true);
          return;
        }
      } catch (e) {
        setQuoteError(e instanceof Error ? e.message.split("\n")[0]! : "Couldn't read a price just now.");
        return;
      } finally {
        setQuoting(false);
      }
    }

    inFlight.current = true;
    setRepriced(false);
    setStage("converting");
    setDetail("Turning it into dollars...");
    try {
      let signer: Signer;
      try {
        signer = await getSigner();
      } catch (e) {
        if (isNeedsPassword(e)) throw e;
        try {
          sessionStorage.setItem(DRAFT_KEY, amount);
        } catch {
          /* the field is lost, nothing moved */
        }
        router.push(`/unlock?next=${encodeURIComponent("/add-money/convert")}`);
        return;
      }

      const outcome = await runConversion({
        net,
        signer,
        quote: live,
        kind: "strict-send",
        bound: liveBound,
        // Written down BEFORE it is submitted, so a lost answer can still be settled against the
        // public record instead of guessed at.
        onHandedOver: (c) => {
          handed.current = c;
        },
      });
      if (!alive.current) return;
      setHash(outcome.hash);
      setStage("done");
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* storage blocked */
      }
      await readBalances();
    } catch (e) {
      console.error("[add-money/convert]", e);
      if (!alive.current) return;
      const f = classifySwapFailure(e);
      if (f.kind === "undecided" && handed.current) {
        await watchBalance(before);
        return;
      }
      setStage("idle");
      setDetail("");
      setFailure(f);
      setCanRetry(!handed.current || retryAllowed(handed.current.retrySafeAfter, Date.now()));
      void readBalances();
    } finally {
      inFlight.current = false;
    }
  }

  if (net.isMainnet) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">Turn XLM into dollars</h1>
        <p className="text-sm text-ink-soft">
          This runs on the test network for now. Switch to practice money to try it.
        </p>
        <Link href="/add-money" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Other ways to add money
        </Link>
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div className="flex flex-col gap-4 py-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Test network</p>
        <h1 className="text-xl font-bold text-ink">It is dollars now</h1>
        <p className="text-sm text-ink-soft">
          {usd !== null ? `You hold ${formatUsd(usd)} in this account.` : "The dollars are in this account."} They can go
          out as a link, to an exchange, or through the lira rail.
        </p>
        {hash && (
          <MoneyCard className="p-4">
            <p className="text-sm text-ink">The conversion, on the ledger</p>
            <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-xs text-money">
              {hash}
            </a>
          </MoneyCard>
        )}
        <PrimaryButton onClick={() => router.push("/send")}>Send it as a link</PrimaryButton>
        <Link href="/home" className="text-center text-sm text-ink-soft underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <Link href="/add-money" className="flex items-center gap-2 text-sm text-ink-soft underline-offset-2 hover:underline">
        <ArrowLeft className="size-4" />
        Other ways to add money
      </Link>

      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Test network</p>
        <h1 className="text-xl font-bold text-ink">Turn XLM into dollars</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Lumenia moves dollars, and the lira rail settles in dollars only. XLM sitting here cannot reach any of that as
          it is. One transaction turns it into dollars, in this same account.
        </p>
      </header>

      {readError && <p className="text-sm text-danger">{readError}</p>}
      {hasDollarLine === null && !readError && <p className="text-sm text-ink-soft">Reading this account...</p>}

      {hasDollarLine === false && (
        <MoneyCard className="p-4">
          <p className="text-sm font-semibold text-ink">This account can&apos;t hold dollars yet</p>
          <p className="mt-1 text-sm text-ink-soft">
            It needs a dollar line on the ledger first. Lumenia opens it on its own reserve; you just approve it.
          </p>
          <div className="mt-3">
            <PrimaryButton loading={repairing} loadingLabel="Opening the dollar line..." onClick={() => void repair()}>
              Open the dollar line
            </PrimaryButton>
          </div>
        </MoneyCard>
      )}

      {hasDollarLine && !offered && (
        <MoneyCard className="p-4">
          <p className="text-sm font-semibold text-ink">There is no XLM here to convert</p>
          <p className="mt-1 text-sm text-ink-soft">
            This account holds {formatXlm(xlm?.xlm ?? "0")} XLM, and {formatXlm(spendable)} of it is spendable once the
            ledger&apos;s own reserves and the network fee are kept back. Send test XLM to the address below from
            another test-network wallet - Freighter, or an account you funded with friendbot - and then convert it here.
          </p>
          <p className="mt-3 break-all rounded-[12px] border border-line bg-paper px-3 py-2 font-mono text-xs text-ink-soft">
            {account.address}
          </p>
        </MoneyCard>
      )}

      {hasDollarLine && offered && (
        <>
          <MoneyCard className="p-4">
            <p className="text-sm text-ink-soft">In this account</p>
            <p className="text-lg font-semibold text-ink">{formatXlm(xlm!.xlm)} XLM</p>
            <p className="mt-1 text-sm text-ink-soft">
              {formatXlm(spendable)} of it is spendable. The rest is the ledger&apos;s own reserve for this account plus
              half a lumen kept back for network fees.
            </p>
          </MoneyCard>

          <label className="text-sm text-ink-soft">
            Convert
            <div className="mt-1 flex items-center rounded-[14px] border border-line bg-surface px-3">
              <input
                inputMode="decimal"
                value={amount}
                disabled={working}
                onChange={(e) => {
                  setTouched(true);
                  setRepriced(false);
                  setFailure(null);
                  setAmount(sanitizeAmountInput(e.target.value));
                }}
                placeholder="0.00"
                className="w-full bg-transparent px-2 py-3 text-lg text-ink outline-none"
              />
              <span className="shrink-0 text-lg text-ink-soft">XLM</span>
            </div>
          </label>
          {overSpendable && <p className="text-sm text-danger">That&apos;s more than this account can spend.</p>}

          <MoneyCard className="p-4">
            {quoting && !quote && <p className="text-sm text-ink-soft">Reading the price...</p>}
            {!quoting && !quote && !quoteError && <p className="text-sm text-ink-soft">Enter an amount to see the price.</p>}
            {quoteError && <p className="text-sm text-danger">{quoteError}</p>}
            {quote && bound && (
              <>
                <p className="text-sm text-ink">
                  About {formatXlm(quote.sendAmount)} XLM becomes about {formatUsd(quote.destAmount)}.
                </p>
                <p className="mt-1 text-sm text-ink-soft">
                  At least {formatUsd(bound)}, or the transaction does not go through. The floor is on the operation
                  itself, so a thin order book cannot quietly take the difference.
                </p>
                <p className="mt-2 text-sm text-ink-soft">
                  Priced on the {engineLabel(quote)} - the order book built into Stellar. Test network rate: it is not
                  the real price of XLM.
                </p>
                <p className="mt-2 text-sm text-ink-soft">
                  You pay the network fee for this one, a fraction of a lumen, out of the XLM in this account. The
                  dollars land here. Nothing is held anywhere along the way.
                </p>
              </>
            )}
          </MoneyCard>

          {repriced && (
            <MoneyCard className="p-4">
              <p className="text-sm font-semibold text-ink">The price moved while you were reading</p>
              <p className="mt-1 text-sm text-ink-soft">
                Nothing was signed. The numbers above are the new ones - tap again if they still work for you.
              </p>
            </MoneyCard>
          )}

          {working && (
            <MoneyCard className="p-4">
              <p className="text-sm text-ink">{detail || "Working..."}</p>
            </MoneyCard>
          )}

          {failure && (
            <div className="text-sm text-danger">
              <p>{failure.message}</p>
              {failure.action === "unlock" && (
                <Link
                  href={`/unlock?next=${encodeURIComponent("/add-money/convert")}`}
                  className="mt-1 inline-block font-semibold text-money underline-offset-2 hover:underline"
                >
                  Unlock this account
                </Link>
              )}
              {failure.action === "repair-trustline" && (
                <button
                  type="button"
                  onClick={() => void repair()}
                  className="mt-2 inline-flex h-10 items-center rounded-full border border-money px-4 text-sm font-medium text-money"
                >
                  Open the dollar line
                </button>
              )}
              {!canRetry && (
                <p className="mt-1 text-ink-soft">
                  Give it a few seconds before trying again - the first attempt can still land until it expires.
                </p>
              )}
            </div>
          )}

          <PrimaryButton
            loading={working}
            loadingLabel="Turning it into dollars..."
            disabled={!amountOk || !quote || !bound || quoting || !canRetry}
            onClick={() => void convert()}
          >
            Turn it into dollars
          </PrimaryButton>
        </>
      )}

      <p className="text-xs text-ink-soft">
        It converts inside {account.address.slice(0, 6)}...{account.address.slice(-4)}, this account. One Stellar path
        payment, priced on the open order book, with a floor under it.
      </p>
    </div>
  );
}
