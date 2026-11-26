import {spring} from 'motion'
import {animate} from 'motion/mini'

export const calm: boolean = matchMedia(
  '(prefers-reduced-motion: reduce)',
).matches
export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]

/** Buttons give under the thumb and spring back. */
export function springy(el: HTMLElement): void {
  if (calm) return
  const to = (scale: number): void => {
    // Hidden buttons still get pointer events on some browsers; there is nothing to animate.
    if (el.offsetParent === null) return
    animate(
      el,
      {transform: `scale(${scale})`},
      {type: spring, stiffness: 520, damping: 22},
    )
  }
  el.addEventListener('pointerdown', () => to(0.94))
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel'])
    el.addEventListener(ev, () => to(1))
}

/** A short sideways jolt, for a lantern lost. */
export function jolt(el: HTMLElement, px: number): void {
  if (calm) return
  const frames = [0, -px, px * 0.85, -px * 0.55, px * 0.4, 0].map(
    x => `translateX(${x}px)`,
  )
  animate(el, {transform: frames}, {duration: 0.42})
}

/** Roll a number up to its value. */
export function countUp(el: HTMLElement, value: number, delayMs = 0): void {
  if (calm) {
    el.textContent = `${value}`
    return
  }
  el.textContent = '0'
  const t0 = performance.now() + delayMs
  const tick = (now: number): void => {
    const p = clamp01((now - t0) / 900)
    el.textContent = `${Math.round(value * (1 - (1 - p) ** 4))}`
    if (p < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export const easeOutBack = (p: number): number =>
  1 + 2.7 * (p - 1) ** 3 + 1.7 * (p - 1) ** 2
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
