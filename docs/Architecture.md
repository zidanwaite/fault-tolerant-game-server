# Architecture Deep Dive

## Table of Contents

1. [System Overview](#system-overview)
2. [Data Flow](#data-flow)
3. [Game Session Lifecycle](#game-session-lifecycle)
4. [State Management](#state-management)
5. [Redis Schema](#redis-schema)
6. [Reconnection Architecture](#reconnection-architecture)
7. [Concurrency Model](#concurrency-model)
8. [Game End Durability](#game-end-durability)
9. [Server Startup Sequence](#server-startup-sequence)

---

## System Overview

The backend is a single Node.js process running on AWS ECS Fargate. It serves two interfaces simultaneously:

- **HTTP** — REST API routes for auth, profiles, rankings, XP, and announcements (Express)
- **WebSocket** — real-time game communication for all four players (Socket.io)

Both interfaces share the same process, the same port (3001), and the same in-memory state. There is no separate API server and game server — it is one process doing both.

```
Internet
    │
    ▼
ECS Fargate (Node.js — server.js)
    ├── Express (HTTP)
    │     ├── /api/auth
    │     ├── /api/profile
    │     ├── /api/rankings
    │     ├── /api/xp
    │     └── /health
    │
    └── Socket.io (WebSocket)
          ├── connection
          ├── createTable
          ├── joinTable
          ├── queueMatchmaking
          ├── startGame
          ├── playMove
          ├── rejoinGame
          ├── leaveGame
          └── disconnect
```

---

## Data Flow

### Move played by a human player

```
1. Player's phone emits 'playMove' (tableId, move, callback)
        │
        ▼
2. withTableLock(tableId) acquires lock for this table
        │
        ▼
3. Validation
   ├── table exists and status === 'playing'
   ├── move.stateVersion === table.gameState.stateVersion
   ├── move.playerId === socket.id (anti-spoofing)
   └── it is this player's turn
        │
        ▼
4. applyMove(table.gameState, move) — synchronous, updates memory
        │
        ▼
5. saveTableToRedisConfirmed(table) — awaited, Redis confirms write
        │
        ▼
6. callback({ success: true }) — private response to the moving player only
        │
        ▼
7. io.to(tableId).emit('movePlayed', { gameState, move })
   — broadcast to all 4 players in the Socket.io room
        │
        ▼
8. withTableLock releases — next queued operation for this table can proceed
```

### Move played by AI or bot

Same as above except:
- Step 5 uses fire-and-forget `saveTableToRedis` (no await)
- Step 6 is skipped (no callback — no player waiting)
- Step 7 still broadcasts to all players

---

## Game Session Lifecycle

### Private lobby

```
Host creates table
    → table object created in memory
    → table saved to Redis (status: 'lobby')
    → host socket joins Socket.io room
    → host seated at position 2 (south)

Players join via invite code
    → player added to table.players in memory
    → table saved to Redis (updated player list)
    → player socket joins Socket.io room
    → io.to(tableId).emit('tableUpdated') — everyone sees new player

Host starts game
    → resolvePrivateTablePartners() assigns seats
    → fillEmptySeatsWithAI() fills empty seats
    → initializeGame() deals tiles, sets first turn
    → table.status = 'playing'
    → table saved to Redis (full game state)
    → io.to(tableId).emit('gameStarted')
```

### Quick match

```
Player queues via 'queueMatchmaking'
    → added to matchmakingQueue array in memory
    → processMatchmaking() runs immediately

4 players matched (or timeout → AI fill)
    → createMatchedTable() builds table object
    → initializeGame() deals tiles
    → table.status = 'playing'
    → table saved to Redis
    → tables.set(tableId, table)
    → each player socket joins Socket.io room
    → io.to(tableId).emit('gameStarted')
```

### Hand completion

```
applyMove() returns gameState.status === 'handComplete'
    → handleHandComplete() fires
    → determineHandWinner() calculates result
    → handsWon[winningTeam]++
    → io.to(tableId).emit('handComplete', result)

    If handsWon[winningTeam] >= targetHands:
        → match complete (see Game End below)

    If not:
        → setTimeout 5000ms (animation buffer)
        → startNewHand() deals new tiles
        → table saved to Redis
        → io.to(tableId).emit('newHandStarted')
        → processNonHumanTurns() if AI goes first
```

### Game end

```
Match complete
    → table.status = 'completed'
    → saveTableToRedis() stamps completedAt + postgresStatus: 'pending'
    → saveMatchReplay() → PostgreSQL
    → saveMatchMetrics() → PostgreSQL
    → processRankedGame() → PostgreSQL (ranked games only)
    → awardXpForUser() → PostgreSQL (each human player)
    → markTableSavedAndDelete() → delete from Redis
    → activePlayers entries cleaned up
    → table stays in memory (status: 'completed') for phantom game scan
```

---

## State Management

### In-memory Maps

```javascript
// Primary game state store
const tables = new Map();
// Key:   tableId (string)
// Value: table object (see Table Object below)

// Active player tracking
const activePlayers = new Map();
// Key:   socketId (string)
// Value: tableId (string)

// Disconnected player grace periods
const disconnectedPlayers = new Map();
// Key:   userId (string)
// Value: { tableId, playerId, playerName, seat, seatIndex,
//          timer, standInMovesPlayed, standInTimer, disconnectedAt }

// Matchmaking queue
const matchmakingQueue = [];
// Each entry: { socketId, type, partnerId, clientType,
//               timestamp, queuedAt, rating, userId, matchMode, targetHands }
```

### Table Object Structure

```javascript
{
  id: 'table-abc123',           // unique table ID — also Redis key suffix and Socket.io room name
  type: 'public' | 'private' | 'unranked',
  hostId: 'socket-id',
  inviteCode: 'ABC123',         // private tables only
  status: 'lobby' | 'playing' | 'completed',
  ranked: true | false,
  matchmakingMode: 'human' | 'hardCore' | 'ai',

  players: [                    // fixed 4-element array, null = empty seat
    { id, userId, name, seat, team, isAI, avatarConfig, rating, tier },
    { id, userId, name, seat, team, isAI, avatarConfig, rating, tier },
    { id, userId, name, seat, team, isAI, avatarConfig, rating, tier },
    { id, userId, name, seat, team, isAI, avatarConfig, rating, tier },
  ],

  config: {
    targetHands: 6,
    mode: 'quickMatch' | 'private',
    aiDifficulty: 'yardSmart',
    allowSpectators: true,
    allowFreeChat: true,
    layoutProfile: 'mobile' | 'default',
  },

  gameState: {                  // managed by @repo/shared game engine
    status: 'playing' | 'handComplete' | 'matchComplete',
    players: [...],
    hands: { [playerId]: [tiles] },
    board: [...],
    currentTurn: 'north' | 'south' | 'east' | 'west',
    handsWon: { A: 0, B: 0 },
    targetHands: 6,
    currentHandNumber: 1,
    stateVersion: 42,           // incremented on every state change
    passedPlayers: Set,         // serialized as Array in Redis
    seed: 'table-abc123-1234567890',
  },

  moveLog: [...],               // every move played, used for replay
  spectators: [...],
  partnerPreferences: {},       // private tables only
  startedAt: Date,              // serialized as ISO string in Redis

  // Set when game ends
  abandonReason: 'voluntaryLeave' | 'playerTimeout' | 'playerLeft',
  abandonedBy: 'player name',
  voidReason: 'stuckMatch' | 'AI move error',
  completedAt: 1234567890,      // timestamp — set by saveTableToRedis on completion
  postgresStatus: 'pending' | 'saved',
  rejoinNotifiedUserIds: Set,   // tracks phantom game notifications
}
```

---

## Redis Schema

### Key format
```
table:{tableId}
```

Example: `table:table-abc123`

### Active table TTL
4 hours (`14400` seconds). Covers the 10-minute reconnect grace period with significant headroom.

### Completed table TTL
24 hours (`86400` seconds). Gives the background worker ample time to retry failed PostgreSQL writes before the key expires.

### Serialization

The table object is serialized with two special cases:

```javascript
// Sets cannot be JSON serialized — converted to tagged objects
passedPlayers: Set(['socketId1', 'socketId2'])
// stored as:
passedPlayers: { __type: 'Set', values: ['socketId1', 'socketId2'] }

// Dates lose type information in JSON — stored as ISO strings
startedAt: new Date('2024-01-01T12:00:00.000Z')
// stored as:
startedAt: '2024-01-01T12:00:00.000Z'
// restored via reviver function checking _key === 'startedAt'
```

### Write strategy

| Situation | Function | Awaited? |
|---|---|---|
| Human move (playMove) | `saveTableToRedisConfirmed` | Yes — confirms before callback |
| AI/bot/slam move | `saveTableToRedis` | No — fire and forget |
| Game start, join, create | `saveTableToRedis` | No |
| Disconnect grace period | `saveTableToRedis` | No |
| Reconnect socket swap | `saveTableToRedis` | No |
| Game complete | `saveTableToRedis` | No — stamps pending status |
| Confirmed postgres save | `markTableSavedAndDelete` | No |
| Empty lobby deletion | `deleteTableFromRedis` | No |

---

## Reconnection Architecture

Player identity survives reconnection because identity is based on `userId`, not `socketId`.

```
socketId — ephemeral, changes on every connection
userId   — stable, set from JWT auth on handshake, stored on socket.data.userId
           and inside table.players[n].userId
```

### Reconnection flow

```
Player reconnects → new socket created → 'rejoinGame' emitted

Server checks disconnectedPlayers Map for userId
    Found:
        → cancel grace period timer
        → cancel stand-in AI timer
        → find player in table.players by old socketId
        → swap old socketId → new socketId in:
            table.players[n].id
            table.gameState.players[n].id
            table.gameState.hands (key rename)
            table.gameState.passHistory (key rename)
            table.gameState.passedPlayers (Set value swap)
        → activePlayers.delete(oldSocketId)
        → activePlayers.set(newSocketId, tableId)
        → socket.join(tableId) — rejoin Socket.io room
        → saveTableToRedis(table) — persist new socketId
        → socket.emit('gameStateSync', fullState) — direct to reconnecting player only
        → io.to(tableId).emit('playerReconnected') — notify others via room

    Not found — scan tables for stale socket with matching userId:
        → force-disconnect stale socket
        → synthesize dcInfo from stale player data
        → continue as above

    Not found anywhere:
        → check disconnectedLobbyPlayers (private lobby reconnect)
        → check phantom games (completed tables — emit 'Game no longer active')
        → return 'No active game to rejoin'
```

---

## Concurrency Model

Node.js is single-threaded — only one operation runs at a time on the event loop. However, async operations (database queries, Redis writes, timers) are non-blocking and interleave. Without explicit locking, two moves could theoretically be processed concurrently for the same table if both arrive while a database query is in flight.

`withTableLock(tableId, fn)` prevents this. It maintains a per-table queue of pending operations. Only one operation runs at a time per table. Subsequent operations wait in the queue until the current one completes.

```javascript
// Two moves arrive simultaneously for the same table
withTableLock('table-abc123', () => applyMove(...))  // runs immediately
withTableLock('table-abc123', () => applyMove(...))  // queued, runs after first completes
```

This makes the read-validate-apply-save sequence atomic per table without needing database transactions or thread locks.

---

## Game End Durability

The completed game worker ensures no game result is permanently lost due to a temporary PostgreSQL outage.

### When a game ends

```javascript
// saveTableToRedis detects completed status
if (table.status === 'completed') {
  table.completedAt = Date.now()
  table.postgresStatus = 'pending'
  redis.set(key, serialized, 'EX', 86400)  // 24h TTL, not deleted
}
```

### Background worker (every 5 minutes)

```
Scan all table:* keys in Redis
    For each key:
        Parse table object
        Skip if status !== 'completed'
        Skip if postgresStatus !== 'pending'
        Skip if Date.now() - completedAt < 5000ms (minimum age)

        Try:
            saveMatchReplay(table) → PostgreSQL
            saveMatchMetrics(table) → PostgreSQL
            markTableSavedAndDelete(tableId) → delete from Redis
            log success

        Catch:
            log failure
            leave in Redis
            retry on next interval
```

### On server restart

`rehydrateTablesFromRedis` treats completed tables with `postgresStatus: 'pending'` differently from active tables:

- Active tables (`status: 'playing'`) → restored into `tables` Map
- Pending completed tables → left in Redis, logged, picked up by worker on next interval
- Already-saved completed tables (`postgresStatus: 'saved'` or absent) → deleted from Redis

---

## Server Startup Sequence

```
1. Node.js process starts
2. Express app initialized
3. Socket.io server attached
4. server.listen() called — port 3001 open

5. rehydrateTablesFromRedis(tables, activePlayers)
   → scan Redis for table:* keys
   → restore playing tables into memory
   → restore activePlayers entries (stale socket IDs)
   → log pending completed tables for worker
   → skip stale lobbies

6. initBotSystem()
   → loadBotConfigs() from PostgreSQL
   → initBotQueueManager()
   → startBotClimbScheduler()

7. startCompletedGameWorker()
   → setInterval every 5 minutes
   → retries pending PostgreSQL writes

8. Server ready — accepting connections
   → players reconnect via 'rejoinGame'
   → stale socket IDs swapped for new ones
   → games resume
```
