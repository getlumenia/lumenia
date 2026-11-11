// Turn whatever near-api-js, fetch or the RPC threw into one honest sentence.

export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const typed = e as Error & { type?: string; cause?: unknown; data?: unknown };
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    if (typed.type && !e.message.includes(typed.type)) parts.push(`(${typed.type})`);
    const cause = typed.cause;
    if (cause && typeof cause === "object") {
      const c = cause as { name?: string; message?: string };
      if (c.name && !parts.join(" ").includes(c.name)) parts.push(`[${c.name}]`);
      if (c.message && !parts.join(" ").includes(c.message)) parts.push(c.message);
    }
    if (typeof typed.data === "string" && !parts.join(" ").includes(typed.data)) parts.push(typed.data);
    const text = parts.join(" ").trim();
    if (/failed to fetch|networkerror|load failed/i.test(text)) {
      return `The NEAR network did not answer (${text}). Check your connection and try again.`;
    }
    return text || "Unknown error";
  }
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "Unknown error";
  }
}

/** The "does not exist" family of RPC errors, which is an answer, not a failure. */
export function isUnknownAccountError(e: unknown): boolean {
  const text = describeError(e);
  return /UNKNOWN_ACCOUNT|does not exist/i.test(text);
}
