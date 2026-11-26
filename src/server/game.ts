import {createHmac, randomBytes} from 'node:crypto'
import {context, realtime, reddit, redis} from '@devvit/web/server'
import type {
  Almanac,
  BoardRsp,
  FlairRsp,
  LegReq,
  LegRsp,
  LiveMsg,
  Me,
  PeekRsp,
  TonightRsp,
  Walker,
  WalkStatus,
} from '../shared/api.ts'
import {
  CAMP,
  campLight,
  generate,
  LANTERNS,
  MAX_LEGS,
  MAX_RELIGHTS,
  nightOf,
  reveal,
  score,
  simulate,
  sparks,
  TILES,
  type Valley,
  validatePath,
} from '../shared/engine.ts'
import {type Day, dayOf, daysBetween, keyBefore, previousKey} from './clock.ts'

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

/** Reddit-side extras must never break a walk; log and carry on. */
async function soft<T>(
  what: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run()
  } catch (err) {
    console.warn(`${what} skipped; ${err instanceof Error ? err.message : err}`)
    return undefined
  }
}

function channelOf(day: Day, exp: number): string {
  return `valley_${day.key.replaceAll('-', '')}_${exp}`
}

/** Stay well under the platform's realtime message budget. */
const LIVE_PER_SECOND = 60

async function announce(
  day: Day,
  exp: number,
  msg: LiveMsg,
  now: number,
): Promise<void> {
  await soft('live update', async () => {
    const key = k.live(Math.floor(now / 1000))
    const n = await redis.incrBy(key, 1)
    if (n === 1) await redis.expire(key, 5)
    if (n <= LIVE_PER_SECOND) await realtime.send(channelOf(day, exp), msg)
  })
}

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
  guide: (day: string) => `g:${day}`,
  life: (uid: string) => `p:${uid}`,
  stats: (day: string) => `st:${day}`,
  roster: (day: string, exp: number) => `x:${day}:${exp}:who`,
  live: (second: number) => `rt:${second}`,
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
    relights: MAX_RELIGHTS - Number(u.rl ?? 0),
    unranked: u.ur === '1',
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
  const night = nightOf(day.weekday)
  for (const s of sparks(valley, sparkSeed, night.sparks)) {
    for (const t of reveal(valley, lit, s)) {
      fields[t] = who.id
      brought++
    }
  }
  if (Object.keys(fields).length > 0) await redis.hSet(litKey, fields)
  const u: Record<string, string> = {
    exp: `${exp}`,
    pos: `${CAMP}`,
    lan: `${night.lanterns}`,
    steps: '0',
    legs: '0',
    st: 'walking',
    fl: `${brought}`,
    name: who.name,
  }
  await redis.hSet(ukey, u)
  const metaKey = k.meta(day.key, exp)
  const joined = await redis.hIncrBy(metaKey, 'walkers', 1)
  const avatar =
    (await soft('snoovatar', () => reddit.getSnoovatarUrl(who.name))) ?? null
  const rosterKey = k.roster(day.key, exp)
  await redis.hSet(rosterKey, {
    [who.id]: JSON.stringify({n: who.name, a: avatar, i: joined}),
  })
  await expire(ukey, litKey, metaKey, rosterKey, k.seq(day.key))
  return u
}

/** A streak of three or more survives one missed night, once a week. */
function spareWick(s: Record<string, string>, now: number): boolean {
  const today = dayOf(now).key
  const rested = !s.saved || daysBetween(s.saved, today) >= 7
  return s.last === keyBefore(now, 2) && Number(s.n ?? 0) >= 3 && rested
}

async function streakOf(
  uid: string,
  now: number,
): Promise<{n: number; saved: boolean}> {
  const s = await redis.hGetAll(k.streak(uid))
  const today = dayOf(now).key
  const alive =
    s.last === today || s.last === previousKey(now) || spareWick(s, now)
  return {n: alive ? Number(s.n ?? 0) : 0, saved: s.saved === today}
}

async function bumpStreak(uid: string, now: number): Promise<void> {
  const key = k.streak(uid)
  const s = await redis.hGetAll(key)
  const today = dayOf(now).key
  if (s.last === today) return
  const spared = spareWick(s, now)
  const n = s.last === previousKey(now) || spared ? Number(s.n ?? 0) + 1 : 1
  await redis.hSet(key, {
    last: today,
    n: `${n}`,
    ...(spared ? {saved: today} : {}),
  })
  await redis.expire(key, TTL_S)
}

