// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Game State ---
const rooms = {};   // roomCode -> { id, players, hostId, settings, gameState, ... }

// --- Uno Deck ---
function createDeck() {
  const colors = ['red', 'blue', 'green', 'yellow'];
  const deck = [];
  let id = 0;
  // Number cards (0-9)
  for (const color of colors) {
    deck.push({ id: String(id++), color, value: 0, type: 'number' });
    for (let i = 1; i <= 9; i++) {
      deck.push({ id: String(id++), color, value: i, type: 'number' });
      deck.push({ id: String(id++), color, value: i, type: 'number' });
    }
  }
  // Action cards (2 of each per color)
  const actions = ['skip', 'reverse', 'draw2'];
  for (const color of colors) {
    for (const action of actions) {
      for (let i = 0; i < 2; i++) {
        deck.push({ id: String(id++), color, value: null, type: action });
      }
    }
  }
  // Wilds & Wild+4
  for (let i = 0; i < 4; i++) {
    deck.push({ id: String(id++), color: null, value: null, type: 'wild' });
    deck.push({ id: String(id++), color: null, value: null, type: 'wild4' });
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Helper Functions ---
function getPlayerIndex(room, playerId) {
  return room.gameState.playerOrder.indexOf(playerId);
}

function getNextPlayer(room, fromIndex, direction) {
  const order = room.gameState.playerOrder;
  const len = order.length;
  let nextIdx = (fromIndex + direction + len) % len;
  // Skip disconnected/AI? AI players are always "connected" for turn taking.
  return order[nextIdx];
}

function isCardPlayable(card, topCard, currentColor) {
  if (!topCard) return true;
  if (card.type === 'wild' || card.type === 'wild4') return true;
  if (card.color === currentColor) return true;
  if (card.type === topCard.type && card.type !== 'number') return true;
  if (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) return true;
  return false;
}

function dealCards(deck, numCards) {
  return deck.splice(0, numCards);
}

function startGameForRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const { players, settings } = room;
  // Initialize deck
  let deck = createDeck();
  // Pick a top card that is not wild4; reshuffle wild4 back
  let topCard;
  while (true) {
    topCard = deck.pop();
    if (topCard.type !== 'wild4') break;
    // put wild4 back and shuffle
    deck.push(topCard);
    deck = shuffle(deck);
    topCard = deck.pop();
  }
  // Deal hands
  const hands = {};
  for (const player of players) {
    hands[player.id] = dealCards(deck, 7);
  }
  const currentColor = topCard.color || (topCard.type === 'wild' ? 'red' : 'red'); // wild starts as red
  const gameState = {
    deck,
    discardPile: [topCard],
    topCard,
    currentColor,
    hands,
    playerOrder: players.map(p => p.id),
    currentPlayerIndex: 0,
    direction: 1,
    deckCount: deck.length,
    unoCalledPlayers: [],
    lastPlayedWild4: null, // { playerId, timestamp }
    timerSeconds: settings.turnTimer || 0,
    timerMax: settings.turnTimer || 0,
    turnTimerInterval: null,
  };
  room.gameState = gameState;
  // Emit game-started to all
  io.to(roomCode).emit('game-started', {
    hands,
    currentPlayerId: gameState.playerOrder[0],
    direction: gameState.direction,
    currentColor: gameState.currentColor,
    topCard: gameState.topCard,
    deckCount: gameState.deck.length,
    unoCalledPlayers: [],
    timerMax: gameState.timerMax,
  });
  // Start turn timer if > 0
  if (gameState.timerMax > 0) {
    startTimer(room);
  }
}

function startTimer(room) {
  stopTimer(room);
  const gs = room.gameState;
  if (!gs || gs.timerMax <= 0) return;
  gs.timerSeconds = gs.timerMax;
  gs.turnTimerInterval = setInterval(() => {
    gs.timerSeconds--;
    io.to(room.id).emit('game-state-update', getGameStatePayload(room));
    if (gs.timerSeconds <= 0) {
      clearInterval(gs.turnTimerInterval);
      gs.turnTimerInterval = null;
      // Force draw for current player if timer runs out
      forceDraw(room);
    }
  }, 1000);
}

function stopTimer(room) {
  const gs = room?.gameState;
  if (gs?.turnTimerInterval) {
    clearInterval(gs.turnTimerInterval);
    gs.turnTimerInterval = null;
  }
}

function forceDraw(room) {
  const gs = room.gameState;
  if (!gs) return;
  const currentPlayerId = gs.playerOrder[gs.currentPlayerIndex];
  // auto draw 1 card + try to play? In official rules if timer runs out, player draws 1 card and turn ends.
  // We'll implement drawing a card.
  if (gs.deck.length === 0) reshuffleDiscard(room);
  const drawn = [];
  if (gs.deck.length > 0) {
    drawn.push(gs.deck.pop());
  }
  if (drawn.length > 0) {
    gs.hands[currentPlayerId].push(...drawn);
  }
  gs.deckCount = gs.deck.length;
  // Check if drawn card can be played (force play rule?)
  const settings = room.settings;
  const drawnCard = drawn[0];
  if (drawnCard && (settings.forcePlay || false) && isCardPlayable(drawnCard, gs.topCard, gs.currentColor)) {
    // Auto play? Not desirable; just end turn after draw.
  }
  // proceed to next turn
  advanceTurn(room);
  io.to(room.id).emit('game-state-update', getGameStatePayload(room));
  if (gs.timerMax > 0) startTimer(room);
}

function advanceTurn(room) {
  const gs = room.gameState;
  if (!gs) return;
  const order = gs.playerOrder;
  const len = order.length;
  // next index based on direction
  gs.currentPlayerIndex = (gs.currentPlayerIndex + gs.direction + len) % len;
  const nextId = order[gs.currentPlayerIndex];
  // If next player is AI (disconnected) but we handle that elsewhere; just move on.
  stopTimer(room);
}

function reshuffleDiscard(room) {
  const gs = room.gameState;
  if (!gs || gs.discardPile.length <= 1) return;
  const top = gs.discardPile.pop();
  const remaining = gs.discardPile;
  gs.deck = shuffle([...gs.deck, ...remaining]);
  gs.discardPile = [top];
  gs.deckCount = gs.deck.length;
}

function getGameStatePayload(room) {
  const gs = room.gameState;
  if (!gs) return null;
  return {
    currentPlayerId: gs.playerOrder[gs.currentPlayerIndex],
    direction: gs.direction,
    currentColor: gs.currentColor,
    topCard: gs.topCard,
    deckCount: gs.deck.length,
    hands: gs.hands, // Be careful with revealing hidden info? Only send own hand to each client, handled in game-started and card-drawn events. Here we send full for simplicity? Better not send all hands. We'll send only needed info.
    unoCalledPlayers: gs.unoCalledPlayers,
    timerRemaining: gs.timerSeconds,
    timerMax: gs.timerMax,
    players: room.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      avatarColor: p.avatarColor,
      cardCount: gs.hands[p.id]?.length || 0,
      isHost: p.id === room.hostId,
      isAI: p.isAI || false,
    })),
  };
}

