/** Small synthesised sounds. No audio files; nothing plays before the first touch. */
const KEY = 'wayglow.muted'
let audio: AudioContext | undefined
let muted = false
try {
  muted = localStorage.getItem(KEY) === '1'
} catch {
  // Storage can be unavailable in a webview; sound simply starts on.
}

export function isMuted(): boolean {
  return muted
}

export function setMuted(next: boolean): void {
  muted = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    // Not remembered; still applies for this visit.
  }
}

/** Browsers only allow sound after a gesture; call this from one. */
export function unlock(): void {
  if (muted) return
  try {
    audio ??= new AudioContext()
    void audio.resume()
  } catch {
    audio = undefined
  }
}

function tone(
  freq: number,
  secs: number,
  type: OscillatorType,
  gain: number,
  delay = 0,
  slideTo?: number,
): void {
  if (muted || !audio || audio.state !== 'running') return
  const t = audio.currentTime + delay
  const osc = audio.createOscillator()
  const amp = audio.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + secs)
  amp.gain.setValueAtTime(0, t)
  amp.gain.linearRampToValueAtTime(gain, t + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, t + secs)
  osc.connect(amp).connect(audio.destination)
  osc.start(t)
  osc.stop(t + secs + 0.02)
}

/** A pentatonic scale keeps every combination pleasant. */
const SCALE = [392, 440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5]

export const sfx = {
  plan(step: number): void {
    tone(SCALE[step % SCALE.length] as number, 0.07, 'triangle', 0.03)
  },
  step(i: number, delay: number): void {
    tone((SCALE[i % SCALE.length] as number) / 2, 0.09, 'sine', 0.045, delay)
  },
  sink(): void {
    tone(190, 0.5, 'sine', 0.11, 0, 55)
    tone(95, 0.35, 'triangle', 0.06, 0.05, 40)
  },
  arrive(): void {
    for (const [i, f] of [523.25, 659.25, 783.99, 1046.5].entries())
      tone(f, 0.7, 'triangle', 0.05, i * 0.1)
  },
  lost(): void {
    tone(294, 0.7, 'sine', 0.05, 0.2, 147)
  },
  flag(): void {
    tone(700, 0.05, 'square', 0.015)
  },
}
