import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {beforeEach, test} from 'node:test'
import {type Context, runWithContext} from '@devvit/web/server'
import {Endpoint} from '../shared/api.ts'
import {BEACON, CAMP, generate, neighbors4, TILES} from '../shared/engine.ts'
import {resetFakeRedis, sent, strings} from '../test/fake-redis.ts'
import {dayOf} from './clock.ts'
import {
  board,
  claimDailyPost,
  EXPEDITION_SIZE,
  forgetSecret,
  type HttpError,
  leg,
  peek,
  relight,
  tonight,
  wearFlair,
} from './game.ts'
import {onReq} from './server.ts'

const NOW: number = Date.UTC(2026, 10, 27, 12)
const ana = {id: 't2_ana', name: 'ana'}

beforeEach(() => {
  resetFakeRedis()
  forgetSecret()
})

/** Rebuild the hidden valley the way the server does, to steer test walkers. */
async function hidden(exp = 0): Promise<ReturnType<typeof generate>> {
  const {createHmac} = await import('node:crypto')
  const day = dayOf(NOW)
  const secret = strings.get('secret') as string
  const seed = createHmac('sha256', secret)
    .update(`valley:${day.key}:${exp}`)
    .digest()
    .readUInt32LE(0)
  return generate(seed, day.weekday)
}

function safeRoute(bogs: readonly boolean[]): number[] {
  const prev = new Map<number, number>([[CAMP, -1]])
  const queue = [CAMP]
  for (let h = 0; h < queue.length; h++) {
    for (const n of neighbors4(queue[h] as number)) {
      if (prev.has(n) || bogs[n]) continue
      prev.set(n, queue[h] as number)
      queue.push(n)
    }
  }
  const path: number[] = []
  for (let c = BEACON; c !== CAMP; c = prev.get(c) as number) path.unshift(c)
  return path
}

test('seating is idempotent and never reveals a bog', async () => {
  const first = await tonight(ana, NOW)
  const again = await tonight(ana, NOW)
  assert.equal(first.expedition, 1)
  assert.deepEqual(again.me, first.me)
  assert.equal(again.walkers, 1)
  assert.equal(first.result, null)
  const v = await hidden()
  assert.ok(first.lit.length >= 9 && first.lit.length < TILES)
  for (const [tile, count] of first.lit) {
    assert.equal(v.bogs[tile], false)
    assert.equal(count, v.counts[tile])
  }
  // Nothing in the reply may carry the hidden map: no key for it, no array as long as the valley.
  assert.ok(!JSON.stringify(first).includes('"bogs"'))
  for (const value of Object.values(first))
    assert.ok(!Array.isArray(value) || value.length < TILES)
})

test('a clean crossing scores, reveals par and joins the board', async () => {
  await tonight(ana, NOW)
  const v = await hidden()
  const rsp = await leg(ana, {leg: 1, path: safeRoute(v.bogs)}, NOW)
  assert.equal(rsp.applied, true)
  assert.equal(rsp.me.status, 'arrived')
  assert.equal(rsp.me.lanterns, 3)
  assert.equal(rsp.result?.par, v.par)
  assert.equal(rsp.result?.route, 100)
  assert.equal(rsp.streak, 1)
  assert.deepEqual((await board(NOW)).top, [
    {name: 'ana', score: rsp.result?.total},
  ])
  const after = await leg(ana, {leg: 2, path: [BEACON + 1]}, NOW)
  assert.equal(after.applied, false)
})

test('three bogs end the walk and mark each bog for the next walker', async () => {
  await tonight(ana, NOW)
  const v = await hidden()
  let pos = CAMP
  let legNo = 1
  let last: Awaited<ReturnType<typeof leg>> = {
    ...(await tonight(ana, NOW)),
    walk: [],
    sunkAt: null,
    applied: false,
  }
  const sunk = new Set<number>()
  // Walk the safe route, detouring into every bog that touches it.
  for (const step of safeRoute(v.bogs)) {
    if (last.me.status !== 'walking') break
    for (const n of neighbors4(pos)) {
      if (!v.bogs[n] || sunk.has(n) || last.me.status !== 'walking') continue
      last = await leg(ana, {leg: legNo++, path: [n]}, NOW)
      assert.equal(last.sunkAt, n)
      assert.equal(last.me.pos, pos)
      sunk.add(n)
    }
    if (last.me.status !== 'walking') break
    last = await leg(ana, {leg: legNo++, path: [step]}, NOW)
    pos = step
  }
  assert.equal(last.me.lanterns, 3 - Math.min(3, sunk.size))
  const bo = await tonight({id: 't2_bo', name: 'bo'}, NOW)
  assert.deepEqual([...bo.sunk].sort(), [...sunk].sort())
  assert.equal(bo.walkers, 2)
})

