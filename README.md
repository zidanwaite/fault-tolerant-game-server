# Designing a Fault-Tolerant Multiplayer Game Backend

## Executive Summary

YardDomino is a real-time multiplayer domino game built for mobile. The backend runs on a single Node.js server using Socket.io for WebSocket communication, PostgreSQL for permanent records, and Redis for active game state. At its core, the server manages live game sessions — tracking every player's hand, the board layout, whose turn it is, and the running score — across four simultaneously connected players per game.

The original backend stored all of this state exclusively in memory. Every active game lived in a JavaScript `Map` on the server process and nowhere else. This meant any server restart, deployment, or crash instantly destroyed every game in progress. Players mid-match would lose their game permanently with no way to recover it. In a production environment where deployments happen regularly, this was not acceptable.

This project redesigns the state layer using a write-through Redis cache. Every meaningful game state change is persisted to Redis immediately after being applied in memory. On server startup, the server rehydrates active games from Redis before accepting connections. Players who were mid-game when the server restarted reconnect via existing socket logic and find their game still alive. The in-memory Map remains the primary source of truth during gameplay — Redis is the durable backup.

A secondary problem was game result durability. When a game ends, the server writes the permanent record to PostgreSQL — move replay, match metrics, and rating updates. If PostgreSQL was temporarily unavailable at that moment, the game result was silently lost. This project addresses that with a completed game background worker that retries failed PostgreSQL writes, only deleting the game from Redis after the write is confirmed.

---

## The Original Problem

### Original Architecture

```
[Player 1] ──┐
[Player 2] ──┤── WebSocket ──► [Node.js server — tables Map in RAM]
[Player 3] ──┤
[Player 4] ──┘
```

All four players connected to a single Node.js process via WebSocket. Game state lived entirely in a JavaScript `Map` called `tables`. Each entry in the map was a table object containing:

- `table.players` — who is at the table and in which seat
- `table.gameState` — the full game state including every player's hand, the board, whose turn it is, and the score
- `table.moveLog` — a log of every move played for replay

Players were grouped into Socket.io rooms by `tableId`. When a move was played, the server applied it in memory and broadcast the new state to everyone in the room.

### Why It Worked Initially

For a single-server deployment with no restarts, this architecture is simple and fast. No network round trips to a database on every move — the state is right there in memory. Socket.io rooms handle broadcasting to all four players with a single `io.to(tableId).emit()` call. The implementation is straightforward and easy to reason about.

### Why It Failed

**Server restarts and deployments.** Any deployment required stopping the server process. When the process stopped, the `tables` Map was garbage collected. Every active game was gone. Players mid-match received a disconnection and came back to nothing.

**Crashes.** Any unhandled exception that caused the process to exit had the same effect. No game state survived.

**Scaling limitations.** Running a second server instance was impossible. Each instance had its own `tables` Map. A player connected to instance A and a player connected to instance B could not be in the same game — their state lived in separate processes with no shared memory.

**Rolling deployments.** Deploying a new version without downtime requires starting a new instance before stopping the old one. With all state in memory on the old instance, there was no way to hand off active games to the new one.

---

## Requirements

The redesigned architecture needed to satisfy the following:

- **Survive server restarts** — active games must persist across process restarts and deployments
- **Survive crashes** — game state must not be permanently lost on unexpected process exit
- **Maintain low latency** — adding persistence must not noticeably affect move confirmation time
- **Support reconnection** — players who disconnect mid-game must be able to rejoin their game
- **Preserve game result integrity** — completed game records must survive temporary PostgreSQL outages
- **Enable future horizontal scaling** — the design must not prevent running multiple server instances
- **Keep complexity manageable** — the solution must be operationally simple for a small team

---

## Proposed Architecture

```
[Player 1] ──┐
[Player 2] ──┤── WebSocket (Socket.io) ──► [ECS Server — Node.js]
[Player 3] ──┤                                    │           │
[Player 4] ──┘                                    │           │
                                               [Redis]   [PostgreSQL]
                                              active      permanent
                                              sessions     records
```

### Components

**ECS Server (Node.js)**
The application server runs `server.js` as a Docker container on AWS ECS Fargate. It handles all WebSocket connections, game logic, move validation, and state management. The in-memory `tables` Map remains the primary source of truth during gameplay — reads never go to Redis during a live game.

