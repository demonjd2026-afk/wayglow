/**
 * Wayglow rules engine. Pure and deterministic: the server runs it with the
 * secret seed to hold the hidden valley; the client only ever sees lit tiles.
 */

export const W = 7
export const H = 10
export const TILES: number = W * H
/** Camp sits bottom centre, the beacon top centre. */
export const CAMP: number = (H - 1) * W + 3
export const BEACON = 3
export const LANTERNS = 3
/** Lanterns a lost walker may relight to walk on, unranked. */
export const MAX_RELIGHTS = 3
export const MAX_PATH = 48
/** Far above any real walk; one tile at a time across the whole valley fits. */
export const MAX_LEGS = 120

export type Valley = {
  /** True where a bog hides. */
  readonly bogs: readonly boolean[]
  /** Bogs touching each tile (8 neighbours). */
  readonly counts: readonly number[]
  /** Fewest steps from camp to beacon avoiding every bog. */
  readonly par: number
}

export type LegResult = {
  /** Tiles entered safely, in order. */
  walk: number[]
  /** Bog the walker stepped in, if any. */
  sunkAt: number | null
  /** Where the walker stands afterwards. */
  end: number
  arrived: boolean
}

/** mulberry32: small, fast, well-distributed 32-bit PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function xOf(i: number): number {
  return i % W
}

export function yOf(i: number): number {
  return Math.floor(i / W)
}

export function inBounds(i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < TILES
}

export function neighbors8(i: number): number[] {
  const x = xOf(i)
  const y = yOf(i)
  const out: number[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const nx = x + dx
      const ny = y + dy
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) out.push(ny * W + nx)
    }
  }
  return out
}

export function neighbors4(i: number): number[] {
  const x = xOf(i)
  const y = yOf(i)
  const out: number[] = []
  if (y > 0) out.push(i - W)
  if (x < W - 1) out.push(i + 1)
  if (y < H - 1) out.push(i + W)
  if (x > 0) out.push(i - 1)
  return out
}

export function adjacent4(a: number, b: number): boolean {
  const dx = Math.abs(xOf(a) - xOf(b))
  const dy = Math.abs(yOf(a) - yOf(b))
  return dx + dy === 1
}

/** Each night of the week has its own character. */
export type Night = {
  readonly name: string
  readonly blurb: string
  /** Share of tiles that are bogs. */
  readonly density: number
  /** Dry tiles each walker lights on arrival. */
  readonly sparks: number
  readonly lanterns: number
}

/** Indexed by UTC weekday, Sunday first. */
export const NIGHTS: readonly Night[] = [
  {
    name: 'Long dark',
    blurb: 'A plain night: three lanterns, three sparks.',
    density: 0.2,
    sparks: 3,
    lanterns: 3,
  },
  {
    name: 'Gentle night',
    blurb: 'Fewer bogs, and an extra spark for every walker.',
    density: 0.17,
    sparks: 4,
    lanterns: 3,
  },
  {
    name: 'Firefly night',
    blurb: 'Every walker arrives with six sparks.',
    density: 0.2,
    sparks: 6,
    lanterns: 3,
  },
  {
    name: 'Still night',
    blurb: 'A plain night: three lanterns, three sparks.',
    density: 0.2,
    sparks: 3,
    lanterns: 3,
  },
  {
    name: 'Thick fog',
    blurb: 'Each walker brings a single spark. Lean on each other.',
    density: 0.2,
    sparks: 1,
    lanterns: 3,
  },
  {
    name: 'Marsh night',
    blurb: 'More bogs than usual.',
    density: 0.23,
    sparks: 3,
    lanterns: 3,
  },
  {
    name: 'Deep marsh',
    blurb: 'The most bogs of the week, and a fourth lantern.',
    density: 0.26,
    sparks: 3,
    lanterns: 4,
  },
]

export function nightOf(weekday: number): Night {
  return NIGHTS[((weekday % 7) + 7) % 7] as Night
}

export function density(weekday: number): number {
  return nightOf(weekday).density
}

/** Fewest safe steps from camp to beacon, or -1 when the bogs wall it off. */
export function shortest(bogs: readonly boolean[]): number {
  const dist = new Array<number>(TILES).fill(-1)
  dist[CAMP] = 0
  const queue = [CAMP]
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as number
    if (cur === BEACON) return dist[cur] as number
    for (const n of neighbors4(cur)) {
      if (bogs[n] || dist[n] !== -1) continue
      dist[n] = (dist[cur] as number) + 1
      queue.push(n)
    }
  }
  return -1
}

/**
 * Build a valley. The camp, its ring and the beacon are always dry, and a dry
 * route to the beacon always exists.
 */