/** Ranks by tiles lit first across all nights. */
const RANKS: readonly [number, string][] = [
  [0, 'Spark'],
  [25, 'Candle'],
  [75, 'Lantern'],
  [200, 'Beacon'],
  [500, 'Lighthouse'],
]

function almanacOf(p: Record<string, string>): Almanac {
  const lit = Number(p.lit ?? 0)
  let at = 0
  for (const [i, [need]] of RANKS.entries()) if (lit >= need) at = i
  const next = RANKS[at + 1]
  return {
    nights: Number(p.nights ?? 0),
    crossed: Number(p.crossed ?? 0),
    lit,
    best: Number(p.best ?? 0),
    rank: (RANKS[at] as [number, string])[1],
    toNext: next ? next[0] - lit : null,
    nextRank: next ? next[1] : null,
  }
}

function rosterOf(
  hash: Record<string, string>,
): Map<string, Walker & {order: number}> {
  const out = new Map<string, Walker & {order: number}>()
  for (const [uid, raw] of Object.entries(hash)) {
    try {
      const w = JSON.parse(raw) as {n: string; a: string | null; i: number}
      out.set(uid, {name: w.n, avatar: w.a, order: w.i})
    } catch {
      // A malformed entry only costs one face in the roster.
    }
  }
  return out
}

async function view(
  day: Day,
  who: Who,
  u: Record<string, string>,
  now: number,
): Promise<TonightRsp> {
  const exp = Number(u.exp)
  const valley = await valleyOf(day, exp)
  const me = meOf(u)
  const over = me.status !== 'walking'
  const [life, litHash, sunkHash, walkers, streak, guided, rosterHash, stats] =
    await Promise.all([
      redis.hGetAll(k.life(who.id)),
      redis.hGetAll(k.lit(day.key, exp)),
      redis.hGetAll(k.sunk(day.key, exp)),
      redis.hGet(k.meta(day.key, exp), 'walkers'),
      streakOf(who.id, now),
      redis.hGet(k.guide(day.key), who.id),
      redis.hGetAll(k.roster(day.key, exp)),
      over ? redis.hGetAll(k.stats(day.key)) : Promise.resolve(null),
    ])
  const roster = rosterOf(rosterHash)
  const live = {
    ...score(
      me.status === 'arrived',
      me.lanterns,
      me.steps,
      valley.par,
      me.firstLight,
    ),
    par: valley.par,
  }
  const lit: [number, number][] = Object.keys(litHash).map(t => [
    Number(t),
    valley.counts[Number(t)] ?? 0,
  ])
  return {
    day: day.key,
    night: day.night,
    nightName: nightOf(day.weekday).name,
    nightBlurb: nightOf(day.weekday).blurb,
    lanternsMax: nightOf(day.weekday).lanterns,
    expedition: exp + 1,
    glow: Math.round(
      (100 * lit.length) / (TILES - valley.bogs.filter(Boolean).length),
    ),
    almanac: almanacOf(life),
    lit,
    sunk: Object.keys(sunkHash).map(Number),
    sunkBy: Object.entries(sunkHash).map(([t, uid]) => [
      Number(t),
      roster.get(uid)?.name ?? 'a walker',
    ]),
    walkers: Number(walkers ?? 1),
    roster: [...roster.values()]
      .sort((a, b) => b.order - a.order)
      .slice(0, 8)
      .map(w => ({name: w.name, avatar: w.avatar})),
    me,
    streak: streak.n,
    streakSaved: streak.saved,
    guided: Number(guided ?? 0),
    result: frozen(u) ?? (over ? live : null),
    stats: stats ? [0, 1, 2, 3].map(i => Number(stats[i] ?? 0)) : null,
    yesterday: null,
    channel: channelOf(day, exp),
    nextAt: day.nextAt,
  }
}

/** The ranked result, fixed when the walk first ended; walking on never changes it. */
function frozen(u: Record<string, string>): TonightRsp['result'] {
  if (!u.res) return null
  try {
    return JSON.parse(u.res) as TonightRsp['result']
  } catch {
    return null
  }
}

