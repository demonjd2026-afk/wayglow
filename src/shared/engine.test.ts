import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  BEACON,
  CAMP,
  campLight,
  generate,
  LANTERNS,
  neighbors4,
  neighbors8,
  reveal,
  score,
  shortest,
  simulate,
  sparks,
  TILES,
  type Valley,
  validatePath,
} from './engine.ts'

test('same seed, same valley', () => {
  assert.deepEqual(generate(42, 3), generate(42, 3))
  assert.notDeepEqual(generate(42, 3).bogs, generate(43, 3).bogs)
})

test('every valley is crossable and the camp ring is dry', () => {
  for (let seed = 0; seed < 2000; seed++) {
    const v = generate(seed, seed % 7)
    assert.ok(v.par > 0)
    assert.equal(v.par, shortest(v.bogs))
    assert.equal(v.bogs[CAMP], false)
    assert.equal(v.bogs[BEACON], false)
    for (const n of neighbors8(CAMP)) assert.equal(v.bogs[n], false)
  }
})

test('counts match the bogs around each tile', () => {
  const v = generate(7, 2)
  for (let i = 0; i < TILES; i++) {
    assert.equal(v.counts[i], neighbors8(i).filter(n => v.bogs[n]).length)
  }
})

test('reveal never lights a bog and floods from empty tiles', () => {
  for (let seed = 0; seed < 300; seed++) {
    const v = generate(seed, 1)
    const lit = new Set<number>()
    campLight(v, lit)
    for (const s of sparks(v, seed)) reveal(v, lit, s)
    for (const i of lit) {
      assert.equal(v.bogs[i], false)
      if (v.counts[i] === 0)
        for (const n of neighbors8(i)) assert.ok(lit.has(n))
    }
    assert.ok(lit.has(CAMP))
  }
})

test('validatePath rejects jumps, bounds and junk', () => {
  assert.equal(validatePath(CAMP, [CAMP - 7, CAMP - 14]), null)
  assert.ok(validatePath(CAMP, [CAMP - 14]))
  assert.ok(validatePath(CAMP, []))
  assert.ok(validatePath(CAMP, [-1]))
  assert.ok(validatePath(CAMP, [CAMP - 6]))
  assert.ok(validatePath(CAMP, 'x'))
  assert.ok(validatePath(CAMP, [1.5]))
  assert.ok(validatePath(6, [7]))
  assert.ok(validatePath(CAMP, new Array(49).fill(CAMP - 7)))
})

test('simulate stops at a bog and at the beacon', () => {
  const bogs = new Array<boolean>(TILES).fill(false)
  bogs[CAMP - 14] = true
  const v: Valley = {bogs, counts: new Array<number>(TILES).fill(0), par: 9}
  const sunk = simulate(v, CAMP, [CAMP - 7, CAMP - 14, CAMP - 21])
  assert.deepEqual(sunk, {
    walk: [CAMP - 7],
    sunkAt: CAMP - 14,
    end: CAMP - 7,
    arrived: false,
  })
  const done = simulate(v, BEACON + 7, [BEACON, BEACON + 1])
  assert.deepEqual(done, {
    walk: [BEACON],
    sunkAt: null,
    end: BEACON,
    arrived: true,
  })
})

test('score rewards lanterns, short routes and first light', () => {
  assert.deepEqual(score(true, 3, 9, 9, 10), {
    lanterns: 300,
    route: 100,
    light: 20,
    total: 420,
  })
  assert.equal(score(true, 1, 19, 9, 0).total, 100 + 60)
  assert.equal(score(false, 0, 5, 9, 4).total, 8)
})

/**
 * A careful walker: deduces what the counts prove, walks proven-safe ground,
 * and only gambles when nothing is certain. Used to tune bog density.
 */
function bot(v: Valley, sparkSeed: number): boolean {
  return botRun(v, sparkSeed) > 0
}

/** Lanterns left on arrival, or 0 when the walker is lost. */
export function botRun(v: Valley, sparkSeed: number): number {
  const lit = new Set<number>()
  const known = new Set<number>()
  campLight(v, lit)
  for (const s of sparks(v, sparkSeed)) reveal(v, lit, s)
  let pos = CAMP
  let lanterns = LANTERNS
  for (let guard = 0; guard < 400 && lanterns > 0; guard++) {
    const safe = new Set<number>(lit)
    for (let changed = true; changed; ) {
      changed = false
      for (const i of lit) {
        const ns = neighbors8(i)
        const bogsKnown = ns.filter(n => known.has(n)).length
        const dark = ns.filter(n => !safe.has(n) && !known.has(n))
        if (dark.length === 0) continue
        const left = (v.counts[i] as number) - bogsKnown
        const proven = left === 0 ? safe : left === dark.length ? known : null
        if (!proven) continue
        for (const n of dark) proven.add(n)
        changed = true
      }
    }
    const reach = new Map<number, number>([[pos, -1]])
    const queue = [pos]
    for (let h = 0; h < queue.length; h++) {
      for (const n of neighbors4(queue[h] as number)) {
        if (reach.has(n) || !safe.has(n)) continue
        reach.set(n, queue[h] as number)
        queue.push(n)
      }
    }
    let target = -1
    if (reach.has(BEACON)) target = BEACON
    else target = queue.find(q => !lit.has(q)) ?? -1
    if (target === -1) {
      let best = Infinity
      for (const q of queue) {
        for (const n of neighbors4(q)) {
          if (safe.has(n) || known.has(n)) continue
          let risk = 0.2
          for (const m of neighbors8(n)) {
            if (!lit.has(m)) continue
            const ns = neighbors8(m)
            const dark = ns.filter(x => !safe.has(x) && !known.has(x)).length
            const left =
              (v.counts[m] as number) - ns.filter(x => known.has(x)).length
            risk = Math.max(risk, left / dark)
          }
          const cost = risk * 100 + Math.floor(n / 7)
          if (cost < best) {
            best = cost
            target = n
            reach.set(n, q)
          }
        }
      }
    }
    if (target === -1) return 0
    const path: number[] = []
    for (let c = target; c !== pos; c = reach.get(c) as number) path.unshift(c)
    assert.equal(validatePath(pos, path), null)
    const leg = simulate(v, pos, path)
    for (const t of leg.walk) reveal(v, lit, t)
    pos = leg.end
    if (leg.sunkAt !== null) {
      known.add(leg.sunkAt)
      lanterns--
    }
    if (leg.arrived) return lanterns
  }
  return 0
}

test('a careful first walker usually crosses a dark valley', () => {
  for (let weekday = 0; weekday < 7; weekday++) {
    let wins = 0
    const runs = 400
    for (let s = 0; s < runs; s++)
      if (bot(generate(s * 31 + weekday, weekday), s)) wins++
    const rate = wins / runs
    console.log(
      `weekday ${weekday}: careful first walker crosses ${(rate * 100).toFixed(0)}%`,
    )
    assert.ok(rate > 0.75, `weekday ${weekday} too harsh: ${rate}`)
    assert.ok(rate < 0.99, `weekday ${weekday} too easy: ${rate}`)
  }
})
