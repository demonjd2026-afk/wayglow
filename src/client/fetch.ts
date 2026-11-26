import type {
  BoardRsp,
  LegReq,
  LegRsp,
  PeekRsp,
  TonightRsp,
} from '../shared/api.ts'
import {Endpoint} from '../shared/api.ts'

export type Failure = {error: string; status: number}

async function call<T>(
  endpoint: Endpoint,
  body?: unknown,
): Promise<T | Failure> {
  try {
    const rsp = await fetch(endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined
          ? {Accept: 'application/json'}
          : {Accept: 'application/json', 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    })
    const json = (await rsp.json().catch(() => undefined)) as
      | T
      | Failure
      | undefined
    if (!rsp.ok || json === undefined) {
      const error =
        json && typeof json === 'object' && 'error' in json
          ? json.error
          : rsp.statusText
      return {error, status: rsp.status || 500}
    }
    return json
  } catch {
    return {error: 'offline', status: 0}
  }
}

export function failed(rsp: object): rsp is Failure {
  return 'error' in rsp && 'status' in rsp
}

export const fetchPeek = (): Promise<PeekRsp | Failure> =>
  call<PeekRsp>(Endpoint.Peek)
export const fetchTonight = (): Promise<TonightRsp | Failure> =>
  call<TonightRsp>(Endpoint.Tonight)
export const fetchBoard = (): Promise<BoardRsp | Failure> =>
  call<BoardRsp>(Endpoint.Board)
export const fetchLeg = (req: LegReq): Promise<LegRsp | Failure> =>
  call<LegRsp>(Endpoint.Leg, req)