export function generate(
  seed: number,
  weekday: number,
  bogDensity?: number,
): Valley {
  const rand = rng(seed)
  const dry = new Set<number>([CAMP, BEACON, ...neighbors8(CAMP)])
  const pool: number[] = []
  for (let i = 0; i < TILES; i++) if (!dry.has(i)) pool.push(i)
  const want = Math.round((bogDensity ?? density(weekday)) * TILES)

  for (;;) {
    const order = pool.slice()
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const a = order[i] as number
      order[i] = order[j] as number
      order[j] = a
    }
    const bogs = new Array<boolean>(TILES).fill(false)
    for (let k = 0; k < want; k++) bogs[order[k] as number] = true
    const par = shortest(bogs)
    if (par < 0) continue
    const counts = new Array<number>(TILES).fill(0)
    for (let i = 0; i < TILES; i++) {
      let c = 0
      for (const n of neighbors8(i)) if (bogs[n]) c++
      counts[i] = c
    }
    return {bogs, counts, par}
  }
}

/**
 * Light a tile. A tile touching no bogs lights its neighbours too, and so on.
 * Returns only tiles that were dark before; adds them to `lit`.
 */
export function reveal(
  valley: Valley,
  lit: Set<number>,
  start: number,
): number[] {
  if (valley.bogs[start] || lit.has(start)) return []
  const fresh: number[] = []
  const stack = [start]
  lit.add(start)
  while (stack.length > 0) {
    const cur = stack.pop() as number
    fresh.push(cur)
    if (valley.counts[cur] !== 0) continue
    for (const n of neighbors8(cur)) {
      if (lit.has(n) || valley.bogs[n]) continue
      lit.add(n)
      stack.push(n)
    }
  }
  return fresh
}

/** Tiles lit before anyone walks: the camp and its ring. */
export function campLight(valley: Valley, lit: Set<number>): number[] {
  const fresh: number[] = []
  for (const i of [CAMP, ...neighbors8(CAMP)])
    fresh.push(...reveal(valley, lit, i))
  return fresh
}

/**
 * The sparks a walker brings: three dry tiles in the upper valley that light
 * for the whole expedition when they arrive.
 */
export function sparks(valley: Valley, seed: number, count = 3): number[] {
  const rand = rng(seed)
  const pool: number[] = []
  for (let i = 0; i < TILES; i++) {
    const y = yOf(i)
    if (!valley.bogs[i] && y >= 1 && y <= H - 4) pool.push(i)
  }
  const out: number[] = []
  while (out.length < count && pool.length > 0) {
    const k = Math.floor(rand() * pool.length)
    out.push(pool.splice(k, 1)[0] as number)
  }
  return out
}

/** Null when the route is legal, else the reason it is not. */
export function validatePath(pos: number, path: unknown): string | null {
  if (!Array.isArray(path)) return 'path must be a list'
  if (path.length < 1 || path.length > MAX_PATH)
    return 'path length out of range'
  let prev = pos
  for (const step of path) {
    if (typeof step !== 'number' || !inBounds(step)) return 'tile out of bounds'
    if (!adjacent4(prev, step)) return 'steps must touch'
    prev = step
  }
  return null
}

/** Walk a validated route until it ends, hits a bog or reaches the beacon. */
export function simulate(
  valley: Valley,
  pos: number,
  path: readonly number[],
): LegResult {
  const walk: number[] = []
  let end = pos
  for (const step of path) {
    if (valley.bogs[step]) return {walk, sunkAt: step, end, arrived: false}
    walk.push(step)
    end = step
    if (step === BEACON) return {walk, sunkAt: null, end, arrived: true}
  }
  return {walk, sunkAt: null, end, arrived: false}
}

export type ScoreParts = {
  lanterns: number
  route: number
  light: number
  total: number
}

export function score(
  arrived: boolean,
  lanternsLeft: number,
  steps: number,
  par: number,
  firstLight: number,
): ScoreParts {
  const lanterns = arrived ? 100 * lanternsLeft : 0
  const route = arrived ? Math.max(0, 100 - 4 * Math.max(0, steps - par)) : 0
  const light = 2 * firstLight
  return {lanterns, route, light, total: lanterns + route + light}
}

/**
 * What the visible counts already prove about dark tiles, using the one rule
 * every player learns first: a count with all its bogs found makes the rest
 * dry, and a count that needs every remaining dark neighbour makes them bogs.
 */
export function sense(
  lit: ReadonlyMap<number, number>,
  sunk: ReadonlySet<number>,
): {dry: Set<number>; bog: Set<number>} {
  const dry = new Set<number>()
  const bog = new Set<number>(sunk)
  for (let changed = true; changed; ) {
    changed = false
    for (const [tile, count] of lit) {
      const around = neighbors8(tile)
      const dark = around.filter(n => !lit.has(n) && !dry.has(n) && !bog.has(n))
      if (dark.length === 0) continue
      const left = count - around.filter(n => bog.has(n)).length
      const proven = left === 0 ? dry : left === dark.length ? bog : null
      if (!proven) continue
      for (const n of dark) proven.add(n)
      changed = true
    }
  }
  for (const t of sunk) bog.delete(t)
  return {dry, bog}
}
