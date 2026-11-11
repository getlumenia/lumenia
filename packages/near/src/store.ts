// The link store: one JSON file, default ~/.lumenia-near/links.json, holding
// every receipt (with its secret link) this installation created. It is the
// receipt log the budget and the duplicate guard read from. The file is
// written with mode 0600 through a temp file + rename so a crash never leaves
// a half-written log. One process at a time is assumed (an MCP server or a CLI
// run); there is no cross-process locking.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Receipt } from "./receipts.js";

export const STORE_VERSION = 1;

export interface StoreFile {
  version: typeof STORE_VERSION;
  receipts: Receipt[];
}

export class StoreError extends Error {
  override name = "StoreError";
}

export class LinkStore {
  constructor(readonly path: string) {}

  static inDir(dataDir: string): LinkStore {
    return new LinkStore(join(dataDir, "links.json"));
  }

  load(): StoreFile {
    if (!existsSync(this.path)) return { version: STORE_VERSION, receipts: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (e) {
      throw new StoreError(`${this.path} is not valid JSON (${(e as Error).message}); move it aside to start a new log`);
    }
    const file = parsed as Partial<StoreFile>;
    if (!file || file.version !== STORE_VERSION || !Array.isArray(file.receipts)) {
      throw new StoreError(`${this.path} has an unexpected shape; expected {"version":1,"receipts":[...]}`);
    }
    return { version: STORE_VERSION, receipts: file.receipts };
  }

  save(file: StoreFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best effort on filesystems without POSIX modes
    }
  }

  upsert(receipt: Receipt): void {
    const file = this.load();
    const i = file.receipts.findIndex((r) => r.receipt_id === receipt.receipt_id);
    if (i >= 0) file.receipts[i] = receipt;
    else file.receipts.push(receipt);
    this.save(file);
  }

  /** One read-modify-write for a whole batch. */
  upsertMany(receipts: readonly Receipt[]): void {
    const file = this.load();
    for (const receipt of receipts) {
      const i = file.receipts.findIndex((r) => r.receipt_id === receipt.receipt_id);
      if (i >= 0) file.receipts[i] = receipt;
      else file.receipts.push(receipt);
    }
    this.save(file);
  }

  findByBatchId(batchId: string): Receipt[] {
    return this.all().filter((r) => r.batch_id === batchId);
  }

  all(): Receipt[] {
    return this.load().receipts;
  }

  findByPublicKey(publicKey: string): Receipt | undefined {
    return this.all().find((r) => r.link_public_key === publicKey);
  }

  findByReference(reference: string): Receipt | undefined {
    return this.all().find((r) => r.reference === reference);
  }
}
