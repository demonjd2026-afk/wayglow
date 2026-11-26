import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {telemetryRouter} from '@devvit/analytics/server/reddit'
import {context, reddit} from '@devvit/web/server'
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import express from 'express'
import {
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type LegReq,
} from '../shared/api.ts'
import {dayOf} from './clock.ts'
import {deep, deepLeg, deepStart} from './deep.ts'
import {
  board,
  claimDailyPost,
  getSecret,
  HttpError,
  leg,
  peek,
  relight,
  tonight,
  type Who,
  wearFlair,
} from './game.ts'

const MAX_BODY = 4096

/** Devvit Journeys: Reddit's own router answers the client's /api/telemetry calls. */
const telemetryApp = express().use(telemetryRouter)

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    if (err instanceof HttpError) {
      writeJson<ErrorRsp>(
        err.status,
        {error: err.message, status: err.status},
        rspMsg,
      )
      return
    }
    // Details stay in the server log; clients get nothing they could probe with.
    console.error(`server error; ${err instanceof Error ? err.stack : err}`)
    writeJson<ErrorRsp>(500, {error: 'server error', status: 500}, rspMsg)
  }
}

function who(): Who | undefined {
  const id = context.userId
  const name = context.username
  return id && name ? {id, name} : undefined
}

function needWho(): Who {
  const w = who()
  if (!w) throw new HttpError(401, 'log in to walk')
  return w
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  if ((reqMsg.url ?? '').startsWith('/api/telemetry/')) {
    telemetryApp(reqMsg, rspMsg)
    return
  }
  const endpoint = (reqMsg.url ?? '').split('?')[0]?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]
  if (!method || method !== reqMsg.method) throw new HttpError(404, 'not found')

  let rsp: PartialJsonValue
  switch (endpoint) {
    case Endpoint.Peek:
      rsp = await peek(who())
      break
    case Endpoint.Tonight:
      rsp = await tonight(needWho())
      break
    case Endpoint.Leg:
      rsp = await leg(needWho(), await readJson<LegReq>(reqMsg))
      break
    case Endpoint.Board:
      rsp = await board()
      break
    case Endpoint.Deep:
      rsp = await deep(needWho())
      break
    case Endpoint.DeepStart:
      rsp = await deepStart(needWho())
      break
    case Endpoint.DeepLeg:
      rsp = await deepLeg(needWho(), await readJson<LegReq>(reqMsg))
      break
    case Endpoint.Relight:
      rsp = await relight(needWho())
      break
    case Endpoint.Flair:
      rsp = await wearFlair(needWho())
      break
    case Endpoint.OnMenuNewPost:
      rsp = await routeMenuNewPost()
      break
    case Endpoint.OnAppInstall:
      rsp = await routeAppInstall()
      break
    case Endpoint.OnDailyPost:
      rsp = await routeDailyPost()
      break
    default:
      endpoint satisfies never
      throw new HttpError(404, 'not found')
  }
  writeJson(200, rsp, rspMsg)
}

function title(): string {
  return `Wayglow, night ${dayOf(Date.now()).night}: light the valley together`
}

async function routeMenuNewPost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({title: title()})
  return {
    showToast: {text: 'Wayglow post created.', appearance: 'success'},
    navigateTo: post.url,
  }
}

async function routeAppInstall(): Promise<TriggerResponse> {
  await getSecret()
  if (await claimDailyPost()) await reddit.submitCustomPost({title: title()})
  return {}
}

/** Runs on a cron; safe to retry because the day can only be claimed once. */
async function routeDailyPost(): Promise<TriggerResponse> {
  if (await claimDailyPost()) await reddit.submitCustomPost({title: title()})
  return {}
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  let size = 0
  reqMsg.on('data', (chunk: Uint8Array) => {
    size += chunk.byteLength
    if (size <= MAX_BODY) chunks.push(chunk)
  })
  await once(reqMsg, 'end')
  if (size > MAX_BODY) throw new HttpError(413, 'body too large')
  try {
    return JSON.parse(`${Buffer.concat(chunks)}`) as T
  } catch {
    throw new HttpError(400, 'bad json')
  }
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  rsp.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  rsp.end(body)
}
