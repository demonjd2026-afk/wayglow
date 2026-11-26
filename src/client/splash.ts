import {requestExpandedMode} from '@devvit/web/client'
import {stagger} from 'motion'
import {animate} from 'motion/mini'
import {backdrop} from './backdrop.ts'
import {failed, fetchPeek} from './fetch.ts'
import {calm, clamp01, EASE, springy} from './fx.ts'

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T
const startBtn = $<HTMLButtonElement>('start-btn')
const stats = $('stats')
const title = document.querySelector('h1') as HTMLElement

startBtn.addEventListener('click', ev => requestExpandedMode(ev, 'game'))
springy(startBtn)
backdrop($<HTMLCanvasElement>('backdrop'), calm)?.light(0, 0.5, 0.3, 0.9)

for (const ch of 'Wayglow') {
  const span = document.createElement('span')
  span.textContent = ch
  span.setAttribute('aria-hidden', 'true')
  title.append(span)
}
if (!calm) {
  animate(
    Array.from(title.children),
    {
      opacity: [0, 1],
      transform: ['translateY(18px)', 'translateY(0px)'],
      filter: ['blur(10px)', 'blur(0px)'],
    },
    {delay: stagger(0.06), duration: 0.7, ease: EASE},
  )
  animate(
    'main > p, main > button',
    {opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0px)']},
    {delay: stagger(0.1, {startDelay: 0.5}), duration: 0.6},
  )
}

/** The game in miniature: a walker lights a path across a strip of valley. */
function mini(): void {
  const canvas = $<HTMLCanvasElement>('mini')
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const cols = 7
  const rows = 3
  const route = [14, 15, 8, 9, 10, 3, 4, 5, 12, 13, 20]
  const dpr = Math.min(devicePixelRatio || 1, 3)
  const frame = (now: number): void => {
    if (!calm) requestAnimationFrame(frame)
    const w = canvas.clientWidth
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(((w * rows) / cols) * dpr)
    }
    const s = w / cols
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, s * rows)
    const beat = calm ? route.length : (now / 420) % (route.length + 6)
    for (let t = 0; t < cols * rows; t++) {
      const x = (t % cols) * s
      const y = Math.floor(t / cols) * s
      const at = route.indexOf(t)
      const glow =
        at < 0 ? 0 : clamp01(beat - at) * clamp01(route.length + 5 - beat)
      ctx.fillStyle = '#131a3d'
      ctx.beginPath()
      ctx.roundRect(x + 2, y + 2, s - 4, s - 4, s * 0.2)
      ctx.fill()
      if (glow > 0) {
        ctx.globalAlpha = glow
        const g = ctx.createLinearGradient(0, y, 0, y + s)
        g.addColorStop(0, '#7a5a24')
        g.addColorStop(1, '#3a2910')
        ctx.fillStyle = g
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,200,110,0.6)'
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }
    const i = Math.min(route.length - 1, Math.floor(beat))
    const head = route[i] as number
    const next = route[Math.min(route.length - 1, i + 1)] as number
    const p = beat >= route.length - 1 ? 0 : beat - i
    const hx = ((head % cols) + ((next % cols) - (head % cols)) * p + 0.5) * s
    const hy =
      (Math.floor(head / cols) +
        (Math.floor(next / cols) - Math.floor(head / cols)) * p +
        0.5) *
      s
    const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, s * 0.9)
    halo.addColorStop(0, 'rgba(255,200,110,0.75)')
    halo.addColorStop(1, 'rgba(255,160,60,0)')
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(hx, hy, s * 0.9, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#fff6dc'
    ctx.beginPath()
    ctx.arc(hx, hy, s * 0.13, 0, Math.PI * 2)
    ctx.fill()
  }
  requestAnimationFrame(frame)
}

async function init(): Promise<void> {
  mini()
  const peek = await fetchPeek()
  if (failed(peek)) return
  const out =
    peek.walkersToday === 0
      ? 'nobody has set out yet'
      : peek.walkersToday === 1
        ? '1 walker out'
        : `${peek.walkersToday} walkers out`
  stats.textContent = `Night ${peek.night}, ${out}${peek.streak > 1 ? `. Your streak: ${peek.streak} nights` : ''}`
  if (peek.status === 'walking') startBtn.textContent = 'Continue your walk'
  else if (peek.status !== 'new') startBtn.textContent = "See tonight's valley"
}

void init()
