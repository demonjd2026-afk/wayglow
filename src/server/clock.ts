const DAY_MS = 86_400_000
/** Night #1. */
const EPOCH: number = Date.UTC(2026, 10, 26)

export type Day = {key: string; night: number; weekday: number; nextAt: number}

export function dayOf(now: number): Day {
  const start = Math.floor(now / DAY_MS) * DAY_MS
  const d = new Date(start)
  return {
    key: d.toISOString().slice(0, 10),
    night: Math.floor((start - EPOCH) / DAY_MS) + 1,
    weekday: d.getUTCDay(),
    nextAt: start + DAY_MS,
  }
}

export function previousKey(now: number): string {
  return dayOf(now - DAY_MS).key
}
