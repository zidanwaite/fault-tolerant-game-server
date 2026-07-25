# Design Decisions — Architecture Decision Records

Architecture Decision Records (ADRs) document the key decisions made during the design of this system. Each record captures the context at the time of the decision, the decision itself, the alternatives that were considered, and the consequences — both positive and negative.

---

## ADR-001 — Use Redis as a Write-Through Cache for Game State

**Status:** Accepted

**Date:** 2025

### Context

All active game state lived exclusively in a JavaScript `Map` in the Node.js process memory. Any server restart, deployment, or crash permanently destroyed every in-progress game. Players mid-match lost their game with no recovery path. In a production environment with regular deployments, this was not acceptable.

The system needed a way to persist active game state so it could survive process restarts without adding significant latency to the move hot path.

### Decision

Use Redis as a write-through cache. The in-memory `tables` Map remains the primary source of truth during gameplay — all reads come from memory. After every meaningful state change, the full table object is serialized to JSON and written to Redis under the key `table:{tableId}`. On server startup, the server reads all `table:*` keys from Redis and restores them into memory before accepting connections.

### Alternatives Considered

**PostgreSQL only.** Write game state to PostgreSQL on every move. Rejected because PostgreSQL writes to disk — adding 5-20ms of database latency to every tile play would make the game feel sluggish. PostgreSQL is designed for durable long-lived records, not high-frequency ephemeral state.

**No persistence.** Accept that games are lost on restart and improve deployment speed to minimize disruption. Rejected because even a 30-second deployment window destroys every active game. As the player base grows, this becomes increasingly unacceptable.

**Write-behind cache.** Batch Redis writes asynchronously on a delay to reduce write frequency. Rejected because write-behind introduces a window where in-memory state is ahead of Redis. A crash during that window loses moves that players believe were confirmed.

**Sticky sessions.** Route players back to the same server instance on reconnect, keeping state in memory. Rejected because it does not solve the restart problem — if the instance goes down, the games are still lost. It also makes horizontal scaling harder and requires load balancer configuration.

### Consequences

**Positive:**
- Active games survive server restarts and deployments
- Players reconnect and find their game intact
- No latency added to reads — memory is always the primary
- Redis TTL provides automatic cleanup of stale data

**Negative:**
- Redis becomes a hard dependency — if Redis goes down, state cannot be persisted
- Serialization logic adds complexity — Sets and Dates require special handling
- The full table object is serialized on every state change — can be several kilobytes for a game with a long move log
- Two write paths must be maintained: confirmed (awaited) for human moves, fire-and-forget for AI moves

---

## ADR-002 — Await Redis Confirmation Only for Human Moves

**Status:** Accepted

**Date:** 2025

### Context

With Redis as the persistence layer, a question arose: should the server wait for Redis to confirm the write before sending `callback({ success: true })` to the player? Waiting guarantees the move is durable before the player's app shows it as confirmed. Not waiting means the callback fires immediately, but there is a narrow window where a crash could lose a move the player believes was saved.

However, not all moves are equal. Human moves are player-initiated and have a callback. AI moves, bot moves, stand-in moves, and slam sequences are server-generated with no player waiting for confirmation.

### Decision

Use two write functions:

- `saveTableToRedisConfirmed` — async, awaited. Used only in the `playMove` handler for human moves. The callback fires only after Redis confirms the write.
- `saveTableToRedis` — fire-and-forget. Used for all server-generated moves (AI, bot, stand-in, slam) and non-move state changes (join, disconnect, etc.).

### Alternatives Considered

**Always await.** Guarantee durability on every write regardless of who made the move. Rejected because it adds Redis network round-trip latency to every AI and bot move, slowing down games with non-human players for no user-facing benefit.

**Never await.** Always fire-and-forget for maximum speed. Rejected because it means a player could receive `{ success: true }` for a move that was never saved to Redis. A crash immediately after the callback fires would lose that move, creating an inconsistency between what the player's app shows and what the server actually persisted.

**Queue writes and flush periodically.** Batch multiple state changes into a single Redis write. Rejected because it increases the window of potential data loss and adds complexity without meaningful benefit at the scale of a domino game.

### Consequences

