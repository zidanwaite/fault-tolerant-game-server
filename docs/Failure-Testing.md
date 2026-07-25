# Failure Testing

This document records the failure scenarios that were tested against the system, the expected behavior, the actual behavior observed, and lessons learned from each test. All tests were conducted against the live AWS deployment using Expo Go connected to the ECS backend.

---

## Test 001 — Server Restart Mid-Game (Pre-Redis)

**Date:** 2025

**Purpose:** Establish a baseline. Confirm the original behavior before Redis was wired in.

### Setup
- Two devices connected to the AWS backend via Expo Go
- Active game in progress, mid-hand
- Both players had tiles on the board

### Action
Forced a new ECS deployment via:
```bash
aws ecs update-service --cluster default --service yarddomino-test-5ec9 --force-new-deployment --region us-east-1
```

### Expected Behavior (pre-Redis)
- Players lose connection briefly
- Game is lost — the server has no memory of it after restart
- Players see a disconnection or "Game no longer active" message

### Actual Behavior
- Both devices disconnected immediately when the old ECS task stopped
- On reconnect, `rejoinGame` found nothing — the `tables` Map was empty
- Players were left on a dead game screen with no game to return to
- The game was permanently gone

### Lesson Learned
The simplest possible architecture — everything in memory — is also the most fragile. A routine deployment was indistinguishable from a crash from the player's perspective. This confirmed the Redis persistence work was necessary, not optional.

---

## Test 002 — Server Restart Mid-Game (Post-Redis)

**Date:** 2025

**Purpose:** Verify that Redis persistence allows active games to survive a server restart.

### Setup
- Same as Test 001 — two devices, active game in progress
- Redis wiring fully implemented (`redisTableCache.js` deployed)

### Action
Same force-new-deployment command as Test 001.

### Expected Behavior
- Players lose connection briefly during task replacement
- New ECS task starts, rehydrates game from Redis
- Players reconnect via `rejoinGame`, find their game intact
- Game resumes from the exact state it was in

### Actual Behavior
- Both devices lost connection when the old task stopped (expected)
- New task started and logged: `[RedisCache] Found 1 table(s) in Redis — rehydrating`
- New task logged: `[RedisCache] Restored table table-xxx (status: playing, players: 2)`
- Players reconnected — `rejoinGame` found the table, swapped socket IDs, sent `gameStateSync`
- Game resumed from the exact board state, same hand, same score
- No moves were lost

### Actual vs Expected
Matched exactly. The game survived the restart without any player-visible data loss.

### Lesson Learned
The rehydration sequence — restoring tables from Redis before accepting connections — is critical. If connections were accepted before rehydration completed, a player could call `rejoinGame` and find nothing, even though their game was about to be restored. The ordering in `server.listen` matters.

---

## Test 003 — Health Check Verification Post-Deployment

**Date:** 2025

**Purpose:** Verify all three services remain connected after every deployment.

### Action
After every deployment, run:
```bash
curl https://ya-ef6f7b8275044f058f1b19d8fdb4127e.ecs.us-east-1.on.aws/health -UseBasicParsing
```

### Expected Behavior
```json
{
  "status": "ok",
  "uptime": 242297.056,
  "database": "connected",
  "redis": "connected"
}
```

### Actual Behavior
All deployments returned status 200 with database and Redis connected. The health check has never returned an error state in production.

### Lesson Learned
A health check endpoint is not optional. Without it, the only way to know if a deployment succeeded is to try to play a game. The `/health` endpoint gives immediate confirmation that all three services — the server, PostgreSQL, and Redis — are reachable after every change.

---

## Test 004 — Security Group Lockdown

**Date:** 2025

**Purpose:** Verify that restricting port 5432 to the ECS security group does not break database connectivity.

### Setup
- RDS security group had `0.0.0.0/0` on port 5432 (open to internet)
- Changed to source `sg-01a1f534f81ef12f6` (ECS security group only)

### Action
Changed the inbound rule via the AWS console. Ran health check immediately after.

### Expected Behavior
- Health check still returns `"database": "connected"`
- ECS tasks can still reach RDS (they are in the allowed security group)
- External connections to port 5432 are blocked

