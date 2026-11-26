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
  /** Lanterns this walker may still relight after losing all of them. */
  relights: number
  /** True once the walker has relit a lantern; the night's score is then fixed. */
  unranked: boolean
}

export type Walker = {name: string; avatar: string | null}

/** A walker's record across nights. */
export type Almanac = {
  nights: number
  crossed: number
  /** Tiles lit first, all nights together. */
  lit: number
  best: number
  rank: string
  /** Tiles still to light before the next rank, or null at the top. */
  toNext: number | null
  nextRank: string | null
}

/** Everything a walker may know about tonight. Never includes dark tiles. */
export type TonightRsp = {
  day: string
  night: number
  /** Tonight's character, such as Thick fog. */
  nightName: string
  nightBlurb: string
  lanternsMax: number
  expedition: number
  /** Share of this valley's dry tiles lit so far, 0 to 100. */
  glow: number
  almanac: Almanac
  /** [tile, bogs touching it] for every lit tile. */
  lit: [number, number][]
  /** Bogs marked by sunk lanterns. */
  sunk: number[]
  /** [tile, walker name] for each sunk lantern. */
  sunkBy: [number, string][]
  walkers: number
  /** Most recent walkers in this expedition, newest first. */
  roster: Walker[]
  me: Me
  streak: number
  /** True when a missed night was forgiven today. */
  streakSaved: boolean
  /** Other walkers who have stepped on a tile this walker lit first. */
  guided: number
  /** Present once the walk is over. */
  result: (ScoreParts & {par: number}) | null
  /** How tonight's finished walks ended: index is lanterns kept, 0 means lost. */
  stats: number[] | null
  /** Last night's walk, on the first load of a new night. */
  yesterday: {night: number; guided: number; status: WalkStatus} | null
  /** Realtime channel for this expedition. */
  channel: string
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

/** Pushed to everyone in the expedition when a walker finishes a stretch. */
export type LiveMsg = {by: string; lit: number; sunk: boolean; arrived: boolean}

/** Read-only summary for the feed card. Never seats the viewer. */
export type PeekRsp = {
  night: number
  nightName: string
  walkersToday: number
  /** How much of the newest valley is lit, 0 to 100. */
  litPct: number
  status: WalkStatus | 'new'
  streak: number
}

export type BoardRsp = {top: {name: string; score: number}[]}
export type FlairRsp = {text: string}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Peek: 'api/peek',
  Tonight: 'api/tonight',
  Leg: 'api/leg',
  Board: 'api/board',
  Flair: 'api/flair',
  Relight: 'api/relight',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnDailyPost: 'internal/cron/daily-post',
} as const

export const EndpointMethod = {
  [Endpoint.Peek]: 'GET',
  [Endpoint.Tonight]: 'GET',
  [Endpoint.Leg]: 'POST',
  [Endpoint.Board]: 'GET',
  [Endpoint.Flair]: 'POST',
  [Endpoint.Relight]: 'POST',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnDailyPost]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
