const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const LB = require('./leaderboard');

// ── Persistent leaderboard DB (loaded from disk, survives restarts) ──────────
const lbDB = LB.load();
console.log('[leaderboard] Loaded from disk:', JSON.stringify({ sol: lbDB.solitario.score.length, mus: lbDB.mus.partidas.length, caida: lbDB.caida.top.length, poker: lbDB.poker.top.length }));

const PORT = process.env.PORT || 3000;

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // JSON leaderboard endpoint (for arcade lobby)
  if (req.url === '/leaderboard.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(lbDB));
    return;
  }
  const routes = { '/': 'arcade.html', '/mus': 'mus.html', '/caida': 'caida.html', '/poker': 'poker.html', '/solitario': 'solitario.html', '/uno': 'uno.html', '/chinchon': 'chinchon.html' };
  const file = routes[req.url] || null;
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

// ─── SHARED ───────────────────────────────────────────────────────────────────
function sendTo(player, msg) {
  if (player.ws && player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}
function genCode(prefix, store) {
  let code;
  do { code = prefix + Math.random().toString(36).substring(2, 5).toUpperCase(); }
  while (store[code]);
  return code;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███ SOLITARIO — LEADERBOARD STORE (persistent via leaderboard.js)
// ═══════════════════════════════════════════════════════════════════════════════
// lbDB.solitario is loaded from disk — no more in-memory-only store


// ═══════════════════════════════════════════════════════════════════════════════
// ███ MUS
// ═══════════════════════════════════════════════════════════════════════════════
const musRooms = {};
// ─── GAME STATE ────────────────────────────────────────────────────────────────
const SUITS = ['oros', 'copas', 'espadas', 'bastos'];
const VALUES = [1, 3, 4, 5, 6, 7, 10, 11, 12]; // sin 2, 8 y 9

function makeDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const val of VALUES)
      deck.push({ suit, val, display: val <= 7 ? val : val === 10 ? '10-Sota' : val === 11 ? '11-Caballo' : '12-Rey' });
  return deck;
}

function musShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Valor de las cartas para el Mus
// Para grande/chica: rey=12, caballo=11, sota=10, 3,2,1,7,6,5,4 (orden descendente para grande)
// Para pares/juego: rey=caballo=sota=10, resto=valor
function musValue(card) {
  if (card.val >= 10) return 10;
  return card.val;
}

function handPoints(hand) {
  return hand.reduce((sum, c) => sum + musValue(c), 0);
}

// Orden para Grande (mayor es mejor): R>C>S>7>6>5>4>3>2>1
const GRANDE_ORDER = [12, 11, 10, 7, 6, 5, 4, 3, 2, 1];
function grandeRank(hand) {
  // Sort hand cards by grande order desc, compare lexicographically
  const sorted = [...hand].sort((a, b) => GRANDE_ORDER.indexOf(a.val) - GRANDE_ORDER.indexOf(b.val));
  return sorted.map(c => 100 - GRANDE_ORDER.indexOf(c.val));
}

// Orden para Chica (menor es mejor): 1>2>3>4>5>6>7>S>C>R
const CHICA_ORDER = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
function chicaRank(hand) {
  const sorted = [...hand].sort((a, b) => CHICA_ORDER.indexOf(a.val) - CHICA_ORDER.indexOf(b.val));
  return sorted.map(c => 100 - CHICA_ORDER.indexOf(c.val));
}

function compareRanks(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Devuelve el índice de jugador más cercano a la mano (en sentido horario desde manoIdx)
// entre los candidatos dados. Usa el índice del jugador en room.players.
function pickMano(candidateIndices, manoIdx, n) {
  n = n || 4;
  let best = null;
  let bestDist = Infinity;
  for (const idx of candidateIndices) {
    const dist = (idx - manoIdx + n) % n;
    if (dist < bestDist) { bestDist = dist; best = idx; }
  }
  return best;
}

// Jerarquía: Póker (4 iguales) > Duples (doble par) > Medias (3 iguales) > Par (2 iguales)
// Puntos:    Póker=7  |  Duples=3  |  Medias=2  |  Par=1
function pairesType(hand) {
  const counts = {};
  // Use card.val directly: K(12), Q(11), J(10) are distinct and only pair with themselves
  hand.forEach(c => { counts[c.val] = (counts[c.val] || 0) + 1; });
  const vals = Object.values(counts).sort((a, b) => b - a);
  if (vals[0] === 4)                    return { type: 'duples_cuatro', rank: 4, pts: 7 }; // póker
  if (vals[0] === 2 && vals[1] === 2)   return { type: 'duples',        rank: 3, pts: 3 }; // doble par
  if (vals[0] === 3)                    return { type: 'medias',         rank: 2, pts: 2 }; // trío
  if (vals[0] === 2)                    return { type: 'par',            rank: 1, pts: 1 }; // par
  return null;
}

function pairesRank(hand) {
  const p = pairesType(hand);
  if (!p) return null;
  const counts = {};
  hand.forEach(c => { counts[c.val] = (counts[c.val] || 0) + 1; });
  // Rank: [type_rank, highest_pair_val, second_pair_if_duples]
  const pairs = Object.entries(counts).filter(([, v]) => v >= 2).map(([k]) => parseInt(k)).sort((a, b) => b - a);
  return [p.rank, ...pairs];
}

// Juego: solo cuenta si tiene 31+ puntos
function juegoPoints(hand) {
  const pts = handPoints(hand);
  if (pts >= 31) return pts;
  return null;
}

// Ranking de juego: 31 > 32 > 40 > 39 > 38 > 37 > 36 > 35 > 34 > 33
// 31 = mejor (3 tantos), 32 = segundo, luego de mayor a menor: 40,39,...33
function juegoRank(hand) {
  const pts = juegoPoints(hand);
  if (pts === null) return null;
  if (pts === 31) return 100; // mejor
  if (pts === 32) return 99;  // segundo mejor
  // 40→98, 39→97, 38→96 ... 33→91
  return pts - 32 + 90; // 40→98, 39→97 ... 33→91 — todos < 99
}

// Puntos que vale ganar el juego (sin apuesta)
function juegoBasePoints(hand) {
  const pts = juegoPoints(hand);
  if (pts === null) return 0;
  return pts === 31 ? 3 : 2;
}

// Punto (cuando nadie tiene juego): gana el que tenga más puntos, máximo 30
// La mano desempata
function puntoPoints(hand) {
  return handPoints(hand); // sin límite, pero en la práctica ≤30 si nadie tiene juego
}

// ─── ROOM MANAGEMENT ──────────────────────────────────────────────────────────

function musCreateRoom(code, maxPlayers) {
  maxPlayers = maxPlayers === 2 ? 2 : 4;
  return {
    code,
    maxPlayers,
    players: [], // { id, ws, name, team, hand, ready }
    state: 'waiting', // waiting, dealing, mus, grande, chica, pares, juego, punto, show_hands, end
    deck: [],
    bets: {}, // { grande, chica, pares, juego }
    scores: [0, 0], // team 0, team 1
    round: 0,
    dealer: 0, // index of dealer player
    currentTurn: 0,
    musVotes: [],
    discardTurn: -1,
    discardDone: [],
    musVoteTurn: -1,
    paso: [],        // quién ha pasado en cada fase
    activeBet: null, // { phase, amount, team, responses }
    roundScores: [0, 0],
    ordago: false,
    musCount: 0,     // cuántas veces se ha pedido mus en este reparto
    discards: [],
    listoVotes: [],  // jugadores que han pulsado "Listo" al final del reparto
    roundLog: [],    // log de puntuaciones del reparto actual
    matchHistory: [], // historial de todos los repartos de la partida
    playerStats: {},  // { playerId: { musRequested, noMus, grande:{w,l}, chica:{w,l}, pares:{w,l}, juego:{w,l}, punto:{w,l}, ordagoLaunched, ordagoWon, ordagoLost, ordagoAccepted } }
    phase: null,
    phaseOrder: ['grande', 'chica', 'pares', 'juego'],
    phaseIndex: 0,
    betHistory: [],  // log for display
    mus: false,
  };
}

function musBroadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  });
}

function musSendTo(player, msg) {
  if (player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function musSendState(room) {
  room.players.forEach(p => {
    const state = musBuildStateFor(room, p);
    musSendTo(p, { type: 'state', state });
  });
}

function musBuildStateFor(room, player) {
  const eligible = getEligiblePlayers(room).map(e => e.i);
  const myIdx = room.players.indexOf(player);
  return {
    roomCode: room.code,
    gameState: room.state,
    phase: room.phase,
    maxPlayers: room.maxPlayers || 4,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      cardCount: p.hand ? p.hand.length : 0,
      isYou: p.id === player.id,
      hand: p.id === player.id ? p.hand : null,
      isEligible: eligible.includes(i),
    })),
    scores: room.scores,
    roundScores: room.roundScores,
    currentTurn: room.currentTurn,
    dealer: room.dealer,
    activeBet: room.activeBet ? { ...room.activeBet, noQuieroVotes: room.activeBet.noQuieroVotes || [] } : null,
    betHistory: room.betHistory ? room.betHistory.slice(-8) : [],
    musVotes: room.musVotes,
    musVoteTurn: room.musVoteTurn,
    paso: room.paso,
    ordago: room.ordago,
    round: room.round,
    myIdx,
    amEligible: eligible.includes(myIdx),
    manoIdx: (room.dealer + 1) % room.players.length,
    listoVotes: room.listoVotes || [],
    roundLog: room.roundLog || [],
    discardTurn: room.discardTurn,
  };
}

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────

function musDealCards(room) {
  // Devolver las cartas actuales de los jugadores a los descartes
  room.players.forEach(p => {
    if (p.hand && p.hand.length) {
      (room.discards || []).push(...p.hand);
      p.hand = [];
    }
  });

  // Juntar cartas disponibles: mazo restante + descartes
  const available = [...(room.deck || []), ...(room.discards || [])];

  // Si no hay suficientes cartas para repartir 4 a cada jugador, crear mazo nuevo
  if (available.length < room.players.length * 4) {
    room.deck = musShuffle(makeDeck());
  } else {
    room.deck = musShuffle(available);
  }
  room.discards = [];

  const np = room.players.length;
  room.players.forEach(p => { p.hand = room.deck.splice(0, 4); });
  room.musVotes = [];
  room.mus = false;
  room.musCount = 0;
  room.state = 'mus';
  room.phaseIndex = 0;
  room.phase = 'mus';
  room.activeBet = null;
  room.paso = [];
  room.betHistory = [];
  room.roundScores = [0, 0];
  room.roundLog = [];
  room.ordago = false;
  // Turn starts at player to the left of dealer (la mano)
  room.currentTurn = (room.dealer + 1) % room.players.length;
  room.musVoteTurn = (room.dealer + 1) % room.players.length; // mus voting starts from mano
  musBroadcast(room, { type: 'log', msg: `🃏 Reparto ${room.round + 1}. Dealer: ${room.players[room.dealer].name}` });
  musSendState(room);
}

function musNextPhase(room) {
  // Si estamos en punto, el siguiente paso es terminar el reparto
  if (room.phase === 'punto') {
    resolveRound(room);
    return;
  }
  room.phaseIndex++;
  if (room.phaseIndex >= room.phaseOrder.length) {
    resolveRound(room);
    return;
  }
  room.phase = room.phaseOrder[room.phaseIndex];
  room.activeBet = null;
  room.paso = [];
  room.currentTurn = (room.dealer + 1) % room.players.length;
  room.state = room.phase;
  musBroadcast(room, { type: 'log', msg: `📢 Fase: ${room.phase.toUpperCase()}` });
  musSendState(room);
  checkAutoSkip(room);
}

// Muestra un aviso a todos los jugadores y ejecuta callback tras 3 segundos
function announceAndDelay(room, msg, callback) {
  musBroadcast(room, { type: 'notice', msg });
  musBroadcast(room, { type: 'log', msg });
  setTimeout(callback, 5000);
}

// Registra un evento de puntuacion para el resumen del reparto
function musAddRoundLog(room, entry) {
  if (!room.roundLog) room.roundLog = [];
  room.roundLog.push(entry);
}

// Añade puntos a roundScores y guarda en log (la comprobación de victoria se hace al final en orden)
function addPointsAndCheckWin(room, team, pts, logEntry) {
  room.roundScores[team] += pts;
  if (logEntry) musAddRoundLog(room, logEntry);
  return false; // win check happens in resolveRound in phase order
}

// Track per-player stats for a phase result
function initStat(name) {
  return { name, musRequested:0, noMus:0, grande:{w:0,l:0}, chica:{w:0,l:0}, pares:{w:0,l:0}, juego:{w:0,l:0}, punto:{w:0,l:0}, ordagoLaunched:0, ordagoWon:0, ordagoLost:0, ordagoAccepted:0, betLaunched:0, betWon:0, betLost:0, hasPares:0, hasJuego:0 };
}
function ensureStat(room, p) {
  if (!room.playerStats) room.playerStats = {};
  if (!room.playerStats[p.id]) room.playerStats[p.id] = initStat(p.name);
  return room.playerStats[p.id];
}
function trackPhaseResult(room, phase, winnerTeam) {
  room.players.forEach(p => {
    const s = ensureStat(room, p);
    // Track hasPares/hasJuego when entering those phases
    if (phase === 'pares' && pairesType(p.hand)) s.hasPares++;
    if (phase === 'juego' && juegoPoints(p.hand) !== null) s.hasJuego++;
    if (s[phase]) {
      if (p.team === winnerTeam) s[phase].w++;
      else s[phase].l++;
    }
  });
}

function checkAutoSkip(room) {
  if (room.phase === 'pares') {
    const withPairs = room.players.filter(p => pairesType(p.hand));

    if (withPairs.length === 0) {
      announceAndDelay(room,
        '⏭️ Nadie tiene pares — se pasa directamente a Juego',
        () => musNextPhase(room)
      );
      return;
    }

    const teamsWithPairs = [...new Set(withPairs.map(p => p.team))];
    if (teamsWithPairs.length === 1) {
      const winnerTeam = teamsWithPairs[0];
      const pts = withPairs.reduce((s, p) => s + (pairesType(p.hand).pts || 1), 0);
      const names = withPairs.map(p => p.name + ' (' + pairesType(p.hand).type + ')').join(', ');
      const logPares = { phase: 'Pares', team: winnerTeam, pts, reason: `Solo Equipo ${winnerTeam+1} tiene pares (${names})` };
      if (addPointsAndCheckWin(room, winnerTeam, pts, logPares)) return;
      announceAndDelay(room,
        `✅ PARES: Se añaden fichas al final del reparto`,
        () => musNextPhase(room)
      );
      return;
    }

    // Ambos equipos tienen pares: ajustar turno al primer jugador con pares (desde mano)
    let startTurn = (room.dealer + 1) % room.players.length;
    for (let i = 0; i < room.players.length; i++) {
      const idx = (startTurn + i) % room.players.length;
      if (pairesType(room.players[idx].hand)) { room.currentTurn = idx; break; }
    }
    musSendState(room);
    return;
  }

  if (room.phase === 'juego') {
    const withJuego = room.players.filter(p => juegoPoints(p.hand) !== null);

    if (withJuego.length === 0) {
      announceAndDelay(room,
        '🎯 Nadie tiene juego (31+) — se jugará al Punto. Gana quien esté más cerca del 30',
        () => resolvePunto(room)
      );
      return;
    }

    const teamsWithJuego = [...new Set(withJuego.map(p => p.team))];
    if (teamsWithJuego.length === 1) {
      const winnerTeam = teamsWithJuego[0];
      const pts = withJuego.filter(p => p.team === winnerTeam)
        .reduce((s, p) => s + juegoBasePoints(p.hand), 0);
      const detail = withJuego.filter(p => p.team === winnerTeam)
        .map(p => `${p.name} (${handPoints(p.hand)} pts → ${juegoBasePoints(p.hand)} tanto)`).join(', ');
      const logJuego = { phase: 'Juego', team: winnerTeam, pts, reason: `Solo Equipo ${winnerTeam+1} tiene juego (${detail})` };
      if (addPointsAndCheckWin(room, winnerTeam, pts, logJuego)) return;
      announceAndDelay(room,
        `✅ JUEGO: Se añaden fichas al final del reparto`,
        () => musNextPhase(room)
      );
      return;
    }

    // Ambos equipos tienen juego: ajustar turno al primer jugador con juego (desde mano)
    let startTurn = (room.dealer + 1) % room.players.length;
    for (let i = 0; i < room.players.length; i++) {
      const idx = (startTurn + i) % room.players.length;
      if (juegoPoints(room.players[idx].hand) !== null) { room.currentTurn = idx; break; }
    }
    musSendState(room);
    return;
  }
}

// Evalúa el punto para comparar equipos (sin resolver aún)
function evaluatePunto(room) {
  const manoIdx = (room.dealer + 1) % room.players.length;
  const playerPuntos = room.players.map((p, i) => ({ team: p.team, pts: puntoPoints(p.hand), idx: i }));
  const teamBest = [0, 1].map(team => {
    const members = playerPuntos.filter(x => x.team === team);
    return Math.max(...members.map(x => x.pts));
  });
  let winnerTeam;
  if (teamBest[0] > teamBest[1]) winnerTeam = 0;
  else if (teamBest[1] > teamBest[0]) winnerTeam = 1;
  else {
    const manoPlayer = room.players[manoIdx];
    winnerTeam = manoPlayer.team;
    musBroadcast(room, { type: 'log', msg: `🤝 Empate en punto. La mano (${manoPlayer.name}) decide: Equipo ${winnerTeam+1}` });
  }
  return { winnerTeam, teamBest };
}

function resolvePuntoFinal(room, betAmount) {
  const { winnerTeam, teamBest } = evaluatePunto(room);
  const gain = betAmount || 1;
  const reason = betAmount
    ? `Equipo ${winnerTeam+1} gana el punto con apuesta de ${gain} (${teamBest[0]}pts vs ${teamBest[1]}pts)`
    : `Equipo ${winnerTeam+1} gana el punto sin apuesta (${teamBest[0]}pts vs ${teamBest[1]}pts)`;
  trackPhaseResult(room, 'punto', winnerTeam);
  musBroadcast(room, { type: 'log', msg: `🎯 Punto: Se añaden fichas al final del reparto` });
  addPointsAndCheckWin(room, winnerTeam, gain, { phase: 'Punto', team: winnerTeam, pts: gain, reason });
  resolveRound(room);
}

function resolvePunto(room) {
  // Iniciar la fase de apuestas del Punto (igual que grande/chica pero se resuelve con evaluatePunto)
  room.state = 'punto';
  room.phase = 'punto';
  room.activeBet = null;
  room.paso = [];
  room.currentTurn = (room.dealer + 1) % room.players.length;
  musBroadcast(room, { type: 'log', msg: '🎯 PUNTO — Nadie tiene juego, se apuesta al más cercano del 30' });
  musSendState(room);
}

