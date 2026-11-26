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

/** The day key `back` days before `now`. */
export function keyBefore(now: number, back: number): string {
  return dayOf(now - back * DAY_MS).key
}

export function previousKey(now: number): string {
  return keyBefore(now, 1)
}

/** Whole days from one day key to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)
}
