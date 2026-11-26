import {redis} from '@devvit/web/server'
import type {DeepLegRsp, DeepRsp, LegReq} from '../shared/api.ts'
import {
  CAMP,
  campLight,
  DEEP_SPARE_EVERY,
  deepDensity,
  generate,
  MAX_LEGS,
  nightOf,
  reveal,
  simulate,
  sparks,
  TILES,
  type Valley,
  validatePath,
} from '../shared/engine.ts'
import {type Day, dayOf} from './clock.ts'
import {getSecret, HttpError, internals, type Who} from './game.ts'

const stateKey = (day: string, uid: string): string => `d:${day}:${uid}`
const lockKey = (day: string, uid: string): string => `dlk:${day}:${uid}`
const boardKey = (day: string): string => `dl:${day}`

type Level = {valley: Valley; open: number[]}
const levels = new Map<string, Level>()

/**
 * Valley `depth` of the night. The same for every walker, so depths can be
 * compared, but each walker lights their own copy.
 */
async function levelOf(day: Day, depth: number): Promise<Level> {
  const id = `${day.key}:${depth}`
  let level = levels.get(id)
  if (!level) {
    const secret = await getSecret()
    const valley = generate(
      internals.seedOf(secret, `deep:${id}`),
      day.weekday,
      deepDensity(depth),
    )
    const lit = new Set<number>()
    campLight(valley, lit)
    for (const s of sparks(
      valley,
      internals.seedOf(secret, `deepsparks:${id}`),
      3,
    ))
      reveal(valley, lit, s)
    level = {valley, open: [...lit]}
    if (levels.size > 200) levels.clear()
    levels.set(id, level)
  }
  return level
}

/** For tests. */
export function forgetLevels(): void {
  levels.clear()
}

const list = (csv: string | undefined): number[] =>
  csv ? csv.split(',').map(Number) : []

async function view(
  day: Day,
  who: Who,
  st: Record<string, string>,
): Promise<DeepRsp> {
  const depth = Number(st.depth ?? 1)
  const {valley} = await levelOf(day, depth)
  const [life, best, top] = await Promise.all([
    redis.hGetAll(internals.lifeKey(who.id)),
    redis.zScore(boardKey(day.key), who.name),
    redis.zRange(boardKey(day.key), 0, 4, {by: 'rank', reverse: true}),
  ])
  const lit = list(st.lit)
  const lanterns = Number(st.lan ?? 0)
  const night = nightOf(day.weekday)
  return {
    day: day.key,
    night: day.night,
    nightName: `The Deep, valley ${depth}`,
    nightBlurb:
      'Private valleys with more bogs each time. Your lanterns carry over.',
    lanternsMax: Math.max(night.lanterns, lanterns),
    expedition: 0,
    glow: Math.round(
      (100 * lit.length) / (TILES - valley.bogs.filter(Boolean).length),
    ),
    almanac: internals.almanacOf(life),
    lit: lit.map(t => [t, valley.counts[t] ?? 0]),
    sunk: list(st.sunk),
    sunkBy: [],
    walkers: 1,
    roster: [],
    me: {
      pos: Number(st.pos ?? CAMP),
      lanterns,
      steps: 0,
      legs: Number(st.legs ?? 0),
      status: st.st === 'over' ? 'lost' : 'walking',
      firstLight: 0,
      relights: 0,
      unranked: true,
    },
    streak: 0,
    streakSaved: false,
    guided: 0,
    result: null,
    stats: null,
    yesterday: null,
    channel: '',
    nextAt: day.nextAt,
    deep: {
      depth,
      crossed: depth - 1,
      best: Number(best ?? 0),
      top: top.map(r => ({name: r.member, score: r.score})),
    },
  }
}

/** The run in progress, or a 404 when there is none. */
export async function deep(
  who: Who,
  now: number = Date.now(),
): Promise<DeepRsp> {
  await internals.rateLimit(who.id, now)
  const day = dayOf(now)
  const st = await redis.hGetAll(stateKey(day.key, who.id))
  if (!st.depth) throw new HttpError(404, 'no run yet')
  return view(day, who, st)
}