function resolveRound(room) {
  // ── Sumar puntos EN ORDEN DE FASE: Grande → Chica → Pares → Juego/Punto → Órdago
  // Si un equipo llega a 25 durante esta suma, gana aunque el rival tuviera más puntos en fases posteriores
  const phaseOrder = ['Grande', 'Chica', 'Pares', 'Juego', 'Punto', 'Órdago'];
  const log = room.roundLog || [];

  // Agrupar puntos del roundLog por fase y equipo
  const byPhase = {};
  for (const entry of log) {
    if (!byPhase[entry.phase]) byPhase[entry.phase] = [0, 0];
    byPhase[entry.phase][entry.team] += entry.pts;
  }

  // Sumar en orden de fase, parando si alguien llega a 25
  let winnerTeam = null;
  for (const phase of phaseOrder) {
    if (!byPhase[phase]) continue;
    for (const team of [0, 1]) {
      if (byPhase[phase][team] > 0) {
        room.scores[team] += byPhase[phase][team];
        if (room.scores[team] >= 25 && winnerTeam === null) {
          winnerTeam = team; // primer equipo en cruzar 25
        }
      }
    }
    if (winnerTeam !== null) break; // parar, ya hay ganador
  }

  // Si ninguna fase cruzó 25, sumar lo que queda (no debería haber nada, pero por seguridad)
  if (winnerTeam === null) {
    // Verificar si hay ganador tras suma completa
    if (room.scores[0] >= 25 || room.scores[1] >= 25) {
      winnerTeam = room.scores[0] >= 25 ? 0 : 1;
    }
  }

  // Guardar reparto en historial
  if (!room.matchHistory) room.matchHistory = [];
  room.matchHistory.push({
    round: room.round + 1,
    roundScores: [...room.roundScores],
    scores: [...room.scores],
    roundLog: [...(room.roundLog || [])],
    hands: room.players.map(p => ({ name: p.name, team: p.team, hand: [...(p.hand || [])] })),
  });

  musBroadcast(room, { type: 'log', msg: `📊 Fin del reparto. Tantos: E1=${room.roundScores[0]} E2=${room.roundScores[1]}` });
  musBroadcast(room, { type: 'log', msg: `🏆 Marcador total: Equipo 1: ${room.scores[0]} | Equipo 2: ${room.scores[1]}` });

  // Check win
  if (winnerTeam !== null) {
    const winnerNum = winnerTeam + 1;
    const winnerNames = room.players.filter(p => p.team === winnerTeam).map(p => p.name).join(' & ');
    room.state = 'end';
    room.phase = 'end';
    room.listoNuevaPartida = [];
    musBroadcast(room, { type: 'log', msg: `🎉 ¡EQUIPO ${winnerNum} GANA LA PARTIDA! (${winnerNames})` });
    musBroadcast(room, { type: 'game_over', winnerTeam, winnerNum, winnerNames, scores: room.scores, matchHistory: room.matchHistory, playerStats: room.playerStats || {} });
    // Persist Mus result
    const musWinners = room.players.filter(p => p.team === winnerTeam).map(p => p.name);
    const musLosers  = room.players.filter(p => p.team !== winnerTeam).map(p => p.name);
    LB.musRecordWin(lbDB, musWinners, musLosers, room.scores[winnerTeam], room.scores[1 - winnerTeam]);
    musSendState(room);
    return;
  }

  // Show hands and wait for all players to press "Listo"
  room.state = 'show_hands';
  room.phase = 'show_hands';
  room.listoVotes = [];
  sendShowHands(room);
  musSendState(room);
}

function sendShowHands(room) {
  const handsInfo = room.players.map(p => ({ name: p.name, team: p.team, hand: p.hand }));
  musBroadcast(room, { type: 'show_hands', hands: handsInfo, roundLog: room.roundLog || [], roundScores: room.roundScores, playerStats: room.playerStats || {} });
  musSendState(room);
}

function evaluatePhase(room, phase) {
  // Determina ganadores y puntos para una fase, con mano como desempate
  const manoIdx = (room.dealer + 1) % room.players.length;
  let winnerTeam = null;
  let points = 0;

  // Helper: dado un array de {idx, team, rank[]}, devuelve el team ganador con mano como desempate
  function bestTeam(candidates) {
    if (!candidates.length) return null;
    let topRank = candidates[0].rank;
    candidates.forEach(c => { if (compareRanks(c.rank, topRank) > 0) topRank = c.rank; });
    const tied = candidates.filter(c => compareRanks(c.rank, topRank) === 0);
    if (tied.length === 1) return tied[0].team;
    // Desempate por mano: gana el jugador más cercano a la mano en sentido horario
    const winnerIdx = pickMano(tied.map(c => c.idx), manoIdx);
    return candidates.find(c => c.idx === winnerIdx).team;
  }

  if (phase === 'grande') {
    const candidates = room.players.map((p, i) => ({ idx: i, team: p.team, rank: grandeRank(p.hand) }));
    winnerTeam = bestTeam(candidates);
    points = 1;

  } else if (phase === 'chica') {
    const candidates = room.players.map((p, i) => ({ idx: i, team: p.team, rank: chicaRank(p.hand) }));
    winnerTeam = bestTeam(candidates);
    points = 1;

  } else if (phase === 'pares') {
    const candidates = room.players
      .map((p, i) => ({ idx: i, team: p.team, rank: pairesRank(p.hand) }))
      .filter(c => c.rank !== null);
    if (!candidates.length) return null;
    winnerTeam = bestTeam(candidates);
    const winnerPlayers = room.players.filter(p => p.team === winnerTeam && pairesType(p.hand));
    points = winnerPlayers.reduce((s, p) => s + (pairesType(p.hand).pts || 1), 0);

  } else if (phase === 'juego') {
    const candidates = room.players
      .map((p, i) => ({ idx: i, team: p.team, rank: [juegoRank(p.hand)], hand: p.hand }))
      .filter(c => c.rank[0] !== null);
    if (!candidates.length) return null;
    winnerTeam = bestTeam(candidates);
    // Puntos: el mejor jugador del equipo ganador determina los tantos (31→3, 32+→2)
    const winnerBest = candidates
      .filter(c => c.team === winnerTeam)
      .reduce((best, c) => compareRanks(c.rank, best.rank) > 0 ? c : best);
    points = juegoBasePoints(winnerBest.hand);
  }

  return { winnerTeam, points };
}

// Resuelve pares sumando SIEMPRE los puntos base de ambos equipos al ganador,
// más el importe apostado (si lo hubo) o 1 punto si fue rechazado/pasado
function resolveParesFinal(room, betAmount, rejectedByTeam, previousAmount) {
  // Determinar ganador por jerarquía de pares
  const candidates = room.players
    .map((p, i) => ({ idx: i, team: p.team, rank: pairesRank(p.hand) }))
    .filter(c => c.rank !== null);

  if (!candidates.length) return;

  const manoIdx = (room.dealer + 1) % room.players.length;
  function bestTeamPares(cands) {
    let topRank = cands[0].rank;
    cands.forEach(c => { if (compareRanks(c.rank, topRank) > 0) topRank = c.rank; });
    const tied = cands.filter(c => compareRanks(c.rank, topRank) === 0);
    if (tied.length === 1) return tied[0].team;
    const winnerIdx = pickMano(tied.map(c => c.idx), manoIdx);
    return cands.find(c => c.idx === winnerIdx).team;
  }
  const winnerTeam = bestTeamPares(candidates);

  // Solo se suman los puntos base del equipo GANADOR
  const winnerBasePts = room.players
    .filter(p => p.team === winnerTeam && pairesType(p.hand))
    .reduce((s, p) => s + (pairesType(p.hand).pts || 1), 0);

  // Puntos extra por apuesta
  let extraPts = 0;
  let reasonExtra = '';
  if (rejectedByTeam !== undefined) {
    // Apuesta rechazada: 1 punto extra al que apostó si era el ganador
    if (rejectedByTeam === winnerTeam) {
      extraPts = 1;
      reasonExtra = ' +1 por rechazo';
    }
  } else if (betAmount) {
    extraPts = betAmount;
    reasonExtra = ` +${betAmount} apostado`;
  }

  const total = winnerBasePts + extraPts;

  // Construir descripción detallada
  const detail = [0, 1].map(team => {
    const playersWithPairs = room.players.filter(p => p.team === team && pairesType(p.hand));
    if (!playersWithPairs.length) return null;
    const desc = playersWithPairs.map(p => {
      const pt = pairesType(p.hand);
      return `${p.name}: ${pt.type}(${pt.pts}pt)`;
    }).join(', ');
    return `E${team+1}[${desc}]`;
  }).filter(Boolean).join(' — ');

  const reason = `Equipo ${winnerTeam+1} gana pares: ${detail}${reasonExtra} = ${total} tanto(s)`;
  trackPhaseResult(room, 'pares', winnerTeam);
  if (addPointsAndCheckWin(room, winnerTeam, total, { phase: 'Pares', team: winnerTeam, pts: total, reason })) return;
  musBroadcast(room, { type: 'log', msg: `✅ PARES: Se añaden fichas al final del reparto` });
}

// Resuelve juego sumando SIEMPRE los puntos base de cada jugador del equipo ganador con juego,
// más lo apostado si hubo apuesta o +1 si fue rechazado
function resolveJuegoFinal(room, betAmount, rejectedByTeam, previousAmount) {
  const candidates = room.players
    .map((p, i) => ({ idx: i, team: p.team, rank: [juegoRank(p.hand)], hand: p.hand }))
    .filter(c => c.rank[0] !== null);
  if (!candidates.length) return;

  const manoIdx = (room.dealer + 1) % room.players.length;
  function bestTeamJuego(cands) {
    let topRank = cands[0].rank;
    cands.forEach(c => { if (compareRanks(c.rank, topRank) > 0) topRank = c.rank; });
    const tied = cands.filter(c => compareRanks(c.rank, topRank) === 0);
    if (tied.length === 1) return tied[0].team;
    const winnerIdx = pickMano(tied.map(c => c.idx), manoIdx);
    return cands.find(c => c.idx === winnerIdx).team;
  }
  const winnerTeam = bestTeamJuego(candidates);

  // Puntos base: suma de juegoBasePoints de cada jugador del equipo ganador con juego
  const winnerPlayers = room.players.filter(p => p.team === winnerTeam && juegoPoints(p.hand) !== null);
  const winnerBasePts = winnerPlayers.reduce((s, p) => s + juegoBasePoints(p.hand), 0);

  // Puntos extra por apuesta
  let extraPts = 0;
  let reasonExtra = '';
  if (rejectedByTeam !== undefined) {
    if (rejectedByTeam === winnerTeam) {
      extraPts = previousAmount || 1;
      reasonExtra = ` +${extraPts} por rechazo`;
    }
  } else if (betAmount) {
    extraPts = betAmount;
    reasonExtra = ` +${betAmount} apostado`;
  }

  const total = winnerBasePts + extraPts;

  const detail = winnerPlayers
    .map(p => `${p.name}: ${handPoints(p.hand)}pts→${juegoBasePoints(p.hand)}tanto`)
    .join(', ');
  const reason = `Equipo ${winnerTeam+1} gana juego: ${detail}${reasonExtra} = ${total} tanto(s)`;
  trackPhaseResult(room, 'juego', winnerTeam);
  if (addPointsAndCheckWin(room, winnerTeam, total, { phase: 'Juego', team: winnerTeam, pts: total, reason })) return;
  musBroadcast(room, { type: 'log', msg: `✅ JUEGO: Se añaden fichas al final del reparto` });
}

function resolveBet(room, phase, betAmount) {
  const result = evaluatePhase(room, phase);
  if (!result) return;
  const phaseName = phase.charAt(0).toUpperCase()+phase.slice(1);

  if (phase === 'pares') {
    // En pares: el ganador se lleva los puntos base de sus pares + lo apostado (o 1 si no hubo apuesta)
    // Además, si el equipo perdedor también tiene pares, sus puntos base también van al ganador
    const allWithPairs = room.players.filter(p => pairesType(p.hand));
    const basePts = allWithPairs.reduce((s, p) => s + (pairesType(p.hand).pts || 1), 0);
    const betPts = betAmount || 1;
    const total = basePts + (betAmount ? betPts - 1 : 0); // base always included, bet adds on top
    // Actually: base pts of winner team + bet gain
    const winnerBasePts = room.players
      .filter(p => p.team === result.winnerTeam && pairesType(p.hand))
      .reduce((s, p) => s + (pairesType(p.hand).pts || 1), 0);
    const loserBasePts = room.players
      .filter(p => p.team !== result.winnerTeam && pairesType(p.hand))
      .reduce((s, p) => s + (pairesType(p.hand).pts || 1), 0);
    const gain = winnerBasePts + loserBasePts + (betAmount ? betAmount - 1 : 0);
    trackPhaseResult(room, 'pares', result.winnerTeam);
    const reason = betAmount
      ? `Equipo ${result.winnerTeam+1} gana apuesta (${betAmount} enviados) + pares propios + pares rivales = ${gain} tanto(s)`
      : `Equipo ${result.winnerTeam+1} gana pares sin apuesta: ${gain} tanto(s)`;
    const logE = { phase: phaseName, team: result.winnerTeam, pts: gain, reason };
    musBroadcast(room, { type: 'log', msg: `✅ PARES: Se añaden fichas al final del reparto` });
    addPointsAndCheckWin(room, result.winnerTeam, gain, logE);
    return;
  }

  const gain = betAmount || result.points || 1;
  const reason = betAmount
    ? `Equipo ${result.winnerTeam+1} gana apuesta de ${gain} tanto(s)`
    : `Equipo ${result.winnerTeam+1} gana sin apuesta`;
  trackPhaseResult(room, phase, result.winnerTeam); // grande, chica, juego
  musBroadcast(room, { type: 'log', msg: `✅ ${phase.toUpperCase()}: Se añaden fichas al final del reparto` });
  addPointsAndCheckWin(room, result.winnerTeam, gain, { phase: phaseName, team: result.winnerTeam, pts: gain, reason });
}

// ─── BETTING LOGIC ─────────────────────────────────────────────────────────────
// Reglas de apuesta en Mus:
// - El equipo contrario debe RESPONDER INDIVIDUALMENTE: cada miembro dice quiero/no quiero
// - Si AL MENOS UNO del equipo contrario dice "quiero" → se acepta la apuesta
// - Solo si AMBOS dicen "no quiero" → se rechaza
// - En pares solo participan jugadores con pares; si un jugador no tiene pares no puede apostar

function getEligiblePlayers(room) {
  // Para pares: solo los que tienen pares. Para juego: solo los que tienen 31+. Para el resto: todos.
  if (room.phase === 'pares') {
    return room.players.map((p, i) => ({ p, i })).filter(({ p }) => pairesType(p.hand));
  }
  if (room.phase === 'juego') {
    return room.players.map((p, i) => ({ p, i })).filter(({ p }) => juegoPoints(p.hand) !== null);
  }
  return room.players.map((p, i) => ({ p, i }));
}

function getNextEligibleTurn(room, fromIdx) {
  const eligible = getEligiblePlayers(room).map(e => e.i);
  // Avanzar desde fromIdx, saltando pasados y no elegibles
  for (let t = 1; t <= room.players.length; t++) {
    const idx = (fromIdx + t) % room.players.length;
    if (eligible.includes(idx) && !room.paso.includes(idx)) return idx;
  }
  return -1; // todos han pasado o no hay más
}

function allEligiblePassed(room) {
  const eligible = getEligiblePlayers(room).map(e => e.i);
  return eligible.every(i => room.paso.includes(i));
}

function bothTeamsPassed(room) {
  // Verifica si ambos equipos (con jugadores elegibles) han pasado
  const eligible = getEligiblePlayers(room);
  for (const team of [0, 1]) {
    const teamEligible = eligible.filter(e => e.p.team === team);
    if (teamEligible.length === 0) continue; // no hay jugadores de este equipo elegibles
    const teamPassed = teamEligible.every(e => room.paso.includes(e.i));
    if (!teamPassed) return false;
  }
  return true;
}

