import {telemetry} from '@devvit/analytics/client/reddit'
import {connectRealtime} from '@devvit/web/client'
import {animate} from 'motion/mini'
import type {LiveMsg, Walker} from '../shared/api.ts'
import {calm} from './fx.ts'

/** Faces of the walkers out tonight; falls back to an initial when an avatar will not load. */
export function showFaces(host: HTMLElement, roster: readonly Walker[]): void {
  const sig = roster.map(w => w.name).join(',')
  if (host.dataset.sig === sig) return
  host.dataset.sig = sig
  host.replaceChildren()
  for (const w of roster.slice(0, 5)) {
    const face = document.createElement('span')
    face.className = 'face'
    face.title = w.name
    face.textContent = w.name.slice(0, 1).toUpperCase()
    if (w.avatar?.startsWith('https://')) {
      const img = document.createElement('img')
      img.alt = ''
      img.referrerPolicy = 'no-referrer'
      img.addEventListener('error', () => img.remove())
      img.src = w.avatar
      face.append(img)
    }
    host.append(face)
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export function toast(el: HTMLElement, text: string, ms = 2600): void {
  el.textContent = text
  el.classList.add('show')
  if (!calm)
    animate(
      el,
      {
        opacity: [0, 1],
        transform: ['translate(-50%,-8px)', 'translate(-50%,0px)'],
      },
      {duration: 0.3},
    )
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), ms)
}

export function describe(msg: LiveMsg): string {
  if (msg.arrived) return `${msg.by} reached the flame`
  if (msg.sunk) return `${msg.by} lost a lantern and marked a bog`
  return `${msg.by} lit ${msg.lit} ${msg.lit === 1 ? 'tile' : 'tiles'}`
}

/** Live updates from the rest of the expedition. Returns false where realtime is unavailable. */
export function listen(
  channel: string,
  onMessage: (msg: LiveMsg) => void,
): boolean {
  try {
    connectRealtime<LiveMsg>({channel, onMessage})
    return true
  } catch {
    return false
  }
}

/**
 * Devvit Journeys. Events are best-effort: playtest builds and apps awaiting
 * approval get a denial receipt, and that must never touch the game.
 */
const quiet = (p: Promise<unknown>): void => {
  p.catch(() => undefined)
}
export const journey = {
  ready: (): void => quiet(telemetry.appReady()),
  start: (): void => quiet(telemetry.startJourney()),
  progress: (progress: number): void =>
    quiet(telemetry.progress({progress, action: 'stretch'})),
  act: (action: string): void => quiet(telemetry.interaction({action})),
  end: (win: boolean, score: number): void =>
    quiet(telemetry.endJourney({complete: true, game: {win, score}})),
}
