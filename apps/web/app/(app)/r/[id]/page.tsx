/**
 * /r/[id] — a request link, seen by the PAYER (REQUEST_MONEY.md §10). The link
 * carries only public metadata (amount + name + nonce, optionally the returning
 * asker's address) — no secret, so unlike /c there is no #fragment and the server
 * may read everything. Value-first: the ask renders before any account talk.
 * noindex: an ask is somebody's money business.
 */
import type { Metadata } from "next";
import { parseAsk } from "../../../../lib/request";
import { formatUsd } from "../../../../lib/money";
import { copy } from "../../../../lib/copy";
import { PayAskClient } from "./PayAskClient";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ a?: string; n?: string; to?: string }>;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { id } = await params;
  const ask = parseAsk(id, await searchParams);
  return {
    title: ask
      ? `${ask.name} is asking for ${formatUsd(ask.amount)} | Lumenia`
      : "Money request | Lumenia",
    description: copy.pay.sub,
    robots: { index: false },
  };
}

export default async function PayAskPage({ params, searchParams }: Props) {
  const { id } = await params;
  const ask = parseAsk(id, await searchParams);
  return <PayAskClient ask={ask} />;
}