function musHandleBetAction(room, playerId, action, amount) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;
  const pidx = room.players.indexOf(player);
  const phase = room.phase;

  // ── RESPUESTA A APUESTA ACTIVA (quiero/no quiero/subir) ──
  // Cualquier jugador del equipo contrario puede responder, no solo el del turno actual
  // En pares/juego: solo los elegibles (con pares / con juego 31+) pueden actuar
  if (room.activeBet && !room.activeBet.isOrdago) {
    const bet = room.activeBet;
    const isOpposingTeam = player.team !== bet.byTeam;

    // Verificar que el jugador es elegible para esta fase antes de permitirle actuar
    const eligibleNow = getEligiblePlayers(room).map(e => e.i);
    if (!eligibleNow.includes(pidx)) {
      musSendTo(player, { type: 'error', msg: 'No puedes participar en esta fase (no cumples las condiciones)' });
      return;
    }

    if (action === 'quiero' && isOpposingTeam) {
      musBroadcast(room, { type: 'log', msg: '✅ ' + player.name + ' acepta los ' + bet.amount + ' tantos en ' + phase.toUpperCase() });
      room.activeBet = null;
      if (phase === 'punto') {
        resolvePuntoFinal(room, bet.amount);
      } else if (phase === 'pares') {
        resolveParesFinal(room, bet.amount, undefined);
        musNextPhase(room);
      } else if (phase === 'juego') {
        resolveJuegoFinal(room, bet.amount, undefined);
        musNextPhase(room);
      } else {
        resolveBet(room, phase, bet.amount);
        musNextPhase(room);
      }
      return;
    }

    if (action === 'noQuiero' && isOpposingTeam) {
      // Registrar que este jugador dijo no quiero
      if (!bet.noQuieroVotes) bet.noQuieroVotes = [];
      if (!bet.noQuieroVotes.includes(pidx)) {
        bet.noQuieroVotes.push(pidx);
        musBroadcast(room, { type: 'log', msg: '❌ ' + player.name + ' no quiere' });
      }
      // Ver cuántos del equipo contrario son elegibles y cuántos han dicho no quiero
      const eligible = getEligiblePlayers(room);
      const opposingEligible = eligible.filter(e => e.p.team !== bet.byTeam);
      const allOpposingRefused = opposingEligible.every(e => bet.noQuieroVotes.includes(e.i));
      if (allOpposingRefused) {
        room.activeBet = null;
        if (phase === 'pares') {
          resolveParesFinal(room, null, bet.byTeam, bet.previousAmount);
          musNextPhase(room);
        } else if (phase === 'juego') {
          resolveJuegoFinal(room, null, bet.byTeam, bet.previousAmount);
          musNextPhase(room);
        } else if (phase === 'punto') {
          const gain = bet.previousAmount || 1;
          musBroadcast(room, { type: 'log', msg: 'Nadie quiso. Se añaden fichas al final del reparto.' });
          addPointsAndCheckWin(room, bet.byTeam, gain, { phase: 'Punto', team: bet.byTeam, pts: gain, reason: `Equipo ${bet.byTeam+1} gana ${gain} tanto(s) — rival rechazó` });
          resolveRound(room);
        } else {
          const gain = bet.previousAmount || 1;
          addPointsAndCheckWin(room, bet.byTeam, gain, { phase: phase.charAt(0).toUpperCase()+phase.slice(1), team: bet.byTeam, pts: gain, reason: `Equipo ${bet.byTeam+1} gana ${gain} tanto(s) — rival rechazó` });
          musBroadcast(room, { type: 'log', msg: 'Nadie quiso. Se añaden fichas al final del reparto.' });
          musNextPhase(room);
        }
      } else {
        // Queda el otro miembro del equipo por responder
        const pending = opposingEligible.filter(e => !bet.noQuieroVotes.includes(e.i));
        musBroadcast(room, { type: 'log', msg: 'Esperando respuesta de ' + pending.map(e => e.p.name).join(', ') + '...' });
        musSendState(room);
      }
      return;
    }

    // Subir la apuesta (solo el equipo contrario puede subir)
    if (action === 'envite' && isOpposingTeam) {
      const amt = parseInt(amount) || (bet.amount + 2);
      // previousAmount = lo que apostó el rival (si rechazan mi subida, ellos se llevan esto)
      room.activeBet = { phase, amount: amt, byTeam: player.team, byPlayer: player.name, noQuieroVotes: [], previousAmount: bet.amount };
      musBroadcast(room, { type: 'log', msg: '💰 ' + player.name + ' sube a ' + amt + ' tantos' });
      musSendState(room);
      return;
    }

    if (action === 'ordago' && isOpposingTeam) {
      room.ordago = true;
      // Si rechazan el ordago, el que lo lanzó se lleva lo que había apostado el rival antes
      room.activeBet = { phase, amount: 40, byTeam: player.team, byPlayer: player.name, isOrdago: true, noQuieroVotes: [], previousAmount: bet.amount };
      musBroadcast(room, { type: 'log', msg: '💥 ¡ÓRDAGO a la GRANDE! ' + player.name + ' lo juega todo' });
      musSendState(room);
      return;
    }
  }

  // ── RESPUESTA A ÓRDAGO ──
  if (room.activeBet && room.activeBet.isOrdago) {
    const bet = room.activeBet;
    const isOpposingTeam = player.team !== bet.byTeam;
    if (!isOpposingTeam) return;

    // Solo elegibles pueden responder al órdago en fases con condición
    const eligibleNow = getEligiblePlayers(room).map(e => e.i);
    if (!eligibleNow.includes(pidx)) {
      musSendTo(player, { type: 'error', msg: 'No puedes participar en esta fase (no cumples las condiciones)' });
      return;
    }

    if (action === 'ordagoQuiero') {
      musBroadcast(room, { type: 'log', msg: '🔥 ¡Órdago ACEPTADO por ' + player.name + '! Se juega todo' });
      // Track who accepted ordago
      ensureStat(room, player);
      room.playerStats[playerId].ordagoAccepted++;
      let winnerTeam;
      if (phase === 'punto') {
        const puntoResult = evaluatePunto(room);
        winnerTeam = puntoResult.winnerTeam;
      } else {
        const result = evaluatePhase(room, phase);
        winnerTeam = result ? result.winnerTeam : 0;
      }
      const winScore = 25 - room.scores[winnerTeam];
      room.roundScores[winnerTeam] += winScore;
      musAddRoundLog(room, { phase: 'Órdago', team: winnerTeam, pts: winScore, reason: `Equipo ${winnerTeam+1} gana el órdago en ${phase.toUpperCase()} — ¡partida ganada!` });
      // Track ordago won/lost for all players
      room.players.forEach(p => { const s = ensureStat(room, p); if (p.team === winnerTeam) s.ordagoWon++; else s.ordagoLost++; });
      musBroadcast(room, { type: 'log', msg: '🏆 Órdago aceptado — ¡se juega todo!' });
      resolveRound(room);
      return;
    }

    if (action === 'ordagoNoQuiero') {
      if (!bet.noQuieroVotes) bet.noQuieroVotes = [];
      if (!bet.noQuieroVotes.includes(pidx)) {
        bet.noQuieroVotes.push(pidx);
        musBroadcast(room, { type: 'log', msg: '❌ ' + player.name + ' rechaza el órdago' });
      }
      const eligible = getEligiblePlayers(room);
      const opposingEligible = eligible.filter(e => e.p.team !== bet.byTeam);
      const allRefused = opposingEligible.every(e => bet.noQuieroVotes.includes(e.i));
      if (allRefused) {
        // Órdago rechazado: 1 tanto al equipo que lo lanzó, y se sigue jugando
        if (phase === 'pares') {
          resolveParesFinal(room, null, bet.byTeam);
        } else if (phase === 'juego') {
          resolveJuegoFinal(room, null, bet.byTeam, bet.previousAmount);
        } else {
          const ordagoGain = bet.previousAmount || 1;
            addPointsAndCheckWin(room, bet.byTeam, ordagoGain, { phase: 'Órdago', team: bet.byTeam, pts: ordagoGain, reason: `Equipo ${bet.byTeam+1} lanzó órdago — rechazado, gana ${ordagoGain} tanto(s)` });
        }
        musBroadcast(room, { type: 'log', msg: 'Órdago rechazado. Se añaden fichas y continúa la partida.' });
        room.activeBet = null;
        room.ordago = false;
        musNextPhase(room);
      } else {
        const pending = opposingEligible.filter(e => !bet.noQuieroVotes.includes(e.i));
        musBroadcast(room, { type: 'log', msg: 'Esperando respuesta de ' + pending.map(e => e.p.name).join(', ') + '...' });
        musSendState(room);
      }
      return;
    }
  }

  // ── TURNO NORMAL (sin apuesta activa) ──
  // Solo puede actuar el jugador en turno, y solo si es elegible
  const eligible = getEligiblePlayers(room).map(e => e.i);
  if (!eligible.includes(pidx)) {
    musSendTo(player, { type: 'error', msg: 'No tienes pares en esta fase' });
    return;
  }
  if (pidx !== room.currentTurn) {
    musSendTo(player, { type: 'error', msg: 'No es tu turno' });
    return;
  }

  if (action === 'paso') {
    room.paso.push(pidx);
    musBroadcast(room, { type: 'log', msg: player.name + ' pasa en ' + phase });

    if (bothTeamsPassed(room) || allEligiblePassed(room)) {
      if (phase === 'punto') {
        resolvePuntoFinal(room, null);
      } else if (phase === 'pares') {
        resolveParesFinal(room, null, undefined);
        musNextPhase(room);
      } else if (phase === 'juego') {
        resolveJuegoFinal(room, null, undefined);
        musNextPhase(room);
      } else {
        resolveBet(room, phase, null);
        musNextPhase(room);
      }
      return;
    }

    const next = getNextEligibleTurn(room, pidx);
    if (next === -1) {
      if (phase === 'punto') {
        resolvePuntoFinal(room, null);
      } else if (phase === 'pares') {
        resolveParesFinal(room, null, undefined);
        musNextPhase(room);
      } else if (phase === 'juego') {
        resolveJuegoFinal(room, null, undefined);
        musNextPhase(room);
      } else {
        resolveBet(room, phase, null);
        musNextPhase(room);
      }
      return;
    }
    room.currentTurn = next;
    musSendState(room);
    return;
  }

  if (action === 'envite') {
    const amt = parseInt(amount) || 2;
    // Sin apuesta previa: si rechazan, el apostador gana 1 (previousAmount=1)
    room.activeBet = { phase, amount: amt, byTeam: player.team, byPlayer: player.name, noQuieroVotes: [], previousAmount: 1 };
    ensureStat(room, player); room.playerStats[playerId].betLaunched++;
    musBroadcast(room, { type: 'log', msg: '💰 ' + player.name + ' envida ' + amt + ' en ' + phase.toUpperCase() });
    musSendState(room);
    return;
  }

  if (action === 'ordago') {
    room.ordago = true;
    room.activeBet = { phase, amount: 40, byTeam: player.team, byPlayer: player.name, isOrdago: true, noQuieroVotes: [], previousAmount: 1 };
    // Track ordago launched
    ensureStat(room, player);
    room.playerStats[playerId].ordagoLaunched++;
    musBroadcast(room, { type: 'log', msg: '💥 ¡ÓRDAGO a la GRANDE! ' + player.name + ' lo juega todo' });
    musSendState(room);
    return;
  }
}

// ─── WEBSOCKET SERVER ─────────────────────────────────────────────────────────
function musStartGame(room) {
  room.state = 'playing';
  room.dealer = 0;
  room.round = 0;
  room.scores = [0, 0];
  musBroadcast(room, { type: 'log', msg: '🎮 ¡Comienza la partida de Mus a 25 tantos!' });
  musDealCards(room);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███ CAÍDA
// ═══════════════════════════════════════════════════════════════════════════════
const caidaRooms = {};
// ─── DECK ─────────────────────────────────────────────────────────────────────
const CAIDA_SUITS = ['oros', 'copas', 'espadas', 'bastos'];
const CAIDA_VALUES = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];

function makeCard(suit, val) {
  const display = val === 10 ? '10-Sota' : val === 11 ? '11-Caballo' : val === 12 ? '12-Rey' : String(val);
  return { suit, val, display };
}
function caidaMakeDeck() {
  const d = [];
  for (const s of CAIDA_SUITS) for (const v of CAIDA_VALUES) d.push(makeCard(s, v));
  return d;
}
function caidaShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isFigure(val) { return val >= 10; }

function caídaPoints(val) {
  if (val <= 7) return 1;
  if (val === 10) return 2;
  if (val === 11) return 3;
  if (val === 12) return 4;
  return 1;
}

function areConsecutive(vals) {
  if (vals.length < 2) return false;
  const s = [...vals].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1] + 1) return false;
  return true;
}

// ─── CANTOS ───────────────────────────────────────────────────────────────────
// Ronda:    2 iguales + 1 NO adyacente al par
// Vigía:    2 iguales + 1 adyacente al par (±1)
// Patrulla: 3 distintos consecutivos
// Tibilín:  3 iguales → gana reparto
function analyzeCantos(hand) {
  if (!hand || hand.length < 3) return null;
  const vals = hand.map(c => c.val);
  const counts = {};
  vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const entries = Object.entries(counts).map(([k, v]) => ({ val: parseInt(k), cnt: v }));
  const maxCnt = Math.max(...entries.map(e => e.cnt));

  if (maxCnt === 3) {
    const v = entries.find(e => e.cnt === 3).val;
    return { type: 'tibilin', rank: 100, pts: 0, val: v, desc: `Tibilín de ${v}` };
  }
  if (maxCnt === 2) {
    const pairVal = entries.find(e => e.cnt === 2).val;
    const singleVal = entries.find(e => e.cnt === 1).val;
    if (Math.abs(pairVal - singleVal) === 1)
      return { type: 'vigia', rank: 3, pts: 7, val: pairVal, desc: `Vigía de ${pairVal}` };
    const pts = isFigure(pairVal) ? caídaPoints(pairVal) : 1;
    return { type: 'ronda', rank: 1, pts, val: pairVal, desc: `Ronda de ${pairVal}` };
  }
  if (areConsecutive(vals))
    return { type: 'patrulla', rank: 2, pts: 6, val: Math.max(...vals), desc: `Patrulla ${Math.min(...vals)}-${Math.max(...vals)}` };
  return null;
}

function compareCantos(a, b) {
  if (!a && !b) return 0; if (!a) return -1; if (!b) return 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.val - b.val;
}

// ─── ROOMS ────────────────────────────────────────────────────────────────────

function caidaCreateRoom(code, maxPlayers) {
  maxPlayers = [2, 3, 4].includes(maxPlayers) ? maxPlayers : 4;
  return {
    code, maxPlayers,
    players: [],
    state: 'waiting',
    deck: [],
    tableCards: [],
    round: 0,
    dealer: 0,
    currentTurn: 0,
    // FIX: lastPlayedCard tracks the card as played to the TABLE (not collected)
    // Only cards left on table count for caída detection
    lastPlayedCard: null,
    lastPlayedBy: -1,
    lastCollectorIdx: -1,
    isLastTanda: false,
    scores: [],
    teamMode: false,
    puestoState: 'choosing',
    puestoDirection: null,
    puestoTargets: [],
    puestoTargetIdx: 0,
    puestoTarget: null,
    puestoRevealed: [],
    puestoResult: null,
    cantosDone: false,
    cantoResults: [],
    pendingCantoLog: [],
    roundLog: [],
    readyForNext: [],
  };
}

function caidaBroadcast(room, msg) {
  room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); });
}
function caidaSendTo(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function caidaAddLog(room, msg) { caidaBroadcast(room, { type: 'log', msg }); }
function caidaAddRoundLog(room, entry) { room.roundLog.push(entry); }

// ─── STATE ────────────────────────────────────────────────────────────────────
function caidaBuildStateFor(room, player) {
  const myIdx = room.players.indexOf(player);
  return {
    roomCode: room.code, maxPlayers: room.maxPlayers,
    gameState: room.state, teamMode: room.teamMode,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, team: p.team,
      cardCount: p.hand ? p.hand.length : 0,
      collectedCount: p.collected ? p.collected.length : 0,
      isYou: p.id === player.id,
      hand: p.id === player.id ? p.hand : null,
      hasCanto: !!(p.canto),
      cantoType: p.canto ? p.canto.type : null,
      myCanto: p.id === player.id ? (p.canto || null) : null,
    })),
    tableCards: room.tableCards,
    scores: room.scores,
    currentTurn: room.currentTurn,
    dealer: room.dealer,
    manoIdx: room.players.length > 0 ? (room.dealer + 1) % room.players.length : 0,
    lastPlayedCard: room.lastPlayedCard,
    lastPlayedBy: room.lastPlayedBy,
    myIdx,
    cantosDone: room.cantosDone,
    cantoResults: room.cantoResults || [],
    puestoState: room.puestoState,
    puestoDirection: room.puestoDirection,
    puestoTarget: room.puestoTarget,
    puestoRevealed: room.puestoRevealed || [],
    puestoResult: room.puestoResult,
    round: room.round,
    cardsInDeck: room.deck.length,
    isLastTanda: room.isLastTanda,
  };
}
function caidaSendState(room) {
  room.players.forEach(p => caidaSendTo(p, { type: 'state', state: caidaBuildStateFor(room, p) }));
}

// ─── GAME START ───────────────────────────────────────────────────────────────
function caidaStartGame(room) {
  const n = room.players.length;
  room.teamMode = n === 4;
  room.players.forEach((p, i) => { p.team = room.teamMode ? i % 2 : i; p.collected = []; p.canto = null; });
  room.scores = room.players.map(() => 0);
  room.round = 0; room.dealer = 0;
  caidaAddLog(room, `🎮 ¡Comienza la Caída! ${n} jugadores`);
  caidaDealRound(room);
}

// ─── DEAL ROUND ───────────────────────────────────────────────────────────────
function caidaDealRound(room) {
  room.deck = caidaShuffle(caidaMakeDeck());
  room.tableCards = [];
  room.lastPlayedCard = null; room.lastPlayedBy = -1; room.lastCollectorIdx = -1;
  room.isLastTanda = false;
  room.cantosDone = false; room.cantoResults = []; room.pendingCantoLog = [];
  room.roundLog = []; room.readyForNext = [];
  room.puestoState = 'choosing'; room.puestoDirection = null;
  room.puestoTarget = null; room.puestoRevealed = []; room.puestoResult = null;
  room.players.forEach(p => { p.hand = []; p.collected = []; p.canto = null; });

  caidaAddLog(room, `🃏 Reparto ${room.round + 1} — Repartidor: ${room.players[room.dealer].name}`);
  room.state = 'puesto_choosing';
  caidaSendState(room);
  caidaBroadcast(room, { type: 'puesto_choose', dealerIdx: room.dealer, dealerName: room.players[room.dealer].name });
}

// ─── PUESTO ───────────────────────────────────────────────────────────────────
function caidaStartPuesto(room, direction) {
  room.puestoDirection = direction;
  room.puestoRevealed = [];
  room.puestoState = 'revealing';
  room.puestoTargets = direction === 'asc' ? [1, 2, 3, 4] : [4, 3, 2, 1];
  room.puestoTargetIdx = 0;
  room.puestoTarget = room.puestoTargets[0];
  caidaAddLog(room, `🎯 Puesto ${direction === 'asc' ? '1→4' : '4→1'} — buscando el ${room.puestoTarget}...`);
  caidaSendState(room);
  setTimeout(() => caidaRevealNextPuestoCard(room), 800);
}

function caidaRevealNextPuestoCard(room) {
  if (room.deck.length === 0) { caidaFinishPuesto(room, false, 'nodeck'); return; }

  // Draw a card, but skip if this value already appeared in revealed cards
  // (can't have repeated values in the puesto display)
  let card = null;
  let attempts = 0;
  while (room.deck.length > 0 && attempts < 40) {
    const candidate = room.deck.splice(0, 1)[0];
    const alreadySeen = room.puestoRevealed.some(c => c.val === candidate.val);
    if (!alreadySeen) {
      card = candidate;
      break;
    }
    // Put it at the bottom of the deck and try next
    room.deck.push(candidate);
    attempts++;
  }

  // If all remaining cards have repeated values → dealer loses puesto
  if (!card) {
    caidaAddLog(room, `⚠️ No quedan cartas sin repetir — repartidor pierde el puesto`);
    room.tableCards = [...room.puestoRevealed];
    setTimeout(() => caidaFinishPuesto(room, false, 'noUnique'), 800);
    return;
  }

  room.puestoRevealed.push(card);
  const target = room.puestoTarget;
  const ordinals = ['primera', 'segunda', 'tercera', 'cuarta'];
  const ordinal = ordinals[room.puestoTargetIdx] || `${room.puestoTargetIdx+1}ª`;

  caidaAddLog(room, `  ${ordinal} carta: ${card.display} de ${card.suit} (buscando ${target})`);
  caidaBroadcast(room, { type: 'puesto_card_revealed', card, target, revealed: room.puestoRevealed });
  caidaSendState(room);

  if (card.val === target) {
    // Score = sum of ALL values in puestoTargets up to and including current position
    const pts = room.puestoTargets.slice(0, room.puestoTargetIdx + 1).reduce((s, v) => s + v, 0);
    room.scores[room.dealer] += pts;
    caidaAddRoundLog(room, { event: 'Puesto', player: room.players[room.dealer].name, pts, detail: `${card.display} = ${target}` });
    caidaAddLog(room, `✅ ¡PUESTO! La ${ordinal} carta es ${target} — +${pts} pts para ${room.players[room.dealer].name}`);
    room.tableCards = [...room.puestoRevealed];
    setTimeout(() => caidaFinishPuesto(room, true, 'hit'), 800);
  } else {
    room.puestoTargetIdx++;
    if (room.puestoTargetIdx >= room.puestoTargets.length) {
      const manoIdx = (room.dealer + 1) % room.players.length;
      room.scores[manoIdx] += 1;
      caidaAddRoundLog(room, { event: 'Puesto fallido', player: room.players[manoIdx].name, pts: 1, detail: 'Sin acertar' });
      caidaAddLog(room, `❌ Puesto fallido — +1 para la mano (${room.players[manoIdx].name})`);
      room.tableCards = [...room.puestoRevealed];
      setTimeout(() => caidaFinishPuesto(room, false, 'miss'), 800);
    } else {
      room.puestoTarget = room.puestoTargets[room.puestoTargetIdx];
      caidaAddLog(room, `  ↳ No es ${target}, buscando el ${room.puestoTarget}...`);
      caidaSendState(room);
      setTimeout(() => caidaRevealNextPuestoCard(room), 1200);
    }
  }
}

