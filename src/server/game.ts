import {createHmac, randomBytes} from 'node:crypto'
import {redis} from '@devvit/web/server'
import type {
  BoardRsp,
  LegReq,
  LegRsp,
  Me,
  PeekRsp,
  TonightRsp,
  WalkStatus,
} from '../shared/api.ts'
import {
  CAMP,
  campLight,
  generate,
  LANTERNS,
  MAX_LEGS,
  reveal,
  score,
  simulate,
  sparks,
  type Valley,
  validatePath,
} from '../shared/engine.ts'
import {type Day, dayOf, previousKey} from './clock.ts'

/** Walkers per expedition. Fixed, so no key grows with the size of the crowd. */
export const EXPEDITION_SIZE = 40
/** Devvit asks for stored user data to go within 30 days. */
const TTL_S: number = 30 * 86_400
/** Longer than the platform's 30 s request limit, so a dead request frees it. */
const LOCK_MS = 40_000
const RATE_PER_MIN = 90

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Who = {id: string; name: string}

const k = {
  secret: 'secret',
  seq: (day: string) => `seq:${day}`,
  user: (day: string, uid: string) => `u:${day}:${uid}`,
  lock: (day: string, uid: string) => `lk:${day}:${uid}`,
  lit: (day: string, exp: number) => `x:${day}:${exp}:lit`,
  sunk: (day: string, exp: number) => `x:${day}:${exp}:sunk`,
  meta: (day: string, exp: number) => `x:${day}:${exp}:meta`,
  board: (day: string) => `lb:${day}`,
  streak: (uid: string) => `s:${uid}`,
  rate: (uid: string, minute: number) => `rl:${uid}:${minute}`,
  posted: (day: string) => `posted:${day}`,
}

let secretCache: string | undefined

/**
 * Per-install secret behind every seed. The code is public; without this the
 * valleys could be computed from the date alone.
 */
export async function getSecret(): Promise<string> {
  if (secretCache) return secretCache
  let secret = await redis.get(k.secret)
  if (!secret) {
    await redis.set(k.secret, randomBytes(32).toString('hex'), {nx: true})
    secret = await redis.get(k.secret)
  }
  if (!secret) throw new HttpError(503, 'storage unavailable')
  secretCache = secret
  return secret
}

/** For tests. */
export function forgetSecret(): void {
  secretCache = undefined
  valleys.clear()
}

function seedOf(secret: string, label: string): number {
  return createHmac('sha256', secret).update(label).digest().readUInt32LE(0)
}

const valleys = new Map<string, Valley>()

async function valleyOf(day: Day, exp: number): Promise<Valley> {
  const id = `${day.key}:${exp}`
  let v = valleys.get(id)
  if (!v) {
    v = generate(seedOf(await getSecret(), `valley:${id}`), day.weekday)
    if (valleys.size > 200) valleys.clear()
    valleys.set(id, v)
  }
  return v
}

async function expire(...keys: string[]): Promise<void> {
  await Promise.all(keys.map(key => redis.expire(key, TTL_S)))
}

async function rateLimit(uid: string, now: number): Promise<void> {
  const key = k.rate(uid, Math.floor(now / 60_000))
  const n = await redis.incrBy(key, 1)
  if (n === 1) await redis.expire(key, 120)
  if (n > RATE_PER_MIN) throw new HttpError(429, 'slow down')
}

function meOf(u: Record<string, string>): Me {
  const status = (u.st ?? 'walking') as WalkStatus
  return {
    pos: Number(u.pos ?? CAMP),
    lanterns: Number(u.lan ?? LANTERNS),
    steps: Number(u.steps ?? 0),
    legs: Number(u.legs ?? 0),
    status,
    firstLight: Number(u.fl ?? 0),
  }
}

