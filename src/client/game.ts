import {spring, stagger} from 'motion'
import {animate} from 'motion/mini'
import type {LegRsp, TonightRsp} from '../shared/api.ts'
import {
  adjacent4,
  BEACON,
  CAMP,
  H,
  LANTERNS,
  MAX_PATH,
  TILES,
  W,
  xOf,
  yOf,
} from '../shared/engine.ts'
import {backdrop} from './backdrop.ts'
import {
  failed,
  fetchBoard,
  fetchFlair,
  fetchLeg,
  fetchTonight,
} from './fetch.ts'
import {calm, clamp01, countUp, EASE, easeOutBack, jolt, springy} from './fx.ts'
import {isMuted, setMuted, sfx, unlock} from './sfx.ts'
import {describe, journey, listen, showFaces, toast} from './social.ts'

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('valley')
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const stage = $('stage')
const hint = $('hint')
const where = $('where')
const lanternsEl = $('lanterns')
const walkBtn = $<HTMLButtonElement>('walk-btn')
const undoBtn = $<HTMLButtonElement>('undo-btn')
const card = $('card')
const toastEl = $('toast')
const facesEl = $('faces')
const soundBtn = $<HTMLButtonElement>('sound-btn')
const fog = backdrop($<HTMLCanvasElement>('backdrop'), calm)

const STEP_MS = calm ? 40 : 150
const FLIP_MS = calm ? 1 : 420
const COUNT_INK = ['', '#fff1cf', '#ffcf7a', '#ff9f5e', '#ff7a6b']

type Sprite = HTMLCanvasElement
type Spark = {
  x: number
  y: number
  vx: number
  vy: number
  born: number
  life: number
}

let data: TonightRsp | undefined
let lit = new Map<number, number>()
let sunk = new Set<number>()
/** When each tile turns over from dark to lit. */
const born = new Map<number, number>()
let path: number[] = []
let busy = false
let dragging = false
let hover = -1
/** Bogs this walker suspects. Private, kept for the night. */
let flags = new Set<number>()
let sunkBy = new Map<number, string>()
let live = false
let introAt = Number.POSITIVE_INFINITY
let walker = {x: xOf(CAMP), y: yOf(CAMP)}
let ripple: {tile: number; at: number} | undefined
let geo = {size: 40, ox: 0, oy: 0, w: 0, h: 0, dpr: 1}
let sprites: {dark: Sprite; lit: Sprite; bog: Sprite; glow: Sprite} | undefined
const sparks: Spark[] = []
const tilt = {x: 0, y: 0}
/** Fireflies drift at three depths and shift with the pointer. */
const flies = Array.from({length: calm ? 0 : 22}, (_, i) => ({
  x: (i * 0.618) % 1,
  y: (i * 0.371) % 1,
  z: 0.35 + ((i * 0.77) % 1) * 0.65,
  phase: i * 1.7,
}))

function sprite(
  size: number,
  dpr: number,
  paint: (c: CanvasRenderingContext2D, s: number) => void,
): Sprite {
  const el = document.createElement('canvas')
  el.width = Math.ceil(size * dpr)
  el.height = Math.ceil(size * dpr)
  const c = el.getContext('2d') as CanvasRenderingContext2D
  c.scale(dpr, dpr)
  paint(c, size)
  return el
}

/** A slab with a visible front edge, so the board reads as raised stone. */
function slab(
  c: CanvasRenderingContext2D,
  s: number,
  side: string,
  top: [string, string],
  rim: string,
  edge: string,
): void {
  const g = Math.max(2, s * 0.05)
  const d = s * 0.09
  const w = s - g * 2
  const r = w * 0.2
  c.fillStyle = side
  c.beginPath()
  c.roundRect(g, g + d, w, w - d * 0.2, r)
  c.fill()
  const grad = c.createLinearGradient(0, g, 0, g + w)
  grad.addColorStop(0, top[0])
  grad.addColorStop(1, top[1])
  c.fillStyle = grad
  c.beginPath()
  c.roundRect(g, g, w, w - d, r)
  c.fill()
  c.strokeStyle = edge
  c.lineWidth = 1
  c.stroke()
  // Light catching the top edge.
  c.save()
  c.clip()
  c.strokeStyle = rim
  c.lineWidth = 2
  c.beginPath()
  c.roundRect(g + 1, g + 1.5, w - 2, w, r)
  c.stroke()
  c.restore()
}