**Socket.io Rooms**
Each game table has a corresponding Socket.io room named after its `tableId`. When a player joins a table, their socket joins that room. The server broadcasts state changes to all players in the room with a single `io.to(tableId).emit()` call. Rooms live inside the Node.js process memory — they are not a separate service.

**Redis (AWS ElastiCache — Valkey)**
Stores active game sessions as serialized JSON under the key `table:{tableId}`. Written to on every meaningful state change. Read only on server startup for rehydration. Completed games that are pending a PostgreSQL write are stored with a 24-hour TTL. Active games use a 4-hour TTL.

**PostgreSQL (AWS RDS)**
Stores permanent records — player accounts, ratings, match replays, match metrics, XP, and leaderboards. Written to when a game ends. Never read during active gameplay.

**Completed Game Worker**
A background `setInterval` that runs every 5 minutes. Scans Redis for completed games with `postgresStatus: 'pending'`. Retries the PostgreSQL write. Only deletes from Redis after PostgreSQL confirms the save.

### Move Flow

```
Player sends move
      ↓
Server validates (stateVersion, turn, player ID)
      ↓
Apply move in memory
      ↓
Await Redis confirmation (saveTableToRedisConfirmed)
      ↓
callback({ success: true }) → private confirmation to that player
      ↓
io.to(tableId).emit('movePlayed') → broadcast to all 4 players
```

### Game End Flow

```
Match complete
      ↓
Stamp table with completedAt + postgresStatus: 'pending' in Redis
      ↓
Write to PostgreSQL (replay, metrics, ratings, XP)
      ↓
Success → markTableSavedAndDelete() → remove from Redis
Failure → table stays in Redis → background worker retries
```

---

## Architecture Decisions

### Why Redis?

**Alternatives considered:** PostgreSQL only, in-memory with no persistence, a message queue like SQS.

Redis was chosen because it stores data in RAM, making reads and writes orders of magnitude faster than PostgreSQL. A game generates a state change on every move — writing to PostgreSQL on every move would add 5-20ms of database latency to every tile play. Redis writes typically complete in under 1ms on the same VPC.

Redis also has a simple key-value API that maps naturally to the existing `tables` Map — the table object is serialized to JSON and stored under `table:{tableId}`. No schema migration, no query planning, no joins.

**Disadvantages:** Redis becomes a dependency. If Redis goes down, the server can no longer persist state. A Redis outage during gameplay means moves are applied in memory but not durably saved — a crash at that moment could lose state.

**Final reasoning:** For a single-instance deployment, Redis adds durability with minimal operational overhead. ElastiCache manages the cluster. The existing health check already monitors Redis availability.

### Why write-through instead of write-behind?

**Write-behind** would batch Redis writes asynchronously on a delay, reducing the number of write operations. However it introduces a window where the in-memory state is ahead of Redis — a crash during that window loses state.

**Write-through** — writing to Redis immediately after every memory mutation — means Redis is always within one operation of being current. The tradeoff is more Redis operations, but at the scale of a domino game (a few moves per minute per table) this is not a concern.

### Why await Redis on human moves but not AI moves?

Human moves use `saveTableToRedisConfirmed` which awaits the Redis write before calling `callback({ success: true })`. This guarantees the move is durable before the player's app receives confirmation — if the server crashes after the callback fires, the player knows their move was saved.

AI moves, bot moves, and slam sequences use the fire-and-forget `saveTableToRedis`. These are server-generated — there is no player waiting for a callback — so adding network round-trip latency to every AI move would slow down games with AI players for no user-facing benefit.

### Why not sticky sessions for scaling?

Sticky sessions route a player back to the same server instance on reconnect. This would allow keeping game state in memory without Redis. However it introduces a single point of failure — if that instance goes down, all its games are still lost. It also makes deployments harder, requires load balancer configuration, and still does not solve the restart problem.

### Why not store everything in PostgreSQL?

PostgreSQL writes to disk and supports complex queries — both of which add latency that is unacceptable on the move hot path. Game state during a live match is also highly volatile (changes on every move) and temporary (deleted when the game ends). PostgreSQL is designed for durable long-lived records, not ephemeral high-frequency state.

### Why keep the in-memory Map as primary?

Reading from Redis on every move would add network latency to every game operation. The in-memory Map gives zero-latency access to game state during gameplay. Redis is write-only during a live game — it is only read on server startup. This keeps the hot path fast while still providing durability.

---

## Failure Scenarios

### Server crashes mid-game

**Problem:** Process exits unexpectedly. Tables Map is gone.

