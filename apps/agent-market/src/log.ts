// One line per event on stderr, UTC timestamp first. Two things never reach a
// log line: the market token and a claim link (the link IS the money), so both
// are scrubbed from every message as a last line of defence.
export type Level = "info" | "warn" | "error";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const TOKEN_RE = /aat_[0-9a-zA-Z_-]{4,}/g;
/** Lumenia's claim route (/claim#secret), the old one it still forwards (/c/near#secret) and the package's standalone one (/c#secret). */
const LINK_RE = /\/(?:claim|c(?:\/near)?)#ed25519:[1-9A-HJ-NP-Za-km-z]+/g;
const SECRET_KEY_RE = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g;

export function redact(text: string): string {
  return text
    .replace(TOKEN_RE, "aat_[redacted]")
    .replace(LINK_RE, (m) => `${m.slice(0, m.indexOf("#"))}#[redacted]`)
    .replace(SECRET_KEY_RE, "ed25519:[redacted]");
}

function renderFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${/\s/.test(text ?? "") ? JSON.stringify(text) : text}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

export function createLogger(write: (line: string) => void = (l) => process.stderr.write(l + "\n"), now: () => Date = () => new Date()): Logger {
  const emit = (level: Level, message: string, fields?: Record<string, unknown>) =>
    write(redact(`${now().toISOString()} ${level.padEnd(5)} ${message}${renderFields(fields)}`));
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