function buildSprites(size: number, dpr: number): void {
  sprites = {
    dark: sprite(size, dpr, (c, s) => {
      slab(
        c,
        s,
        '#03050f',
        ['#1a2350', '#0d1330'],
        'rgba(150,170,255,0.2)',
        'rgba(120,140,255,0.12)',
      )
      // Fluted glass: fine ribs, like reeds seen through fog.
      const g = Math.max(2, s * 0.05)
      c.save()
      c.beginPath()
      c.roundRect(g, g, s - g * 2, s - g * 2 - s * 0.09, (s - g * 2) * 0.2)
      c.clip()
      for (let x = g + s * 0.1; x < s - g; x += s * 0.115) {
        c.fillStyle = 'rgba(160,180,255,0.045)'
        c.fillRect(x, 0, s * 0.03, s)
        c.fillStyle = 'rgba(0,0,10,0.16)'
        c.fillRect(x + s * 0.03, 0, s * 0.025, s)
      }
      c.restore()
    }),
    lit: sprite(size, dpr, (c, s) => {
      slab(
        c,
        s,
        '#241505',
        ['#6a4d1f', '#33230d'],
        'rgba(255,225,160,0.55)',
        'rgba(255,190,90,0.4)',
      )
      const g = Math.max(2, s * 0.05)
      const warm = c.createRadialGradient(
        s * 0.4,
        s * 0.3,
        0,
        s * 0.4,
        s * 0.3,
        s * 0.6,
      )
      warm.addColorStop(0, 'rgba(255,205,120,0.3)')
      warm.addColorStop(1, 'rgba(255,205,120,0)')
      c.fillStyle = warm
      c.beginPath()
      c.roundRect(g, g, s - g * 2, s - g * 2 - s * 0.09, (s - g * 2) * 0.2)
      c.fill()
    }),
    bog: sprite(size, dpr, (c, s) => {
      slab(
        c,
        s,
        '#021615',
        ['#12585a', '#07282f'],
        'rgba(120,255,235,0.45)',
        'rgba(54,201,180,0.7)',
      )
    }),
    glow: sprite(size * 4, dpr, (c, s) => {
      const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
      g.addColorStop(0, 'rgba(255,190,90,0.5)')
      g.addColorStop(0.35, 'rgba(255,150,60,0.16)')
      g.addColorStop(1, 'rgba(255,140,50,0)')
      c.fillStyle = g
      c.fillRect(0, 0, s, s)
    }),
  }
}

function adopt(next: TonightRsp, bornAt?: (tile: number) => number): void {
  const now = performance.now()
  for (const [tile] of next.lit)
    if (!lit.has(tile)) born.set(tile, bornAt ? bornAt(tile) : now)
  const lost = data !== undefined && next.me.lanterns < data.me.lanterns
  data = next
  lit = new Map(next.lit)
  sunk = new Set(next.sunk)
  sunkBy = new Map(next.sunkBy)
  for (const t of flags) if (lit.has(t) || sunk.has(t)) flags.delete(t)
  showFaces(facesEl, next.roster)
  where.textContent = `Night ${next.night}, ${next.walkers === 1 ? 'you are first out' : `${next.walkers} walkers out`}`
  const pips = lanternsEl.querySelectorAll('i')
  pips.forEach((pip, i) => {
    pip.classList.toggle('out', i >= next.me.lanterns)
  })
  lanternsEl.setAttribute(
    'aria-label',
    `${next.me.lanterns} of ${LANTERNS} lanterns left`,
  )
  if (lost) jolt(lanternsEl, 5)
}

