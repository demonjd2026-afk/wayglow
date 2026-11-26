import type {LegRsp, TonightRsp} from '../shared/api.ts'
import {
  adjacent4,
  BEACON,
  H,
  LANTERNS,
  MAX_PATH,
  TILES,
  W,
  xOf,
  yOf,
} from '../shared/engine.ts'
import {failed, fetchBoard, fetchLeg, fetchTonight} from './fetch.ts'

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('valley')
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const hint = $('hint')
const where = $('where')
const lanternsEl = $('lanterns')
const walkBtn = $<HTMLButtonElement>('walk-btn')
const undoBtn = $<HTMLButtonElement>('undo-btn')
const card = $('card')

const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
const STEP_MS = calm ? 40 : 150

const ink = {
  dark: '#131a31',
  darkEdge: '#1d2646',
  lit: '#3a3020',
  litEdge: '#6b5527',
  bog: '#0f3038',
  bogEdge: '#3fb6a8',
  glow: '#ffc45c',
  counts: ['', '#ffe9b8', '#ffc66b', '#ff9d5c', '#ff7d6e'],
}

let data: TonightRsp | undefined
let lit = new Map<number, number>()
let sunk = new Set<number>()
/** When each tile first appeared, for the fade-in. */
const born = new Map<number, number>()
let path: number[] = []
let busy = false
let dragging = false
/** Walker position in tile units while animating. */
let walker = {x: 3, y: H - 1}
let ripple: {tile: number; at: number} | undefined
let geo = {size: 40, ox: 0, oy: 0}

function adopt(next: TonightRsp, bornAt?: (tile: number) => number): void {
  const now = performance.now()
  for (const [tile] of next.lit)
    if (!lit.has(tile)) born.set(tile, bornAt ? bornAt(tile) : now)
  data = next
  lit = new Map(next.lit)
  sunk = new Set(next.sunk)
  where.textContent = `Night ${next.night} · ${next.walkers === 1 ? 'first walker out' : `${next.walkers} walkers`}`
  const dots = lanternsEl.querySelectorAll('i')
  dots.forEach((dot, i) => {
    dot.classList.toggle('out', i >= next.me.lanterns)
  })
  lanternsEl.setAttribute(
    'aria-label',
    `${next.me.lanterns} of ${LANTERNS} lanterns left`,
  )
}