test('duplicate, out-of-turn and illegal legs change nothing', async () => {
  const start = await tonight(ana, NOW)
  const up = CAMP - 7
  assert.equal((await leg(ana, {leg: 2, path: [up]}, NOW)).applied, false)
  await assert.rejects(
    leg(ana, {leg: 1, path: [CAMP - 14]}, NOW),
    (e: HttpError) => e.status === 400,
  )
  await assert.rejects(
    leg(ana, {leg: 1, path: 'x' as unknown as number[]}, NOW),
    (e: HttpError) => e.status === 400,
  )
  assert.deepEqual((await tonight(ana, NOW)).me, start.me)
  assert.equal((await leg(ana, {leg: 1, path: [up]}, NOW)).applied, true)
  const dup = await leg(ana, {leg: 1, path: [up - 7]}, NOW)
  assert.equal(dup.applied, false)
  assert.equal(dup.me.pos, up)
})

test('a leg in flight blocks a second one', async () => {
  await tonight(ana, NOW)
  strings.set(`lk:${dayOf(NOW).key}:${ana.id}`, '1')
  await assert.rejects(
    leg(ana, {leg: 1, path: [CAMP - 7]}, NOW),
    (e: HttpError) => e.status === 409,
  )
})

test('expeditions fill in order and stay separate', async () => {
  for (let i = 0; i < EXPEDITION_SIZE; i++)
    await tonight({id: `t2_${i}`, name: `w${i}`}, NOW)
  const late = await tonight({id: 't2_late', name: 'late'}, NOW)
  assert.equal(late.expedition, 2)
  assert.equal(late.walkers, 1)
  assert.equal((await peek(undefined, NOW)).walkersToday, EXPEDITION_SIZE + 1)
  assert.equal(
    (await peek({id: 't2_late', name: 'late'}, NOW)).status,
    'walking',
  )
})

test('requests are rate limited per walker', async () => {
  for (let i = 0; i < 90; i++) await tonight(ana, NOW)
  await assert.rejects(tonight(ana, NOW), (e: HttpError) => e.status === 429)
})

test('streak grows on consecutive nights and resets after a gap', async () => {
  const day = 86_400_000
  for (const [offset, want] of [
    [0, 1],
    [1, 2],
    [3, 1],
  ] as const) {
    const t = NOW + offset * day
    await tonight(ana, t)
    assert.equal((await leg(ana, {leg: 1, path: [CAMP - 7]}, t)).streak, want)
  }
})

test("following another walker's light credits them once", async () => {
  const bo = {id: 't2_bo', name: 'bo'}
  await tonight(ana, NOW)
  const v = await hidden()
  const route = safeRoute(v.bogs)
  const first = await leg(ana, {leg: 1, path: route}, NOW)
  assert.equal(first.guided, 0)
  const live = sent.at(-1)?.msg as {by: string; arrived: boolean; sunk: boolean}
  assert.deepEqual([live.by, live.arrived, live.sunk], ['ana', true, false])
  await tonight(bo, NOW)
  const half = Math.floor(route.length / 2)
  await leg(bo, {leg: 1, path: route.slice(0, half)}, NOW)
  await leg(bo, {leg: 2, path: route.slice(half)}, NOW)
  const after = await tonight(ana, NOW)
  assert.equal(after.guided, 1)
  assert.deepEqual(after.stats, [0, 0, 0, 2])
  assert.deepEqual(
    after.roster.map(w => w.name),
    ['bo', 'ana'],
  )
  assert.equal(after.channel, sent.at(-1)?.channel)
  assert.match(after.channel, /^[a-zA-Z0-9_]+$/)
})

test("a sunk lantern carries the walker's name, and the feed card sees the light", async () => {
  await tonight(ana, NOW)
  const v = await hidden()
  let pos = CAMP
  let legNo = 1
  for (const step of safeRoute(v.bogs)) {
    const bog = neighbors4(pos).find(n => v.bogs[n])
    if (bog !== undefined) {
      const rsp = await leg(ana, {leg: legNo, path: [bog]}, NOW)
      assert.deepEqual(rsp.sunkBy, [[bog, 'ana']])
      break
    }
    await leg(ana, {leg: legNo++, path: [step]}, NOW)
    pos = step
  }
  const card = await peek(undefined, NOW)
  assert.ok(card.litPct > 10 && card.litPct <= 100)
})

test('a streak of three survives one missed night, once', async () => {
  const day = 86_400_000
  const walk = async (
    offset: number,
  ): Promise<{streak: number; streakSaved: boolean}> => {
    const t = NOW + offset * day
    await tonight(ana, t)
    return leg(ana, {leg: 1, path: [CAMP - 7]}, t)
  }
  for (const offset of [0, 1, 2]) await walk(offset)
  const spared = await walk(4)
  assert.equal(spared.streak, 4)
  assert.equal(spared.streakSaved, true)
  assert.equal((await walk(6)).streak, 1)
})

test('last night shows up once, before the first step of a new night', async () => {
  const day = 86_400_000
  await tonight(ana, NOW)
  await leg(ana, {leg: 1, path: [CAMP - 7]}, NOW)
  const next = await tonight(ana, NOW + day)
  assert.deepEqual(next.yesterday, {
    night: next.night - 1,
    guided: 0,
    status: 'walking',
  })
  const stepped = await leg(ana, {leg: 1, path: [CAMP - 7]}, NOW + day)
  assert.equal(stepped.yesterday, null)
})

