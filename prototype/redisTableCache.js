// redisTableCache.js
// Write-through Redis cache for active game tables.
//
// Strategy:
//   - In-memory `tables` Map is always the primary (zero latency, no await on hot path).
//   - Every meaningful table mutation calls saveTableToRedis() fire-and-forget.
//   - On server start, rehydrateTablesFromRedis() restores in-progress games so
//     active matches survive a deploy or crash.
//
// Completed game durability:
//   - When a game ends, before deleting from Redis we stamp it with
//     completedAt and postgresStatus: 'pending'.
//   - The table is only deleted from Redis after PostgreSQL confirms the save.
//   - If PostgreSQL fails, the table stays in Redis with postgresStatus: 'pending'
//     so the background worker (completedGameWorker.js) can retry.
//   - On server restart, pending completed tables are NOT deleted — they are
//     picked up by the background worker on the next interval.
//
// Key schema:   table:{tableId}
// TTL:          4 hours for active tables, 24 hours for pending completed tables
//
// Serialization notes:
//   - gameState.passedPlayers is a Set  → stored as Array, restored as Set
//   - table.rejoinNotifiedUserIds is a Set → stored as Array, restored as Set
//   - table.startedAt is a Date          → stored as ISO string, restored as Date

import { redis, isRedisAvailable } from './redis.js';
import logger from './lib/logger.js';

const TABLE_TTL_SECONDS = 4 * 60 * 60;           // 4 hours for active tables
const COMPLETED_TTL_SECONDS = 24 * 60 * 60;      // 24 hours for pending completed tables
const KEY_PREFIX = 'table:';

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeTable(table) {
  const clone = JSON.parse(JSON.stringify(table, (_key, value) => {
    if (value instanceof Set) {
      return { __type: 'Set', values: [...value] };
    }
    return value;
  }));
  return JSON.stringify(clone);
}

