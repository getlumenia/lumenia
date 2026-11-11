// Expiry math. The contract stores nanosecond timestamps (u64); the browser works in ms.

export const EXPIRY_OPTIONS = [
  { label: "10 minutes (demo)", seconds: 600 },
  { label: "1 hour", seconds: 3_600 },
  { label: "24 hours", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
] as const;

export const DEFAULT_EXPIRY_S = 604_800;

const NS_PER_MS = 1_000_000n;

/** A u64 nanosecond timestamp (string or JSON number) -> ms since epoch. */
export function nsToMs(ns: string | number | bigint): number {
  return Number(BigInt(ns) / NS_PER_MS);
}

export function expiresAtMs(createdMs: number, expiresInS: number): number {
  return createdMs + expiresInS * 1000;
}

export function isExpired(expiresAt: number, nowMs: number): boolean {
  return nowMs >= expiresAt;
}

/** "6 days 23 hours", "3 hours 10 minutes", "12 minutes", "under a minute". */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (days >= 1) {
    const restHours = hours - days * 24;
    return restHours ? `${plural(days, "day")} ${plural(restHours, "hour")}` : plural(days, "day");
  }
  if (hours >= 1) {
    const restMinutes = minutes - hours * 60;
    return restMinutes ? `${plural(hours, "hour")} ${plural(restMinutes, "minute")}` : plural(hours, "hour");
  }
  return plural(minutes, "minute");
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function formatLocal(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