**Positive:**
- Human moves are guaranteed durable before the player receives confirmation
- AI/bot moves have no added latency
- The distinction maps cleanly to the user experience — only player-initiated actions need confirmation

**Negative:**
- Two code paths must be maintained and correctly applied
- Applying `saveTableToRedisConfirmed` where `saveTableToRedis` was intended (or vice versa) is a silent bug — no compiler catches it
- The latency tradeoff (1-3ms per human move) is acceptable for a turn-based game but would need re-evaluation for a real-time action game

---

## ADR-003 — Use a Background Worker for Completed Game Durability

**Status:** Accepted

**Date:** 2025

### Context

When a game ends, the server writes the permanent record to PostgreSQL — match replay, metrics, ratings, and XP. These writes are fire-and-forget with `.catch()` error logging. If PostgreSQL was temporarily unavailable at the moment a game ended, the result was silently lost. There was no retry, no recovery, and no way to reconstruct the data.

### Decision

Before attempting PostgreSQL writes, stamp the completed table in Redis with `completedAt` and `postgresStatus: 'pending'`, using a 24-hour TTL instead of deleting immediately. A background worker runs every 5 minutes, scans Redis for completed tables with `postgresStatus: 'pending'`, and retries the PostgreSQL writes. Only after PostgreSQL confirms the save does the worker delete the table from Redis via `markTableSavedAndDelete`.

On server restart, `rehydrateTablesFromRedis` identifies pending completed tables and leaves them in Redis for the worker to pick up — it does not delete them.

### Alternatives Considered

**Retry immediately on failure.** Catch the PostgreSQL error and retry a fixed number of times before giving up. Rejected because if PostgreSQL is down, immediate retries will also fail. The system needs to wait for PostgreSQL to recover, which could take minutes.

**Dead letter queue in a separate service.** Use SQS or a dedicated queue service to hold failed jobs. Rejected for operational simplicity — the system already has Redis connected, and a Redis list works as an effective queue without adding another AWS service.

**Accept the loss.** Log the error and move on. Rejected because completed game records include ranked rating updates. Losing a ranked game result means a player won but their rating was never updated — a correctness failure with real user impact.

**Write to PostgreSQL before marking complete.** Make the PostgreSQL write synchronous and block game completion until it succeeds. Rejected because a PostgreSQL outage would prevent games from ending cleanly, leaving players stuck on a completed game screen indefinitely.

### Consequences

**Positive:**
- No game result is permanently lost due to a temporary PostgreSQL outage
- The worker retries automatically without manual intervention
- Survives server restarts — pending tables are left in Redis and picked up on the next interval
- Simple implementation — a `setInterval` scanning Redis keys

**Negative:**
- There is a window between game end and PostgreSQL confirmation where stats are not updated — players checking leaderboards immediately after a game may see stale data
- The worker scans all `table:*` keys on every interval — at scale this becomes expensive and should be replaced with a dedicated Redis list (push completed tableIds, pop and process)
- Ranked rating updates (`processRankedGame`) are not currently covered by the worker retry — a separate gap that remains open

---

## ADR-004 — Identify Players by userId, Not socketId

**Status:** Accepted

**Date:** 2025

### Context

Socket IDs are assigned by Socket.io on every connection. When a player disconnects and reconnects, they receive a new socket ID. If the system used socket IDs as player identity, every reconnection would look like a new unknown player — the server would have no way to match the reconnecting socket to an in-progress game.

### Decision

Player identity is based on `userId`, which comes from the JWT auth token passed in the socket handshake. On every connection, the server reads `auth.userId` and stores it on `socket.data.userId`. The `userId` is also stored inside `table.players[n].userId`. When a player reconnects, the server looks up their `userId` in the `disconnectedPlayers` Map and uses it to find their table and seat — regardless of what their new socket ID is.

After confirming identity, the server swaps the old socket ID for the new one everywhere it appears: `table.players`, `gameState.players`, `gameState.hands`, `gameState.passHistory`, and `gameState.passedPlayers`.

### Alternatives Considered

**Reconnection tokens.** Issue a one-time token on connection that the client stores and presents on reconnect. More explicit than userId but adds token management complexity and an extra round trip.