function caidaFinishPuesto(room, hit, reason) {
  room.puestoState = 'done';
  // Fill table to 4 cards, ensuring no repeated values
  while (room.tableCards.length < 4 && room.deck.length > 0) {
    const existingVals = new Set(room.tableCards.map(c => c.val));
    // Find next card with unique value
    let found = false;
    for (let i = 0; i < room.deck.length; i++) {
      if (!existingVals.has(room.deck[i].val)) {
        room.tableCards.push(room.deck.splice(i, 1)[0]);
        found = true;
        break;
      }
    }
    if (!found) break; // all remaining cards have repeated values, stop
  }
  room.puestoResult = { hit, direction: room.puestoDirection, reason };
  const ordinals = ['primera', 'segunda', 'tercera', 'cuarta'];
  const tableLog = room.tableCards.map((c, i) => `${ordinals[i]||i+1}: ${c.display}`).join(', ');
  caidaAddLog(room, `🃏 Mesa: ${tableLog}`);
  caidaSendState(room);
  setTimeout(() => caidaDealTanda(room), 1200);
}

// ─── TANDA ────────────────────────────────────────────────────────────────────
function caidaDealTanda(room) {
  const n = room.players.length;

  // Reveal pending canto results from previous tanda
  if (room.pendingCantoLog && room.pendingCantoLog.length > 0) {
    caidaAddLog(room, `🎺 Cantos del turno anterior:`);
    room.pendingCantoLog.forEach(l => caidaAddLog(room, l));
    room.pendingCantoLog = [];
  }

  room.isLastTanda = room.deck.length < n * 3;

  room.players.forEach(p => {
    p.canto = null;
    p.hand = room.deck.splice(0, Math.min(3, room.deck.length));
  });

  if (n === 3 && room.deck.length === 1) {
    room.players[room.dealer].hand.push(room.deck.pop());
    caidaAddLog(room, `🃏 Carta sobrante al repartidor`);
  }

  room.players.forEach(p => { p.canto = p.hand.length >= 3 ? analyzeCantos(p.hand) : null; });
  room.cantosDone = false; room.cantoResults = [];
  // FIX: Reset last played card between tandas so caída doesn't carry over
  room.lastPlayedCard = null; room.lastPlayedBy = -1;
  room.state = 'cantos';
  room.currentTurn = (room.dealer + 1) % n;

  if (room.players.every(p => p.hand.length === 0)) { caidaEndRound(room); return; }

  caidaAddLog(room, `🃏 Tanda${room.isLastTanda ? ' final' : ''} repartida`);
  caidaSendState(room);
  caidaResolveCantos(room);
}

// ─── CANTOS ───────────────────────────────────────────────────────────────────
function caidaResolveCantos(room) {
  const n = room.players.length;
  const manoIdx = (room.dealer + 1) % n;
  const withCanto = room.players.map((p, i) => ({ p, i, canto: p.canto })).filter(x => x.canto);

  if (withCanto.length === 0) {
    room.cantosDone = true; room.state = 'playing';
    caidaAddLog(room, '▶️ Sin cantos — ¡a jugar!');
    caidaSendState(room); return;
  }

  const tibilines = withCanto.filter(x => x.canto.type === 'tibilin');
  if (tibilines.length > 0) {
    const winner = tibilines.reduce((b, c) => ((c.i - manoIdx + n) % n) < ((b.i - manoIdx + n) % n) ? c : b);
    room.scores[winner.i] += 10;
    caidaAddRoundLog(room, { event: 'Tibilín', player: winner.p.name, pts: 10, detail: winner.canto.desc });
    caidaAddLog(room, `🃏 ¡TIBILÍN! ${winner.p.name} — +10 pts. ¡Gana el reparto!`);
    room.cantoResults = [{ player: winner.p.name, canto: winner.canto.desc, pts: 10, won: true }];
    room.cantosDone = true;
    caidaEndRound(room); return;
  }

  let best = null;
  withCanto.forEach(x => { if (compareCantos(x.canto, best) > 0) best = x.canto; });
  const top = withCanto.filter(x => compareCantos(x.canto, best) === 0);
  const winner = top.reduce((b, c) => ((c.i - manoIdx + n) % n) < ((b.i - manoIdx + n) % n) ? c : b);

  let totalPts = winner.canto.pts;
  const results = [];
  withCanto.forEach(x => {
    if (x.i === winner.i) {
      results.push({ player: x.p.name, cantoType: x.canto.type, pts: x.canto.pts, won: true });
    } else {
      totalPts += x.canto.pts;
      results.push({ player: x.p.name, cantoType: x.canto.type, pts: x.canto.pts, won: false, killedBy: winner.p.name });
    }
  });

  room.scores[winner.i] += totalPts;
  caidaAddRoundLog(room, { event: 'Cantos', player: winner.p.name, pts: totalPts, detail: winner.canto.desc });

  const CANTO_NAME = { ronda: 'Ronda', vigia: 'Vigía', patrulla: 'Patrulla' };
  const logLines = [`  ${winner.p.name} ganó cantos (${CANTO_NAME[winner.canto.type]||winner.canto.type}) — +${totalPts} pts`];
  withCanto.filter(x => x.i !== winner.i).forEach(x => {
    logLines.push(`  ${x.p.name} tenía ${CANTO_NAME[x.canto.type]||x.canto.type} (matado)`);
  });
  room.pendingCantoLog = logLines;

  room.cantoResults = results;
  room.cantosDone = true;
  room.state = 'playing';
  caidaSendState(room);
}

// ─── PLAY CARD ────────────────────────────────────────────────────────────────
function caidaPlayCard(room, playerIdx, cardIndex) {
  const player = room.players[playerIdx];
  const card = player.hand[cardIndex];
  if (!card) return;
  const n = room.players.length;

  player.hand.splice(cardIndex, 1);
  caidaAddLog(room, `🃏 ${player.name} juega ${card.display} de ${card.suit}`);

  // ── CAÍDA: only if lastPlayedCard is STILL ON THE TABLE (not collected) ──
  // FIX: We only set lastPlayedCard when card goes to table, not when collected
  let caida = false;
  if (room.lastPlayedBy !== -1 && room.lastPlayedCard && room.lastPlayedCard.val === card.val) {
    // Verify the last played card is actually still on the table
    const stillOnTable = room.tableCards.some(c => c === room.lastPlayedCard);
    if (stillOnTable) {
      const pts = caídaPoints(card.val);
      room.scores[playerIdx] += pts;
      caida = true;
      caidaAddRoundLog(room, { event: 'Caída', player: player.name, pts, detail: `${card.display} sobre ${room.players[room.lastPlayedBy].name}` });
      caidaAddLog(room, `💥 ¡CAÍDA! ${player.name} cae sobre ${room.players[room.lastPlayedBy].name} — +${pts} pt`);
      caidaBroadcast(room, { type: 'caida', by: player.name, on: room.players[room.lastPlayedBy].name, card, pts });
    }
  }

  // ── COLLECT FROM TABLE ──
  let collected = [];
  const sameOnTable = room.tableCards.filter(c => c.val === card.val);

  if (sameOnTable.length > 0) {
    // Match: take all same-value cards + extend upward as escalera
    // Start with the matching cards, then look for consecutive above
    collected = [...sameOnTable, card];
    room.tableCards = room.tableCards.filter(c => c.val !== card.val);
    // Now extend: take consecutive cards above from table
    const tableValsSet = new Set(room.tableCards.map(c => c.val));
    let v = card.val + 1;
    while (v <= 12 && tableValsSet.has(v)) {
      const found = room.tableCards.find(c => c.val === v);
      if (found) {
        collected.push(found);
        room.tableCards = room.tableCards.filter(c => c !== found);
        tableValsSet.delete(v);
      }
      v++;
    }
    const topVal = collected[collected.length - 1].val;
    if (topVal > card.val) {
      caidaAddLog(room, `🎯 ${player.name} recoge escalera ${card.val}-${topVal}`);
    } else {
      caidaAddLog(room, `✅ ${player.name} limpia con ${card.display}`);
    }
  } else {
    // Card not on table — goes to table, no escalera
  }

  const didCollect = collected.length > 0;

  // ── MESA VACÍA (4 pts, solo si NO es la última tanda) ──
  if (didCollect && room.tableCards.length === 0 && !room.isLastTanda) {
    const pts = 4;
    room.scores[playerIdx] += pts;
    caidaAddRoundLog(room, { event: 'Mesa vacía', player: player.name, pts, detail: caida ? '+caída' : '' });
    caidaAddLog(room, `🌟 ¡Mesa vacía! ${player.name} — +${pts} pts${caida ? ' (+ caída)' : ''}`);
    caidaBroadcast(room, { type: 'mesa_vacia', by: player.name, pts, plusCaida: caida });
  }

  if (didCollect) {
    player.collected.push(...collected);
    room.lastCollectorIdx = playerIdx;
    // FIX: Card was collected, reset lastPlayedCard so no false caída next turn
    room.lastPlayedCard = null;
    room.lastPlayedBy = -1;
  } else {
    // Card stays on table — track it for caída
    room.tableCards.push(card);
    room.lastPlayedCard = card;
    room.lastPlayedBy = playerIdx;
  }

  // FIX: advance turn within valid range
  room.currentTurn = (playerIdx + 1) % n;

  const handsEmpty = room.players.every(p => p.hand.length === 0);
  if (handsEmpty) {
    if (room.deck.length > 0) {
      caidaSendState(room);
      setTimeout(() => caidaDealTanda(room), 800);
    } else {
      if (room.pendingCantoLog && room.pendingCantoLog.length > 0) {
        caidaAddLog(room, `🎺 Cantos del reparto:`);
        room.pendingCantoLog.forEach(l => caidaAddLog(room, l));
        room.pendingCantoLog = [];
      }
      caidaSendState(room);
      setTimeout(() => caidaEndRound(room), 600);
    }
  } else {
    caidaSendState(room);
  }
}

// ─── END ROUND ────────────────────────────────────────────────────────────────
function caidaEndRound(room) {
  const n = room.players.length;

  if (room.tableCards.length > 0) {
    const lastIdx = room.lastCollectorIdx >= 0 ? room.lastCollectorIdx : room.lastPlayedBy;
    if (lastIdx >= 0 && lastIdx < n) {
      room.players[lastIdx].collected.push(...room.tableCards);
      caidaAddLog(room, `📦 Cartas restantes → ${room.players[lastIdx].name}`);
    }
    room.tableCards = [];
  }

  const base = n === 3 ? 13 : 20;
  const totalCollected = room.players.map(p => p.collected.length);
  const scoresBefore = [...room.scores];

  caidaAddLog(room, `📊 Conteo (base ${base}):`);

  if (n === 4 && room.teamMode) {
    const teamCollected = [0, 1].map(t =>
      room.players.filter(p => p.team === t).reduce((s, p) => s + p.collected.length, 0)
    );
    [0, 1].forEach(t => {
      const extra = Math.max(0, teamCollected[t] - base);
      room.players.filter(p => p.team === t).forEach(p => { room.scores[room.players.indexOf(p)] += extra; });
      caidaAddLog(room, `  Equipo ${t + 1}: ${teamCollected[t]} cartas → +${extra} pts`);
      if (extra > 0) {
        const nm = room.players.filter(p => p.team === t).map(p => p.name).join(' & ');
        caidaAddRoundLog(room, { event: 'Cartas', player: nm, pts: extra, detail: `${teamCollected[t]} cartas` });
      }
    });
  } else {
    room.players.forEach((p, i) => {
      const extra = Math.max(0, totalCollected[i] - base);
      room.scores[i] += extra;
      caidaAddLog(room, `  ${p.name}: ${totalCollected[i]} cartas → +${extra} pts`);
      if (extra > 0) caidaAddRoundLog(room, { event: 'Cartas', player: p.name, pts: extra, detail: `${totalCollected[i]} cartas` });
    });
  }

  caidaAddLog(room, `🏆 Marcador: ${room.players.map((p, i) => `${p.name}: ${room.scores[i]}`).join(' | ')}`);

  // ── WIN CONDITION: first to 24+ pts wins ──
  const WIN_SCORE = 24;
  const winnerIdx = room.scores.findIndex(s => s >= WIN_SCORE);
  const isGameOver = winnerIdx !== -1;
  if (isGameOver) {
    const winnerName = room.players[winnerIdx].name;
    caidaAddLog(room, `🎉 ¡${winnerName} gana la partida con ${room.scores[winnerIdx]} pts!`);
    LB.caidaRecordWin(lbDB, winnerName, room.scores[winnerIdx]);
  }

  const summary = {
    log: room.roundLog,
    players: room.players.map((p, i) => ({
      name: p.name, cards: totalCollected[i],
      scoreTotal: room.scores[i],
      scoreDelta: room.scores[i] - scoresBefore[i],
    })),
    scores: room.scores,
    base,
    gameOver: isGameOver,
    winnerName: isGameOver ? room.players[winnerIdx].name : null,
  };

  room.state = 'round_end';
  if (!isGameOver) {
    room.round++;
    room.dealer = (room.dealer + 1) % n;
  }
  room.readyForNext = [];

  caidaBroadcast(room, { type: 'round_end', summary });
  caidaSendState(room);
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// ███ PÓKER
// ═══════════════════════════════════════════════════════════════════════════════
const pokerRooms = {};
// ─── DECK ─────────────────────────────────────────────────────────────────────
const POKER_SUITS = ['♠','♥','♦','♣'];
const POKER_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const POKER_RANK_VAL = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function pokerMakeDeck() {
  const d = [];
  for (const s of POKER_SUITS) for (const r of POKER_RANKS) d.push({ suit: s, rank: r, val: POKER_RANK_VAL[r] });
  return d;
}
function pokerShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── HAND EVALUATION ─────────────────────────────────────────────────────────
function getBestHand(cards) {
  // cards = up to 7 cards, find best 5-card hand
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = evalHand(combo);
    if (!best || compareScore(score, best.score) > 0) best = { score, cards: combo };
  }
  return best;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [...combinations(rest, k-1).map(c => [first, ...c]), ...combinations(rest, k)];
}

function evalHand(cards) {
  const vals = cards.map(c => c.val).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const rankCounts = {};
  vals.forEach(v => { rankCounts[v] = (rankCounts[v]||0)+1; });
  const counts = Object.values(rankCounts).sort((a,b) => b-a);
  const uniqueVals = [...new Set(vals)].sort((a,b) => b-a);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = uniqueVals.length === 5 && (uniqueVals[0] - uniqueVals[4] === 4);
  // Wheel straight A-2-3-4-5
  const isWheel = JSON.stringify(uniqueVals) === JSON.stringify([14,5,4,3,2]);

  if (isFlush && (isStraight || isWheel)) {
    const high = isWheel ? 5 : uniqueVals[0];
    return [8, high];
  }
  if (counts[0] === 4) return [7, ...sortByCount(rankCounts)];
  if (counts[0] === 3 && counts[1] === 2) return [6, ...sortByCount(rankCounts)];
  if (isFlush) return [5, ...uniqueVals];
  if (isStraight || isWheel) return [4, isWheel ? 5 : uniqueVals[0]];
  if (counts[0] === 3) return [3, ...sortByCount(rankCounts)];
  if (counts[0] === 2 && counts[1] === 2) return [2, ...sortByCount(rankCounts)];
  if (counts[0] === 2) return [1, ...sortByCount(rankCounts)];
  return [0, ...uniqueVals];
}

function sortByCount(rankCounts) {
  return Object.entries(rankCounts)
    .sort((a,b) => b[1]-a[1] || b[0]-a[0])
    .map(([v]) => parseInt(v));
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i]||0) !== (b[i]||0)) return (a[i]||0) - (b[i]||0);
  }
  return 0;
}

const POKER_HAND_NAMES = ['Carta alta','Par','Doble par','Trío','Escalera','Color','Full','Póker','Escalera de color'];

// ─── ROOMS ────────────────────────────────────────────────────────────────────

function pokerCreateRoom(code, maxPlayers) {
  return {
    code, maxPlayers: Math.min(9, Math.max(2, maxPlayers||6)),
    players: [],
    state: 'waiting',
    deck: [],
    community: [],
    pot: 0,
    sidePots: [],
    currentBet: 0,
    minRaise: 20,
    round: 0,
    dealer: 0,
    currentTurn: -1,
    street: 'preflop', // preflop, flop, turn, river, showdown
    smallBlind: 10,
    bigBlind: 20,
    lastRaiseIdx: -1,
    actionsThisStreet: 0,
    readyForNext: [],
    log: [],
  };
}

function pokerBroadcast(room, msg) {
  room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); });
}
function pokerSendTo(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function pokerAddLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 80) room.log.shift();
  pokerBroadcast(room, { type: 'log', msg });
}

function pokerBuildStateFor(room, player) {
  const myIdx = room.players.indexOf(player);
  const activePlayers = room.players.filter(p => !p.folded && !p.eliminated);
  return {
    roomCode: room.code, maxPlayers: room.maxPlayers,
    gameState: room.state,
    street: room.street,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name,
      chips: p.chips,
      bet: p.bet || 0,
      folded: p.folded || false,
      allIn: p.allIn || false,
      eliminated: p.eliminated || false,
      isDealer: i === room.dealer,
      isYou: p.id === player.id,
      isHost: i === 0,
      hand: p.id === player.id ? p.hand : (
        (room.state === 'showdown' || (room.currentTurn === -1 && p.allIn && !p.folded)) && !p.folded ? p.hand : null
      ),
      handName: (room.state === 'showdown' || room.currentTurn === -1) && !p.folded ? p.handName : null,
      cardCount: p.hand ? p.hand.length : 0,
    })),
    community: room.community,
    pot: room.pot,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    currentTurn: room.currentTurn,
    myIdx,
    round: room.round,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    winners: room.winners || null,
  };
}
function pokerSendState(room) {
  room.players.forEach(p => pokerSendTo(p, { type: 'state', state: pokerBuildStateFor(room, p) }));
}

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function pokerStartGame(room) {
  room.players.forEach(p => { p.chips = 1000; p.eliminated = false; });
  room.round = 0;
  room.dealer = 0;
  pokerAddLog(room, `🃏 ¡Comienza el poker! ${room.players.length} jugadores, 1,000 fichas cada uno`);
  pokerStartHand(room);
}