test('flair is refused without a streak', async () => {
  await assert.rejects(wearFlair(ana, NOW), (e: HttpError) => e.status === 409)
})

test('a lost walker can relight and walk on without changing the ranked result', async () => {
  await tonight(ana, NOW)
  await assert.rejects(relight(ana, NOW), (e: HttpError) => e.status === 409)
  const v = await hidden()
  // Walk the safe route until a bog is beside it, then step in until the lanterns run out.
  let pos = CAMP
  let legNo = 1
  let last = await leg(
    ana,
    {leg: legNo++, path: [safeRoute(v.bogs)[0] as number]},
    NOW,
  )
  pos = last.me.pos
  const rest = safeRoute(v.bogs).slice(1)
  let bog: number | undefined
  while (bog === undefined) {
    bog = neighbors4(pos).find(n => v.bogs[n])
    if (bog !== undefined) break
    last = await leg(ana, {leg: legNo++, path: [rest.shift() as number]}, NOW)
    pos = last.me.pos
  }
  while (last.me.status === 'walking')
    last = await leg(ana, {leg: legNo++, path: [bog]}, NOW)
  assert.equal(last.me.status, 'lost')
  const lostResult = last.result
  const boardBefore = await board(NOW)

  const relit = await relight(ana, NOW)
  assert.deepEqual(
    [relit.me.status, relit.me.lanterns, relit.me.unranked, relit.me.relights],
    ['walking', 1, true, 2],
  )
  assert.deepEqual(relit.result, lostResult)
  const done = await leg(ana, {leg: legNo++, path: rest}, NOW)
  assert.equal(done.me.status, 'arrived')
  assert.deepEqual(done.result, lostResult)
  assert.deepEqual(await board(NOW), boardBefore)
  assert.deepEqual(done.stats, [1, 0, 0, 0])
  assert.equal(done.almanac.nights, 1)
  assert.equal(done.almanac.crossed, 0)
})

test('relights run out after three', async () => {
  await tonight(ana, NOW)
  const v = await hidden()
  let pos = CAMP
  let legNo = 1
  const route = safeRoute(v.bogs)
  let bog = neighbors4(pos).find(n => v.bogs[n])
  while (bog === undefined) {
    pos = (await leg(ana, {leg: legNo++, path: [route.shift() as number]}, NOW))
      .me.pos
    bog = neighbors4(pos).find(n => v.bogs[n])
  }
  const sink = async (): Promise<void> => {
    let st = 'walking'
    while (st === 'walking')
      st = (await leg(ana, {leg: legNo++, path: [bog as number]}, NOW)).me
        .status
  }
  await sink()
  for (let i = 0; i < 3; i++) {
    await relight(ana, NOW)
    await sink()
  }
  await assert.rejects(relight(ana, NOW), (e: HttpError) => e.status === 409)
})

test('each night has a name, and a crossing builds the almanac', async () => {
  const start = await tonight(ana, NOW)
  assert.equal(start.nightName, 'Marsh night')
  assert.equal(start.lanternsMax, 3)
  assert.equal(start.almanac.rank, 'Spark')
  const v = await hidden()
  const done = await leg(ana, {leg: 1, path: safeRoute(v.bogs)}, NOW)
  assert.ok(done.glow > start.glow && done.glow <= 100)
  assert.equal(done.almanac.nights, 1)
  assert.equal(done.almanac.crossed, 1)
  assert.equal(done.almanac.best, done.result?.total)
  assert.equal(done.almanac.lit, done.me.firstLight - start.me.firstLight)
  assert.equal((await peek(undefined, NOW)).nightName, 'Marsh night')
  const sat = await tonight(ana, NOW + 86_400_000)
  assert.deepEqual(
    [sat.nightName, sat.me.lanterns, sat.lanternsMax],
    ['Deep marsh', 4, 4],
  )
})

test('the daily post can only be claimed once', async () => {
  assert.equal(await claimDailyPost(NOW), true)
  assert.equal(await claimDailyPost(NOW), false)
})

test('http: logged-out walkers get 401, unknown routes 404, peek stays open', async () => {
  const server = createServer((req, rsp) => {
    void runWithContext({postId: 't3_1'} as unknown as Context, () =>
      onReq(req, rsp),
    )
  })
  await new Promise<void>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    assert.equal((await fetch(`${url}/${Endpoint.Tonight}`)).status, 401)
    assert.equal((await fetch(`${url}/nope`)).status, 404)
    assert.equal((await fetch(`${url}/${Endpoint.Leg}`)).status, 404)
    const peeked = await fetch(`${url}/${Endpoint.Peek}`)
    assert.equal(peeked.status, 200)
    assert.equal(((await peeked.json()) as {status: string}).status, 'new')
    const big = await fetch(`${url}/${Endpoint.Leg}`, {
      method: 'POST',
      body: 'x'.repeat(5000),
    })
    assert.equal(big.status, 401)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