function resize(): void {
  const box = canvas.getBoundingClientRect()
  const dpr = Math.min(devicePixelRatio || 1, 3)
  canvas.width = Math.round(box.width * dpr)
  canvas.height = Math.round(box.height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const size = Math.floor(Math.min((box.width - 16) / W, (box.height - 10) / H))
  geo = {
    size,
    ox: (box.width - size * W) / 2,
    oy: (box.height - size * H) / 2,
    w: box.width,
    h: box.height,
    dpr,
  }
  buildSprites(size, dpr)
}

function tileAt(ev: PointerEvent): number {
  const box = canvas.getBoundingClientRect()
  const x = Math.floor((ev.clientX - box.left - geo.ox) / geo.size)
  const y = Math.floor((ev.clientY - box.top - geo.oy) / geo.size)
  return x < 0 || x >= W || y < 0 || y >= H ? -1 : y * W + x
}

function flagKey(): string {
  return `wayglow.flags.${data?.day}.${data?.expedition}`
}

function loadFlags(): void {
  try {
    flags = new Set(
      (JSON.parse(localStorage.getItem(flagKey()) ?? '[]') as number[]).filter(
        t => !lit.has(t),
      ),
    )
  } catch {
    flags = new Set()
  }
}

/** Mark or unmark a dark tile as a suspected bog. Routes cannot cross a mark. */
function toggleFlag(tile: number): void {
  if (!data || tile < 0 || lit.has(tile) || sunk.has(tile) || tile === BEACON)
    return
  if (flags.has(tile)) flags.delete(tile)
  else flags.add(tile)
  path = path.includes(tile) ? path.slice(0, path.indexOf(tile)) : path
  sfx.flag()
  navigator.vibrate?.(12)
  journey.act('mark')
  try {
    localStorage.setItem(flagKey(), JSON.stringify([...flags]))
  } catch {
    // Marks still work for this visit.
  }
  refreshControls()
}

function canPlan(): boolean {
  return !busy && data?.me.status === 'walking'
}

function canStep(tile: number): boolean {
  if (
    !data ||
    !canPlan() ||
    tile < 0 ||
    sunk.has(tile) ||
    flags.has(tile) ||
    path.length >= MAX_PATH
  )
    return false
  const tail = path.at(-1) ?? data.me.pos
  return (
    tail !== BEACON &&
    adjacent4(tail, tile) &&
    !path.includes(tile) &&
    tile !== data.me.pos
  )
}

function plan(tile: number): void {
  if (!data || tile < 0 || !canPlan()) return
  const before = path.length
  if (tile === data.me.pos) path = []
  else {
    const at = path.indexOf(tile)
    if (at >= 0) path = path.slice(0, at + 1)
    else if (canStep(tile)) path.push(tile)
  }
  if (path.length > before) {
    navigator.vibrate?.(6)
    sfx.plan(path.length)
  }
  refreshControls()
}

function refreshControls(): void {
  const me = data?.me
  const over = me !== undefined && me.status !== 'walking'
  walkBtn.hidden = over
  undoBtn.hidden = over
  walkBtn.disabled = !canPlan() || path.length === 0
  undoBtn.disabled = !canPlan() || path.length === 0
  walkBtn.textContent =
    path.length > 0
      ? `Walk ${path.length} ${path.length === 1 ? 'step' : 'steps'}`
      : 'Walk'
  if (!me || busy) return
  if (over) {
    hint.textContent =
      'Your walk is over. The lights you left stay on for everyone tonight.'
    return
  }
  const blind = path.filter(t => !lit.has(t)).length
  if (path.length === 0) {
    hint.textContent =
      me.legs === 0
        ? 'Drag from your lantern toward the flame. Each number counts the bogs touching that tile.'
        : 'Drag from your lantern to plan the next stretch.'
  } else if (blind > 0) {
    hint.textContent = `${blind} ${blind === 1 ? 'step' : 'steps'} into the dark. A bog there costs a lantern.`
  } else {
    hint.textContent = 'All on lit ground. Safe to walk.'
  }
}

function centre(tile: number): [number, number] {
  return [
    geo.ox + (xOf(tile) + 0.5) * geo.size,
    geo.oy + (yOf(tile) + 0.46) * geo.size,
  ]
}

function burst(tile: number, count: number, now: number): void {
  if (calm) return
  const [x, y] = centre(tile)
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2
    const v = 0.04 + Math.random() * 0.2
    sparks.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 0.08,
      born: now,
      life: 500 + Math.random() * 900,
    })
  }
}

