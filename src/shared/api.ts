import type {ScoreParts} from './engine.ts'

/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

export type WalkStatus = 'walking' | 'arrived' | 'lost'

export type Me = {
  pos: number
  lanterns: number
  steps: number
  legs: number
  status: WalkStatus
  firstLight: number
}

/** Everything a walker may know about tonight. Never includes dark tiles. */
export type TonightRsp = {
  day: string
  night: number
  expedition: number
  /** [tile, bogs touching it] for every lit tile. */
  lit: [number, number][]
  /** Bogs marked by sunk lanterns. */
  sunk: number[]
  walkers: number
  me: Me
  streak: number
  /** Present once the walk is over. */
  result: (ScoreParts & {par: number}) | null
  /** Epoch ms when the next valley opens. */
  nextAt: number
}

export type LegReq = {leg: number; path: number[]}

export type LegRsp = TonightRsp & {
  /** Tiles entered safely this leg, for the walk animation. */
  walk: number[]
  sunkAt: number | null
  /** False when this leg was a duplicate or out of turn and was ignored. */
  applied: boolean
}

/** Read-only summary for the feed card. Never seats the viewer. */
export type PeekRsp = {
  night: number
  walkersToday: number
  status: WalkStatus | 'new'
  streak: number
}

export type BoardRsp = {top: {name: string; score: number}[]}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Peek: 'api/peek',
  Tonight: 'api/tonight',
  Leg: 'api/leg',
  Board: 'api/board',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnDailyPost: 'internal/cron/daily-post',
} as const

export const EndpointMethod = {
  [Endpoint.Peek]: 'GET',
  [Endpoint.Tonight]: 'GET',
  [Endpoint.Leg]: 'POST',
  [Endpoint.Board]: 'GET',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnDailyPost]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
