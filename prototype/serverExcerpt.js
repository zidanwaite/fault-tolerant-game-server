// serverExcerpt.js
// Annotated excerpt from server.js showing the Redis wiring patterns.
// This is not the full server — it shows the key architectural decisions
// around game state persistence, move validation, and reconnection logic.
 
// ---------------------------------------------------------------------------
// 1. WRITE-THROUGH CACHE — save to memory first, then Redis
//    Every meaningful state change follows this pattern.
// ---------------------------------------------------------------------------
 
socket.on('playMove', (tableId, move, callback) => {
  withTableLock(tableId, async () => {
    const table = tables.get(tableId);
 
    // Validate move before touching any state
    if (move.stateVersion !== table.gameState.stateVersion) {
      callback({ success: false, error: 'Stale state — please retry' });
      return;
    }
    if (table.gameState.players.find(p => p.seat === table.gameState.currentTurn)?.id !== move.playerId) {
      callback({ success: false, error: 'Not your turn' });
      return;
    }
 
    // 1. Apply to memory (synchronous — guaranteed before callback fires)
    table.gameState = applyMove(table.gameState, move, layoutConfig);
 
    // 2. Await Redis confirmation before responding to player
    //    This guarantees the move is durable before the player sees success.
    //    AI/bot moves use fire-and-forget saveTableToRedis() to avoid latency.
    await saveTableToRedisConfirmed(table);
 
    // 3. Confirm to the player who moved (private — not broadcast)
    callback({ success: true });
 
    // 4. Broadcast new state to all 4 players in the Socket.io room
    io.to(tableId).emit('movePlayed', {
      gameState: serializeGameState(table.gameState),
      move,
    });
  });
});
 
// ---------------------------------------------------------------------------
// 2. RECONNECTION — identity confirmed via userId, not socket ID
//    Socket IDs are ephemeral. userId is the stable identity.
// ---------------------------------------------------------------------------
 
socket.on('rejoinGame', (callback) => {
  const userId = socket.data.userId;
 
  // Look up the disconnected player by userId
  const dcInfo = disconnectedPlayers.get(userId);
 
  if (dcInfo) {
    const table = tables.get(dcInfo.tableId);
 
    // Swap old socket ID for new one everywhere it appears
    const oldPlayerId = dcInfo.playerId;
    table.players[playerIndex].id = socket.id;
    table.gameState.players.find(p => p.id === oldPlayerId).id = socket.id;
    table.gameState.hands[socket.id] = table.gameState.hands[oldPlayerId];
    delete table.gameState.hands[oldPlayerId];
 
    // Update Redis with new socket ID
    saveTableToRedis(table);
 
    // Send full current state directly to reconnecting player (not via room)
    socket.emit('gameStateSync', serializeGameState(table.gameState));
 
    // Notify other players via room that someone reconnected
    io.to(dcInfo.tableId).emit('playerReconnected', {
      playerId: socket.id,
      playerName: dcInfo.playerName,
      seat: dcInfo.seat,
    });
  }
});
 
// ---------------------------------------------------------------------------
// 3. DISCONNECT GRACE PERIOD — AI stand-in plays while player is away
//    Game stays alive for 10 minutes. State saved to Redis on disconnect.
// ---------------------------------------------------------------------------
 
socket.on('disconnect', () => {
  const userId = socket.data.userId;
  const table = tables.get(activePlayers.get(socket.id));
 
  if (table?.status === 'playing' && userId && !player.isAI) {
    // Start 10 minute grace period
    const gracePeriodTimer = setTimeout(() => {
      // Grace expired — abandon the game
      abandonGame(tableId, table, socket.id, player.name, 'playerTimeout');
    }, RECONNECT_GRACE_MS);
 
    // Store disconnected player info so rejoinGame can find them
    disconnectedPlayers.set(userId, {
      tableId,
      playerId: socket.id,
      playerName: player.name,
      seat: player.seat,
      timer: gracePeriodTimer,
      disconnectedAt: Date.now(),
    });
 
    // Save to Redis — captures the disconnect state so it survives a restart
    saveTableToRedis(table);
 
    // AI stand-in begins playing for the disconnected player
    processStandInTurn(tableId, socket.id);
  }
});
 
// ---------------------------------------------------------------------------
// 4. GAME END — write permanent record to PostgreSQL, then delete from Redis
//    The completed game worker handles retries if PostgreSQL fails.
// ---------------------------------------------------------------------------
 
async function handleHandComplete(tableId) {
  const table = tables.get(tableId);
 
  if (handsWon[winningTeam] >= targetHands) {
    table.status = 'completed';
 
    // Write permanent record to PostgreSQL
    // saveTableToRedis detects completed status, stamps completedAt +
    // postgresStatus: 'pending', and saves with 24h TTL instead of deleting.
    // The completedGameWorker retries if this fails.
    await saveMatchReplay(table, null);
    await saveMatchMetrics(table, null);
    await processRankedGame(table, winningTeam);
 
    // Only delete from Redis after PostgreSQL confirms
    markTableSavedAndDelete(table.id);
  }
}
 
// ---------------------------------------------------------------------------
// 5. SERVER STARTUP — rehydrate active games from Redis before accepting connections
// ---------------------------------------------------------------------------
 
server.listen(port, hostname, async () => {
  // Restore in-progress games from Redis.
  // Players reconnect via rejoinGame and find their game still alive.
  await rehydrateTablesFromRedis(tables, activePlayers);
 
  // Start bot system after rehydration so bots don't fill already-active tables
  await initBotSystem();
 
  // Start background worker — retries failed PostgreSQL writes for completed games
  startCompletedGameWorker({ saveMatchReplay, saveMatchMetrics, isDbAvailable });
});