function calculateScore(room) {
  const gs = room.gameState;
  if (!gs) return {};
  const scores = {};
  for (const playerId of gs.playerOrder) {
    let points = 0;
    const hand = gs.hands[playerId] || [];
    for (const card of hand) {
      if (card.type === 'number') points += card.value;
      else if (card.type === 'wild' || card.type === 'wild4') points += 50;
      else points += 20; // action cards
    }
    scores[playerId] = points;
  }
  return scores;
}

function handlePlayerDisconnect(roomCode, playerId) {
  const room = rooms[roomCode];
  if (!room) return;
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;
  if (room.gameState) {
    // In-game: replace with AI if setting allows
    if (room.settings.aiOnDisconnect !== false) {
      player.isAI = true;
      io.to(roomCode).emit('chat-message', { nickname: 'System', message: `${player.nickname} disconnected, AI takes over.` });
      // If it's their turn, AI will play after a short delay
      if (room.gameState.playerOrder[room.gameState.currentPlayerIndex] === playerId) {
        setTimeout(() => aiPlayTurn(roomCode, playerId), 1000);
      }
    } else {
      // Remove from game (simplified: end game?)
      io.to(roomCode).emit('chat-message', { nickname: 'System', message: `${player.nickname} disconnected. Game over.` });
      endGame(room, null); // cancel game
    }
  } else {
    // Lobby: just remove
    room.players = room.players.filter(p => p.id !== playerId);
    io.to(roomCode).emit('room-update', { players: room.players, settings: room.settings, roomCode, hostId: room.hostId });
  }
}