function pokerStartHand(room) {
  const activePlayers = room.players.filter(p => !p.eliminated);
  if (activePlayers.length < 2) {
    const winner = activePlayers[0] || room.players.reduce((b,p) => p.chips > b.chips ? p : b);
    pokerBroadcast(room, { type: 'game_over', winner: winner.name, chips: winner.chips });
    LB.pokerRecordWin(lbDB, winner.name, winner.chips);
    pokerAddLog(room, `🏆 ¡${winner.name} gana la partida!`);
    room.state = 'game_over';
    pokerSendState(room); return;
  }

  room.round++;
  room.deck = pokerShuffle(pokerMakeDeck());
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.winners = null;
  room.readyForNext = [];
  room.state = 'playing';
  room.street = 'preflop';

  // Reset players
  activePlayers.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop()];
    p.folded = false;
    p.allIn = false;
    p.bet = 0;
    p.totalBet = 0;
    p.handName = null;
    p.actedThisStreet = false;
  });
  room.players.filter(p => p.eliminated).forEach(p => { p.hand = []; p.bet = 0; p.folded = true; });

  // Advance dealer to next active player
  const n = room.players.length;
  let d = room.dealer;
  do { d = (d + 1) % n; } while (room.players[d].eliminated);
  room.dealer = d;

  // Blinds — heads-up: dealer = SB, other = BB. 3+ players: dealer+1 = SB, dealer+2 = BB
  const active = activePlayers.filter(p => !p.eliminated);
  const dealerPos = active.indexOf(room.players[room.dealer]);
  let sbPlayer, bbPlayer;
  if (active.length === 2) {
    // Heads-up: dealer posts SB, other posts BB
    sbPlayer = active[dealerPos];
    bbPlayer = active[(dealerPos + 1) % 2];
  } else {
    sbPlayer = active[(dealerPos + 1) % active.length];
    bbPlayer = active[(dealerPos + 2) % active.length];
  }

  postBlind(room, sbPlayer, room.smallBlind, 'small blind');
  postBlind(room, bbPlayer, room.bigBlind, 'big blind');
  room.currentBet = room.bigBlind;
  room.lastRaiseIdx = room.players.indexOf(bbPlayer);

  pokerAddLog(room, `🃏 Mano ${room.round} — Dealer: ${room.players[room.dealer].name}`);

  // First to act preflop: after BB
  const bbIdx = room.players.indexOf(bbPlayer);
  setNextTurn(room, bbIdx);
  pokerSendState(room);
}

function postBlind(room, player, amount, label) {
  const actual = Math.min(amount, player.chips);
  player.chips -= actual;
  player.bet = actual;
  player.totalBet = actual;
  room.pot += actual;
  if (player.chips === 0) player.allIn = true;
  // Blinds count as forced bets, NOT as voluntary actions — actedThisStreet stays false
  pokerAddLog(room, `  ${player.name} posta ${label}: ${actual}`);
}

function setNextTurn(room, afterIdx) {
  const n = room.players.length;
  let idx = (afterIdx + 1) % n;
  let checked = 0;
  while (checked < n) {
    const p = room.players[idx];
    if (!p.folded && !p.allIn && !p.eliminated) {
      room.currentTurn = idx;
      return;
    }
    idx = (idx + 1) % n;
    checked++;
  }
  // No one can act — advance street
  room.currentTurn = -1;
  pokerAdvanceStreet(room);
}

function allActed(room) {
  const active = room.players.filter(p => !p.folded && !p.eliminated);
  const canAct = active.filter(p => !p.allIn);
  if (canAct.length === 0) return true;
  const betsMatch = canAct.every(p => p.bet === room.currentBet);
  const allHadTurn = canAct.every(p => p.actedThisStreet);
  return betsMatch && allHadTurn;
}

// ─── SIDE POTS ────────────────────────────────────────────────────────────────
function calcSidePots(room) {
  // Build side pots from totalBet amounts
  const active = room.players.filter(p => !p.folded && !p.eliminated && p.totalBet > 0);
  const allIn = active.filter(p => p.allIn).sort((a,b) => a.totalBet - b.totalBet);
  if (allIn.length === 0) return null; // no side pots needed

  const pots = [];
  let covered = 0;
  for (const allinP of allIn) {
    const level = allinP.totalBet;
    if (level <= covered) continue;
    const contribution = level - covered;
    const eligible = room.players.filter(p => !p.eliminated && !p.folded && p.totalBet >= level);
    // Amount = contribution from ALL players who put in at least this level (including folded — they already contributed)
    const contributors = room.players.filter(p => !p.eliminated && p.totalBet >= level);
    const amount = contribution * contributors.length;
    pots.push({ amount, eligible: eligible.map(p => p.id) });
    covered = level;
  }

  // Main pot for remaining players above last all-in level
  const remaining = room.players.filter(p => !p.eliminated && !p.folded && p.totalBet > covered);
  if (remaining.length > 0) {
    const extra = room.players.reduce((sum, p) => sum + Math.max(0, (p.totalBet||0) - covered), 0);
    if (extra > 0) pots.push({ amount: extra, eligible: remaining.map(p => p.id) });
  }

  return pots.length > 0 ? pots : null;
}

function pokerAdvanceStreet(room) {
  const active = room.players.filter(p => !p.folded && !p.eliminated);
  if (active.length === 1) { pokerEndHand(room); return; }

  // Reset bets and actions for new street
  room.players.forEach(p => { p.bet = 0; p.actedThisStreet = false; });
  room.currentBet = 0;
  room.minRaise = room.bigBlind;

  if (room.street === 'preflop') {
    room.street = 'flop';
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    pokerAddLog(room, `🂠 Flop: ${room.community.map(cardStr).join(' ')}`);
  } else if (room.street === 'flop') {
    room.street = 'turn';
    room.community.push(room.deck.pop());
    pokerAddLog(room, `🂠 Turn: ${cardStr(room.community[3])}`);
  } else if (room.street === 'turn') {
    room.street = 'river';
    room.community.push(room.deck.pop());
    pokerAddLog(room, `🂠 River: ${cardStr(room.community[4])}`);
  } else {
    pokerEndHand(room); return;
  }

  // First to act post-flop: first active after dealer
  const n = room.players.length;
  let idx = (room.dealer + 1) % n;
  let checked = 0;
  while (checked < n) {
    const p = room.players[idx];
    if (!p.folded && !p.allIn && !p.eliminated) { room.currentTurn = idx; pokerSendState(room); return; }
    idx = (idx + 1) % n;
    checked++;
  }
  // All-in runout: reveal all hands, send state, then pause before next street
  room.currentTurn = -1;
  pokerBroadcast(room, { type: 'allin_runout', players: active.map(p => ({ name: p.name, hand: p.hand })) });
  pokerSendState(room);
  setTimeout(() => pokerAdvanceStreet(room), 2200);
}

function cardStr(c) { return `${c.rank}${c.suit}`; }

function pokerEndHand(room) {
  room.street = 'showdown';
  const active = room.players.filter(p => !p.folded && !p.eliminated);

  // Evaluate hands
  active.forEach(p => {
    const allCards = [...p.hand, ...room.community];
    if (allCards.length >= 5) {
      const best = getBestHand(allCards);
      p.bestScore = best.score;
      p.handName = POKER_HAND_NAMES[best.score[0]];
    } else {
      // Not enough community cards (e.g. everyone folded early)
      p.bestScore = [0];
      p.handName = 'Carta alta';
    }
  });

  // ── SIDE POTS ──
  const sidePots = calcSidePots(room);
  const winnersAll = [];

  if (sidePots && sidePots.length > 0) {
    pokerAddLog(room, `💰 Calculando botes separados (${sidePots.length})...`);
    sidePots.forEach((pot, i) => {
      const eligible = active.filter(p => pot.eligible.includes(p.id));
      if (eligible.length === 0) return;
      let bestScore = null;
      eligible.forEach(p => { if (!bestScore || compareScore(p.bestScore, bestScore) > 0) bestScore = p.bestScore; });
      const winners = eligible.filter(p => compareScore(p.bestScore, bestScore) === 0);
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach(p => {
        p.chips += share;
        pokerAddLog(room, `🏆 ${p.name} gana bote${sidePots.length>1?' '+(i+1):''}: ${share} fichas con ${p.handName}`);
        if (!winnersAll.find(w => w.name === p.name)) winnersAll.push({ name: p.name, handName: p.handName, chips: p.chips });
      });
    });
  } else {
    // Simple single pot
    let bestScore = null;
    active.forEach(p => { if (!bestScore || compareScore(p.bestScore, bestScore) > 0) bestScore = p.bestScore; });
    const winners = active.filter(p => compareScore(p.bestScore, bestScore) === 0);
    const share = Math.floor(room.pot / winners.length);
    winners.forEach(p => {
      p.chips += share;
      pokerAddLog(room, `🏆 ${p.name} gana ${share} fichas con ${p.handName}!`);
      winnersAll.push({ name: p.name, handName: p.handName, chips: p.chips });
    });
  }

  room.winners = winnersAll;

  // Eliminate broke players
  room.players.forEach(p => { if (p.chips <= 0 && !p.eliminated) { p.eliminated = true; pokerAddLog(room, `💀 ${p.name} eliminado`); } });

  room.state = 'hand_end';
  room.currentTurn = -1;
  pokerSendState(room);
  // Send each player their own hand_end with full player hands included
  room.players.forEach(recipient => {
    pokerSendTo(recipient, {
      type: 'hand_end',
      winners: room.winners,
      pot: room.pot,
      // Include all non-eliminated player hands (folded ones hidden by default, revealed on request)
      playerHands: room.players.filter(p => !p.eliminated).map(p => ({
        id: p.id,
        name: p.name,
        hand: p.hand || [],
        folded: p.folded || false,
        handName: p.handName || null,
        isYou: p.id === recipient.id,
      }))
    });
  });
}

function pokerHandleAction(room, playerIdx, action, amount) {
  const player = room.players[playerIdx];

  player.actedThisStreet = true;

  if (action === 'fold') {
    player.folded = true;
    pokerAddLog(room, `${player.name} se retira`);
    const active = room.players.filter(p => !p.folded && !p.eliminated);
    if (active.length === 1) { pokerEndHand(room); return; }

  } else if (action === 'check') {
    pokerAddLog(room, `${player.name} pasa`);

  } else if (action === 'call') {
    const toCall = Math.min(room.currentBet - player.bet, player.chips);
    player.chips -= toCall;
    player.bet += toCall;
    player.totalBet = (player.totalBet || 0) + toCall;
    room.pot += toCall;
    if (player.chips === 0) player.allIn = true;
    pokerAddLog(room, `${player.name} iguala ${room.currentBet}`);

  } else if (action === 'raise') {
    const raiseTotal = Math.min(amount, player.chips + player.bet);
    const toAdd = raiseTotal - player.bet;
    player.chips -= toAdd;
    room.pot += toAdd;
    player.totalBet = (player.totalBet || 0) + toAdd;
    room.minRaise = raiseTotal - room.currentBet;
    room.currentBet = raiseTotal;
    player.bet = raiseTotal;
    if (player.chips === 0) player.allIn = true;
    room.lastRaiseIdx = playerIdx;
    pokerAddLog(room, `${player.name} sube a ${raiseTotal}`);
    // Bug 2 fix: when someone raises, reset actedThisStreet for all OTHER active players
    room.players.forEach((p, i) => { if (i !== playerIdx && !p.folded && !p.eliminated && !p.allIn) p.actedThisStreet = false; });

  } else if (action === 'allin') {
    const toAdd = player.chips;
    player.bet += toAdd;
    player.totalBet = (player.totalBet || 0) + toAdd;
    room.pot += toAdd;
    if (player.bet > room.currentBet) {
      room.minRaise = player.bet - room.currentBet;
      room.currentBet = player.bet;
      room.lastRaiseIdx = playerIdx;
      // Reset others so they can respond to the all-in raise
      room.players.forEach((p, i) => { if (i !== playerIdx && !p.folded && !p.eliminated && !p.allIn) p.actedThisStreet = false; });
    }
    player.chips = 0;
    player.allIn = true;
    pokerAddLog(room, `${player.name} va ALL-IN con ${player.bet}`);
  }

  // Check if street is over
  if (allActed(room)) {
    pokerAdvanceStreet(room);
  } else {
    setNextTurn(room, playerIdx);
    pokerSendState(room);
  }
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════════════
// ███ UNO
// ═══════════════════════════════════════════════════════════════════════════════
const unoRooms = {};

// ── DECK BUILDERS ──────────────────────────────────────────────────────────────
function unoMakeDeck(mode) {
  const COLORS = ['red','blue','green','yellow'];
  const deck = [];

  // Classic deck (108 cards)
  for (const c of COLORS) {
    deck.push({ type:'number', color:c, value:0 });             // one 0
    for (let n = 1; n <= 9; n++) for (let r=0;r<2;r++) deck.push({ type:'number', color:c, value:n });
    for (let r=0;r<2;r++) { deck.push({type:'skip',color:c}); deck.push({type:'reverse',color:c}); deck.push({type:'take2',color:c}); }
  }
  for (let r=0;r<4;r++) { deck.push({type:'wild',color:'wild'}); deck.push({type:'wild4',color:'wild'}); }

  if (mode === 'mercy') {
    // No Mercy extras: Tira un color (x4 colors x1), Salta a todos (x4 colors x1)
    for (const c of COLORS) {
      deck.push({ type:'throwcolor', color:c });
      deck.push({ type:'skipall',    color:c });
    }
    // Wild comodines: take6 x4, take10 x4, wildrev4 x4, ruleta x4
    for (let r=0;r<4;r++) {
      deck.push({ type:'take6',    color:'wild' });
      deck.push({ type:'take10',   color:'wild' });
      deck.push({ type:'wildrev4', color:'wild' });
      deck.push({ type:'ruleta',   color:'wild' });
    }
  }

  return unoShuffle(deck);
}

function unoShuffle(arr) {
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

// ── ROOM ───────────────────────────────────────────────────────────────────────
function unoCreateRoom(code, maxPlayers, mode, winCon) {
  return {
    code, maxPlayers, mode: mode||'classic', winCon: winCon||'hand',
    players: [], // { id, ws, name, hand, totalPoints, eliminated, calledUno }
    state: 'waiting',
    deck: [], discard: [],
    currentTurn: 0, direction: 1,   // 1=clockwise, -1=counter
    stack: 0,         // pending draw stack
    activeColor: null, // color override for wilds
    hand: 1,          // current hand number
    mustPlay: false,   // must play (after drawing match)
    canPass: false,    // can pass after drawing non-playable
    lastDrawn: null,   // card drawn this turn (for pass logic)
    readyForNext: [],
  };
}

function unoBroadcast(room, msg) { room.players.forEach(p => { if(p.ws&&p.ws.readyState===1) p.ws.send(JSON.stringify(msg)); }); }
function unoSendTo(p, msg)       { if(p.ws&&p.ws.readyState===1) p.ws.send(JSON.stringify(msg)); }
function unoLog(room, msg)       { unoBroadcast(room, { type:'log', msg }); }

function unoBuildStateFor(room, player) {
  const myIdx = room.players.indexOf(player);
  const playable = myIdx === room.currentTurn && !player.eliminated
    ? unoGetPlayable(room, player) : [];
  return {
    roomCode: room.code, gameState: room.state,
    mode: room.mode, winCon: room.winCon,
    hand: room.hand, direction: room.direction,
    currentTurn: room.currentTurn, activeColor: room.activeColor,
    stack: room.stack, deckCount: room.deck.length,
    topCard: room.discard.length ? room.discard[room.discard.length-1] : null,
    mustPlay: room.mustPlay, canPass: room.canPass,
    myIdx,
    playable,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, isYou: p.id === player.id,
      isHost: i === 0, eliminated: p.eliminated||false,
      calledUno: p.calledUno||false, totalPoints: p.totalPoints||0,
      cardCount: p.hand ? p.hand.length : 0,
      origIdx: i,
      hand: p.id === player.id ? p.hand : null,
    })),
  };
}
function unoSendState(room) { room.players.forEach(p => unoSendTo(p, { type:'state', state: unoBuildStateFor(room, p) })); }

// ── PLAYABILITY ────────────────────────────────────────────────────────────────
function unoCanPlay(room, card) {
  const top = room.discard[room.discard.length-1];
  if (!top) return true;
  const ac = room.activeColor || top.color;

  // If stack is active, can only play draw-stacking cards (equal or higher value)
  if (room.stack > 0) {
    const drawTypes = ['take2','wild4','take6','take10','wildrev4'];
    if (!drawTypes.includes(card.type)) return false;
    // Must be equal or higher draw value
    const drawVal = { take2:2, wild4:4, take6:6, take10:10, wildrev4:4 };
    return (drawVal[card.type]||0) >= (drawVal[top.type]||0);
  }

  // Wild cards always playable
  if (['wild','wild4','take6','take10','wildrev4','ruleta'].includes(card.type)) return true;
  // Match color
  if (card.color === ac) return true;
  // Match type/value
  if (card.type !== 'number' && card.type === top.type) return true;
  if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
  // throwcolor matches on color only
  if (card.type === 'throwcolor' && card.color === ac) return true;
  if (top.type === 'throwcolor' && card.color === ac) return true;
  if (card.type === 'skipall' && card.color === ac) return true;
  return false;
}

function unoGetPlayable(room, player) {
  return player.hand.map((c, i) => unoCanPlay(room, c) ? i : -1).filter(i => i >= 0);
}

// ── DECK MANAGEMENT ────────────────────────────────────────────────────────────
function unoEnsureDeck(room) {
  if (room.deck.length > 4) return;
  if (room.discard.length <= 1) return; // nothing to recycle
  const top = room.discard.pop();
  // Reshuffle discard pile back into deck
  room.deck = unoShuffle([...room.deck, ...room.discard]);
  room.discard = [top];
  unoLog(room, '🔄 Mazo agotado — se ha reciclado la pila de descarte');
}

// ── DEAL ───────────────────────────────────────────────────────────────────────
function unoStartHand(room) {
  room.deck = unoMakeDeck(room.mode);
  room.discard = [];
  room.stack = 0;
  room.activeColor = null;
  room.mustPlay = false;
  room.canPass = false;
  room.readyForNext = [];

  // Deal 7 cards to each active player
  room.players.forEach(p => {
    if (!p.eliminated) {
      p.hand = room.deck.splice(0, 7);
      p.calledUno = false;
    } else {
      p.hand = [];
    }
  });

  // First discard card — skip action cards
  let startCard;
  do { startCard = room.deck.shift(); } while (startCard.type !== 'number');
  room.discard.push(startCard);

  // First player to act
  room.currentTurn = room.players.findIndex(p => !p.eliminated);
  room.direction = 1;
  room.state = 'playing';
  unoLog(room, `🃏 Mano ${room.hand} — Carta inicial: ${startCard.color} ${startCard.value}`);
  unoSendState(room);
}

// ── ADVANCE TURN ───────────────────────────────────────────────────────────────
function unoNextTurn(room, skip=0) {
  const n = room.players.length;
  let idx = room.currentTurn;
  for (let s = 0; s <= skip; s++) {
    do {
      idx = ((idx + room.direction) % n + n) % n;
    } while (room.players[idx].eliminated && room.players.filter(p=>!p.eliminated).length > 1);
  }
  room.currentTurn = idx;
  room.mustPlay = false;
  room.canPass = false;
  unoSendState(room);
}