**Socket ID persistence.** Store the socket ID in a database and reuse it on reconnect. Not possible — socket IDs are assigned by Socket.io and cannot be chosen by the application.

**Session cookies.** Use HTTP session cookies to identify returning clients. Does not work cleanly with WebSocket connections that bypass HTTP after the initial handshake upgrade.

### Consequences

**Positive:**
- Reconnection works transparently — the player rejoins their exact seat with their exact hand
- Identity survives network changes (switching from WiFi to cellular)
- No client-side token storage required — the auth JWT already exists

**Negative:**
- Anonymous players (no userId) cannot reconnect — if they disconnect mid-game, the game is immediately abandoned
- A player using multiple devices simultaneously with the same userId causes a stale socket conflict — handled by force-disconnecting the stale socket, but an edge case with complex behavior

---

## ADR-005 — Use Socket.io Rooms for Game Broadcasting

**Status:** Accepted

**Date:** 2025

### Context

After a move is applied, the new game state must be delivered to all four players simultaneously. The server needs a way to target all sockets in a specific game without manually tracking each player's socket ID in application code.

### Decision

Use Socket.io rooms. When a player joins a table, their socket calls `socket.join(tableId)`. The room name is the `tableId`. After a state change, the server calls `io.to(tableId).emit(eventName, data)` which Socket.io delivers to every socket in that room. Rooms are created automatically when the first socket joins and destroyed automatically when the last socket leaves.

### Alternatives Considered

**Manual socket tracking.** Keep an array of socket IDs per table and iterate over them to emit individually. More verbose, error-prone (stale socket IDs), and duplicates functionality Socket.io already provides.

**Redis pub/sub.** Publish events to a Redis channel per table; all server instances subscribe and forward to their connected players. Necessary for multi-instance deployments but over-engineered for a single instance. Added as a future improvement.

**Server-Sent Events.** Unidirectional push from server to client. Does not support bidirectional communication needed for move submission. Not suitable.

### Consequences

**Positive:**
- Single `io.to(tableId).emit()` call reaches all four players
- Room membership is managed automatically by Socket.io
- No manual socket ID tracking in application code
- Rooms are free — they exist only when sockets are in them

**Negative:**
- All four players must be connected to the same server instance — cross-instance broadcasting requires Redis pub/sub
- Room state lives only in the Node.js process memory — not visible to other instances or persisted anywhere
- Debugging room membership requires Socket.io-specific tooling

---

## ADR-006 — Lock Down Security Groups to Principle of Least Privilege

**Status:** Accepted

**Date:** 2025

### Context

The initial RDS security group had port 5432 open to `0.0.0.0/0` — the entire internet. While RDS requires credentials to connect, exposing the port publicly is unnecessary attack surface. Any machine on the internet could attempt a connection and probe for vulnerabilities.

### Decision

Remove the `0.0.0.0/0` inbound rule for port 5432. Replace it with a rule that allows port 5432 only from the ECS security group (`sg-01a1f534f81ef12f6`). The ECS tasks can still reach the database — they are in that security group — but no traffic from outside the VPC can reach port 5432.

The same principle applies to Redis — port 6379 is only open to traffic from within the same security group (self-referencing rule), meaning only ECS tasks can reach ElastiCache.

### Alternatives Considered

**IP allowlist.** Restrict port 5432 to specific IP addresses. Rejected because developer IP addresses change (home, office, coffee shop) and maintaining an allowlist is operationally burdensome. Security group referencing is cleaner and does not require updates when developer IPs change.

**VPN.** Require all database access to go through a VPN. More secure but significantly more operational overhead for a small team.

**Leave as-is.** Accept the exposure since credentials are still required. Rejected — defense in depth means not relying on a single layer (credentials) when an additional layer (network restriction) is cheap to add.

### Consequences

**Positive:**
- Eliminates unnecessary attack surface on the database port
- Reduces blast radius of a credential compromise — an attacker with valid credentials still cannot reach the database from outside the VPC
- No operational impact — ECS tasks retain full database access

**Negative:**
- Local development cannot connect directly to RDS without going through a bastion host or VPN — developers must use a local database for development
- Slightly more complex security group configuration to reason about