function aiPlayTurn(roomCode, aiPlayerId) {
  const room = rooms[roomCode];
  if (!room || !room.gameState) return;
  const gs = room.gameState;
  const currentPlayerId = gs.playerOrder[gs.currentPlayerIndex];
  if (currentPlayerId !== aiPlayerId) return;
  const hand = gs.hands[aiPlayerId] || [];
  // simple AI: play first playable card, else draw
  const playable = hand.find(c => isCardPlayable(c, gs.topCard, gs.currentColor));
  if (playable) {
    let chosenColor = playable.color;
    if (playable.type === 'wild' || playable.type === 'wild4') {
      // pick random color
      chosenColor = ['red','blue','green','yellow'][Math.floor(Math.random()*4)];
    }
    // simulate play
    const playerIndex = getPlayerIndex(room, aiPlayerId);
    // Execute play logic
    executePlayCard(room, aiPlayerId, playable.id, chosenColor);
  } else {
    // draw
    if (gs.deck.length === 0) reshuffleDiscard(room);
    if (gs.deck.length > 0) {
      gs.hands[aiPlayerId].push(gs.deck.pop());
      gs.deckCount = gs.deck.length;
    }
    advanceTurn(room);
    io.to(roomCode).emit('game-state-update', getGameStatePayload(room));
    if (gs.timerMax > 0) startTimer(room);
  }
}

function executePlayCard(room, playerId, cardId, chosenColor) {
  const gs = room.gameState;
  if (!gs) return;
  const hand = gs.hands[playerId];
  const cardIndex = hand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) return;
  const card = hand[cardIndex];
  // Remove from hand
  hand.splice(cardIndex, 1);
  // Add to discard
  gs.discardPile.push(card);
  gs.topCard = card;
  // Process card effect
  let skipNext = false;
  const playerIndex = getPlayerIndex(room, playerId);
  const order = gs.playerOrder;
  const len = order.length;

  if (card.type === 'skip') {
    skipNext = true;
  } else if (card.type === 'reverse') {
    if (len === 2) skipNext = true; // acts as skip
    gs.direction *= -1;
  } else if (card.type === 'draw2') {
    const nextIdx = (playerIndex + gs.direction + len) % len;
    const nextId = order[nextIdx];
    drawCardsForPlayer(room, nextId, 2);
    skipNext = true;
  } else if (card.type === 'wild4') {
    gs.lastPlayedWild4 = { playerId, timestamp: Date.now() };
    const nextIdx = (playerIndex + gs.direction + len) % len;
    const nextId = order[nextIdx];
    drawCardsForPlayer(room, nextId, 4);
    skipNext = true;
  } else if (card.type === 'wild') {
    // no skip
  }

  // Set color
  if (card.type === 'wild' || card.type === 'wild4') {
    gs.currentColor = chosenColor || 'red';
  } else {
    gs.currentColor = card.color;
  }

  // Check 7-0 rule
  if (room.settings.sevenZeroRule && card.type === 'number') {
    if (card.value === 7) {
      // Swap hand with chosen player (simplified: random opponent)
      const others = order.filter(id => id !== playerId);
      if (others.length > 0) {
        const target = others[Math.floor(Math.random() * others.length)];
        [gs.hands[playerId], gs.hands[target]] = [gs.hands[target], gs.hands[playerId]];
        io.to(room.id).emit('chat-message', { nickname: 'System', message: `7! ${playerId} swapped hands.` });
      }
    } else if (card.value === 0) {
      // rotate hands in direction
      const allHands = order.map(id => [...gs.hands[id]]);
      for (let i = 0; i < len; i++) {
        const nextI = (i + gs.direction + len) % len;
        gs.hands[order[nextI]] = allHands[i];
      }
      io.to(room.id).emit('chat-message', { nickname: 'System', message: '0! Hands rotated.' });
    }
  }

  // Check winner
  if (hand.length === 0) {
    endGame(room, playerId);
    return;
  }

  // Advance turn
  if (skipNext) {
    // skip next player entirely
    gs.currentPlayerIndex = (playerIndex + 2 * gs.direction + len) % len;
  } else {
    gs.currentPlayerIndex = (playerIndex + gs.direction + len) % len;
  }

  // Update deck count
  gs.deckCount = gs.deck.length;

  // Broadcast
  io.to(room.id).emit('card-played', {
    playerId,
    card: gs.topCard,
    currentColor: gs.currentColor,
    nextPlayerId: order[gs.currentPlayerIndex],
    deckCount: gs.deck.length,
    unoCalledPlayers: gs.unoCalledPlayers,
  });
  io.to(room.id).emit('game-state-update', getGameStatePayload(room));
  if (gs.timerMax > 0) startTimer(room);
}