// ── APPLY CARD EFFECT ──────────────────────────────────────────────────────────
function unoApplyEffect(room, card, chosenColor, playerId) {
  const n = room.players.length;
  const player = room.players.find(p => p.id === playerId);

  // Set active color for wilds
  if (['wild','wild4','take6','take10','wildrev4','ruleta'].includes(card.type)) {
    room.activeColor = chosenColor || 'red';
  } else {
    room.activeColor = card.color;
  }

  switch (card.type) {
    case 'skip':
      unoLog(room, `⊘ Turno saltado`);
      unoNextTurn(room, 1);
      break;

    case 'skipall':
      unoLog(room, `⊘⊘ ¡Salta a todos! ${player.name} vuelve a jugar`);
      // No advance — same player
      unoSendState(room);
      break;

    case 'reverse':
      room.direction *= -1;
      unoLog(room, `↺ Sentido invertido`);
      if (room.players.filter(p=>!p.eliminated).length === 2) {
        // 2 players: reverse acts as skip
        unoNextTurn(room, 1);
      } else {
        unoNextTurn(room);
      }
      break;

    case 'take2':
      room.stack += 2;
      unoLog(room, `+2 apilado (total +${room.stack})`);
      unoCheckStack(room);
      break;

    case 'wild4':
      room.stack += 4;
      unoLog(room, `+4 apilado (total +${room.stack}), color: ${chosenColor}`);
      unoCheckStack(room);
      break;

    case 'take6':
      room.stack += 6;
      unoLog(room, `+6 apilado (total +${room.stack}), color: ${chosenColor}`);
      unoCheckStack(room);
      break;

    case 'take10':
      room.stack += 10;
      unoLog(room, `+10 apilado (total +${room.stack}), color: ${chosenColor}`);
      unoCheckStack(room);
      break;

    case 'wildrev4':
      room.direction *= -1;
      room.stack += 4;
      unoLog(room, `↺+4 apilado (total +${room.stack}), color: ${chosenColor}`);
      if (room.players.filter(p=>!p.eliminated).length === 2) {
        // In 2 player game: YOU take 4 instead
        const selfIdx = room.players.indexOf(player);
        unoForceDraw(room, selfIdx, 4);
        room.stack = 0;
        unoSendState(room);
      } else {
        unoCheckStack(room);
      }
      break;

    case 'throwcolor': {
      // Discard all cards of active color from hand
      const matching = player.hand.filter(c => c.color === card.color);
      player.hand = player.hand.filter(c => c.color !== card.color);
      // Place matching cards below the throwcolor card
      room.discard.unshift(...matching);
      unoLog(room, `🎨 ${player.name} tira ${matching.length} cartas ${card.color}`);
      unoCheckWinCondition(room, room.players.indexOf(player));
      unoNextTurn(room);
      break;
    }

    case 'ruleta': {
      // Next player draws until they get a card of chosenColor
      const nextIdx = unoGetNextIdx(room);
      const nextP = room.players[nextIdx];
      let drawn = 0;
      while (true) {
        unoEnsureDeck(room);
        if (room.deck.length === 0) break;
        const c = room.deck.shift();
        nextP.hand.push(c);
        drawn++;
        if (c.color === chosenColor) break;
        if (drawn > 30) break; // safety
      }
      unoLog(room, `🎰 Ruleta ${chosenColor}: ${nextP.name} roba ${drawn} carta(s)`);
      unoNextTurn(room, 1); // next player loses turn
      break;
    }

    case 'number':
      if (card.value === 7 && room.mode === 'mercy') {
        // Swap is handled by server directly — state already updated
        unoNextTurn(room);
        break;
      }
      if (card.value === 0) {
        // Everyone passes hand to next in direction
        const active = room.players.filter(p => !p.eliminated);
        const n2 = active.length;
        const hands = active.map(p => [...p.hand]);
        if (room.direction === 1) {
          active.forEach((p, i) => { p.hand = hands[(i + 1) % n2]; });
        } else {
          active.forEach((p, i) => { p.hand = hands[(i - 1 + n2) % n2]; });
        }
        unoLog(room, `0️⃣ ¡Todos pasan la mano al siguiente!`);
        unoNextTurn(room);
        break;
      }
      unoNextTurn(room);
      break;

    default:
      unoNextTurn(room);
      break;
  }
}

function unoGetNextIdx(room) {
  const n = room.players.length;
  let idx = room.currentTurn;
  do { idx = ((idx + room.direction) % n + n) % n; } while (room.players[idx].eliminated);
  return idx;
}

function unoCheckStack(room) {
  // Next player must play a stackable card or take the full stack
  const nextIdx = unoGetNextIdx(room);
  const nextP = room.players[nextIdx];
  const canStack = nextP.hand.some(c => unoCanPlay(room, c));
  room.currentTurn = nextIdx;
  unoSendState(room);
}

function unoForceDraw(room, playerIdx, n) {
  const p = room.players[playerIdx];
  for (let i = 0; i < n; i++) {
    unoEnsureDeck(room);
    if (room.deck.length === 0) break;
    p.hand.push(room.deck.shift());
  }
  // Piedad (No Mercy): 25+ cards = eliminated
  if ((room.mode === 'mercy' || room.winCon === 'last') && p.hand.length >= 25) {
    p.eliminated = true;
    unoLog(room, `💀 PIEDAD: ${p.name} tiene ${p.hand.length} cartas — eliminado`);
    unoBroadcast(room, { type:'notice', msg: `💀 ${p.name} eliminado por Piedad (25+ cartas)` });
    // Check if only 1 player left
    const alive = room.players.filter(x => !x.eliminated);
    if (alive.length === 1) {
      unoEndHand(room, alive[0]);
      return true; // game ended
    }
  }
  return false;
}

function unoCheckWinCondition(room, playerIdx) {
  const p = room.players[playerIdx];
  if (p.hand.length === 0) {
    unoEndHand(room, p);
    return true;
  }
  return false;
}

// ── END HAND ───────────────────────────────────────────────────────────────────
function unoEndHand(room, winner) {
  room.state = 'hand_end';
  unoLog(room, `🏆 ${winner.name} gana la mano!`);

  // Calculate points for winner
  let pts = 0;
  const scores = [];
  room.players.forEach(p => {
    if (p.id !== winner.id) {
      let ppts = 0;
      (p.hand||[]).forEach(c => {
        if (c.type === 'number') ppts += c.value;
        else if (['skip','reverse','take2','skipall','throwcolor'].includes(c.type)) ppts += 20;
        else if (['wild','wild4','take6','take10','wildrev4','ruleta'].includes(c.type)) ppts += 50;
        else ppts += 20;
      });
      pts += ppts;
      scores.push({ name: p.name, points: ppts, cards: p.hand.length });
    } else {
      scores.push({ name: p.name, points: 0, cards: 0, winner: true });
    }
  });

  // Bonus for eliminations (No Mercy)
  if (room.mode === 'mercy' || room.winCon === 'last') {
    const elimCount = room.players.filter(p => p.eliminated && p.id !== winner.id).length;
    pts += elimCount * 250;
    if (elimCount > 0) unoLog(room, `+${elimCount*250} pts por ${elimCount} eliminado(s)`);
  }

  winner.totalPoints = (winner.totalPoints || 0) + pts;
  unoLog(room, `💰 ${winner.name} gana ${pts} puntos (total: ${winner.totalPoints})`);

  // Check game-over conditions
  let gameOver = false;
  let gameWinner = null;

  if (room.winCon === 'hand') {
    gameOver = true; gameWinner = winner;
  } else if (room.winCon === 'points' && winner.totalPoints >= 1000) {
    gameOver = true; gameWinner = winner;
  } else if (room.winCon === 'last') {
    const alive = room.players.filter(p => !p.eliminated);
    if (alive.length === 1) { gameOver = true; gameWinner = alive[0]; }
  }

  const scoresSorted = scores.sort((a,b) => b.points - a.points);

  if (gameOver) {
    unoBroadcast(room, { type:'game_over', winnerName: gameWinner.name,
      scores: room.players.map(p => ({ name:p.name, points:p.totalPoints||0, cards:(p.hand||[]).length }))
        .sort((a,b) => b.points - a.points) });
    room.state = 'game_over';
    LB.unoRecordWin && LB.unoRecordWin(lbDB, gameWinner.name, winner.totalPoints);
    return;
  }

  // Prepare next hand
  room.hand++;
  // Reset eliminations for 'points' mode only
  if (room.winCon !== 'last') room.players.forEach(p => p.eliminated = false);

  unoBroadcast(room, { type:'hand_end', winnerName: winner.name, scores: scoresSorted,
    nextTarget: room.winCon === 'points' ? `${1000 - winner.totalPoints} más` : null,
    gameOver: false });
  unoSendState(room);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███ CHINCHÓN
// ═══════════════════════════════════════════════════════════════════════════════
// Rules:
// - 7 cards per player. On your turn: draw 1 (from deck or discard pile), then discard 1.
// - Goal: form combinations with all 6 remaining cards and discard the 7th = "bajar"
// - Combination types: GROUP (3-4 same value) or RUN (3+ consecutive same suit)
// - Chinchón: all 7 cards in one sequence of the same suit = special win (−10 pts)
// - Points on hand = sum of unmatched cards (Jotas/Reyes/etc = face value)
// - Spanish deck: values 1-7, 10-12 (8&9 removed). J=8,Q=9,K=10 for points
// - French deck: standard 52 cards, A=1, J=Q=K=10 for points
// - Elimination: reach 100 pts → eliminated, points anchored to next player
// - Last player under 100 wins

const chinchonRooms = {};

// ── DECK ──────────────────────────────────────────────────────────────────────
const CH_SUITS_ES = ['oros','copas','espadas','bastos'];
const CH_VALS_ES  = [1,2,3,4,5,6,7,10,11,12]; // Spanish deck (no 8,9)
const CH_SUITS_FR = ['♠','♥','♦','♣'];
const CH_VALS_FR  = [1,2,3,4,5,6,7,8,9,10,11,12,13]; // French deck

function chMakeDeck(variant) {
  const suits = variant === 'es' ? CH_SUITS_ES : CH_SUITS_FR;
  const vals  = variant === 'es' ? CH_VALS_ES  : CH_VALS_FR;
  const deck = [];
  for (const s of suits) for (const v of vals) deck.push({ suit:s, val:v, id:`${s}_${v}` });
  return deck;
}

function chShuffle(arr) {
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

// Number of decks based on player count
function chNumDecks(n) {
  if (n <= 4)  return 1;
  if (n <= 7)  return 2;
  return 3;
}

// Point value of a card
function chCardPoints(card, variant) {
  if (variant === 'es') {
    if (card.val <= 7)  return card.val;
    if (card.val === 10) return 8;  // Sota
    if (card.val === 11) return 9;  // Caballo
    if (card.val === 12) return 10; // Rey
  } else {
    if (card.val <= 10) return card.val;
    return 10; // J,Q,K
  }
  return card.val;
}

// Display label for a card value
function chValLabel(val, variant) {
  if (variant === 'es') {
    if (val === 10) return 'S';
    if (val === 11) return 'C';
    if (val === 12) return 'R';
  } else {
    if (val === 1)  return 'A';
    if (val === 11) return 'J';
    if (val === 12) return 'Q';
    if (val === 13) return 'K';
  }
  return String(val);
}

// ── COMBINATION VALIDATION ────────────────────────────────────────────────────
// Returns { valid:bool, combos:[], deadwood:[] }
// combos = array of arrays of card objects
// deadwood = unmatched cards

function chOrderVal(val, variant) {
  // For sequence purposes in Spanish deck: 1,2,3,4,5,6,7,10(=8),11(=9),12(=10)
  if (variant === 'es') {
    const order = [1,2,3,4,5,6,7,10,11,12];
    return order.indexOf(val);
  }
  return val - 1; // French: 1=A=1, 13=K=13
}

// Check if a set of cards forms a valid run (sequence, same suit, 3+)
function chIsRun(cards, variant) {
  if (cards.length < 3) return false;
  const suit = cards[0].suit;
  if (!cards.every(c => c.suit === suit)) return false;
  const sorted = [...cards].sort((a,b) => chOrderVal(a.val, variant) - chOrderVal(b.val, variant));
  for (let i = 1; i < sorted.length; i++) {
    if (chOrderVal(sorted[i].val, variant) !== chOrderVal(sorted[i-1].val, variant) + 1) return false;
  }
  return true;
}

// Check if a set of cards forms a valid group (same value, 3-4 cards)
function chIsGroup(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const val = cards[0].val;
  return cards.every(c => c.val === val);
}

// Check if all 7 cards form a single run (Chinchón)
function chIsChinchon(cards, variant) {
  return cards.length === 7 && chIsRun(cards, variant);
}

// Try to find best combination layout for given cards
// Returns { combos, deadwood, deadwoodPoints }
function chBestLayout(cards, variant) {
  // Try all possible partitions to minimize deadwood
  // For 6-7 cards with combinations of 3-4, brute force is feasible
  const best = { combos:[], deadwood:[...cards], deadwoodPoints: cards.reduce((s,c)=>s+chCardPoints(c,variant),0) };

  function tryPartition(remaining, currentCombos) {
    if (remaining.length === 0) {
      const pts = 0;
      if (pts < best.deadwoodPoints) {
        best.combos = [...currentCombos];
        best.deadwood = [];
        best.deadwoodPoints = 0;
      }
      return;
    }

    // Try each subset of size 3 and 4
    for (let size = 3; size <= Math.min(4, remaining.length); size++) {
      // Generate all combinations of `size` from remaining
      const combos = combinations(remaining, size);
      for (const combo of combos) {
        if (chIsRun(combo, variant) || chIsGroup(combo)) {
          const rest = remaining.filter(c => !combo.includes(c));
          tryPartition(rest, [...currentCombos, combo]);
        }
      }
    }

    // Baseline: current remaining are all deadwood
    const pts = remaining.reduce((s,c) => s+chCardPoints(c,variant), 0);
    if (pts < best.deadwoodPoints) {
      best.combos = [...currentCombos];
      best.deadwood = [...remaining];
      best.deadwoodPoints = pts;
    }
  }

  function combinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const [first, ...rest] = arr;
    return [
      ...combinations(rest, k-1).map(c => [first,...c]),
      ...combinations(rest, k)
    ];
  }

  tryPartition(cards, []);
  return best;
}

// Validate a player's declared bajar move
function chValidateBajar(hand, combos, discardCard, variant) {
  // combos: array of index arrays referring to hand positions
  // discardCard: index of card being discarded (the 7th)
  const usedIndices = new Set(combos.flat());
  if (usedIndices.has(discardCard)) return { ok:false, reason:'La carta a descartar no puede estar en una combinación' };

  const allIndices = [...usedIndices, discardCard];
  if (allIndices.length !== hand.length) return { ok:false, reason:'Debes usar todas las cartas' };
  if (new Set(allIndices).size !== allIndices.length) return { ok:false, reason:'Carta usada dos veces' };

  for (const combo of combos) {
    const cards = combo.map(i => hand[i]);
    if (!chIsRun(cards, variant) && !chIsGroup(cards)) {
      return { ok:false, reason:`Combinación inválida: ${cards.map(c=>chValLabel(c.val,variant)+c.suit).join(',')}` };
    }
  }
  return { ok:true };
}

// Validate chinchón (all 7 form a run)
function chValidateChinchon(hand, variant) {
  return chIsChinchon(hand, variant);
}

// ── ROOM ──────────────────────────────────────────────────────────────────────
function chCreateRoom(code, maxPlayers, variant) {
  return {
    code,
    maxPlayers: Math.min(10, Math.max(2, maxPlayers||4)),
    variant: variant || 'es', // 'es' | 'fr'
    players: [], // { id, ws, name, hand, points, eliminated, anchored, anchoredFrom }
    state: 'waiting',
    deck: [],
    discardPile: [], // top = last element
    currentTurn: 0,
    round: 0,
    drawnCard: null,     // card drawn this turn (must discard before ending)
    drawnFrom: null,     // 'deck' | 'discard'
    hasDrawn: false,     // whether current player has drawn this turn
    readyForNext: [],
    lastBajar: null,     // { playerName, combos, discard, isChinchon }
  };
}

function chBroadcast(room, msg) {
  room.players.forEach(p => { if(p.ws&&p.ws.readyState===1) p.ws.send(JSON.stringify(msg)); });
}
function chSendTo(p, msg) { if(p.ws&&p.ws.readyState===1) p.ws.send(JSON.stringify(msg)); }
function chLog(room, msg) { chBroadcast(room, { type:'log', msg }); }

function chBuildStateFor(room, player) {
  const myIdx = room.players.indexOf(player);
  return {
    roomCode: room.code,
    gameState: room.state,
    variant: room.variant,
    currentTurn: room.currentTurn,
    round: room.round,
    hasDrawn: room.hasDrawn,
    drawnFrom: room.drawnFrom,
    topDiscard: room.discardPile.length ? room.discardPile[room.discardPile.length-1] : null,
    deckCount: room.deck.length,
    myIdx,
    lastBajar: room.lastBajar || null,
    players: room.players.map((p,i) => ({
      id: p.id, name: p.name, isYou: p.id === player.id,
      isHost: i === 0, eliminated: p.eliminated||false,
      anchored: p.anchored||false, anchoredPts: p.anchoredPts||0,
      points: p.points||0, cardCount: p.hand ? p.hand.length : 0,
      hand: p.id === player.id ? p.hand : null,
    })),
  };
}
function chSendState(room) { room.players.forEach(p => chSendTo(p, { type:'state', state: chBuildStateFor(room, p) })); }

// ── DEAL ──────────────────────────────────────────────────────────────────────
function chDeal(room) {
  const n = room.players.filter(p=>!p.eliminated).length;
  const numDecks = chNumDecks(n);
  let deck = [];
  for (let i = 0; i < numDecks; i++) deck.push(...chMakeDeck(room.variant));
  room.deck = chShuffle(deck);
  room.discardPile = [];
  room.hasDrawn = false;
  room.drawnCard = null;
  room.drawnFrom = null;
  room.lastBajar = null;
  room.readyForNext = [];

  // Deal 7 cards to each active player
  room.players.forEach(p => {
    if (!p.eliminated) {
      p.hand = room.deck.splice(0, 7);
    } else {
      p.hand = [];
    }
  });

  // First discard card
  room.discardPile.push(room.deck.pop());

  // First turn: first non-eliminated player
  room.currentTurn = room.players.findIndex(p => !p.eliminated);
  room.state = 'playing';
  room.round++;
  chLog(room, `🃏 Ronda ${room.round} — ${room.players[room.currentTurn].name} empieza`);
  chSendState(room);
}

// ── NEXT TURN ──────────────────────────────────────────────────────────────────
function chNextTurn(room) {
  room.hasDrawn = false;
  room.drawnCard = null;
  room.drawnFrom = null;
  const n = room.players.length;
  let idx = room.currentTurn;
  do { idx = (idx + 1) % n; } while (room.players[idx].eliminated);
  room.currentTurn = idx;
  chSendState(room);
}

// ── SCORING ───────────────────────────────────────────────────────────────────
function chScoreHand(hand, variant) {
  return hand.reduce((s,c) => s + chCardPoints(c, variant), 0);
}

// End of round: someone bajó, score all other players
function chEndRound(room, winnerIdx, isChinchon) {
  const variant = room.variant;
  room.state = 'round_end';

  const scores = [];
  room.players.forEach((p, i) => {
    if (p.eliminated) { scores.push({ name:p.name, pts:0, total:p.points, eliminated:true }); return; }
    let roundPts = 0;
    if (i === winnerIdx) {
      roundPts = isChinchon ? -10 : 0; // winner scores 0 (or -10 for chinchón)
    } else {
      roundPts = chScoreHand(p.hand, variant);
    }
    p.points = (p.points||0) + roundPts;
    scores.push({ name:p.name, pts:roundPts, total:p.points });
  });

  chLog(room, `📊 Ronda ${room.round} terminada:`);
  scores.filter(s=>!s.eliminated).forEach(s => chLog(room, `  ${s.name}: +${s.pts} → ${s.total} pts`));

  // Check eliminations (≥100 pts) — anchor to next active player
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      if (!p.eliminated && p.points >= 100) {
        p.eliminated = true;
        changed = true;
        chLog(room, `💀 ${p.name} eliminado con ${p.points} pts`);
        // Anchor points to next active player
        let next = (i+1) % room.players.length;
        while (room.players[next].eliminated && next !== i) next = (next+1) % room.players.length;
        if (next !== i && !room.players[next].eliminated) {
          room.players[next].points += p.points;
          room.players[next].anchored = true;
          room.players[next].anchoredPts = (room.players[next].anchoredPts||0) + p.points;
          chLog(room, `🔗 ${p.points} pts anclados a ${room.players[next].name} (${room.players[next].points} total)`);
        }
      }
    }
  }

  // Check win condition: only 1 player left
  const alive = room.players.filter(p=>!p.eliminated);
  if (alive.length <= 1) {
    const winner = alive[0] || room.players.reduce((a,b) => a.points < b.points ? a : b);
    chBroadcast(room, { type:'game_over', winnerName: winner.name, scores: room.players.map(p=>({name:p.name,points:p.points,eliminated:p.eliminated})).sort((a,b)=>a.points-b.points) });
    room.state = 'game_over';
    chSendState(room);
    return;
  }

  chBroadcast(room, { type:'round_end', scores, lastBajar: room.lastBajar });
  chSendState(room);
}

