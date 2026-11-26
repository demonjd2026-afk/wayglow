# Wayglow

**One dark valley. Three lanterns. Every step you take stays lit for the walkers after you.**

Wayglow is a daily game for Reddit, built on Devvit Web as an interactive post. Each night the community gets a valley hidden in darkness. Nobody can see all of it. Every walker lights the tiles they cross, for everyone, so the subreddit finds the way across together.

## How to play

1. **Open tonight's post.** You start at the camp at the bottom. The beacon burns at the top.
2. **Read the numbers.** A lit tile shows how many bogs touch it, counting diagonals. A lit tile with no number touches none.
3. **Plan a stretch.** Drag from your lantern through any tiles, lit or dark, then press **Walk**. You can walk in as many stretches as you like.
4. **Mind the dark.** Stepping into a bog costs one of your three lanterns. The sunk lantern marks that bog for every walker after you.
5. **Reach the beacon.** Your walk ends at the beacon, or when the third lantern sinks. Either way, everything you lit stays lit.

One ranked walk per night. A new valley opens at 00:00 UTC.

### Scoring

| Part                     | Points                                                  |
| ------------------------ | ------------------------------------------------------- |
| Lanterns kept on arrival | 100 each                                                |
| Route                    | 100, minus 4 for every step over the shortest dry route |
| First light              | 2 for every tile you were first to light                |

## What makes it a community game

- **Expeditions.** Walkers are grouped 40 to a valley, in order of arrival. What one walker lights, the other 39 can use.
- **Sparks.** Each walker arrives with three sparks that light dry tiles somewhere up the valley, so every arrival adds something even before the first step.
- **Useful failure.** A lost lantern is a warning sign for everyone else.
- **Streaks.** Walk on consecutive nights to build one.

## How it is built

```
src/shared/engine.ts   Rules: seeded valley generator, bog counts, lighting, route checks, scoring
src/shared/api.ts      Request and response types shared by client and server
src/server/game.ts     Seating, walking, streaks and the board, on Devvit Redis
src/server/server.ts   HTTP routes, menu action, install trigger, daily post job
src/client/splash.ts   Feed card
src/client/backdrop.ts Fog and lantern-heat shader
src/client/fx.ts       Springs, count-up and easing helpers
src/client/game.ts     Canvas valley, route planning, walk animation, result card
src/test/              In-memory Redis and a local preview server
```

- **The server holds the valley.** Bog positions never leave it. The client receives lit tiles and their counts and nothing else, and every route is checked and walked on the server.
- **Valleys come from a secret seed.** Each install creates a random secret, and each valley is generated from an HMAC of that secret, the date and the expedition. Reading this repository does not reveal tomorrow's valley.
- **No locks on shared state.** Lit tiles are only ever added, so walkers in the same expedition cannot conflict. A short per-walker lock, which expires on its own, stops double submits.
- **Bounded keys.** Expeditions have a fixed size, so no Redis key grows with the size of the crowd.
- **Retention.** Every key that names a walker expires within 30 days.
- **No external requests and no free-text input.**

### Look and motion

- **Backdrop:** one hand-written WebGL fragment shader draws drifting fog and the heat of the lantern and the flame. No 3D library is loaded. Without WebGL a CSS gradient shows instead.
- **Board:** Canvas 2D with pre-rendered tile sprites, so every frame is a few dozen image draws. Tiles rise in a wave, turn over when lit, and dim with distance from the lantern.
- **Interface:** [Motion](https://motion.dev) drives the springs and staggered entrances.
- **Type:** Fraunces, self-hosted from `public/fonts` under the SIL Open Font License.
- **Reduced motion:** every animation is skipped or shortened when the device asks for it.

Difficulty is tuned by a test that sends a careful, logic-first walker alone into hundreds of dark valleys for each weekday and checks how often it crosses.

## Development

Requires Node 22.6 or newer (24 recommended).

```sh
npm install
npm run preview     # play locally at http://localhost:5173/game.html, no Reddit needed
npm test            # types, lint, unit tests, build
npm run playtest    # run on your test subreddit through Devvit
npm run upload      # build and upload a new version
```

The local preview runs the real server code against an in-memory Redis. Add `?as=name` to an API call, or send an `x-user` header, to act as another walker.

## License

BSD-3-Clause. Scaffolded from Reddit's Devvit Web hello-world template; see `LICENSE`.