**Current behavior:** On restart, `rehydrateTablesFromRedis` runs before accepting connections. Active games are restored from Redis into the new tables Map. When players reconnect and call `rejoinGame`, the server finds their table, swaps their new socket ID for the old one, and sends the current game state directly to their socket.

**Remaining limitation:** Any move applied in memory but not yet confirmed by Redis at the exact moment of crash is lost. This is a narrow window — only moves in-flight during the crash.

### Planned deployment

**Current behavior:** Same as crash. New ECS task starts, rehydrates from Redis, begins accepting connections. Players reconnect and find their games intact.

**Remaining limitation:** During the gap between old task stopping and new task accepting connections (typically 10-30 seconds), players experience a disconnection. The reconnect grace period (10 minutes) covers this window.

### Player disconnects mid-game

**Current behavior:** Disconnect is detected via WebSocket close. A 10-minute grace period starts. The disconnected player's info (userId, seat, tableId) is stored in `disconnectedPlayers`. A casual AI stand-in begins playing on their behalf with intentionally long delays. The table is saved to Redis capturing the disconnect state. When the player reconnects, their userId confirms identity, their old socket ID is swapped for the new one everywhere it appears in the game state, and they receive a full state sync.

**Remaining limitation:** If the player does not reconnect within 10 minutes, `abandonGame` fires and the game ends for all players.

### Redis unavailable

**Current behavior:** `saveTableToRedis` and `saveTableToRedisConfirmed` check `isRedisAvailable()` before attempting writes. If Redis is down, writes are skipped and errors are logged. The game continues in memory.

**Remaining limitation:** If Redis is down and the server restarts, active games are lost — there is nothing to rehydrate from. This is the core dependency risk of the architecture.

### PostgreSQL unavailable at game end

**Current behavior:** `saveMatchReplay` and `saveMatchMetrics` throw. The completed game worker catches this, leaves the table in Redis with `postgresStatus: 'pending'`, and retries every 5 minutes until PostgreSQL recovers.

**Remaining limitation:** Ranked rating updates (`processRankedGame`) are not currently covered by the worker retry. A PostgreSQL failure at game end could mean a player won a ranked match but their rating was never updated.

### Player reconnects with stale state

**Current behavior:** Every move includes a `stateVersion`. If the client's `stateVersion` does not match the server's current version, the move is rejected with `staleState: true`. The client re-fetches state and retries.

---

## Tradeoffs

**Redis as a dependency.** The system now has a third infrastructure component that can fail. A Redis outage during gameplay means moves are not durably saved. This is mitigated by ElastiCache's managed availability, but it is a real operational risk that did not exist before.

**Increased complexity.** The codebase now has `redisTableCache.js`, `completedGameWorker.js`, serialization logic for Sets and Dates, rehydration logic, and confirmed vs fire-and-forget write paths. Each of these is a new surface area for bugs.

**Cost.** ElastiCache adds to the AWS bill. Even the smallest node type (`cache.t4g.micro`) adds a fixed monthly cost regardless of traffic.

**Eventual consistency for game results.** When a game ends, the result is written to PostgreSQL asynchronously. There is a window — typically seconds, up to minutes if PostgreSQL is struggling — where the game is complete but ratings and stats have not updated. Players checking leaderboards immediately after a game may see stale data.

**Serialization overhead.** The entire table object is serialized to JSON on every state change. For a table with a full move log this can be several kilobytes. This is not currently a problem but could become one at scale.

**No multi-instance support yet.** While Redis enables the possibility of horizontal scaling, Socket.io room broadcasts still require all players in a game to be connected to the same server instance. Scaling to multiple instances would require adding Redis pub/sub to route broadcasts across instances.

---

## Technologies Used

**Node.js**
Chosen for its event-driven, non-blocking I/O model which maps naturally to WebSocket-heavy applications. A single-threaded event loop handles thousands of concurrent WebSocket connections without the context-switching overhead of multi-threaded models. The existing game logic (`@repo/shared`) is also written in JavaScript, making Node.js the natural server choice.

**Socket.io**
Chosen for its room abstraction, which allows broadcasting to all players in a game with a single call. Also provides built-in reconnection handling, acknowledgement callbacks (the private player-to-server response channel), and automatic fallback from WebSockets to long polling for unreliable connections.

