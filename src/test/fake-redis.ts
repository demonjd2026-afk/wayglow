import {realtime, redis} from '@devvit/web/server'

/** In-memory stand-in for the handful of Redis commands the game uses. */
export const strings = new Map<string, string>()
export const hashes = new Map<string, Map<string, string>>()
export const zsets = new Map<string, Map<string, number>>()
const hash = (key: string): Map<string, string> => {
  let h = hashes.get(key)
  if (!h) {
    h = new Map()
    hashes.set(key, h)
  }
  return h
}
const r = redis as unknown as Record<string, unknown>
r.get = async (key: string) => strings.get(key)
r.set = async (key: string, value: string, opts?: {nx?: boolean}) => {
  if (opts?.nx && strings.has(key)) return ''
  strings.set(key, value)
  return 'OK'
}
r.del = async (...keys: string[]) => {
  for (const key of keys) strings.delete(key)
}
r.incrBy = async (key: string, by: number) => {
  const v = Number(strings.get(key) ?? 0) + by
  strings.set(key, `${v}`)
  return v
}
r.expire = async () => {}
r.hGetAll = async (key: string) => Object.fromEntries(hash(key))
r.hGet = async (key: string, field: string) => hash(key).get(field)
r.hSet = async (key: string, fields: Record<string, string>) => {
  for (const [f, v] of Object.entries(fields)) hash(key).set(f, v)
  return Object.keys(fields).length
}
r.hSetNX = async (key: string, field: string, value: string) => {
  if (hash(key).has(field)) return 0
  hash(key).set(field, value)
  return 1
}
r.hIncrBy = async (key: string, field: string, by: number) => {
  const v = Number(hash(key).get(field) ?? 0) + by
  hash(key).set(field, `${v}`)
  return v
}
r.zAdd = async (key: string, ...rows: {member: string; score: number}[]) => {
  let z = zsets.get(key)
  if (!z) {
    z = new Map()
    zsets.set(key, z)
  }
  for (const row of rows) z.set(row.member, row.score)
  return rows.length
}
r.zRange = async (key: string, start: number, stop: number) =>
  [...(zsets.get(key) ?? new Map<string, number>())]
    .map(([member, score]) => ({member, score}))
    .sort((a, b) => b.score - a.score)
    .slice(start, stop + 1)

// Outside Reddit there is no snoovatar service; keep the expected skips out of test output.
const warn = console.warn
console.warn = (...args: unknown[]): void => {
  if (!`${args[0]}`.endsWith('server request?')) warn(...args)
}

/** Live messages the server tried to send, newest last. */
export const sent: {channel: string; msg: unknown}[] = []
;(realtime as unknown as Record<string, unknown>).send = async (
  channel: string,
  msg: unknown,
) => {
  sent.push({channel, msg})
}

export function resetFakeRedis(): void {
  sent.length = 0
  strings.clear()
  hashes.clear()
  zsets.clear()
}