// ── MESSAGE HANDLERS ──────────────────────────────────────────────────────────
function chHandleMessage(room, player, msg) {
  const pidx = room.players.indexOf(player);

  if (msg.type === 'startGame') {
    if (room.state !== 'waiting') return;
    if (room.players.length < 2) { chSendTo(player, {type:'error',msg:'Necesitas al menos 2 jugadores'}); return; }
    chLog(room, `🎮 ¡Comienza el Chinchón! ${room.players.length} jugadores · Baraja ${room.variant === 'es' ? 'española' : 'francesa'}`);
    chDeal(room);
    return;
  }

  if (msg.type === 'drawDeck') {
    if (room.state !== 'playing') return;
    if (pidx !== room.currentTurn) { chSendTo(player, {type:'error',msg:'No es tu turno'}); return; }
    if (room.hasDrawn) { chSendTo(player, {type:'error',msg:'Ya has robado esta ronda'}); return; }
    if (room.deck.length === 0) {
      // Reshuffle discard except top
      const top = room.discardPile.pop();
      room.deck = chShuffle([...room.discardPile]);
      room.discardPile = [top];
      chLog(room, '🔄 Mazo agotado — se rebaraja la pila de descarte');
    }
    const card = room.deck.pop();
    player.hand.push(card);
    room.hasDrawn = true;
    room.drawnCard = card;
    room.drawnFrom = 'deck';
    chLog(room, `📥 ${player.name} roba del mazo`);
    chSendState(room);
    return;
  }

  if (msg.type === 'drawDiscard') {
    if (room.state !== 'playing') return;
    if (pidx !== room.currentTurn) { chSendTo(player, {type:'error',msg:'No es tu turno'}); return; }
    if (room.hasDrawn) { chSendTo(player, {type:'error',msg:'Ya has robado esta ronda'}); return; }
    if (!room.discardPile.length) { chSendTo(player, {type:'error',msg:'La pila de descarte está vacía'}); return; }
    const card = room.discardPile.pop();
    player.hand.push(card);
    room.hasDrawn = true;
    room.drawnCard = card;
    room.drawnFrom = 'discard';
    chLog(room, `📥 ${player.name} toma la carta del descarte`);
    chSendState(room);
    return;
  }

  if (msg.type === 'discard') {
    if (room.state !== 'playing') return;
    if (pidx !== room.currentTurn) { chSendTo(player, {type:'error',msg:'No es tu turno'}); return; }
    if (!room.hasDrawn) { chSendTo(player, {type:'error',msg:'Primero debes robar una carta'}); return; }
    const { cardIdx } = msg;
    if (cardIdx < 0 || cardIdx >= player.hand.length) return;
    const card = player.hand.splice(cardIdx, 1)[0];
    room.discardPile.push(card);
    chLog(room, `🗑️ ${player.name} descarta ${chValLabel(card.val, room.variant)}${card.suit}`);
    chNextTurn(room);
    return;
  }

  if (msg.type === 'bajar') {
    if (room.state !== 'playing') return;
    if (pidx !== room.currentTurn) { chSendTo(player, {type:'error',msg:'No es tu turno'}); return; }
    if (!room.hasDrawn) { chSendTo(player, {type:'error',msg:'Primero debes robar una carta'}); return; }
    const { combos, discardIdx } = msg; // combos: [[idx,idx,idx], ...], discardIdx: card index to discard

    if (discardIdx < 0 || discardIdx >= player.hand.length) { chSendTo(player, {type:'error',msg:'Índice de descarte inválido'}); return; }

    // Validate
    const result = chValidateBajar(player.hand, combos, discardIdx, room.variant);
    if (!result.ok) { chSendTo(player, {type:'error',msg:result.reason}); return; }

    const discardCard = player.hand[discardIdx];
    const comboCards = combos.map(combo => combo.map(i => player.hand[i]));

    room.lastBajar = { playerName: player.name, combos: comboCards, discard: discardCard, isChinchon: false };

    chLog(room, `✅ ${player.name} baja con ${combos.length} combinación(es)`);
    chBroadcast(room, { type:'bajar', playerName: player.name, combos: comboCards, discard: discardCard });
    chEndRound(room, pidx, false);
    return;
  }

  if (msg.type === 'chinchon') {
    if (room.state !== 'playing') return;
    if (pidx !== room.currentTurn) { chSendTo(player, {type:'error',msg:'No es tu turno'}); return; }
    if (!room.hasDrawn) { chSendTo(player, {type:'error',msg:'Primero debes robar una carta'}); return; }

    // The discardIdx is the card to throw out after forming chinchón with the other 6? 
    // Actually traditional chinchón: all 7 cards form one run — validate all 7
    // Some variants: draw, form 7-card run, discard the last drawn? 
    // We allow: declare chinchón with all 7 in hand (after draw = 8 cards, pick 7 to form run)
    const { discardIdx } = msg;
    if (discardIdx === undefined || discardIdx < 0 || discardIdx >= player.hand.length) {
      chSendTo(player, {type:'error',msg:'Indica la carta a descartar'}); return;
    }
    const remaining = player.hand.filter((_,i) => i !== discardIdx);
    if (!chIsChinchon(remaining, room.variant)) {
      chSendTo(player, {type:'error',msg:'Tus 7 cartas no forman un Chinchón (escalera completa del mismo palo)'}); return;
    }

    const discardCard = player.hand[discardIdx];
    room.lastBajar = { playerName: player.name, combos:[remaining], discard: discardCard, isChinchon: true };
    chLog(room, `🎉 ¡CHINCHÓN! ${player.name} gana la ronda con -10 puntos`);
    chBroadcast(room, { type:'chinchon', playerName: player.name, hand: remaining, discard: discardCard });
    chEndRound(room, pidx, true);
    return;
  }

  if (msg.type === 'nextRound') {
    if (room.state !== 'round_end') return;
    if (!room.readyForNext.includes(player.id)) {
      room.readyForNext.push(player.id);
      const alive = room.players.filter(p=>!p.eliminated).length;
      chBroadcast(room, { type:'ready_count', count: room.readyForNext.length, total: alive });
    }
    if (room.readyForNext.length >= room.players.filter(p=>!p.eliminated).length) {
      chDeal(room);
    }
    return;
  }

  if (msg.type === 'chat') {
    chBroadcast(room, { type:'chat', from: player.name, msg: msg.text });
    return;
  }
}



// ═══════════════════════════════════════════════════════════════════════════════
// ███ WEBSOCKET UNIFICADO
// ═══════════════════════════════════════════════════════════════════════════════
const wss = new WebSocketServer({ server: httpServer });
let globalCounter = 0;

