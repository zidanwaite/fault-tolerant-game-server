// completedGameWorker.js
// Background worker that retries failed PostgreSQL writes for completed games.
//
// When a game ends, the table is saved to Redis with postgresStatus: 'pending'
// before attempting the PostgreSQL write. If the write fails, the table stays
// in Redis. This worker runs periodically, finds those pending tables, and
// retries the write. Only after PostgreSQL confirms the save does it delete
// the table from Redis.
//
// This ensures no game result is ever permanently lost due to a temporary
// PostgreSQL outage.

import { redis, isRedisAvailable } from './redis.js';
import { markTableSavedAndDelete } from './redisTableCache.js';
import logger from './lib/logger.js';

const KEY_PREFIX = 'table:';
const WORKER_INTERVAL_MS = 5 * 60 * 1000;  // check every 5 minutes
const MIN_AGE_BEFORE_RETRY_MS = 5 * 1000; // wait at least 60s before first retry

/**
 * Start the background worker.
 * Call this once on server startup, after initBotSystem.
 *
 * @param {object} deps
 * @param {Function} deps.saveMatchReplay   - from server.js
 * @param {Function} deps.saveMatchMetrics  - from server.js
 * @param {Function} deps.processRankedGame - from rankingService.js (optional)
 * @param {Function} deps.isDbAvailable     - from db/index.js
 */
export function startCompletedGameWorker({ saveMatchReplay, saveMatchMetrics, isDbAvailable }) {
  logger.info('[CompletedGameWorker] Started — checking every 5 minutes for pending postgres writes');

  setInterval(async () => {
    if (!isRedisAvailable() || !redis) return;
    if (!isDbAvailable()) {
      logger.warn('[CompletedGameWorker] Database not available — skipping retry pass');
      return;
    }

    let keys;
    try {
      keys = await redis.keys(KEY_PREFIX + '*');
    } catch (err) {
      logger.error(`[CompletedGameWorker] Failed to list keys: ${err.message}`);
      return;
    }

    if (!keys || keys.length === 0) return;

    let retried = 0;
    let saved = 0;
    let failed = 0;

    for (const key of keys) {
      let raw;
      try {
        raw = await redis.get(key);
      } catch (err) {
        logger.error(`[CompletedGameWorker] Failed to read ${key}: ${err.message}`);
        continue;
      }

      if (!raw) continue;

      let table;
      try {
        table = JSON.parse(raw, (_k, value) => {
          if (value && typeof value === 'object' && value.__type === 'Set') {
            return new Set(value.values);
          }
          if (_k === 'startedAt' && typeof value === 'string') {
            return new Date(value);
          }
          return value;
        });
      } catch (err) {
        logger.error(`[CompletedGameWorker] Failed to parse ${key}: ${err.message}`);
        continue;
      }

      // Only process completed tables with pending postgres writes
      if (table.status !== 'completed') continue;
      if (table.postgresStatus !== 'pending') continue;

      // Wait at least 60s before first retry — gives postgres time to recover
      const ageMs = Date.now() - (table.completedAt || 0);
      if (ageMs < MIN_AGE_BEFORE_RETRY_MS) continue;

      retried++;
      logger.info(`[CompletedGameWorker] Retrying postgres write for table ${table.id} (age: ${Math.round(ageMs / 1000)}s)`);

      try {
        await saveMatchReplay(table, null);
        await saveMatchMetrics(table, null);

        // PostgreSQL confirmed — now safe to delete from Redis
        markTableSavedAndDelete(table.id);
        saved++;
        logger.info(`[CompletedGameWorker] Successfully saved table ${table.id} to postgres — deleted from Redis`);
      } catch (err) {
        failed++;
        logger.error(`[CompletedGameWorker] Retry failed for table ${table.id}: ${err.message} — will retry next interval`);
      }
    }

    if (retried > 0) {
      logger.info(`[CompletedGameWorker] Pass complete — retried: ${retried}, saved: ${saved}, failed: ${failed}`);
    }
  }, WORKER_INTERVAL_MS);
}
