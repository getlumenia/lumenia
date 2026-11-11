import { describe, expect, it } from "vitest";
import { escapeCell, formatUtc, receiptJson, renderCsv, renderMarkdown, sumUsdc, type DeliverableInput } from "../src/deliverable.js";

const input: DeliverableInput = {
  jobId: "job-1",
  assignmentId: "asg-1",
  network: "near:testnet",
  contractId: "lumenia-near.testnet",
  usdcContractId: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  funderAccount: "lumenia-funder.testnet",
  createdAt: "2026-11-11T12:00:00.000Z",
  expiresInHours: 48,
  batchId: "batch_1",
  links: [
    {
      index: 1,
      label: "Ayse",
      amountUsdc: "1.00",
      memo: "thanks for the review",
      link: "https://getlumenia.com/c/near#ed25519:SECRET1",
      publicKey: "ed25519:PUB1",
      txHash: "9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT",
      explorerUrl: "https://testnet.nearblocks.io/txns/9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT",
      expiresAt: "2026-11-13T12:00:00.000Z",
      status: "Open",
    },
    {
      index: 2,
      label: "Ali | [x](http://evil) *",
      amountUsdc: "2.50",
      memo: 'say "hi", twice',
      link: "https://getlumenia.com/c/near#ed25519:SECRET2",
      publicKey: "ed25519:PUB2",
      txHash: "9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT",
      explorerUrl: "https://testnet.nearblocks.io/txns/9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT",
      expiresAt: "2026-11-13T12:00:00.000Z",
      status: "Open",
    },
  ],
};

const GOLDEN_MARKDOWN = `# Lumenia payout: 2 claim links on NEAR testnet

Each row is one person. Send them their claim link over a private channel; whoever opens it gets the USDC in a new NEAR account (or one they already have), with no wallet to install and no gas to pay.

| # | Label | Amount (USDC) | Memo | Claim link | Expires | Escrow transaction |
|---:|---|---:|---|---|---|---|
| 1 | Ayse | 1.00 | thanks for the review | https://getlumenia.com/c/near#ed25519:SECRET1 | 2026-11-13 12:00 UTC | [9xKfQ7...R6sT](https://testnet.nearblocks.io/txns/9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT) |
| 2 | Ali \\| \\[x\\](http://evil) \\* | 2.50 | say "hi", twice | https://getlumenia.com/c/near#ed25519:SECRET2 | 2026-11-13 12:00 UTC | [9xKfQ7...R6sT](https://testnet.nearblocks.io/txns/9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT) |

**Total: 3.50 USDC in 2 links**, funded in one transaction on NEAR testnet (Circle testnet USDC, no real money). A link is a bearer secret: anyone holding it can claim it, so do not post it where others can read it. Links nobody opens by their expiry return to our treasury; after that a link is void and a new hire is needed.

## Receipt

\`\`\`json
`;

const GOLDEN_CSV =
  "index,label,amount_usdc,memo,claim_link,link_public_key,expires_at,escrow_tx_hash,explorer_url,status,network,contract_id,job_id,assignment_id\r\n" +
  "1,Ayse,1.00,thanks for the review,https://getlumenia.com/c/near#ed25519:SECRET1,ed25519:PUB1,2026-11-13T12:00:00.000Z,9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT,https://testnet.nearblocks.io/txns/9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT,Open,near:testnet,lumenia-near.testnet,job-1,asg-1\r\n" +
  '2,Ali | [x](http://evil) *,2.50,"say ""hi"", twice",https://getlumenia.com/c/near#ed25519:SECRET2,ed25519:PUB2,2026-11-13T12:00:00.000Z,9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT,https://testnet.nearblocks.io/txns/9xKfQ7mN2pR4sT6vW8yZ1aB3cD5eF7gH9jK2mN4pR6sT,Open,near:testnet,lumenia-near.testnet,job-1,asg-1\r\n';

describe("renderMarkdown", () => {
  it("opens with the result table and escapes buyer text (golden)", () => {
    const md = renderMarkdown(input);
    expect(md.startsWith(GOLDEN_MARKDOWN)).toBe(true);
    const jsonText = md.slice(md.indexOf("```json\n") + 8, md.indexOf("\n```", md.indexOf("```json\n")));
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    expect(parsed).toEqual(receiptJson(input));
    expect(parsed.totals).toEqual({ count: 2, amount_usdc: "3.50" });
    expect((parsed.payouts as unknown[]).length).toBe(2);
    expect(md).toMatch(/The attached `receipt.csv` holds the same rows/);
    expect(md).toMatch(/Escrow contract: `lumenia-near.testnet` on NEAR testnet/);
    expect(md).not.toMatch(/Dry run/);
  });

  it("renders a dry run and a missing hash honestly", () => {
    const md = renderMarkdown({ ...input, dryRun: true });
    expect(md).toMatch(/\(dry run, nothing on chain\)/);
    expect(md).toMatch(/_Dry run: the links above were generated offline/);
    const noHash = renderMarkdown({ ...input, links: [{ ...input.links[0]!, txHash: null, explorerUrl: null }] });
    expect(noHash).toMatch(/confirmed on chain \(hash unknown\)/);
    expect(noHash).toMatch(/1 claim link on NEAR testnet/);
  });

  it("prepends the rework note with the feedback quoted as data", () => {
    const md = renderMarkdown(input, { kind: "rework", at: "2026-11-12T09:30:00.000Z", feedback: "Please add Ali | again [now](x)" });
    const lines = md.split("\n");
    expect(lines[0]).toBe("# Lumenia payout: 2 claim links on NEAR testnet");
    expect(lines[2]).toMatch(/^> \*\*Re-submitted 2026-11-12 09:30 UTC after your request for changes\.\*\* The links below are unchanged/);
    expect(lines[2]).toMatch(/Your message, as received: "Please add Ali \\\| again \\\[now\\\]\(x\)"/);
    const redo = renderMarkdown(input, { kind: "redo", at: "2026-11-12T09:30:00.000Z", feedback: null });
    expect(redo).toMatch(/after the dispute ruling asked for a redo/);
    expect(redo).not.toMatch(/Your message/);
  });

  it("stays well under the market's 256 KiB limit for ten links", () => {
    const ten = { ...input, links: Array.from({ length: 10 }, (_, i) => ({ ...input.links[0]!, index: i + 1, label: `Person ${i + 1}` })) };
    expect(Buffer.byteLength(renderMarkdown(ten), "utf8")).toBeLessThan(16 * 1024);
  });
});

describe("renderCsv", () => {
  it("is RFC 4180: header, CRLF, quotes only where needed (golden)", () => {
    expect(renderCsv(input)).toBe(GOLDEN_CSV);
  });
});

describe("helpers", () => {
  it("sumUsdc adds cents without floats", () => {
    expect(sumUsdc(["0.10", "0.20", "0.30"])).toBe("0.60");
    expect(sumUsdc(["19.99", "0.01"])).toBe("20.00");
    expect(sumUsdc([])).toBe("0.00");
  });
  it("formatUtc and escapeCell", () => {
    expect(formatUtc("2026-11-13T12:05:00.000Z")).toBe("2026-11-13 12:05 UTC");
    expect(formatUtc("not a date")).toBe("not a date");
    expect(escapeCell("a|b`c<d>_e\n#f")).toBe("a\\|b\\`c&lt;d&gt;\\_e #f");
    expect(escapeCell("#heading")).toBe("\\#heading");
  });
});