wss.on('connection', (ws) => {
  const playerId = `p${++globalCounter}`;
  let playerRoom = null;
  let playerData = null;
  let playerGame = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const game = msg.game;

    // ── CREATE ROOM ──────────────────────────────────────────────────────────
    if (msg.type === 'getOnlineCounts') {
      const countPlayers = (store) => Object.values(store).reduce((s, r) => s + r.players.length, 0);
      sendTo({ ws }, { type: 'online_counts', mus: countPlayers(musRooms), caida: countPlayers(caidaRooms), poker: countPlayers(pokerRooms), uno: countPlayers(unoRooms), chinchon: countPlayers(chinchonRooms) });
      return;
    }

    if (msg.type === 'createRoom') {
      if (!game) return;
      playerGame = game;
      if (game === 'mus') {
        const maxP = msg.maxPlayers === 2 ? 2 : 4;
        const code = genCode('M', musRooms);
        musRooms[code] = musCreateRoom(code, maxP);
        const room = musRooms[code];
        const p = { id: playerId, ws, name: msg.name || 'Jugador', team: 0, hand: [], ready: false };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: code, playerId });
        musSendState(room);
        return;
      }
      if (game === 'caida') {
        const maxP = [2,3,4].includes(msg.maxPlayers) ? msg.maxPlayers : 4;
        const code = genCode('C', caidaRooms);
        caidaRooms[code] = caidaCreateRoom(code, maxP);
        const room = caidaRooms[code];
        const p = { id: playerId, ws, name: msg.name || 'Jugador', hand: [], collected: [], score: 0, canto: null };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: code, playerId });
        caidaBroadcast(room, { type: 'log', msg: `👤 ${p.name} creó la sala` });
        caidaSendState(room);
        return;
      }
      if (game === 'poker') {
        const code = genCode('P', pokerRooms);
        pokerRooms[code] = pokerCreateRoom(code, msg.maxPlayers || 6);
        const room = pokerRooms[code];
        const p = { id: playerId, ws, name: msg.name || 'Jugador', chips: 1000, hand: [], folded: false, eliminated: false, bet: 0, totalBet: 0, actedThisStreet: false, allIn: false };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: code, playerId });
        pokerSendState(room);
        return;
      }
      if (game === 'uno') {
        const code = genCode('U', unoRooms);
        unoRooms[code] = unoCreateRoom(code, msg.maxPlayers || 4, msg.mode || 'classic', msg.winCon || 'hand');
        const room = unoRooms[code];
        const p = { id: playerId, ws, name: msg.name || 'Jugador', hand: [], totalPoints: 0, eliminated: false, calledUno: false };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: code, playerId });
        unoSendState(room);
        return;
      }
      if (game === 'chinchon') {
        const code = genCode('H', chinchonRooms);
        chinchonRooms[code] = chCreateRoom(code, msg.maxPlayers || 4, msg.variant || 'es');
        const room = chinchonRooms[code];
        const p = { id: playerId, ws, name: msg.name || 'Jugador', hand: [], points: 0, eliminated: false };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: code, playerId });
        chSendState(room);
        return;
      }
    }

    // ── JOIN ROOM ────────────────────────────────────────────────────────────
    if (msg.type === 'joinRoom') {
      if (!game) return;
      playerGame = game;
      const store = game === 'mus' ? musRooms : game === 'caida' ? caidaRooms : game === 'uno' ? unoRooms : game === 'chinchon' ? chinchonRooms : pokerRooms;
      const room = store[msg.code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala no encontrada' })); return; }
      if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala llena' })); return; }

      // ── RECONNECTION: if game is in progress, allow player to rejoin by name ──
      if (room.state !== 'waiting') {
        const existingPlayer = room.players.find(p => p.name === (msg.name || 'Jugador'));
        if (existingPlayer) {
          // Update WebSocket reference for this player
          existingPlayer.ws = ws;
          playerRoom = room; playerData = existingPlayer;
          sendTo(existingPlayer, { type: 'joined', roomCode: room.code, playerId: existingPlayer.id });
          if (game === 'mus') {
            musBroadcast(room, { type: 'log', msg: `🔄 ${existingPlayer.name} se ha reconectado` });
            musSendState(room);
          } else if (game === 'caida') {
            caidaBroadcast(room, { type: 'log', msg: `🔄 ${existingPlayer.name} se ha reconectado` });
            caidaSendState(room);
          } else if (game === 'poker') {
            pokerBroadcast(room, { type: 'log', msg: `🔄 ${existingPlayer.name} se ha reconectado` });
            pokerSendState(room);
          } else if (game === 'uno') {
            unoBroadcast(room, { type: 'log', msg: `🔄 ${existingPlayer.name} se ha reconectado` });
            unoSendState(room);
          } else if (game === 'chinchon') {
            chBroadcast(room, { type: 'log', msg: `🔄 ${existingPlayer.name} se ha reconectado` });
            chSendState(room);
          }
          return;
        }
        ws.send(JSON.stringify({ type: 'error', msg: 'Partida en curso' })); return;
      }

      if (game === 'mus') {
        const seatIdx = room.players.length;
        const team = seatIdx % 2;
        const p = { id: playerId, ws, name: msg.name || 'Jugador', team, hand: [], ready: false };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: room.code, playerId });
        musBroadcast(room, { type: 'log', msg: `👤 ${p.name} se unió al equipo ${team+1}` });
        musSendState(room);
        if (room.players.length === room.maxPlayers) {
          musBroadcast(room, { type: 'log', msg: `✅ ¡${room.maxPlayers} jugadores! Comenzando en 3s...` });
          setTimeout(() => musStartGame(room), 3000);
        }
        return;
      }
      if (game === 'caida') {
        const p = { id: playerId, ws, name: msg.name || 'Jugador', hand: [], collected: [], score: 0, canto: null };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: room.code, playerId });
        caidaBroadcast(room, { type: 'log', msg: `👤 ${p.name} se unió` });
        caidaSendState(room);
        if (room.players.length === room.maxPlayers) {
          caidaBroadcast(room, { type: 'log', msg: `✅ ¡${room.maxPlayers} jugadores! Comenzando en 3s...` });
          setTimeout(() => caidaStartGame(room), 3000);
        }
        return;
      }
      if (game === 'poker') {
        const p = { id: playerId, ws, name: msg.name || 'Jugador', chips: 1000, hand: [], folded: false, eliminated: false, bet: 0, totalBet: 0, actedThisStreet: false, allIn: false };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: room.code, playerId });
        pokerBroadcast(room, { type: 'log', msg: `👤 ${p.name} se unió` });
        pokerSendState(room);
        return;
      }
      if (game === 'uno') {
        const p = { id: playerId, ws, name: msg.name || 'Jugador', hand: [], totalPoints: 0, eliminated: false, calledUno: false };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: room.code, playerId });
        unoBroadcast(room, { type: 'log', msg: `👤 ${p.name} se unió` });
        unoSendState(room);
        return;
      }
      if (game === 'chinchon') {
        const p = { id: playerId, ws, name: msg.name || 'Jugador', hand: [], points: 0, eliminated: false };
        room.players.push(p);
        playerRoom = room; playerData = p;
        sendTo(p, { type: 'joined', roomCode: room.code, playerId });
        chBroadcast(room, { type: 'log', msg: `👤 ${p.name} se unió` });
        chSendState(room);
        return;
      }
    }

    if (!playerRoom || !playerData) return;

    // ── MUS MESSAGES ─────────────────────────────────────────────────────────
    if (playerGame === 'mus') {
      const room = playerRoom;
    if (msg.type === 'ready') {
      playerData.ready = true;
      musBroadcast(room, { type: 'log', msg: `${playerData.name} está listo` });
      musSendState(room);
      return;
    }

    if (msg.type === 'listoNuevaPartida') {
      if (room.phase !== 'end') return;
      if (!room.listoNuevaPartida) room.listoNuevaPartida = [];
      if (!room.listoNuevaPartida.includes(playerId)) {
        room.listoNuevaPartida.push(playerId);
        musBroadcast(room, { type: 'log', msg: `✅ ${playerData.name} listo para nueva partida (${room.listoNuevaPartida.length}/${room.players.length})` });
        musBroadcast(room, { type: 'nueva_partida_count', count: room.listoNuevaPartida.length, total: room.players.length });
      }
      if (room.listoNuevaPartida.length >= room.players.length) {
        room.listoNuevaPartida = [];
        room.matchHistory = [];
        room.scores = [0, 0];
        room.round = 0;
        room.dealer = (room.dealer + 1) % room.players.length;
        musBroadcast(room, { type: 'log', msg: '🔄 ¡Nueva partida!' });
        musBroadcast(room, { type: 'new_game' });
        musDealCards(room);
      }
      return;
    }

    if (msg.type === 'listo') {
      if (room.phase !== 'show_hands') return;
      if (!room.listoVotes) room.listoVotes = [];
      if (!room.listoVotes.includes(playerId)) {
        room.listoVotes.push(playerId);
        musBroadcast(room, { type: 'log', msg: `✅ ${playerData.name} está listo para continuar (${room.listoVotes.length}/${room.players.length})` });
        // Send updated listo count to all
        musBroadcast(room, { type: 'listo_count', count: room.listoVotes.length, total: room.players.length });
        musSendState(room);
      }
      if (room.listoVotes.length >= room.players.length) {
        room.listoVotes = [];
        room.dealer = (room.dealer + 1) % room.players.length;
        room.round++;
        musDealCards(room);
      }
      return;
    }

    if (msg.type === 'mus') {
      if (room.phase !== 'mus') return;
      // Sequential mus: only the current musVoteTurn player can vote
      const pidxMus = room.players.indexOf(playerData);
      if (room.musVoteTurn !== undefined && room.musVoteTurn >= 0 && pidxMus !== room.musVoteTurn) {
        musSendTo(playerData, { type: 'error', msg: 'Espera tu turno para votar' });
        return;
      }
      if (!room.musVotes.includes(playerId)) room.musVotes.push(playerId);
      // Track mus requested
      ensureStat(room, playerData);
      room.playerStats[playerId].musRequested++;
      musBroadcast(room, { type: 'log', msg: `${playerData.name} pide MUS` });
      // Advance musVoteTurn to next player
      room.musVoteTurn = (pidxMus + 1) % room.players.length;
      if (room.musVotes.length === room.players.length) {
        musBroadcast(room, { type: 'log', msg: '🔄 ¡MUS! Cambiando cartas en orden...' });
        room.mus = true;
        room.musVotes = [];
        room.musCount++;
        room.state = 'cambio';
        room.phase = 'cambio';
        room.players.forEach(p => { p.discardSelected = null; });
        // Sequential discard: start with mano player
        const manoIdxForDiscard = (room.dealer + 1) % room.players.length;
        room.discardTurn = manoIdxForDiscard;
        room.discardDone = [];
        musBroadcast(room, { type: 'log', msg: `🃏 Le toca cambiar a ${room.players[room.discardTurn].name}` });
        musSendState(room);
      } else {
        musSendState(room);
      }
      return;
    }

    if (msg.type === 'noMus') {
      // Track noMus
      ensureStat(room, playerData);
      room.playerStats[playerId].noMus++;
      if (room.phase !== 'mus') return;
      // Check if it's this player's turn to vote
      const pidxNoMus = room.players.indexOf(playerData);
      if (room.musVoteTurn >= 0 && pidxNoMus !== room.musVoteTurn) {
        musSendTo(playerData, { type: 'error', msg: 'Espera tu turno para votar' });
        return;
      }
      musBroadcast(room, { type: 'log', msg: `${playerData.name} dice NO HAY MUS` });
      room.musVoteTurn = -1;
      room.state = 'grande';
      room.phase = 'grande';
      room.phaseIndex = 0;
      room.activeBet = null;
      room.paso = [];
      room.currentTurn = (room.dealer + 1) % room.players.length;
      musSendState(room);
      return;
    }

    if (msg.type === 'discard') {
      if (room.phase !== 'cambio') return;
      // Sequential discard: only the current discardTurn player can act
      const pidxDiscard = room.players.indexOf(playerData);
      if (pidxDiscard !== room.discardTurn) {
        musSendTo(playerData, { type: 'error', msg: 'Espera tu turno para cambiar cartas' });
        return;
      }
      if (!msg.indices || msg.indices.length < 1) {
        musSendTo(playerData, { type: 'error', msg: 'Debes descartar al menos 1 carta para pedir Mus' });
        return;
      }
      // Apply this player's discard immediately
      const indices = msg.indices || [];
      indices.forEach(i => {
        if (playerData.hand[i]) {
          room.discards.push(playerData.hand[i]);
          // Recycle deck if needed
          if (room.deck.length === 0 && room.discards.length > 0) {
            room.deck = musShuffle([...room.discards]);
            room.discards = [];
          }
          playerData.hand[i] = room.deck.pop();
        }
      });
      musBroadcast(room, { type: 'log', msg: `🃏 ${playerData.name} cambia ${indices.length} carta(s)` });
      room.discardDone.push(pidxDiscard);

      // Advance to next player in mano order
      let nextDiscard = -1;
      for (let t = 1; t <= room.players.length; t++) {
        const candidate = (room.discardTurn + t) % room.players.length;
        if (!room.discardDone.includes(candidate)) { nextDiscard = candidate; break; }
      }

      if (nextDiscard === -1) {
        // All players have discarded
        if (room.deck.length < room.players.length && room.discards.length > 0) {
          room.deck = musShuffle([...room.deck, ...room.discards]);
          room.discards = [];
        }
        musBroadcast(room, { type: 'log', msg: '✅ Cambio completado. ¿Más mus?' });
        room.state = 'mus';
        room.phase = 'mus';
        room.musVotes = [];
        room.discardTurn = -1;
        room.discardDone = [];
        room.musVoteTurn = (room.dealer + 1) % room.players.length; // start from mano
        musSendState(room);
      } else {
        room.discardTurn = nextDiscard;
        musBroadcast(room, { type: 'log', msg: `🃏 Le toca cambiar a ${room.players[room.discardTurn].name}` });
        musSendState(room);
      }
      return;
    }

    if (msg.type === 'betAction') {
      musHandleBetAction(room, playerId, msg.action, msg.amount);
      return;
    }

    if (msg.type === 'chat') {
      musBroadcast(room, { type: 'chat', from: playerData.name, msg: msg.text });
      return;
    } // end last mus handler
    } // end playerGame===mus

    // ── CAÍDA MESSAGES ───────────────────────────────────────────────────────
    if (playerGame === 'caida') {
      const room = playerRoom;
    if (msg.type === 'puestoChoice') {
      if (playerRoom.state !== 'puesto_choosing') return;
      if (playerRoom.players.indexOf(playerData) !== playerRoom.dealer) {
        caidaSendTo(playerData, { type: 'error', msg: 'Solo el repartidor elige' }); return;
      }
      caidaStartPuesto(playerRoom, msg.direction === 'asc' ? 'asc' : 'desc');
      return;
    }

    if (msg.type === 'playCard') {
      if (playerRoom.state !== 'playing') return;
      const pidx = playerRoom.players.indexOf(playerData);
      if (pidx !== playerRoom.currentTurn) { caidaSendTo(playerData, { type: 'error', msg: 'No es tu turno' }); return; }
      if (msg.cardIndex < 0 || msg.cardIndex >= playerData.hand.length) return;
      caidaPlayCard(playerRoom, pidx, msg.cardIndex);
      return;
    }

    if (msg.type === 'nextRound') {
      if (playerRoom.state !== 'round_end') return;
      if (!playerRoom.readyForNext.includes(playerId)) {
        playerRoom.readyForNext.push(playerId);
        caidaBroadcast(playerRoom, { type: 'ready_count', count: playerRoom.readyForNext.length, total: playerRoom.players.length });
        caidaAddLog(playerRoom, `✅ ${playerData.name} listo (${playerRoom.readyForNext.length}/${playerRoom.players.length})`);
      }
      // FIX: compare against current player count (handles disconnects during round_end)
      if (playerRoom.readyForNext.length >= playerRoom.players.length) {
        playerRoom.readyForNext = [];
        caidaDealRound(playerRoom);
      }
      return;
    }

    if (msg.type === 'chat') {
      caidaBroadcast(playerRoom, { type: 'chat', from: playerData.name, msg: msg.text });
      return;
    } // end last caida handler
    } // end playerGame===caida

    // ── POKER MESSAGES ───────────────────────────────────────────────────────
    if (playerGame === 'poker') {
      const room = playerRoom;
      if (msg.type === 'startGame') {
        console.log(`[poker] startGame from ${playerData.name}, room=${room?.code}, state=${room?.state}, players=${room?.players?.length}`);
        if (!room || room.state !== 'waiting') { console.log('[poker] startGame rejected: state=', room?.state); return; }
        if (room.players.length < 2) { pokerSendTo(playerData, { type: 'error', msg: 'Se necesitan al menos 2 jugadores' }); return; }
        pokerStartGame(room); return;
      }

      if (msg.type === 'action') {
        if (!room || room.state !== 'playing') return;
        const pidx = room.players.indexOf(playerData);
        if (pidx !== room.currentTurn) { pokerSendTo(playerData, { type: 'error', msg: 'No es tu turno' }); return; }
        pokerHandleAction(room, pidx, msg.action, msg.amount);
        return;
      }

      if (msg.type === 'nextHand') {
        if (!room || room.state !== 'hand_end') return;
        if (!room.readyForNext.includes(playerId)) {
          room.readyForNext.push(playerId);
          pokerBroadcast(room, { type: 'ready_count', count: room.readyForNext.length, total: room.players.filter(p => !p.eliminated).length });
        }
        if (room.readyForNext.length >= room.players.filter(p => !p.eliminated).length) {
          pokerStartHand(room);
        }
        return;
      }

      if (msg.type === 'chat') {
        pokerBroadcast(room, { type: 'chat', from: playerData.name, msg: msg.text });
        return;
      }

      // ── REVEAL FOLDED HAND ─────────────────────────────────────────────────
      // A folded player can choose to show their hand to everyone at hand_end
      if (msg.type === 'revealFolded') {
        if (!room || room.state !== 'hand_end') return;
        const revealPlayer = room.players.find(p => p.id === playerId);
        if (!revealPlayer || !revealPlayer.folded || !revealPlayer.hand || !revealPlayer.hand.length) return;
        // Broadcast the revealed hand to all players
        pokerBroadcast(room, {
          type: 'revealFolded',
          name: revealPlayer.name,
          hand: revealPlayer.hand,
          handName: revealPlayer.handName || null,
        });
        return;
      }

      // ── HIDE FOLDED HAND ───────────────────────────────────────────────────
      if (msg.type === 'hideFolded') {
        if (!room || room.state !== 'hand_end') return;
        pokerBroadcast(room, { type: 'hideFolded', name: playerData.name });
        return;
      }
    } // end playerGame===poker

    // ══════════════════════════════════════════════════════
    // ███ SOLITARIO — LEADERBOARD
    // ══════════════════════════════════════════════════════
    if (msg.game === 'solitario') {
      playerGame = 'solitario';
      if (msg.type === 'sol_getLeaderboard') {
        sendTo({ ws }, { type: 'sol_leaderboard', topScore: lbDB.solitario.score, topMoves: lbDB.solitario.moves });
        return;
      }
      if (msg.type === 'sol_submitScore') {
        const { name, score, moves } = msg;
        if (!name || typeof score !== 'number' || typeof moves !== 'number') return;
        LB.solSubmit(lbDB, name, score, moves);
        const lb = { type: 'sol_leaderboard', topScore: lbDB.solitario.score, topMoves: lbDB.solitario.moves };
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify(lb)); });
        return;
      }
    }
    // ███ LOBBY — CROSS-GAME LEADERBOARD
    if (msg.type === 'getAllLeaderboard') {
      sendTo({ ws }, { type: 'all_leaderboard', data: lbDB });
      return;
    }


    // ── UNO MESSAGES ─────────────────────────────────────────────────────────
    if (playerGame === 'uno') {
      const room = playerRoom;
      if (!room) return;

      if (msg.type === 'startGame') {
        if (room.state !== 'waiting') return;
        if (room.players.length < 2) { unoSendTo(playerData, {type:'error',msg:'Necesitas al menos 2 jugadores'}); return; }
        unoLog(room, `🎮 ¡Comienza UNO ${room.mode === 'mercy' ? 'No Mercy' : 'Clásico'}! ${room.players.length} jugadores`);
        unoStartHand(room);
        return;
      }

      if (msg.type === 'playCard') {
        if (room.state !== 'playing') return;
        const pidx = room.players.indexOf(playerData);
        if (pidx !== room.currentTurn) { unoSendTo(playerData, {type:'error',msg:'No es tu turno'}); return; }
        const card = playerData.hand[msg.cardIdx];
        if (!card) return;
        if (!unoCanPlay(room, card)) { unoSendTo(playerData, {type:'error',msg:'Esa carta no es jugable'}); return; }

        // Remove from hand
        playerData.hand.splice(msg.cardIdx, 1);
        playerData.calledUno = false;

        // If player now has exactly 1 card and hasn't called UNO → open catch window
        if (playerData.hand.length === 1 && !playerData.calledUno) {
          // Broadcast that this player is vulnerable (others can call UNO on them)
          room._unoVulnerable = playerId;
          room._unoVulnerableTimer = setTimeout(() => {
            if (room._unoVulnerable === playerId) room._unoVulnerable = null;
          }, 4000); // 4 second window to catch
          unoBroadcast(room, { type: 'uno_vulnerable', name: playerData.name, playerId });
        } else {
          // If played their last card, vulnerability cleared
          if (playerData.hand.length === 0) room._unoVulnerable = null;
        }

        room.discard.push(card);
        unoLog(room, `🃏 ${playerData.name} juega ${card.color||''} ${card.type === 'number' ? card.value : card.type}`);

        // Handle 7-swap
        if (card.type === 'number' && card.value === 7 && room.mode === 'mercy') {
          const targets = room.players.filter(p => p.id !== playerId && !p.eliminated).map(p => p.name);
          if (targets.length > 0 && msg.swapTarget) {
            const target = room.players.find(p => p.name === msg.swapTarget && !p.eliminated);
            if (target) {
              const tmp = playerData.hand; playerData.hand = target.hand; target.hand = tmp;
              unoLog(room, `🔁 ${playerData.name} intercambia mano con ${target.name}`);
            }
          } else if (targets.length > 0 && !msg.swapTarget) {
            unoSendTo(playerData, { type:'ask_swap', cardIdx: msg.cardIdx, targets });
            playerData.hand.splice(msg.cardIdx, 0, card); // put card back
            room.discard.pop();
            return;
          }
        }

        // Check win
        if (unoCheckWinCondition(room, pidx)) return;

        // Apply effect
        unoApplyEffect(room, card, msg.chosenColor, playerId);
        return;
      }

      if (msg.type === 'drawCard') {
        if (room.state !== 'playing') return;
        const pidx = room.players.indexOf(playerData);
        if (pidx !== room.currentTurn) { unoSendTo(playerData, {type:'error',msg:'No es tu turno'}); return; }

        if (room.stack > 0) {
          // Must take the full stack
          const n = room.stack;
          room.stack = 0;
          const ended = unoForceDraw(room, pidx, n);
          if (ended) return;
          unoLog(room, `📥 ${playerData.name} toma ${n} cartas del stack`);
          unoNextTurn(room);
          return;
        }

        // Normal draw
        unoEnsureDeck(room);
        if (room.deck.length === 0) { unoSendTo(playerData, {type:'error',msg:'Mazo vacío'}); return; }
        const drawn = room.deck.shift();
        playerData.hand.push(drawn);
        unoLog(room, `📥 ${playerData.name} roba una carta`);

        // Check if drawn card is playable
        if (unoCanPlay(room, drawn)) {
          room.canPass = true;
          room.mustPlay = false;
          unoSendState(room);
        } else {
          // Auto-pass
          unoNextTurn(room);
        }
        return;
      }

      if (msg.type === 'passTurn') {
        if (room.state !== 'playing') return;
        const pidx = room.players.indexOf(playerData);
        if (pidx !== room.currentTurn) return;
        if (!room.canPass) { unoSendTo(playerData, {type:'error',msg:'No puedes pasar ahora'}); return; }
        room.canPass = false;
        unoNextTurn(room);
        return;
      }

      if (msg.type === 'callUno') {
        playerData.calledUno = true;
        // Clear vulnerability if this player called for themselves
        if (room._unoVulnerable === playerId) room._unoVulnerable = null;
        unoBroadcast(room, { type:'uno_shout', name: playerData.name });
        unoLog(room, `🎉 ¡${playerData.name} dice UNO!`);
        return;
      }

      // Another player catches someone who didn't call UNO
      if (msg.type === 'catchUno') {
        if (room.state !== 'playing') return;
        const targetId = room._unoVulnerable;
        if (!targetId) { unoSendTo(playerData, { type:'error', msg:'No hay nadie que pillar' }); return; }
        if (targetId === playerId) { unoSendTo(playerData, { type:'error', msg:'No puedes pillarte a ti mismo' }); return; }
        const target = room.players.find(p => p.id === targetId);
        if (!target || target.hand.length !== 1) { room._unoVulnerable = null; return; }
        // Penalty: target draws 2 cards
        room._unoVulnerable = null;
        if (room._unoVulnerableTimer) { clearTimeout(room._unoVulnerableTimer); room._unoVulnerableTimer = null; }
        unoForceDraw(room, room.players.indexOf(target), 2);
        unoLog(room, `🚨 ¡${playerData.name} pilla a ${target.name} sin decir UNO! +2 cartas`);
        unoBroadcast(room, { type:'uno_caught', catcher: playerData.name, caught: target.name });
        unoSendState(room);
        return;
      }

      if (msg.type === 'nextHand') {
        if (room.state !== 'hand_end') return;
        if (!room.readyForNext.includes(playerId)) {
          room.readyForNext.push(playerId);
          const alive = room.players.filter(p => !p.eliminated);
          unoBroadcast(room, { type:'ready_count', count: room.readyForNext.length, total: alive.length });
        }
        if (room.readyForNext.length >= room.players.filter(p=>!p.eliminated).length) {
          unoStartHand(room);
        }
        return;
      }

      if (msg.type === 'chat') {
        unoBroadcast(room, { type:'chat', from: playerData.name, msg: msg.text });
        return;
      }
    } // end playerGame === uno

  }); // end ws.on message

  ws.on('close', () => {
    if (!playerRoom || !playerData) return;
    if (playerGame === 'mus') {
      musBroadcast(playerRoom, { type: 'log', msg: `⚠️ ${playerData.name} se desconectó` });
      playerRoom.players = playerRoom.players.filter(p => p.id !== playerId);
      if (playerRoom.players.length === 0) { delete musRooms[playerRoom.code]; return; }
      musSendState(playerRoom);
    } else if (playerGame === 'caida') {
      caidaBroadcast(playerRoom, { type: 'log', msg: `⚠️ ${playerData.name} se desconectó` });
      playerRoom.players = playerRoom.players.filter(p => p.id !== playerId);
      if (playerRoom.players.length === 0) { delete caidaRooms[playerRoom.code]; return; }
      const n = playerRoom.players.length;
      if (playerRoom.currentTurn !== undefined && playerRoom.currentTurn >= n)
        playerRoom.currentTurn = playerRoom.currentTurn % n;
      caidaSendState(playerRoom);
    } else if (playerGame === 'poker') {
      pokerBroadcast(playerRoom, { type: 'log', msg: `⚠️ ${playerData.name} se fue` });
      playerRoom.players = playerRoom.players.filter(p => p.id !== playerId);
      if (playerRoom.players.length === 0) { delete pokerRooms[playerRoom.code]; return; }
      if (playerRoom.currentTurn >= playerRoom.players.length) playerRoom.currentTurn = 0;
      pokerSendState(playerRoom);
    } else if (playerGame === 'uno') {
      unoBroadcast(playerRoom, { type: 'log', msg: `⚠️ ${playerData.name} se desconectó` });
      if (playerRoom.state === 'playing') playerData.eliminated = true;
      else playerRoom.players = playerRoom.players.filter(p => p.id !== playerId);
      if (playerRoom.players.length === 0) { delete unoRooms[playerRoom.code]; return; }
      unoSendState(playerRoom);
    } else if (playerGame === 'chinchon') {
      chBroadcast(playerRoom, { type: 'log', msg: `⚠️ ${playerData.name} se desconectó` });
      if (playerRoom.state === 'playing') playerData.eliminated = true;
      else playerRoom.players = playerRoom.players.filter(p => p.id !== playerId);
      if (playerRoom.players.length === 0) { delete chinchonRooms[playerRoom.code]; return; }
      chSendState(playerRoom);
    }
  });
}); // end wss.on connection

// ─── START ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎮 Arcade Server — puerto ${PORT}`);
  console.log('  /       → Lobby');
  console.log('  /mus    → Mus');
  console.log('  /caida  → Caída');
  console.log('  /poker  → Poker\n');
});