/** Last night's walk, for the welcome back line. */
async function recap(who: Who, now: number): Promise<TonightRsp['yesterday']> {
  const prev = dayOf(now - 86_400_000)
  const [u, guided] = await Promise.all([
    redis.hGetAll(k.user(prev.key, who.id)),
    redis.hGet(k.guide(prev.key), who.id),
  ])
  if (!u.name) return null
  return {
    night: prev.night,
    guided: Number(guided ?? 0),
    status: meOf(u).status,
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
  const rsp = await view(day, who, u, now)
  if (rsp.me.legs === 0) rsp.yesterday = await recap(who, now)
  return rsp
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
    const owners = await redis.hGetAll(litKey)
    const lit = new Set(Object.keys(owners).map(Number))
    // Credit each walker whose light this walker used, once per pair.
    const thanked = new Set((u.gu ?? '').split(',').filter(Boolean))
    const newly: string[] = []
    for (const t of out.walk) {
      const owner = owners[t]
      if (!owner || owner === who.id || thanked.has(owner)) continue
      thanked.add(owner)
      newly.push(owner)
    }
    if (newly.length > 0) {
      await Promise.all(
        newly.map(owner => redis.hIncrBy(k.guide(day.key), owner, 1)),
      )
      await expire(k.guide(day.key))
    }
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
      gu: [...thanked].join(','),
    }
    const ended = status !== 'walking'
    const ranked = ended && !me.unranked
    const parts = score(
      out.arrived,
      lanterns,
      Number(next.steps),
      valley.par,
      Number(next.fl),
    )
    if (ranked) next.res = JSON.stringify({...parts, par: valley.par})
    await redis.hSet(ukey, next)
    if (me.legs === 0) {
      await bumpStreak(who.id, now)
      await expire(k.sunk(day.key, exp))
    }
    const lifeKey = k.life(who.id)
    if (fresh > 0) await redis.hIncrBy(lifeKey, 'lit', fresh)
    if (ranked) {
      await redis.zAdd(k.board(day.key), {member: who.name, score: parts.total})
      await redis.hIncrBy(k.stats(day.key), `${out.arrived ? lanterns : 0}`, 1)
      await redis.hIncrBy(lifeKey, 'nights', 1)
      if (out.arrived) await redis.hIncrBy(lifeKey, 'crossed', 1)
      const best = Number((await redis.hGet(lifeKey, 'best')) ?? 0)
      if (parts.total > best)
        await redis.hSet(lifeKey, {best: `${parts.total}`})
      await expire(k.board(day.key), k.stats(day.key))
    }
    if (fresh > 0 || ranked) await expire(lifeKey)
    if (fresh > 0 || out.sunkAt !== null || out.arrived) {
      await announce(
        day,
        exp,
        {
          by: who.name,
          lit: fresh,
          sunk: out.sunkAt !== null,
          arrived: out.arrived,
        },
        now,
      )
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
    who ? streakOf(who.id, now) : Promise.resolve({n: 0, saved: false}),
  ])
  const walkersToday = Number(seq ?? 0)
  let litPct = 0
  if (walkersToday > 0) {
    // The viewer's own valley when they have one, otherwise the newest.
    const exp = u.exp
      ? Number(u.exp)
      : Math.floor((walkersToday - 1) / EXPEDITION_SIZE)
    const [valley, lit] = await Promise.all([
      valleyOf(day, exp),
      redis.hGetAll(k.lit(day.key, exp)),
    ])
    const dry = TILES - valley.bogs.filter(Boolean).length
    litPct = Math.round((100 * Object.keys(lit).length) / dry)
  }
  return {
    night: day.night,
    nightName: nightOf(day.weekday).name,
    walkersToday,
    litPct,
    status: u.name ? meOf(u).status : 'new',
    streak: streak.n,
  }
}

/**
 * A lost walker relights one lantern and walks on. The night's score is
 * already fixed; what they light and mark from here still helps the expedition.
 */
export async function relight(
  who: Who,
  now: number = Date.now(),
): Promise<TonightRsp> {
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
    const me = meOf(u)
    if (!u.name || me.status !== 'lost')
      throw new HttpError(409, 'nothing to relight')
    if (me.relights <= 0)
      throw new HttpError(409, 'no lanterns left to relight')
    const next = {
      ...u,
      st: 'walking',
      lan: '1',
      rl: `${Number(u.rl ?? 0) + 1}`,
      ur: '1',
    }
    await redis.hSet(ukey, next)
    return await view(day, who, next, now)
  } finally {
    await redis.del(lockKey)
  }
}

/** Opt-in: wear tonight's streak as subreddit flair. Only ever runs on the walker's own tap. */
export async function wearFlair(
  who: Who,
  now: number = Date.now(),
): Promise<FlairRsp> {
  await rateLimit(who.id, now)
  const {n} = await streakOf(who.id, now)
  if (n < 2) throw new HttpError(409, 'walk two nights in a row first')
  const subredditName = context.subredditName
  if (!subredditName) throw new HttpError(503, 'no subreddit')
  const text = `${n}-night lantern`
  await reddit.setUserFlair({
    subredditName,
    username: who.name,
    text,
    backgroundColor: '#1a2350',
    textColor: 'light',
  })
  return {text}
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