**Redis (AWS ElastiCache — Valkey)**
Chosen for in-memory speed (sub-millisecond writes), simple key-value API that maps directly to the existing tables Map, and built-in TTL support for automatic cleanup of stale data. Valkey is a Redis-compatible engine that is approximately 20% cheaper than Redis OSS on ElastiCache with identical API compatibility.

**PostgreSQL (AWS RDS)**
Chosen for permanent records because it provides ACID transactions, complex query support for leaderboards and analytics, and a mature ecosystem. Game state during active play never touches PostgreSQL — it is reserved for durable long-lived records where its strengths matter.

**AWS ECS Fargate**
Chosen for container orchestration without managing EC2 instances. Fargate handles provisioning, scaling, and health checks. Docker containers ensure the server environment is identical between local development and production.

**Terraform**
Chosen to define all AWS infrastructure as code — VPC, security groups, RDS, ElastiCache, ECR, ECS. Infrastructure-as-code makes the deployment reproducible, version-controlled, and reviewable, unlike manually clicking through the AWS console.

**ioredis**
Chosen as the Redis client for Node.js because it supports TLS (required for ElastiCache with encryption in transit enabled), has a clean Promise-based API, and handles reconnection automatically with configurable backoff.

---

## What I Learned

**Stateful vs stateless applications.** Stateless applications — where any server can handle any request — are easy to scale. Stateful applications — where a specific server holds game state for specific players — require careful thought about where state lives and how it survives failures. This project is fundamentally about moving from a stateful-in-memory design toward a more durable stateful design.

**The cost of simplicity.** Storing everything in memory is the simplest possible architecture. It is also the most fragile. Every architectural improvement added complexity — a new service, new serialization logic, new failure modes to handle. Engineering judgment means knowing which complexity is worth the tradeoff.

**Distributed systems failure modes.** Building this system surfaced failure modes that don't exist in simple in-memory designs: Redis unavailable, PostgreSQL temporarily down at game end, moves applied in memory but not yet saved. Each failure mode required a specific response — graceful degradation, retry logic, or accepted limitation.

**Socket ID vs user identity.** Socket IDs are ephemeral — they change on every connection. User IDs are stable. Reconnection logic must be built on user identity, not socket identity. This seems obvious in retrospect but the existing codebase already had this right — the lesson was in understanding why.

**Fire-and-forget vs confirmed writes.** Not all writes need to be awaited. AI moves don't need Redis confirmation before continuing — no one is waiting. Human moves do — the player needs to know their move is durable. Distinguishing between these cases is a practical optimization that reflects understanding of the system's latency requirements.

**Cloud networking and security.** Locking down security groups — restricting PostgreSQL to ECS traffic only, restricting Redis to within the same security group — is not optional hygiene. Port 5432 open to `0.0.0.0/0` is a real vulnerability that existed before this project and was closed as part of it.

---

## Future Improvements

**Redis pub/sub for horizontal scaling.** The current architecture runs a single ECS task. Scaling to multiple tasks requires routing Socket.io room broadcasts across instances. Redis pub/sub would allow one instance to publish a move event that all other instances subscribe to and forward to their connected players.

**Redis Cluster mode.** Currently using a single Redis node. Redis Cluster shards data across multiple nodes and provides automatic failover. This eliminates Redis as a single point of failure.

**Multi-AZ RDS.** Currently using a single-AZ RDS instance. Multi-AZ provides a standby replica in a second availability zone with automatic failover, reducing database downtime during AWS infrastructure events.

**Dead letter queue for all async failures.** The completed game worker handles PostgreSQL failures at game end. Similar retry logic should cover ranking updates (`processRankedGame`) and XP awards (`awardXpForUser`), which are currently fire-and-forget and can be silently lost.

**Persistent event log.** Currently the move log is stored in memory during a game and written to PostgreSQL at the end. A persistent event log (appending each move to a durable store as it happens) would allow reconstructing game state from scratch after any failure, not just from the last Redis snapshot.

**Observability.** The server logs to CloudWatch but has no structured metrics dashboard. Adding metrics for Redis write latency, reconnection rates, grace period expirations, and completed game worker retry counts would make the system's health visible at a glance.

**Chaos testing.** The failure scenarios described in this document have been reasoned about but not systematically tested. Deliberately killing the server mid-game, taking Redis offline, and simulating PostgreSQL failures would verify that the recovery paths work as designed.

**Rate limiting.** Socket events are rate-limited per socket but there is no global rate limiting at the load balancer level. A compromised client could generate excessive traffic. Adding AWS WAF rate limiting rules would protect the backend.
