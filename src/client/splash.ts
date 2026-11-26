import {requestExpandedMode} from '@devvit/web/client'
import {failed, fetchPeek} from './fetch.ts'

const startBtn = document.getElementById('start-btn') as HTMLButtonElement
const stats = document.getElementById('stats') as HTMLParagraphElement
startBtn.addEventListener('click', ev => requestExpandedMode(ev, 'game'))

async function init(): Promise<void> {
  const peek = await fetchPeek()
  if (failed(peek)) return
  const out =
    peek.walkersToday === 1
      ? '1 walker out'
      : `${peek.walkersToday} walkers out`
  const streak = peek.streak > 1 ? ` · ${peek.streak}-night streak` : ''
  stats.textContent = `Night ${peek.night} · ${peek.walkersToday === 0 ? 'the valley is still dark' : out}${streak}`
  if (peek.status === 'walking') startBtn.textContent = 'Continue your walk'
  else if (peek.status !== 'new') startBtn.textContent = "See tonight's valley"
}

void init()
