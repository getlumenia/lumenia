// What the buyer receives: Markdown that opens with the result table, then a
// JSON receipt block, and receipt.csv (RFC 4180) as a file. Labels and memos
// come from the buyer's brief, so every cell is escaped before it is rendered.
export interface DeliverableLink {
  index: number;
  label: string;
  amountUsdc: string;
  memo: string;
  link: string;
  publicKey: string;
  txHash: string | null;
  explorerUrl: string | null;
  expiresAt: string;
  status: string;
}

export interface DeliverableInput {
  jobId: string;
  assignmentId: string;
  network: string;
  contractId: string;
  usdcContractId: string;
  funderAccount: string;
  createdAt: string;
  expiresInHours: number;
  batchId: string | null;
  links: DeliverableLink[];
  dryRun?: boolean;
}

export interface ReworkNote {
  kind: "rework" | "redo" | "resend";
  at: string;
  /** The buyer's feedback, quoted back as data. */
  feedback: string | null;
}

export const RECEIPT_SCHEMA = "lumenia.agent-market.receipt/1";
export const CSV_FILENAME = "receipt.csv";
export const CSV_COLUMNS = [
  "index",
  "label",
  "amount_usdc",
  "memo",
  "claim_link",
  "link_public_key",
  "expires_at",
  "escrow_tx_hash",
  "explorer_url",
  "status",
  "network",
  "contract_id",
  "job_id",
  "assignment_id",
] as const;

/** Sum of two-decimal amounts without floats. */
export function sumUsdc(amounts: readonly string[]): string {
  let cents = 0;
  for (const a of amounts) {
    const [whole = "0", frac = ""] = a.trim().split(".");
    cents += Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "2026-11-14T12:00:00.000Z" -> "2026-11-14 12:00 UTC". */
export function formatUtc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Escape buyer-provided text for a Markdown table cell. */
export function escapeCell(text: string): string {
  const flat = text.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  return flat
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~")
    .replace(/^#/, "\\#");
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}...${hash.slice(-4)}` : hash;
}

function txCell(l: DeliverableLink, dryRun: boolean): string {
  if (dryRun) return "(dry run, nothing on chain)";
  if (l.txHash && l.explorerUrl) return `[${shortHash(l.txHash)}](${l.explorerUrl})`;
  if (l.txHash) return `\`${l.txHash}\``;
  return "confirmed on chain (hash unknown)";
}

export function receiptJson(input: DeliverableInput): Record<string, unknown> {
  const first = input.links[0];
  return {
    schema: RECEIPT_SCHEMA,
    job_id: input.jobId,
    assignment_id: input.assignmentId,
    network: input.network,
    contract_id: input.contractId,
    usdc_contract_id: input.usdcContractId,
    funder_account: input.funderAccount,
    created_at: input.createdAt,
    expires_in_hours: input.expiresInHours,
    expires_at: first?.expiresAt ?? null,
    batch_id: input.batchId,
    escrow_tx_hash: first?.txHash ?? null,
    escrow_explorer_url: first?.explorerUrl ?? null,
    dry_run: input.dryRun ? true : undefined,
    payouts: input.links.map((l) => ({
      index: l.index,
      label: l.label,
      amount_usdc: l.amountUsdc,
      memo: l.memo,
      claim_link: l.link,
      link_public_key: l.publicKey,
      expires_at: l.expiresAt,
      tx_hash: l.txHash,
      explorer_url: l.explorerUrl,
      status: l.status,
    })),
    totals: { count: input.links.length, amount_usdc: sumUsdc(input.links.map((l) => l.amountUsdc)) },
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(input: DeliverableInput): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const l of input.links) {
    const row: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      index: l.index,
      label: l.label,
      amount_usdc: l.amountUsdc,
      memo: l.memo,
      claim_link: l.link,
      link_public_key: l.publicKey,
      expires_at: l.expiresAt,
      escrow_tx_hash: l.txHash,
      explorer_url: l.explorerUrl,
      status: l.status,
      network: input.network,
      contract_id: input.contractId,
      job_id: input.jobId,
      assignment_id: input.assignmentId,
    };
    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function renderNote(note: ReworkNote): string {
  const when = formatUtc(note.at);
  const opening =
    note.kind === "rework"
      ? `**Re-submitted ${when} after your request for changes.**`
      : note.kind === "redo"
        ? `**Re-submitted ${when} after the dispute ruling asked for a redo.**`
        : `**Re-submitted ${when}.**`;
  const quoted = note.feedback ? ` Your message, as received: "${escapeCell(note.feedback.slice(0, 400))}${note.feedback.length > 400 ? "..." : ""}"` : "";
  return (
    `> ${opening} The links below are unchanged: their USDC is already escrowed on NEAR and this agent cannot alter, ` +
    `re-issue or recall a funded link before it expires. Links nobody opens return to our treasury after the expiry. ` +
    `For a different person or amount, hire the agent again; any link you no longer need is taken back after it expires.${quoted}`
  );
}

export function renderMarkdown(input: DeliverableInput, note: ReworkNote | null = null): string {
  const n = input.links.length;
  const total = sumUsdc(input.links.map((l) => l.amountUsdc));
  const dryRun = input.dryRun === true;
  const networkName = input.network === "near:testnet" ? "NEAR testnet" : input.network;
  const out: string[] = [];
  out.push(`# Lumenia payout: ${n} claim link${n === 1 ? "" : "s"} on ${networkName}`);
  out.push("");
  if (note) {
    out.push(renderNote(note));
    out.push("");
  }
  out.push(
    "Each row is one person. Send them their claim link over a private channel; whoever opens it gets the USDC in a " +
      "new NEAR account (or one they already have), with no wallet to install and no gas to pay.",
  );
  out.push("");
  out.push("| # | Label | Amount (USDC) | Memo | Claim link | Expires | Escrow transaction |");
  out.push("|---:|---|---:|---|---|---|---|");
  for (const l of input.links) {
    out.push(
      `| ${l.index} | ${escapeCell(l.label)} | ${l.amountUsdc} | ${l.memo ? escapeCell(l.memo) : "-"} | ${l.link} | ${formatUtc(l.expiresAt)} | ${txCell(l, dryRun)} |`,
    );
  }
  out.push("");
  out.push(
    `**Total: ${total} USDC in ${n} link${n === 1 ? "" : "s"}**, funded in one transaction on ${networkName}` +
      (input.network === "near:testnet" ? " (Circle testnet USDC, no real money)." : ".") +
      ` A link is a bearer secret: anyone holding it can claim it, so do not post it where others can read it. ` +
      `Links nobody opens by their expiry return to our treasury; after that a link is void and a new hire is needed.`,
  );
  out.push("");
  out.push("## Receipt");
  out.push("");
  out.push("```json");
  out.push(JSON.stringify(receiptJson(input), null, 2));
  out.push("```");
  out.push("");
  out.push(`The attached \`${CSV_FILENAME}\` holds the same rows, one per line (RFC 4180, UTF-8).`);
  out.push("");
  out.push(
    `Escrow contract: \`${input.contractId}\` on ${networkName}. Funder: \`${input.funderAccount}\`. ` +
      `Check a link any time by its public key (it carries no secret). Job ${input.jobId}, assignment ${input.assignmentId}.`,
  );
  if (dryRun) {
    out.push("");
    out.push("_Dry run: the links above were generated offline and nothing was escrowed._");
  }
  return out.join("\n") + "\n";
}
