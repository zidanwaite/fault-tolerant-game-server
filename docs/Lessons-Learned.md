# Lessons Learned

This document is an honest retrospective on what was assumed, what was discovered, what was harder than expected, and what would be done differently today.

---

## What Assumptions Were Wrong

**"In-memory state is fine for now."**
The assumption was that storing game state in memory was acceptable for an early-stage product and could be addressed later. This was wrong. The moment real players are playing real games, any server restart becomes a player-facing failure. "We'll fix it later" is not a viable position when players lose games on every deployment. Persistence should have been designed in from the start, not retrofitted.

**"Deployments are rare."**
The assumption was that deployments happen infrequently enough that losing active games occasionally is acceptable. In practice, deployments happen constantly during active development — bug fixes, feature additions, configuration changes. Every deployment was destroying every active game. The frequency of the problem was much higher than anticipated.

**"Redis is just a cache."**
The assumption was that Redis would be used for simple caching — storing frequently read data to avoid database hits. The actual use turned out to be more architectural — Redis became the durability layer for an entirely stateful system. This required understanding Redis not as a cache but as a primary persistence mechanism with its own failure modes, serialization requirements, and TTL management.

**"Security groups are a deployment detail."**
Port 5432 was open to `0.0.0.0/0` from the beginning. The assumption was that database credentials were sufficient protection and network-level restrictions could be addressed later. This was wrong — defense in depth means not relying on a single layer. The vulnerability existed in production for longer than it should have.

---

## What Became More Difficult Than Expected

**Serialization.**
Serializing the table object to JSON sounds trivial. In practice, JavaScript `Set` objects are silently dropped by `JSON.stringify` — they serialize to `{}` with no error. `Date` objects serialize to strings but deserialize as strings, losing their type. Both required custom serialization logic with tagged objects and a reviver function. Discovering this through a bug rather than upfront design cost time.

**The ordering of startup operations.**
`rehydrateTablesFromRedis` must complete before the server accepts connections. `initBotSystem` must run after rehydration so bots do not try to fill already-active tables. `startCompletedGameWorker` must run after both. Getting this sequence wrong produces subtle bugs — a player calling `rejoinGame` before rehydration completes finds nothing, even though their game is about to be restored. The ordering was not obvious and required careful reasoning.

**Identifying every mutation site.**
Adding `saveTableToRedis` after every meaningful state change sounds straightforward. In practice, `server.js` is a large file with game state mutations scattered across many functions — `playMove`, `processAITurns`, `processBotTurns`, `processStandInTurn`, `processSlamSequence`, `handleHandComplete`, `startGame`, `createTable`, `joinTable`, `abandonGame`, `voidMatch`, and multiple interval-based cleanup functions. Missing even one mutation site meant Redis could have a stale version of the table at the moment of a restart. A systematic audit of every mutation site was required.

**Understanding the difference between socket ID and user identity.**
This seems obvious in retrospect — of course socket IDs change on reconnect. But the full implications took time to understand: the socket ID appears not just in `table.players` but in `gameState.players`, `gameState.hands` (as a key), `gameState.passHistory` (as a key), and `gameState.passedPlayers` (as a Set value). Every one of these had to be updated on reconnect. Missing any one of them would cause subtle bugs — the player's hand would be inaccessible, or their pass history would be lost.

---

## What Was Surprising

**How much the architecture was already correct.**
The existing reconnection logic (`rejoinGame`), the grace period system, the AI stand-in, the phantom game scan — all of this was already designed to handle player disconnections gracefully. The missing piece was purely persistence. The socket-level reconnection architecture was well-designed from the beginning. Redis slotted in as the missing durability layer without requiring changes to the reconnection flow itself.

**How fast Redis actually is.**
The concern about latency from adding a Redis write to the move hot path turned out to be unfounded. ElastiCache within the same VPC responds in under 1ms for a `SET` operation. The `saveTableToRedisConfirmed` await adds effectively imperceptible latency to a turn-based game where players think for seconds between moves.

**How much a health check endpoint matters.**
`/health` returning `{ status: 'ok', database: 'connected', redis: 'connected' }` became the first thing checked after every deployment. Without it, verifying a deployment succeeded meant trying to play a game. A three-field JSON response became the most practically useful endpoint in the entire API.

**The CAP theorem is not theoretical.**
When Redis is unavailable, this system makes a real CAP tradeoff — it chooses availability (keep the game running) over consistency (guarantee state is saved). This is not an abstract academic choice. It is a concrete decision embedded in the `isRedisAvailable()` check: if Redis is down, writes are skipped silently and the game continues. Understanding that this is a deliberate consistency tradeoff — not an oversight — changed how the system was reasoned about.

---

## What Would Be Redesigned Today

**The completed game worker scans all Redis keys.**
The current implementation runs `redis.keys('table:*')` on every interval, scanning every key to find completed ones. This works at small scale but becomes expensive as the number of active tables grows. The correct design is a Redis list — push a `tableId` onto the list when a game ends, pop from the list in the worker. Scan complexity drops from O(n keys) to O(1) per poll.

**`saveTableToRedis` is called at individual mutation sites.**
Rather than manually adding a `saveTableToRedis` call after every state mutation, a cleaner design would wrap the `tables` Map in a proxy that automatically persists on every `set` operation. This would eliminate the class of bugs where a mutation site is missed and Redis has a stale version.

**The move log grows unbounded in memory.**
`table.moveLog` accumulates every move played during a game. For a 6-hand game with 4 players, this could be 100+ moves. The entire log is serialized into the Redis value on every state change, even though only the latest game state is needed for rehydration. The move log should be written to an append-only store (PostgreSQL or a Redis stream) incrementally, not stored in the table object.

**Ranked rating updates are not covered by the retry worker.**
`processRankedGame` is called at game end alongside `saveMatchReplay` and `saveMatchMetrics`. The completed game worker retries the replay and metrics writes but not the rating update. A PostgreSQL failure at game end means the replay and metrics will eventually be saved, but the rating update will be permanently lost. The worker should cover all PostgreSQL writes that happen at game end.

**No observability.**
There are no metrics dashboards, no alerting, and no structured visibility into Redis write latency, reconnection rates, or worker retry counts. The system is either working or it is not, with no gradation in between. Adding CloudWatch metrics for key operations would make the system's health visible before it becomes a problem.

---

## The Most Important Lesson

Distributed systems are not harder because the concepts are complex. They are harder because the failure modes are invisible during development. Everything works when the server is running, Redis is available, and PostgreSQL is up. The failures only appear in production — during a deployment, during a network blip, at the exact moment a database is temporarily unavailable.

The discipline of distributed systems engineering is asking "what happens when this fails?" for every component and every operation, before the failure happens in production. The architecture documents in this repository — the ADRs, the failure scenarios, the tradeoffs — are the output of that discipline applied to a real system.
