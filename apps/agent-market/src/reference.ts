// The idempotency reference handed to the library for a job: the assignment id,
// prefixed so it cannot collide with references other callers of the same
// receipt log use, and hashed when the market's id would not fit the library's
// 64-character limit.
import { createHash } from "node:crypto";

export const REFERENCE_PREFIX = "agent-market:";
export const MAX_REFERENCE_CHARS = 64;

export function referenceFor(assignmentId: string): string {
  const id = assignmentId.trim();
  if (!id) throw new Error("referenceFor needs an assignment id");
  const plain = `${REFERENCE_PREFIX}${id}`;
  if (plain.length <= MAX_REFERENCE_CHARS) return plain;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 40);
  return `${REFERENCE_PREFIX}sha256:${digest}`;
}