function deserializeTable(raw) {
  return JSON.parse(raw, (_key, value) => {
    if (value && typeof value === 'object' && value.__type === 'Set') {
      return new Set(value.values);
    }
    if (_key === 'startedAt' && typeof value === 'string') {
      return new Date(value);
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a table to Redis.
 * Fire-and-forget: errors are logged but never thrown.
 * Call this after every meaningful state change (move, disconnect, hand complete, etc.).
 *
 * For completed tables: stamps completedAt and postgresStatus: 'pending', saves
 * with a 24h TTL, and does NOT delete — the background worker handles deletion
 * after confirming the PostgreSQL write.
 *
 * @param {object} table - The live table object from the `tables` Map.
 */
export function saveTableToRedis(table) {
  if (!isRedisAvailable() || !redis || !table?.id) return;

  // Completed tables get a pending stamp and a longer TTL.
  // Do NOT delete them here — the background worker deletes after postgres confirms.
  if (table.status === 'completed') {
    if (!table.completedAt) {
      table.completedAt = Date.now();
    }
    if (!table.postgresStatus) {
      table.postgresStatus = 'pending';
    }

    let serialized;
    try {
      serialized = serializeTable(table);
    } catch (err) {
      logger.error(`[RedisCache] Failed to serialize completed table ${table.id}: ${err.message}`);
      return;
    }

    redis.set(KEY_PREFIX + table.id, serialized, 'EX', COMPLETED_TTL_SECONDS).catch((err) => {
      logger.error(`[RedisCache] Failed to save completed table ${table.id}: ${err.message}`);
    });
    return;
  }

  const key = KEY_PREFIX + table.id;
  let serialized;
  try {
    serialized = serializeTable(table);
  } catch (err) {
    logger.error(`[RedisCache] Failed to serialize table ${table.id}: ${err.message}`);
    return;
  }

  redis.set(key, serialized, 'EX', TABLE_TTL_SECONDS).catch((err) => {
    logger.error(`[RedisCache] Failed to save table ${table.id}: ${err.message}`);
  });
}

/**
 * Persist a table to Redis and wait for confirmation.
 * Use this when you need to guarantee Redis is saved before proceeding.
 * Only use for human-initiated moves (playMove handler) — AI/bot/slam moves
 * use the fire-and-forget saveTableToRedis to avoid unnecessary latency.
 *
 * @param {object} table - The live table object from the `tables` Map.
 */
export async function saveTableToRedisConfirmed(table) {
  if (!isRedisAvailable() || !redis || !table?.id) return;

  if (table.status === 'completed') {
    if (!table.completedAt) table.completedAt = Date.now();
    if (!table.postgresStatus) table.postgresStatus = 'pending';
    const serialized = serializeTable(table);
    await redis.set(KEY_PREFIX + table.id, serialized, 'EX', COMPLETED_TTL_SECONDS);
    return;
  }

  const serialized = serializeTable(table);
  await redis.set(KEY_PREFIX + table.id, serialized, 'EX', TABLE_TTL_SECONDS);
}

/**
 * Mark a completed table as saved in PostgreSQL and delete it from Redis.
 * Called by the background worker after a confirmed PostgreSQL write.
 * Fire-and-forget.
 *
 * @param {string} tableId
 */
export function markTableSavedAndDelete(tableId) {
  if (!isRedisAvailable() || !redis || !tableId) return;

  redis.del(KEY_PREFIX + tableId).catch((err) => {
    logger.error(`[RedisCache] Failed to delete saved table ${tableId}: ${err.message}`);
  });
}

/**
 * Remove a table from Redis immediately — for lobby deletions and cases
 * where no PostgreSQL write is needed (empty lobbies, etc.).
 * Fire-and-forget.
 *
 * @param {string} tableId
 */
export function deleteTableFromRedis(tableId) {
  if (!isRedisAvailable() || !redis || !tableId) return;

  redis.del(KEY_PREFIX + tableId).catch((err) => {
    logger.error(`[RedisCache] Failed to delete table ${tableId}: ${err.message}`);
  });
}

/**
 * On server start: load all table:* keys from Redis and restore them into
 * the in-memory `tables` Map and `activePlayers` Map.
 *
 * Restores:
 *   - status === 'playing'   → active game, restore fully
 *   - status === 'lobby'     → only private lobbies with at least one human
 *   - status === 'completed' + postgresStatus === 'pending' → left for background
 *                              worker to retry, NOT restored into tables Map
 *
 * @param {Map} tables        - The live in-memory tables Map from server.js
 * @param {Map} activePlayers - The live in-memory activePlayers Map from server.js
 */
export async function rehydrateTablesFromRedis(tables, activePlayers) {
  if (!isRedisAvailable() || !redis) {
    logger.info('[RedisCache] Redis not available — skipping rehydration');
    return;
  }

  let keys;
  try {
    keys = await redis.keys(KEY_PREFIX + '*');
  } catch (err) {
    logger.error(`[RedisCache] Failed to list table keys: ${err.message}`);
    return;
  }

  if (!keys || keys.length === 0) {
    logger.info('[RedisCache] No tables found in Redis — clean start');
    return;
  }

  logger.info(`[RedisCache] Found ${keys.length} table(s) in Redis — rehydrating`);

  let restored = 0;
  let skipped = 0;
  let pendingPostgres = 0;

  for (const key of keys) {
    let raw;
    try {
      raw = await redis.get(key);
    } catch (err) {
      logger.error(`[RedisCache] Failed to read key ${key}: ${err.message}`);
      skipped++;
      continue;
    }

    if (!raw) { skipped++; continue; }

    let table;
    try {
      table = deserializeTable(raw);
    } catch (err) {
      logger.error(`[RedisCache] Failed to deserialize key ${key}: ${err.message}`);
      skipped++;
      continue;
    }

    if (!table?.id) { skipped++; continue; }

    // Completed tables with pending postgres write — leave them for the
    // background worker. Do NOT delete and do NOT restore into tables Map.
    if (table.status === 'completed') {
      if (table.postgresStatus === 'pending') {
        pendingPostgres++;
        logger.info(`[RedisCache] Found pending postgres write for completed table ${table.id} — background worker will retry`);
      } else {
        // Completed and already saved — clean it up
        redis.del(key).catch(() => {});
        skipped++;
      }
      continue;
    }

    // Skip non-private lobbies with no humans (stale public lobby remnants)
    if (table.status === 'lobby') {
      const hasHumans = table.players?.some(p => p && !p.isAI);
      if (!hasHumans || table.type !== 'private') {
        redis.del(key).catch(() => {});
        skipped++;
        continue;
      }
    }

    // Restore into the in-memory Maps
    tables.set(table.id, table);

    if (table.players) {
      for (const player of table.players) {
        if (player && player.id && !player.isAI) {
          activePlayers.set(player.id, table.id);
        }
      }
    }

    restored++;
    logger.info(`[RedisCache] Restored table ${table.id} (status: ${table.status}, players: ${table.players?.filter(Boolean).length ?? 0})`);
  }

  logger.info(`[RedisCache] Rehydration complete — restored: ${restored}, pending postgres: ${pendingPostgres}, skipped: ${skipped}`);
}
