/**
 * Local preview: serves the client and runs the real server code against an
 * in-memory Redis, so the game can be played without Reddit.
 *
 *   npm run preview   then open http://localhost:5173/game.html
 */
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {extname, join, normalize} from 'node:path'
import {type Context, runWithContext} from '@devvit/web/server'
import {onReq} from '../server/server.ts'
import './fake-redis.ts'

const root = join(import.meta.dirname, '../../public')
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.map': 'application/json',
  '.png': 'image/png',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
}
const port = Number(process.env.PORT ?? 5173)

createServer((req, rsp) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/internal/')
  ) {
    const user =
      url.searchParams.get('as') ?? req.headers['x-user']?.toString() ?? 'you'
    const ctx = {
      postId: 't3_local',
      userId: `t2_${user}`,
      username: user,
    } as unknown as Context
    void runWithContext(ctx, () => onReq(req, rsp))
    return
  }
  const file = normalize(
    join(root, url.pathname === '/' ? 'game.html' : url.pathname),
  )
  if (!file.startsWith(root)) {
    rsp.writeHead(403).end()
    return
  }
  readFile(file).then(
    body =>
      rsp
        .writeHead(200, {
          'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        })
        .end(body),
    () => rsp.writeHead(404).end('not found'),
  )
}).listen(port, () =>
  console.log(`Wayglow preview: http://localhost:${port}/game.html`),
)