function resize(): void {
  const box = canvas.getBoundingClientRect()
  const dpr = Math.min(devicePixelRatio || 1, 3)
  canvas.width = Math.round(box.width * dpr)
  canvas.height = Math.round(box.height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const size = Math.floor(Math.min((box.width - 16) / W, (box.height - 8) / H))
  geo = {size, ox: (box.width - size * W) / 2, oy: (box.height - size * H) / 2}
}

function tileAt(ev: PointerEvent): number {
  const box = canvas.getBoundingClientRect()
  const x = Math.floor((ev.clientX - box.left - geo.ox) / geo.size)
  const y = Math.floor((ev.clientY - box.top - geo.oy) / geo.size)
  return x < 0 || x >= W || y < 0 || y >= H ? -1 : y * W + x
}

function canPlan(): boolean {
  return !busy && data?.me.status === 'walking'
}

function plan(tile: number): void {
  if (!data || tile < 0 || !canPlan()) return
  const pos = data.me.pos
  if (tile === pos) path = []
  else {
    const at = path.indexOf(tile)
    const tail = path.at(-1) ?? pos
    if (at >= 0) path = path.slice(0, at + 1)
    else if (
      adjacent4(tail, tile) &&
      tail !== BEACON &&
      !sunk.has(tile) &&
      path.length < MAX_PATH
    )
      path.push(tile)
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
  if (me.status !== 'walking') {
    hint.textContent =
      'Your walk is over. The lights you left stay on for everyone tonight.'
    return
  }
  const blind = path.filter(t => !lit.has(t)).length
  if (path.length === 0) {
    hint.textContent =
      me.legs === 0
        ? 'Drag from your lantern toward the beacon. Each number counts the bogs touching that tile.'
        : 'Drag from your lantern to plan the next stretch.'
  } else if (blind > 0) {
    hint.textContent = `${blind} ${blind === 1 ? 'step' : 'steps'} into the dark. A bog there costs a lantern.`
  } else {
    hint.textContent = 'All on lit ground. Safe to walk.'
  }
}

function rounded(x: number, y: number, s: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, s, s, r)
}

function centre(tile: number): [number, number] {
  return [
    geo.ox + (xOf(tile) + 0.5) * geo.size,
    geo.oy + (yOf(tile) + 0.5) * geo.size,
  ]
}

function draw(now: number): void {
  const {size, ox, oy} = geo
  const box = canvas.getBoundingClientRect()
  ctx.clearRect(0, 0, box.width, box.height)
  const gap = Math.max(2, size * 0.06)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (let t = 0; t < TILES; t++) {
    const x = ox + xOf(t) * size + gap / 2
    const y = oy + yOf(t) * size + gap / 2
    const s = size - gap
    rounded(x, y, s, s * 0.18)
    ctx.fillStyle = ink.dark
    ctx.fill()
    ctx.strokeStyle = ink.darkEdge
    ctx.lineWidth = 1
    ctx.stroke()

    if (sunk.has(t)) {
      rounded(x, y, s, s * 0.18)
      ctx.fillStyle = ink.bog
      ctx.fill()
      ctx.strokeStyle = ink.bogEdge
      ctx.stroke()
      // Three ripples: a sunk lantern.
      ctx.lineWidth = Math.max(1.5, size * 0.04)
      for (const k of [0.14, 0.24, 0.34]) {
        ctx.beginPath()
        ctx.ellipse(
          x + s / 2,
          y + s / 2,
          s * k,
          s * k * 0.55,
          0,
          0,
          Math.PI * 2,
        )
        ctx.stroke()
      }
      continue
    }
    const count = lit.get(t)
    if (count === undefined) continue
    const age = calm
      ? 1
      : Math.min(1, Math.max(0, (now - (born.get(t) ?? 0)) / 450))
    if (age <= 0) continue
    ctx.globalAlpha = age
    rounded(x, y, s, s * 0.18)
    ctx.fillStyle = ink.lit
    ctx.fill()
    ctx.strokeStyle = ink.litEdge
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Beacon: a flame that is always visible, so the goal is never in doubt.
  const [bx, by] = centre(BEACON)
  const flick = calm ? 1 : 1 + Math.sin(now / 260) * 0.06
  ctx.shadowColor = ink.glow
  ctx.shadowBlur = size * 0.5
  ctx.fillStyle = '#ffd98a'
  ctx.beginPath()
  ctx.moveTo(bx, by - size * 0.32 * flick)
  ctx.quadraticCurveTo(bx + size * 0.26, by, bx, by + size * 0.28)
  ctx.quadraticCurveTo(bx - size * 0.26, by, bx, by - size * 0.32 * flick)
  ctx.fill()
  ctx.shadowBlur = 0

  if (path.length > 0 && data) {
    ctx.strokeStyle = ink.glow
    ctx.lineWidth = Math.max(3, size * 0.1)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.setLineDash([size * 0.02, size * 0.22])
    ctx.beginPath()
    ctx.moveTo(...centre(data.me.pos))
    for (const t of path) ctx.lineTo(...centre(t))
    ctx.stroke()
    ctx.setLineDash([])
    const [ex, ey] = centre(path.at(-1) as number)
    ctx.beginPath()
    ctx.arc(ex, ey, size * 0.14, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Counts go on top of the planned route so they always stay readable.
  ctx.font = `700 ${Math.round(size * 0.44)}px system-ui, sans-serif`
  for (const [t, count] of lit) {
    if (count === 0 || sunk.has(t)) continue
    const age = calm
      ? 1
      : Math.min(1, Math.max(0, (now - (born.get(t) ?? 0)) / 450))
    const [cx, cy] = centre(t)
    ctx.globalAlpha = age
    ctx.lineWidth = Math.max(3, size * 0.12)
    ctx.strokeStyle = ink.lit
    ctx.strokeText(`${count}`, cx, cy + 1)
    ctx.fillStyle = ink.counts[Math.min(count, 4)] ?? ink.glow
    ctx.fillText(`${count}`, cx, cy + 1)
  }
  ctx.globalAlpha = 1

  if (ripple) {
    const p = (now - ripple.at) / 700
    if (p >= 1) ripple = undefined
    else {
      const [rx, ry] = centre(ripple.tile)
      ctx.strokeStyle = ink.bogEdge
      ctx.globalAlpha = 1 - p
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(rx, ry, size * (0.2 + p * 0.5), 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  if (data && data.me.status !== 'lost') {
    const wx = ox + (walker.x + 0.5) * size
    const wy = oy + (walker.y + 0.5) * size
    ctx.shadowColor = ink.glow
    ctx.shadowBlur = size * 0.7
    ctx.fillStyle = ink.glow
    ctx.beginPath()
    ctx.arc(wx, wy, size * 0.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.fillStyle = '#fff6dc'
    ctx.beginPath()
    ctx.arc(wx, wy, size * 0.09, 0, Math.PI * 2)
    ctx.fill()
  }
  requestAnimationFrame(draw)
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
  hint.textContent = 'Walking…'
  const sent = path
  const rsp = await fetchLeg({leg: data.me.legs + 1, path: sent})
  if (failed(rsp)) {
    busy = false
    hint.textContent =
      rsp.status === 0
        ? 'No connection. Your route is saved here; try again.'
        : 'That step did not land. Try again.'
    walkBtn.disabled = false
    return
  }
  path = []
  await play(rsp)
  busy = false
  refreshControls()
  if (rsp.me.status !== 'walking') void showCard(rsp)
}

async function play(rsp: LegRsp): Promise<void> {
  const start = performance.now()
  // New tiles fade in as the walker passes the nearest point of the walk.
  adopt(rsp, tile => {
    let best = 0
    let bestD = Infinity
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
    return start + (best + 1) * STEP_MS
  })
  // The sunk marker should only appear once the walker gets there.
  if (rsp.sunkAt !== null) sunk.delete(rsp.sunkAt)
  for (const t of rsp.walk) await glide(xOf(t), yOf(t), STEP_MS)
  if (rsp.sunkAt !== null) {
    const back = {...walker}
    await glide(
      (back.x + xOf(rsp.sunkAt)) / 2,
      (back.y + yOf(rsp.sunkAt)) / 2,
      STEP_MS,
    )
    sunk.add(rsp.sunkAt)
    ripple = {tile: rsp.sunkAt, at: performance.now()}
    await glide(back.x, back.y, STEP_MS * 1.5)
    hint.textContent =
      rsp.me.lanterns > 0
        ? 'A lantern sank. That bog is now marked for every walker after you.'
        : 'Your last lantern sank. Everything you lit stays lit.'
    await new Promise(resolve => setTimeout(resolve, calm ? 300 : 1100))
  }
}

function row(dl: HTMLElement, label: string, value: string, cls = ''): void {
  const dt = document.createElement('dt')
  const dd = document.createElement('dd')
  dt.textContent = label
  dd.textContent = value
  if (cls) {
    dt.className = cls
    dd.className = cls
  }
  dl.append(dt, dd)
}

async function showCard(d: TonightRsp): Promise<void> {
  const r = d.result
  if (!r) return
  const arrived = d.me.status === 'arrived'
  $('card-title').textContent = arrived
    ? 'You reached the beacon'
    : 'Your lanterns are out'
  $('card-sub').textContent = arrived
    ? `Night ${d.night}, crossed in ${d.me.steps} steps. The shortest dry route was ${r.par}.`
    : `Night ${d.night}. You lit ${d.me.firstLight} tiles that the next walkers can now trust.`
  const dl = $('card-score')
  dl.replaceChildren()
  row(dl, `Lanterns kept (${arrived ? d.me.lanterns : 0})`, `${r.lanterns}`)
  row(dl, 'Route', `${r.route}`)
  row(dl, `First light (${d.me.firstLight} tiles)`, `${r.light}`)
  row(dl, 'Tonight', `${r.total}`, 'total')
  $('card-streak').textContent =
    d.streak > 1
      ? `${d.streak} nights in a row.`
      : 'Come back tomorrow to start a streak.'
  const mins = Math.max(1, Math.round((d.nextAt - Date.now()) / 60_000))
  $('card-next').textContent =
    `A new valley opens in ${Math.floor(mins / 60)} h ${mins % 60} min.`
  const ol = $('card-board')
  ol.replaceChildren()
  card.classList.add('show')
  $<HTMLButtonElement>('card-close').focus()
  const top = await fetchBoard()
  if (failed(top)) return
  for (const entry of top.top.slice(0, 5)) {
    const li = document.createElement('li')
    li.textContent = `${entry.name} · ${entry.score}`
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
  canvas.addEventListener('pointerdown', ev => {
    dragging = true
    canvas.setPointerCapture(ev.pointerId)
    plan(tileAt(ev))
  })
  canvas.addEventListener('pointermove', ev => {
    if (dragging) plan(tileAt(ev))
  })
  const stop = (): void => {
    dragging = false
  }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)
  walkBtn.addEventListener('click', () => void walk())
  undoBtn.addEventListener('click', () => {
    path = []
    refreshControls()
  })
  $('card-close').addEventListener('click', () => card.classList.remove('show'))

  const first = await fetchTonight()
  if (failed(first)) {
    hint.textContent =
      first.status === 401
        ? 'Log in to Reddit to walk the valley.'
        : 'The valley could not be reached. Reopen the post to try again.'
    return
  }
  adopt(first, () => performance.now())
  walker = {x: xOf(first.me.pos), y: yOf(first.me.pos)}
  refreshControls()
  if (first.me.status !== 'walking') void showCard(first)
  setInterval(() => void refresh(), 10_000)
}

void init()
