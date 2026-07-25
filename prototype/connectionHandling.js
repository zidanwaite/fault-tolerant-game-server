// connectionHandling.js
// Annotated excerpt showing how WebSocket connections are established,
// how player identity is attached to each socket, and how Socket.io
// rooms are used to group players by game table.
//
// This is not the full server — it shows the connection layer only.
 
// ---------------------------------------------------------------------------
// 1. CONNECTION — extract userId from JWT auth on every new socket
//    socket.data persists for the lifetime of the connection.
//    userId is the stable player identity — it survives reconnections.
//    socketId is ephemeral — it changes on every new connection.
// ---------------------------------------------------------------------------
 
io.on('connection', (socket) => {
  const auth = socket.handshake.auth || {};
 
  // Client type — used to select board layout profile (mobile vs desktop)
  socket.data.clientType = auth.clientType === 'mobile' ? 'mobile' : 'web';
 
  // userId from JWT auth — the stable player identity used for reconnection.
  // Anonymous players (no userId) cannot reconnect mid-game.
  socket.data.userId = (typeof auth.userId === 'string' && auth.userId.trim() !== '')
    ? auth.userId.trim()
    : undefined;
 
  // Client timezone offset — used by XP service to bucket daily streaks
  // by the player's local calendar day rather than UTC.
  const tzOffsetRaw = Number(auth.tzOffsetMinutes);
  socket.data.tzOffsetMinutes = Number.isFinite(tzOffsetRaw) ? tzOffsetRaw : 0;
});
 
// ---------------------------------------------------------------------------
// 2. ROOM JOINING — players join a Socket.io room when they join a table.
//    The room name is the tableId — the same ID used as the Redis key.
//    io.to(tableId).emit() delivers to every socket in that room.
// ---------------------------------------------------------------------------
 
socket.on('createTable', async (config, callback) => {
  const tableId = generateId('table');
 
  const table = {
    id: tableId,
    // ...
  };
 
  tables.set(tableId, table);
  activePlayers.set(socket.id, tableId);
 
  // Join the Socket.io room — creates the room if it doesn't exist yet.
  // Room name === tableId === Redis key suffix. One ID used everywhere.
  socket.join(tableId);
 
  // Save to Redis immediately — lobby state is durable from creation.
  saveTableToRedis(table);
 
  callback({ success: true, table });
});
 
socket.on('joinTable', async (inputTableId, callback) => {
  const table = tables.get(inputTableId);
 
  // ...validation...
 
  activePlayers.set(socket.id, tableId);
 
  // Player joins the same room — now io.to(tableId).emit() reaches them too.
  socket.join(tableId);
 
  // Notify everyone already in the room that a new player joined.
  // This is how the lobby updates in real time on all connected devices.
  io.to(tableId).emit('tableUpdated', table);
 
  callback({ success: true, table });
});
 
// ---------------------------------------------------------------------------
// 3. BROADCASTING — one call reaches all players in the room.
//    The server never needs to track individual socket IDs for broadcasting.
//    Socket.io handles delivery to every socket currently in the room.
// ---------------------------------------------------------------------------
 
// After a move is applied:
io.to(tableId).emit('movePlayed', {
  gameState: serializeGameState(table.gameState),
  move,
});
 
// After a hand completes:
io.to(tableId).emit('handComplete', result);
 
// After match is complete:
io.to(tableId).emit('matchComplete', {
  winner: result.winningTeam,
  finalScore: table.gameState.handsWon,
  ranked,
});
 
// After a player disconnects mid-game:
io.to(tableId).emit('playerDisconnected', {
  playerId: socket.id,
  playerName: player.name,
  action: 'reconnecting',
  gracePeriodMs: RECONNECT_GRACE_MS,
});
 
// ---------------------------------------------------------------------------
// 4. DISCONNECT — socket leaves all rooms automatically.
//    For registered players (have userId), a 10-minute grace period starts.
//    For anonymous players (no userId), the game is abandoned immediately.
//    activePlayers is NOT cleaned up during the grace period — it is used
//    by rejoinGame to locate the table on reconnect.
// ---------------------------------------------------------------------------
 
socket.on('disconnect', () => {
  const tableId = activePlayers.get(socket.id);
  const table = tables.get(tableId);
  const userId = socket.data.userId;
 
  if (table?.status === 'playing' && userId && !player.isAI) {
    // Registered player — start grace period, AI stand-in plays for them
    const gracePeriodTimer = setTimeout(() => {
      abandonGame(tableId, table, socket.id, player.name, 'playerTimeout');
    }, RECONNECT_GRACE_MS);
 
    disconnectedPlayers.set(userId, {
      tableId,
      playerId: socket.id,
      playerName: player.name,
      seat: player.seat,
      timer: gracePeriodTimer,
      disconnectedAt: Date.now(),
    });
 
    // Save disconnect state to Redis — survives a server restart
    saveTableToRedis(table);
 
    // Notify remaining players via the room
    io.to(tableId).emit('playerDisconnected', {
      playerId: socket.id,
      playerName: player.name,
      action: 'reconnecting',
      gracePeriodMs: RECONNECT_GRACE_MS,
    });
 
    // Socket has left the room automatically on disconnect.
    // activePlayers entry is intentionally kept so rejoinGame can find the table.
  } else {
    // Anonymous player or AI — no reconnection possible, abandon immediately
    abandonGame(tableId, table, socket.id, player.name);
    activePlayers.delete(socket.id);
  }
});
 
// ---------------------------------------------------------------------------
// 5. RECONNECTION — new socket, same userId, same game.
//    The room is rejoined with the new socket.
//    The old socket ID is swapped everywhere it appears in game state.
// ---------------------------------------------------------------------------
 
socket.on('rejoinGame', (callback) => {
  const userId = socket.data.userId;
  const dcInfo = disconnectedPlayers.get(userId);
 
  if (dcInfo) {
    const table = tables.get(dcInfo.tableId);
 
    // Cancel grace period and stand-in AI
    clearTimeout(dcInfo.timer);
    if (dcInfo.standInTimer) clearTimeout(dcInfo.standInTimer);
 
    // Swap old socket ID for new one everywhere it appears
    const oldId = dcInfo.playerId;
    table.players[playerIndex].id = socket.id;
    table.gameState.players.find(p => p.id === oldId).id = socket.id;
    table.gameState.hands[socket.id] = table.gameState.hands[oldId];
    delete table.gameState.hands[oldId];
 
    // Update tracking
    activePlayers.delete(oldId);
    activePlayers.set(socket.id, dcInfo.tableId);
 
    // Rejoin the Socket.io room with the new socket
    socket.join(dcInfo.tableId);
 
    // Persist the socket ID swap to Redis
    saveTableToRedis(table);
 
    // Send full current state directly to reconnecting player only (not via room)
    socket.emit('gameStateSync', serializeGameState(table.gameState));
 
    // Notify other players via the room
    io.to(dcInfo.tableId).emit('playerReconnected', {
      playerId: socket.id,
      playerName: dcInfo.playerName,
      seat: dcInfo.seat,
    });
 
    disconnectedPlayers.delete(userId);
    callback({ success: true });
  }
});