function draw(now: number): void {
  requestAnimationFrame(draw)
  const s = sprites
  if (!s) return
  const {size, ox, oy} = geo
  ctx.clearRect(0, 0, geo.w, geo.h)
  const wx = ox + (walker.x + 0.5) * size
  const wy = oy + (walker.y + 0.46) * size
  const bob = calm ? 0 : Math.sin(now / 420) * size * 0.03
  const alive = data !== undefined && data.me.status !== 'lost'
  fog?.light(
    0,
    (stage.offsetLeft + wx) / innerWidth,
    (stage.offsetTop + wy) / innerHeight,
    alive ? 1 : 0.25,
  )
  const [bx, by] = centre(BEACON)
  fog?.light(
    1,
    (stage.offsetLeft + bx) / innerWidth,
    (stage.offsetTop + by) / innerHeight,
    0.8,
  )

  // Tiles rise in a wave from the camp, then turn over as they are lit.
  for (let t = 0; t < TILES; t++) {
    const ring = Math.max(
      Math.abs(xOf(t) - xOf(CAMP)),
      Math.abs(yOf(t) - yOf(CAMP)),
    )
    const rise = calm ? 1 : clamp01((now - introAt - ring * 42) / 380)
    if (rise <= 0) continue
    const x = ox + xOf(t) * size
    const y = oy + yOf(t) * size
    const flip = lit.has(t) ? clamp01((now - (born.get(t) ?? 0)) / FLIP_MS) : 0
    const img = sunk.has(t) ? s.bog : flip >= 0.5 ? s.lit : s.dark
    const sx = sunk.has(t) ? 1 : Math.abs(1 - 2 * flip) || 0.02
    const lift = Math.sin(Math.PI * flip) * size * 0.16
    const pop = easeOutBack(rise)
    ctx.globalAlpha = rise
    ctx.setTransform(
      geo.dpr * sx * pop,
      0,
      0,
      geo.dpr * pop,
      (x + size / 2) * geo.dpr,
      (y + size / 2 - lift) * geo.dpr,
    )
    ctx.drawImage(img, -size / 2, -size / 2, size, size)
    ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0)
    // Lantern light falls off with distance, so the valley feels dark.
    const d = Math.min(
      Math.hypot(xOf(t) - walker.x, yOf(t) - walker.y),
      Math.hypot(xOf(t) - xOf(BEACON), yOf(t)) + 0.6,
    )
    const veil = Math.min(
      lit.has(t) || sunk.has(t) ? 0.34 : 0.5,
      Math.max(0, d - 1.2) * 0.075,
    )
    if (veil > 0.01) {
      ctx.globalAlpha = veil * rise
      ctx.fillStyle = '#03050f'
      ctx.beginPath()
      ctx.roundRect(x + 1, y + 1, size - 2, size - 2, size * 0.18)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    if (sunk.has(t)) {
      const [cx, cy] = centre(t)
      ctx.strokeStyle = '#7ff5e2'
      ctx.lineWidth = Math.max(1.2, size * 0.03)
      for (let k = 0; k < 3; k++) {
        const p = calm ? (k + 1) / 3.4 : (now / 2600 + k / 3) % 1
        ctx.globalAlpha = (1 - p) * 0.8
        ctx.beginPath()
        ctx.ellipse(
          cx,
          cy,
          size * (0.06 + p * 0.3),
          size * (0.035 + p * 0.17),
          0,
          0,
          Math.PI * 2,
        )
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
  }

  for (const t of flags) {
    const [fx, fy] = centre(t)
    ctx.strokeStyle = '#ff7a6b'
    ctx.fillStyle = '#ff7a6b'
    ctx.lineWidth = Math.max(2, size * 0.05)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(fx - size * 0.1, fy + size * 0.2)
    ctx.lineTo(fx - size * 0.1, fy - size * 0.22)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(fx - size * 0.1, fy - size * 0.22)
    ctx.lineTo(fx + size * 0.2, fy - size * 0.1)
    ctx.lineTo(fx - size * 0.1, fy + size * 0.02)
    ctx.fill()
  }

  if (hover >= 0 && canPlan()) {
    const ok = canStep(hover)
    ctx.strokeStyle = ok ? 'rgba(255,225,160,0.9)' : 'rgba(160,175,255,0.25)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(
      ox + xOf(hover) * size + 3,
      oy + yOf(hover) * size + 3,
      size - 6,
      size - 6 - size * 0.09,
      size * 0.18,
    )
    ctx.stroke()
  }

  // Planned route: a soft trail with dots that march toward the end.
  if (path.length > 0 && data) {
    const trace = (): void => {
      ctx.beginPath()
      ctx.moveTo(...centre(data?.me.pos ?? CAMP))
      for (const t of path) ctx.lineTo(...centre(t))
    }
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255,181,71,0.13)'
    ctx.lineWidth = size * 0.2
    trace()
    ctx.stroke()
    ctx.strokeStyle = '#ffd98a'
    ctx.lineWidth = Math.max(3, size * 0.09)
    ctx.setLineDash([size * 0.02, size * 0.2])
    ctx.lineDashOffset = calm ? 0 : -(now / 38) % (size * 0.22)
    trace()
    ctx.stroke()
    ctx.setLineDash([])
    const [ex, ey] = centre(path.at(-1) as number)
    const beat = calm ? 0 : Math.sin(now / 240) * size * 0.025
    ctx.beginPath()
    ctx.arc(ex, ey, size * 0.17 + beat, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Counts sit above the route so they always stay readable.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `620 ${Math.round(size * 0.46)}px Fraunces, Georgia, serif`
  for (const [t, count] of lit) {
    if (count === 0 || sunk.has(t)) continue
    const flip = clamp01((now - (born.get(t) ?? 0)) / FLIP_MS)
    if (flip < 0.5 || now < introAt) continue
    const [cx, cy] = centre(t)
    ctx.globalAlpha = (flip - 0.5) * 2
    ctx.lineWidth = Math.max(2, size * 0.06)
    ctx.strokeStyle = 'rgba(40,26,8,0.85)'
    ctx.strokeText(`${count}`, cx, cy)
    ctx.fillStyle = COUNT_INK[Math.min(count, 4)] ?? '#fff1cf'
    ctx.fillText(`${count}`, cx, cy)
  }
  ctx.globalAlpha = 1

  // Beacon flame.
  const flick = calm
    ? 1
    : 1 + Math.sin(now / 230) * 0.07 + Math.sin(now / 97) * 0.03
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = 0.8
  ctx.drawImage(s.glow, bx - size * 1.5, by - size * 1.5, size * 3, size * 3)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  for (const [k, ink] of [
    [1, '#ff9a3c'],
    [0.62, '#ffd98a'],
    [0.3, '#fff6dc'],
  ] as const) {
    ctx.fillStyle = ink
    ctx.beginPath()
    ctx.moveTo(bx, by - size * 0.36 * flick * k)
    ctx.bezierCurveTo(
      bx + size * 0.3 * k,
      by - size * 0.02,
      bx + size * 0.16 * k,
      by + size * 0.26 * k,
      bx,
      by + size * 0.26 * k,
    )
    ctx.bezierCurveTo(
      bx - size * 0.16 * k,
      by + size * 0.26 * k,
      bx - size * 0.3 * k,
      by - size * 0.02,
      bx,
      by - size * 0.36 * flick * k,
    )
    ctx.fill()
  }

  if (ripple) {
    const p = (now - ripple.at) / 800
    if (p >= 1) ripple = undefined
    else {
      const [rx, ry] = centre(ripple.tile)
      ctx.strokeStyle = '#7ff5e2'
      ctx.lineWidth = 3
      for (const k of [0, 0.25]) {
        const q = clamp01(p - k)
        ctx.globalAlpha = (1 - q) * 0.9
        ctx.beginPath()
        ctx.ellipse(
          rx,
          ry,
          size * (0.15 + q * 0.75),
          size * (0.09 + q * 0.45),
          0,
          0,
          Math.PI * 2,
        )
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
  }

  // The walker's lantern.
  if (alive && now >= introAt) {
    ctx.globalCompositeOperation = 'lighter'
    ctx.drawImage(
      s.glow,
      wx - size * 2,
      wy - size * 2 + bob,
      size * 4,
      size * 4,
    )
    ctx.globalCompositeOperation = 'source-over'
    const under = lit.get(Math.round(walker.y) * W + Math.round(walker.x)) ?? 0
    ctx.strokeStyle = '#ffd98a'
    ctx.lineWidth = Math.max(2.5, size * 0.07)
    ctx.beginPath()
    ctx.arc(wx, wy + bob, size * 0.34, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255,246,220,0.9)'
    ctx.lineWidth = Math.max(1, size * 0.02)
    ctx.stroke()
    if (under === 0) {
      ctx.fillStyle = '#fff6dc'
      ctx.beginPath()
      ctx.arc(wx, wy + bob, size * 0.1, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  ctx.globalCompositeOperation = 'lighter'
  for (const f of flies) {
    const fx =
      ((f.x + Math.sin(now / 9000 + f.phase) * 0.06 + tilt.x * f.z * 0.03 + 1) %
        1) *
      geo.w
    const fy =
      ((f.y +
        Math.cos(now / 7000 + f.phase * 1.3) * 0.05 +
        tilt.y * f.z * 0.03 +
        1) %
        1) *
      geo.h
    const r = size * 0.5 * f.z
    ctx.globalAlpha =
      (0.2 + 0.5 * (0.5 + 0.5 * Math.sin(now / 700 + f.phase))) * f.z
    ctx.drawImage(s.glow, fx - r, fy - r, r * 2, r * 2)
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const sp = sparks[i] as Spark
    const age = now - sp.born
    if (age > sp.life) {
      sparks.splice(i, 1)
      continue
    }
    ctx.globalAlpha = 1 - age / sp.life
    ctx.fillStyle = '#ffc66b'
    ctx.beginPath()
    ctx.arc(
      sp.x + sp.vx * age,
      sp.y + sp.vy * age + 0.00004 * age * age,
      size * 0.045,
      0,
      Math.PI * 2,
    )
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

function glide(toX: number, toY: number, ms: number): Promise<void> {
  const from = {...walker}
  const t0 = performance.now()
  return new Promise(resolve => {
    const tick = (now: number): void => {
      const p = Math.min(1, (now - t0) / ms)
      const e = p * p * (3 - 2 * p)
      walker = {x: from.x + (toX - from.x) * e, y: from.y + (toY - from.y) * e}
      if (p < 1) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
}

async function walk(): Promise<void> {
  if (!data || !canPlan() || path.length === 0) return
  busy = true
  refreshControls()
  hint.textContent = 'Walking'
  if (data.me.legs === 0) journey.start()
  const rsp = await fetchLeg({leg: data.me.legs + 1, path})
  if (failed(rsp)) {
    busy = false
    hint.textContent =
      rsp.status === 0
        ? 'No connection. Your route is still planned; press Walk again.'
        : 'That step did not land. Press Walk again.'
    walkBtn.disabled = false
    return
  }
  path = []
  await play(rsp)
  busy = false
  refreshControls()
  if (rsp.me.status === 'walking') {
    journey.progress(Math.min(0.95, 1 - yOf(rsp.me.pos) / (H - 1)))
    if (rsp.streakSaved && rsp.me.legs === 1)
      toast(toastEl, 'A spare wick kept your streak alive.', 3600)
    else if (rsp.sunkAt !== null && rsp.me.lanterns === 2) {
      toast(
        toastEl,
        'Press and hold a dark tile to mark a bog you suspect.',
        4200,
      )
    }
  } else {
    journey.end(rsp.me.status === 'arrived', rsp.result?.total ?? 0)
    void showCard(rsp)
  }
}

async function play(rsp: LegRsp): Promise<void> {
  const start = performance.now()
  // Tiles turn over as the walker passes the nearest point of the walk.
  adopt(rsp, tile => {
    let best = 0
    let bestD = Number.POSITIVE_INFINITY
    rsp.walk.forEach((w, i) => {
      const d = Math.max(
        Math.abs(xOf(w) - xOf(tile)),
        Math.abs(yOf(w) - yOf(tile)),
      )
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return start + (best + 0.6) * STEP_MS + bestD * 70
  })
  if (rsp.sunkAt !== null) sunk.delete(rsp.sunkAt)
  rsp.walk.forEach((_, i) => {
    sfx.step(i, (i * STEP_MS) / 1000)
  })
  for (const t of rsp.walk) await glide(xOf(t), yOf(t), STEP_MS)
  if (rsp.me.status === 'arrived') {
    sfx.arrive()
    burst(BEACON, 70, performance.now())
    navigator.vibrate?.([20, 40, 20])
    await new Promise(resolve => setTimeout(resolve, calm ? 200 : 900))
  }
  if (rsp.sunkAt !== null) {
    const back = {...walker}
    await glide(
      (back.x + xOf(rsp.sunkAt)) / 2,
      (back.y + yOf(rsp.sunkAt)) / 2,
      STEP_MS,
    )
    sunk.add(rsp.sunkAt)
    ripple = {tile: rsp.sunkAt, at: performance.now()}
    sfx.sink()
    if (rsp.me.lanterns === 0) sfx.lost()
    navigator.vibrate?.(70)
    jolt(stage, 7)
    await glide(back.x, back.y, STEP_MS * 1.5)
    hint.textContent =
      rsp.me.lanterns > 0
        ? 'A lantern sank. That bog is now marked for every walker after you.'
        : 'Your last lantern sank. Everything you lit stays lit.'
    await new Promise(resolve => setTimeout(resolve, calm ? 300 : 1100))
  }
}

function row(
  dl: HTMLElement,
  label: string,
  value: number,
  cls = '',
): HTMLElement {
  const dt = document.createElement('dt')
  const dd = document.createElement('dd')
  dt.textContent = label
  dd.textContent = `${value}`
  if (cls) {
    dt.className = cls
    dd.className = cls
  }
  dl.append(dt, dd)
  return dd
}

async function showCard(d: TonightRsp): Promise<void> {
  const r = d.result
  if (!r) return
  const arrived = d.me.status === 'arrived'
  $('card-title').textContent = arrived
    ? 'You reached the flame'
    : 'Your lanterns are out'
  $('card-sub').textContent = arrived
    ? `Crossed in ${d.me.steps} steps. The shortest dry route tonight was ${r.par}.`
    : `You lit ${d.me.firstLight} tiles that the next walkers can now trust.`
  const dl = $('card-score')
  dl.replaceChildren()
  row(dl, `Lanterns kept (${arrived ? d.me.lanterns : 0})`, r.lanterns)
  row(dl, 'Route', r.route)
  row(dl, `First light (${d.me.firstLight} tiles)`, r.light)
  const total = row(dl, `Night ${d.night}`, r.total, 'total')
  const mins = Math.max(1, Math.round((d.nextAt - Date.now()) / 60_000))
  const opens = `A new valley opens in ${Math.floor(mins / 60)} h ${mins % 60} min.`
  $('card-streak').textContent =
    d.streak > 1
      ? `${d.streak} nights in a row. ${opens}`
      : `${opens} Come back to start a streak.`
  $('card-guided').textContent =
    d.guided > 0
      ? `Your light has guided ${d.guided} ${d.guided === 1 ? 'walker' : 'walkers'} so far tonight.`
      : 'When another walker uses a tile you lit, you will see it here.'
  const bars = $('card-stats')
  bars.replaceChildren()
  const tally = d.stats ?? [0, 0, 0, 0]
  const most = Math.max(1, ...tally)
  const mine = arrived ? d.me.lanterns : 0
  for (const [i, label] of ['Lost', '1 left', '2 left', '3 left'].entries()) {
    const col = document.createElement('div')
    const bar = document.createElement('i')
    const cap = document.createElement('span')
    bar.style.height = `${Math.round(5 + (24 * (tally[i] ?? 0)) / most)}px`
    if (i === mine) col.className = 'mine'
    cap.textContent = `${label} (${tally[i] ?? 0})`
    col.append(bar, cap)
    bars.append(col)
  }
  const flairBtn = $<HTMLButtonElement>('flair-btn')
  flairBtn.hidden = d.streak < 2
  const ol = $('card-board')
  ol.replaceChildren()
  card.classList.add('show')
  if (!calm) {
    const panel = card.querySelector('section') as HTMLElement
    animate(card, {opacity: [0, 1]}, {duration: 0.3})
    animate(
      panel,
      {transform: ['scale(0.9) translateY(24px)', 'scale(1) translateY(0px)']},
      {type: spring, stiffness: 260, damping: 22},
    )
    animate(
      Array.from(panel.children),
      {opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0px)']},
      {delay: stagger(0.06, {startDelay: 0.12}), duration: 0.4},
    )
  }
  countUp(total, r.total, 350)
  $<HTMLButtonElement>('card-close').focus()
  const top = await fetchBoard()
  if (failed(top)) return
  for (const entry of top.top.slice(0, 3)) {
    const li = document.createElement('li')
    li.textContent = `${entry.name}, ${entry.score}`
    ol.append(li)
  }
}

async function refresh(): Promise<void> {
  if (busy || dragging || document.hidden) return
  const next = await fetchTonight()
  if (busy || failed(next)) return
  adopt(next)
  path = path.filter(t => !sunk.has(t))
  refreshControls()
}

async function init(): Promise<void> {
  resize()
  addEventListener('resize', resize)
  requestAnimationFrame(draw)
  void document.fonts?.load('620 20px Fraunces')
  springy(walkBtn)
  springy(undoBtn)
  springy($('card-close'))
  if (!calm) {
    animate(
      'header',
      {opacity: [0, 1], transform: ['translateY(-14px)', 'translateY(0px)']},
      {duration: 0.6, ease: EASE},
    )
    animate(
      'footer',
      {opacity: [0, 1], transform: ['translateY(18px)', 'translateY(0px)']},
      {duration: 0.6, delay: 0.15, ease: EASE},
    )
  }
  let hold: ReturnType<typeof setTimeout> | undefined
  let heldTile = -1
  canvas.addEventListener('pointerdown', ev => {
    unlock()
    if (ev.button === 2) return
    dragging = true
    canvas.setPointerCapture(ev.pointerId)
    const tile = tileAt(ev)
    heldTile = tile
    const name = sunkBy.get(tile)
    if (name)
      hint.textContent = `${name}'s lantern sank here. Thanks to them, everyone knows.`
    // Press and hold marks a suspected bog instead of planning through it.
    clearTimeout(hold)
    hold = setTimeout(() => {
      if (heldTile !== tile) return
      dragging = false
      toggleFlag(tile)
    }, 430)
    plan(tile)
  })
  canvas.addEventListener('contextmenu', ev => {
    ev.preventDefault()
    toggleFlag(tileAt(ev as PointerEvent))
  })
  canvas.addEventListener('pointermove', ev => {
    hover = ev.pointerType === 'mouse' ? tileAt(ev) : -1
    tilt.x = (ev.clientX / innerWidth - 0.5) * 2
    tilt.y = (ev.clientY / innerHeight - 0.5) * 2
    if (tileAt(ev) !== heldTile) heldTile = -1
    if (dragging) plan(tileAt(ev))
  })
  canvas.addEventListener('pointerleave', () => {
    hover = -1
  })
  const stop = (): void => {
    dragging = false
    heldTile = -1
    clearTimeout(hold)
  }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)
  // Keyboard: arrows plan, Enter walks, Escape clears, F marks the tile ahead.
  addEventListener('keydown', ev => {
    unlock()
    if (!data || card.classList.contains('show')) return
    const tail = path.at(-1) ?? data.me.pos
    const step = {ArrowUp: -W, ArrowDown: W, ArrowLeft: -1, ArrowRight: 1}[
      ev.key
    ]
    if (step !== undefined) {
      ev.preventDefault()
      const to = tail + step
      const wraps = Math.abs(step) === 1 && yOf(to) !== yOf(tail)
      if (to < 0 || to >= W * H || wraps) return
      if (ev.shiftKey) toggleFlag(to)
      else if (to === (path.at(-2) ?? data.me.pos))
        plan(path.length > 1 ? to : data.me.pos)
      else plan(to)
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      void walk()
    } else if (ev.key === 'Escape' || ev.key === 'Backspace') {
      path = []
      refreshControls()
    }
  })
  const paintSound = (): void => {
    soundBtn.setAttribute('aria-pressed', `${!isMuted()}`)
    soundBtn.textContent = isMuted() ? 'Sound off' : 'Sound on'
  }
  paintSound()
  soundBtn.addEventListener('click', () => {
    setMuted(!isMuted())
    unlock()
    paintSound()
    sfx.plan(2)
  })
  $('flair-btn').addEventListener('click', ev => {
    const btn = ev.currentTarget as HTMLButtonElement
    btn.disabled = true
    journey.act('flair')
    void fetchFlair().then(rsp => {
      btn.textContent = failed(rsp)
        ? 'Flair could not be set here'
        : `Flair set: ${rsp.text}`
    })
  })
  walkBtn.addEventListener('click', () => void walk())
  undoBtn.addEventListener('click', () => {
    path = []
    refreshControls()
  })
  $('card-close').addEventListener('click', () => card.classList.remove('show'))

  const first = await fetchTonight()
  const loader = $('loader')
  if (!calm)
    animate(loader, {opacity: 0, transform: 'scale(1.6)'}, {duration: 0.45})
  setTimeout(() => loader.remove(), calm ? 0 : 460)
  if (failed(first)) {
    hint.textContent =
      first.status === 401
        ? 'Log in to Reddit to walk the valley.'
        : 'The valley could not be reached. Reopen the post to try again.'
    return
  }
  // Board rises first, then the lit tiles turn over in a wave from the camp.
  introAt = performance.now()
  adopt(first, tile => {
    const ring = Math.max(
      Math.abs(xOf(tile) - xOf(CAMP)),
      Math.abs(yOf(tile) - yOf(CAMP)),
    )
    return introAt + (calm ? 0 : 520 + ring * 55)
  })
  walker = {x: xOf(first.me.pos), y: yOf(first.me.pos)}
  loadFlags()
  refreshControls()
  journey.ready()
  if (first.yesterday && first.yesterday.guided > 0) {
    const g = first.yesterday.guided
    setTimeout(
      () =>
        toast(
          toastEl,
          `Last night your light guided ${g} ${g === 1 ? 'walker' : 'walkers'}.`,
          4200,
        ),
      1800,
    )
  }
  // Live pushes make other walkers' lights appear at once; polling stays as the safety net.
  let pending: ReturnType<typeof setTimeout> | undefined
  live = listen(first.channel, msg => {
    if (msg.by !== undefined) toast(toastEl, describe(msg))
    clearTimeout(pending)
    pending = setTimeout(() => void refresh(), 350)
  })
  if (first.me.status !== 'walking')
    setTimeout(() => void showCard(first), calm ? 0 : 1500)
  setInterval(() => void refresh(), live ? 30_000 : 10_000)
}

void init()