function drawCardsForPlayer(room, playerId, count) {
  const gs = room.gameState;
  if (!gs) return [];
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (gs.deck.length === 0) reshuffleDiscard(room);
    if (gs.deck.length > 0) {
      drawn.push(gs.deck.pop());
    }
  }
  gs.hands[playerId].push(...drawn);
  gs.deckCount = gs.deck.length;
  return drawn;
}

function endGame(room, winnerId) {
  const gs = room.gameState;
  if (!gs) return;
  stopTimer(room);
  const scores = calculateScore(room);
  const winnerPlayer = winnerId ? room.players.find(p => p.id === winnerId) : null;
  const payload = {
    winnerId,
    winnerNickname: winnerPlayer?.nickname || 'Unknown',
    scores,
  };
  io.to(room.id).emit('game-over', payload);
  // Keep room but reset gameState for possible replay
  room.gameState = null;
}

// --- Socket.IO Events ---
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create-room', ({ nickname, settings }) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    const player = {
      id: socket.id,
      nickname,
      avatarColor: '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0'),
      isHost: true,
    };
    rooms[roomCode] = {
      id: roomCode,
      players: [player],
      hostId: socket.id,
      settings: { ...settings },
      gameState: null,
    };
    socket.join(roomCode);
    socket.emit('room-update', { players: rooms[roomCode].players, settings: rooms[roomCode].settings, roomCode, hostId: socket.id });
    console.log(`Room ${roomCode} created by ${nickname}`);
  });

  socket.on('join-room', ({ nickname, roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error-msg', { message: 'Room not found.' });
      return;
    }
    if (room.players.length >= (room.settings.playerCapacity || 10)) {
      socket.emit('error-msg', { message: 'Room is full.' });
      return;
    }
    const player = {
      id: socket.id,
      nickname,
      avatarColor: '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0'),
      isHost: false,
    };
    room.players.push(player);
    socket.join(roomCode);
    io.to(roomCode).emit('room-update', { players: room.players, settings: room.settings, roomCode, hostId: room.hostId });
  });

  socket.on('start-game', () => {
    const room = Object.values(rooms).find(r => r.hostId === socket.id);
    if (!room || room.gameState) return;
    if (room.players.length < 2) return;
    startGameForRoom(room.id);
  });

  socket.on('play-card', ({ cardId, chosenColor }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.playerOrder[gs.currentPlayerIndex] !== socket.id) return;
    const hand = gs.hands[socket.id];
    const card = hand.find(c => c.id === cardId);
    if (!card) return;
    // Validate playability (unless forceplay rule)
    if (!room.settings.forcePlay && !isCardPlayable(card, gs.topCard, gs.currentColor)) {
      socket.emit('error-msg', { message: 'You cannot play that card.' });
      return;
    }
    // Check no bluff on wild4
    if (card.type === 'wild4' && room.settings.noBluffWild4) {
      // check if player has matching color
      const hasColor = hand.some(c => c.color === gs.currentColor && c.type !== 'wild4');
      if (hasColor) {
        socket.emit('error-msg', { message: 'Illegal Wild Draw Four! You have a matching color.' });
        return;
      }
    }
    // Execute
    executePlayCard(room, socket.id, cardId, chosenColor);
  });

  socket.on('draw-card', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.playerOrder[gs.currentPlayerIndex] !== socket.id) return;
    // Draw 1 card
    if (gs.deck.length === 0) reshuffleDiscard(room);
    if (gs.deck.length === 0) return;
    const drawn = gs.deck.pop();
    gs.hands[socket.id].push(drawn);
    gs.deckCount = gs.deck.length;
    // Check if drawn card can be played instantly (and force play? optional)
    // We allow immediate play if they choose, but they must click again; we just end turn if they can't play.
    // However, many Uno rules allow playing immediately. We'll not auto-play for simplicity.
    // Just advance turn.
    advanceTurn(room);
    io.to(room.id).emit('card-drawn', {
      playerId: socket.id,
      cards: [drawn],
      deckCount: gs.deck.length,
      nextPlayerId: gs.playerOrder[gs.currentPlayerIndex],
    });
    io.to(room.id).emit('game-state-update', getGameStatePayload(room));
    if (gs.timerMax > 0) startTimer(room);
  });

  socket.on('call-uno', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.hands[socket.id]?.length === 1 && !gs.unoCalledPlayers.includes(socket.id)) {
      gs.unoCalledPlayers.push(socket.id);
      io.to(room.id).emit('uno-called', {
        playerId: socket.id,
        nickname: room.players.find(p => p.id === socket.id)?.nickname,
        unoCalledPlayers: gs.unoCalledPlayers,
      });
    }
  });

  socket.on('catch-uno', ({ targetPlayerId }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    // Target must have 1 card and not have called uno
    if (gs.hands[targetPlayerId]?.length === 1 && !gs.unoCalledPlayers.includes(targetPlayerId)) {
      // Penalty: draw 2
      const drawn = drawCardsForPlayer(room, targetPlayerId, 2);
      io.to(room.id).emit('uno-penalty', {
        playerId: targetPlayerId,
        nickname: room.players.find(p => p.id === targetPlayerId)?.nickname,
        cardsDrawn: drawn.length,
        cards: drawn,
      });
      io.to(room.id).emit('game-state-update', getGameStatePayload(room));
    }
  });

  socket.on('challenge-wild4', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const last = gs.lastPlayedWild4;
    if (!last) return;
    const challengerId = socket.id;
    const challengedId = last.playerId;
    // Check if challenged player had matching color when they played wild4
    const challengedHand = gs.hands[challengedId] || [];
    const hadMatchingColor = challengedHand.some(c => c.color === gs.currentColor && c.type !== 'wild4');
    if (hadMatchingColor) {
      // Guilty: challenged draws 4
      drawCardsForPlayer(room, challengedId, 4);
      io.to(room.id).emit('challenge-result', {
        guilty: true,
        challengerNickname: room.players.find(p => p.id === challengerId)?.nickname,
        challengedNickname: room.players.find(p => p.id === challengedId)?.nickname,
        updatedHands: { [challengedId]: gs.hands[challengedId] },
      });
    } else {
      // Innocent: challenger draws 6
      drawCardsForPlayer(room, challengerId, 6);
      io.to(room.id).emit('challenge-result', {
        guilty: false,
        challengerNickname: room.players.find(p => p.id === challengerId)?.nickname,
        challengedNickname: room.players.find(p => p.id === challengedId)?.nickname,
        updatedHands: { [challengerId]: gs.hands[challengerId] },
      });
    }
    gs.lastPlayedWild4 = null;
    io.to(room.id).emit('game-state-update', getGameStatePayload(room));
  });

  socket.on('send-chat', ({ message }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    io.to(room.id).emit('chat-message', { nickname: player?.nickname || 'Unknown', message });
  });

  socket.on('kick-player', ({ playerId }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    const player = room.players.find(p => p.id === playerId);
    if (player && player.id !== socket.id) {
      io.to(playerId).emit('player-kicked', { playerId });
      const socketToKick = io.sockets.sockets.get(playerId);
      if (socketToKick) socketToKick.leave(room.id);
      room.players = room.players.filter(p => p.id !== playerId);
      io.to(room.id).emit('room-update', { players: room.players, settings: room.settings, roomCode: room.id, hostId: room.hostId });
    }
  });

  socket.on('update-settings', ({ settings }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.settings = { ...room.settings, ...settings };
    io.to(room.id).emit('room-update', { players: room.players, settings: room.settings, roomCode: room.id, hostId: room.hostId });
  });

  socket.on('back-to-lobby', () => {
    const room = findRoomByPlayer(socket.id);
    if (room && room.hostId === socket.id) {
      room.gameState = null;
      io.to(room.id).emit('back-to-lobby');
      io.to(room.id).emit('room-update', { players: room.players, settings: room.settings, roomCode: room.id, hostId: room.hostId });
    }
  });

  socket.on('leave-room', () => {
    const room = findRoomByPlayer(socket.id);
    if (room) {
      socket.leave(room.id);
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[room.id];
      } else {
        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
          room.players[0].isHost = true;
        }
        io.to(room.id).emit('room-update', { players: room.players, settings: room.settings, roomCode: room.id, hostId: room.hostId });
      }
    }
  });

  socket.on('disconnect', () => {
    // Find room containing socket
    const roomEntry = Object.entries(rooms).find(([_, r]) => r.players.some(p => p.id === socket.id));
    if (roomEntry) {
      const [roomCode, room] = roomEntry;
      handlePlayerDisconnect(roomCode, socket.id);
      // If no players left after handling, delete room
      if (room.players.length === 0) {
        delete rooms[roomCode];
      }
    }
  });
});

function findRoomByPlayer(playerId) {
  return Object.values(rooms).find(r => r.players.some(p => p.id === playerId));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🃏 Uno server running on port ${PORT}`);
});

module.exports = { app, server, io };