### Actual Behavior
- Health check returned 200 with `"database": "connected"` immediately
- No disruption to any active connections
- Security group change took effect without requiring a deployment

### Lesson Learned
Security group changes are live immediately — they do not require a deployment or restart. This makes them safe to apply to a running system. The principle of least privilege (only allow what is necessary) should be applied from day one, not as an afterthought. Port 5432 being open to `0.0.0.0/0` was a real vulnerability that existed in production before this test.

---

## Test 005 — Reconnection After Disconnect

**Date:** 2025

**Purpose:** Verify that a player who disconnects mid-game can reconnect and find their game intact.

### Setup
- Active game in progress
- One device intentionally disconnected (airplane mode)

### Action
Enabled airplane mode on one device for approximately 15 seconds, then disabled it.

### Expected Behavior
- Server detects disconnect via WebSocket close
- Grace period starts (10 minutes)
- AI stand-in begins playing for disconnected player after ~20 seconds
- Player reconnects, `rejoinGame` finds their `userId` in `disconnectedPlayers`
- Socket ID swapped, game state synced, player back in their seat

### Actual Behavior
- Server detected disconnect within ~5 seconds (pingTimeout: 5000ms)
- Grace period started, `playerDisconnected` emitted to room with `action: 'reconnecting'`
- Other player's screen showed reconnecting indicator
- On reconnect, `rejoinGame` ran successfully — player found their table
- Full game state synced to reconnecting device
- AI stand-in had not yet played (reconnected before the 10-second stand-in delay)
- Game resumed normally

### Actual vs Expected
Matched. The 5-second ping timeout meant the server detected the disconnect faster than expected — the stand-in delay (10 seconds after disconnect detection) gave enough buffer that the player reconnected before the AI played.

### Lesson Learned
The layered timing design works well in practice. The 5-second ping timeout detects disconnects quickly. The 10-second stand-in delay gives the player a window to reconnect before the AI takes over. The 10-minute grace period is generous — in practice most reconnections happen within seconds for a network blip, not minutes.

---

## Test 006 — Stale Redis Keys After Completed Game

**Date:** 2025

**Purpose:** Verify that completed games are deleted from Redis and do not accumulate.

### Setup
- Played a full game to completion
- Monitored Redis keys before and after

### Action
Connected to the ECS task logs and watched for `[RedisCache]` log lines during and after a completed game.

### Expected Behavior
- During game: `table:{tableId}` key exists in Redis
- After game ends: key is deleted via `markTableSavedAndDelete`
- Redis does not accumulate stale completed game keys

### Actual Behavior
- Key existed throughout the game
- On match complete: PostgreSQL writes fired, then `markTableSavedAndDelete` called
- Key was deleted from Redis
- Subsequent Redis key scan showed no stale keys from that game

### Lesson Learned
The 24-hour TTL on completed tables is a safety net, not the primary cleanup mechanism. The primary cleanup is `markTableSavedAndDelete` firing immediately after a confirmed PostgreSQL write. The TTL ensures that even if the worker fails repeatedly for an extended period, keys do not accumulate indefinitely.

---

## Remaining Untested Scenarios

The following failure scenarios have been reasoned about in the architecture documentation but not yet systematically tested:

**Redis unavailable during active gameplay.**
Expected: moves continue in memory, Redis writes silently fail, server logs errors. If server restarts while Redis is down, active games are lost. This has not been tested by deliberately taking Redis offline.

**PostgreSQL unavailable at game end.**
Expected: completed game worker retries the write. This has not been tested by deliberately making PostgreSQL unavailable at the exact moment a game ends.

**Two devices reconnecting simultaneously with the same userId.**
Expected: the second reconnection force-disconnects the stale socket from the first. Edge case behavior has not been systematically tested.

**Grace period expiry (10 minutes).**
Expected: `abandonGame` fires with reason `playerTimeout`, game ends for all players. This has not been tested by waiting the full 10 minutes with a disconnected player.

**Stuck match detector.**
Expected: after 5 minutes of no moves, the match is auto-voided. This has not been tested by deliberately leaving a game idle for 5 minutes.

These scenarios are documented as future chaos testing work in `Future-Improvements.md`.