/** Give the walker a place in tonight's next open expedition, once. */
async function seat(day: Day, who: Who): Promise<Record<string, string>> {
  const ukey = k.user(day.key, who.id)
  const n = await redis.incrBy(k.seq(day.key), 1)
  let exp = Math.floor((n - 1) / EXPEDITION_SIZE)
  // First write wins, so two racing requests land in the same expedition.
  const won = await redis.hSetNX(ukey, 'exp', `${exp}`)
  if (!won) {
    const seated = await redis.hGetAll(ukey)
    if (seated.name) return seated
    // The request that won the seat died before finishing; finish it here.
    // Every write below is safe to repeat.
    exp = Number(seated.exp ?? exp)
  }

  const valley = await valleyOf(day, exp)
  const litKey = k.lit(day.key, exp)
  const lit = new Set(Object.keys(await redis.hGetAll(litKey)).map(Number))
  const fields: Record<string, string> = {}
  for (const t of campLight(valley, lit)) fields[t] = ''
  let brought = 0
  const sparkSeed = seedOf(
    await getSecret(),
    `sparks:${day.key}:${exp}:${who.id}`,
  )
  for (const s of sparks(valley, sparkSeed)) {
    for (const t of reveal(valley, lit, s)) {
      fields[t] = who.id
      brought++
    }
  }
  if (Object.keys(fields).length > 0) await redis.hSet(litKey, fields)
  const u: Record<string, string> = {
    exp: `${exp}`,
    pos: `${CAMP}`,
    lan: `${LANTERNS}`,
    steps: '0',
    legs: '0',
    st: 'walking',
    fl: `${brought}`,
    name: who.name,
  }
  await redis.hSet(ukey, u)
  const metaKey = k.meta(day.key, exp)
  await redis.hIncrBy(metaKey, 'walkers', 1)
  await expire(ukey, litKey, metaKey, k.seq(day.key))
  return u
}

async function streakOf(uid: string, now: number): Promise<number> {
  const s = await redis.hGetAll(k.streak(uid))
  const today = dayOf(now).key
  if (s.last === today || s.last === previousKey(now)) return Number(s.n ?? 0)
  return 0
}

async function bumpStreak(uid: string, now: number): Promise<void> {
  const key = k.streak(uid)
  const s = await redis.hGetAll(key)
  const today = dayOf(now).key
  if (s.last === today) return
  const n = s.last === previousKey(now) ? Number(s.n ?? 0) + 1 : 1
  await redis.hSet(key, {last: today, n: `${n}`})
  await redis.expire(key, TTL_S)
}

async function view(
  day: Day,
  who: Who,
  u: Record<string, string>,
  now: number,
): Promise<TonightRsp> {
  const exp = Number(u.exp)
  const valley = await valleyOf(day, exp)
  const [litHash, sunkHash, walkers, streak] = await Promise.all([
    redis.hGetAll(k.lit(day.key, exp)),
    redis.hGetAll(k.sunk(day.key, exp)),
    redis.hGet(k.meta(day.key, exp), 'walkers'),
    streakOf(who.id, now),
  ])
  const me = meOf(u)
  const lit: [number, number][] = Object.keys(litHash).map(t => [
    Number(t),
    valley.counts[Number(t)] ?? 0,
  ])
  const over = me.status !== 'walking'
  return {
    day: day.key,
    night: day.night,
    expedition: exp + 1,
    lit,
    sunk: Object.keys(sunkHash).map(Number),
    walkers: Number(walkers ?? 1),
    me,
    streak,
    result: over
      ? {
          ...score(
            me.status === 'arrived',
            me.lanterns,
            me.steps,
            valley.par,
            me.firstLight,
          ),
          par: valley.par,
        }
      : null,
    nextAt: day.nextAt,
  }
}

export async function tonight(
  who: Who,
  now: number = Date.now(),
): Promise<TonightRsp> {
  await rateLimit(who.id, now)
  const day = dayOf(now)
  let u = await redis.hGetAll(k.user(day.key, who.id))
  if (!u.name) u = await seat(day, who)
  if (!u.name) throw new HttpError(503, 'seating in progress, try again')
  return view(day, who, u, now)
}