/** Begin a fresh run at valley 1. Open once tonight's ranked walk has ended. */
export async function deepStart(
  who: Who,
  now: number = Date.now(),
): Promise<DeepRsp> {
  await internals.rateLimit(who.id, now)
  const day = dayOf(now)
  const night = await redis.hGetAll(internals.userKey(day.key, who.id))
  if (!night.res) throw new HttpError(409, "finish tonight's valley first")
  const {open} = await levelOf(day, 1)
  const key = stateKey(day.key, who.id)
  const st = {
    depth: '1',
    lan: `${nightOf(day.weekday).lanterns}`,
    pos: `${CAMP}`,
    lit: open.join(','),
    sunk: '',
    legs: '0',
    st: 'walking',
  }
  await redis.hSet(key, st)
  await redis.expire(key, internals.TTL_S)
  return view(day, who, st)
}

export async function deepLeg(
  who: Who,
  req: LegReq,
  now: number = Date.now(),
): Promise<DeepLegRsp> {
  await internals.rateLimit(who.id, now)
  const day = dayOf(now)
  const key = stateKey(day.key, who.id)
  const lock = lockKey(day.key, who.id)
  const held = await redis.set(lock, '1', {
    nx: true,
    expiration: new Date(now + internals.LOCK_MS),
  })
  if (!held) throw new HttpError(409, 'previous step still landing')
  try {
    const st = await redis.hGetAll(key)
    if (!st.depth) throw new HttpError(409, 'no run yet')
    const legs = Number(st.legs ?? 0)
    const idle = {
      walk: [],
      sunkAt: null,
      applied: false,
      descended: false,
      spare: false,
    }
    if (st.st !== 'walking' || req?.leg !== legs + 1 || legs >= MAX_LEGS * 10) {
      return {...(await view(day, who, st)), ...idle}
    }
    const pos = Number(st.pos ?? CAMP)
    const bad = validatePath(pos, req.path)
    if (bad) throw new HttpError(400, bad)

    const depth = Number(st.depth)
    const {valley} = await levelOf(day, depth)
    const out = simulate(valley, pos, req.path)
    const lit = new Set(list(st.lit))
    for (const t of out.walk) reveal(valley, lit, t)
    const sunk = new Set(list(st.sunk))
    if (out.sunkAt !== null) sunk.add(out.sunkAt)
    let lanterns = Number(st.lan ?? 0) - (out.sunkAt !== null ? 1 : 0)
    let next: Record<string, string> = {
      ...st,
      pos: `${out.end}`,
      lan: `${lanterns}`,
      lit: [...lit].join(','),
      sunk: [...sunk].join(','),
      legs: `${legs + 1}`,
      st: lanterns <= 0 ? 'over' : 'walking',
    }
    let spare = false
    if (out.arrived) {
      // Crossing counts at once, so a run that ends later still keeps its depth.
      const board = boardKey(day.key)
      const best = Number((await redis.zScore(board, who.name)) ?? 0)
      if (depth > best) {
        await redis.zAdd(board, {member: who.name, score: depth})
        await redis.expire(board, internals.TTL_S)
      }
      spare = depth % DEEP_SPARE_EVERY === 0
      if (spare) lanterns++
      const below = await levelOf(day, depth + 1)
      next = {
        ...next,
        depth: `${depth + 1}`,
        pos: `${CAMP}`,
        lan: `${lanterns}`,
        lit: below.open.join(','),
        sunk: '',
      }
    }
    await redis.hSet(key, next)
    return {
      ...(await view(day, who, next)),
      walk: out.walk,
      sunkAt: out.sunkAt,
      applied: true,
      descended: out.arrived,
      spare,
    }
  } finally {
    await redis.del(lock)
  }
}