export async function leg(
  who: Who,
  req: LegReq,
  now: number = Date.now(),
): Promise<LegRsp> {
  await rateLimit(who.id, now)
  const day = dayOf(now)
  const ukey = k.user(day.key, who.id)
  const lockKey = k.lock(day.key, who.id)
  const held = await redis.set(lockKey, '1', {
    nx: true,
    expiration: new Date(now + LOCK_MS),
  })
  if (!held) throw new HttpError(409, 'previous step still landing')
  try {
    const u = await redis.hGetAll(ukey)
    if (!u.name) throw new HttpError(409, 'not seated')
    const me = meOf(u)
    const stale =
      me.status !== 'walking' || req?.leg !== me.legs + 1 || me.legs >= MAX_LEGS
    if (stale)
      return {
        ...(await view(day, who, u, now)),
        walk: [],
        sunkAt: null,
        applied: false,
      }
    const bad = validatePath(me.pos, req.path)
    if (bad) throw new HttpError(400, bad)

    const exp = Number(u.exp)
    const valley = await valleyOf(day, exp)
    const litKey = k.lit(day.key, exp)
    const out = simulate(valley, me.pos, req.path)

    // Lit tiles only ever get added, so concurrent walkers cannot conflict;
    // at worst two walkers both claim first light on the same tile.
    const lit = new Set(Object.keys(await redis.hGetAll(litKey)).map(Number))
    const fields: Record<string, string> = {}
    let fresh = 0
    for (const t of out.walk) {
      for (const r of reveal(valley, lit, t)) {
        fields[r] = who.id
        fresh++
      }
    }
    if (fresh > 0) await redis.hSet(litKey, fields)
    if (out.sunkAt !== null)
      await redis.hSetNX(k.sunk(day.key, exp), `${out.sunkAt}`, who.id)

    const lanterns = me.lanterns - (out.sunkAt !== null ? 1 : 0)
    const status: WalkStatus = out.arrived
      ? 'arrived'
      : lanterns <= 0
        ? 'lost'
        : 'walking'
    const next: Record<string, string> = {
      ...u,
      pos: `${out.end}`,
      lan: `${lanterns}`,
      steps: `${me.steps + out.walk.length}`,
      legs: `${me.legs + 1}`,
      st: status,
      fl: `${me.firstLight + fresh}`,
    }
    await redis.hSet(ukey, next)
    if (me.legs === 0) {
      await bumpStreak(who.id, now)
      await expire(k.sunk(day.key, exp))
    }
    if (status !== 'walking') {
      const total = score(
        out.arrived,
        lanterns,
        Number(next.steps),
        valley.par,
        Number(next.fl),
      ).total
      await redis.zAdd(k.board(day.key), {member: who.name, score: total})
      await expire(k.board(day.key))
    }
    return {
      ...(await view(day, who, next, now)),
      walk: out.walk,
      sunkAt: out.sunkAt,
      applied: true,
    }
  } finally {
    await redis.del(lockKey)
  }
}

export async function peek(
  who: Who | undefined,
  now: number = Date.now(),
): Promise<PeekRsp> {
  const day = dayOf(now)
  const [seq, u, streak] = await Promise.all([
    redis.get(k.seq(day.key)),
    who
      ? redis.hGetAll(k.user(day.key, who.id))
      : Promise.resolve({} as Record<string, string>),
    who ? streakOf(who.id, now) : Promise.resolve(0),
  ])
  return {
    night: day.night,
    walkersToday: Number(seq ?? 0),
    status: u.name ? meOf(u).status : 'new',
    streak,
  }
}

export async function board(now: number = Date.now()): Promise<BoardRsp> {
  const rows = await redis.zRange(k.board(dayOf(now).key), 0, 9, {
    by: 'rank',
    reverse: true,
  })
  return {top: rows.map(r => ({name: r.member, score: r.score}))}
}

/** True the first time it is called for a day; later calls are no-ops. */
export async function claimDailyPost(
  now: number = Date.now(),
): Promise<boolean> {
  const key = k.posted(dayOf(now).key)
  const won = await redis.set(key, '1', {
    nx: true,
    expiration: new Date(now + TTL_S * 1000),
  })
  return Boolean(won)
}
