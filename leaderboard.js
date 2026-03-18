/**
 * leaderboard.js — Persistent leaderboard storage for Arcade
 * Saves to leaderboard.json next to this file so rankings survive server restarts.
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'leaderboard.json');

// ── Default structure ──────────────────────────────────────────────────────
const DEFAULT = {
  solitario: { score: [], moves: [] },
  mus:        { partidas: [] },   // { name, team, wins, losses, tantos }
  caida:      { top: [] },        // { name, wins, pts }
  poker:      { top: [] },        // { name, wins, chips }
};

// ── Load from disk ─────────────────────────────────────────────────────────
function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      const data = JSON.parse(raw);
      // Merge with defaults so new keys survive upgrades
      return Object.assign({}, DEFAULT, data);
    }
  } catch (e) {
    console.error('[leaderboard] Error loading:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT));
}

// ── Save to disk ───────────────────────────────────────────────────────────
let saveTimer = null;
function save(db) {
  // Debounce writes — max one write per second
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
      console.error('[leaderboard] Error saving:', e.message);
    }
  }, 800);
}

// ── Solitario helpers ──────────────────────────────────────────────────────
function solSubmit(db, name, score, moves) {
  const lb = db.solitario;

  // Top score (higher = better, tiebreak: fewer moves)
  const ex = lb.score.find(e => e.name === name);
  if (!ex) {
    lb.score.push({ name, score, moves });
  } else if (score > ex.score || (score === ex.score && moves < ex.moves)) {
    ex.score = score; ex.moves = moves;
  }
  lb.score.sort((a, b) => b.score - a.score || a.moves - b.moves);
  lb.score = lb.score.slice(0, 10);

  // Top efficiency (fewer moves = better, tiebreak: higher score)
  const exM = lb.moves.find(e => e.name === name);
  if (!exM) {
    lb.moves.push({ name, moves, score });
  } else if (moves < exM.moves || (moves === exM.moves && score > exM.score)) {
    exM.moves = moves; exM.score = score;
  }
  lb.moves.sort((a, b) => a.moves - b.moves || b.score - a.score);
  lb.moves = lb.moves.slice(0, 10);

  save(db);
}

// ── Mus helpers ────────────────────────────────────────────────────────────
function musRecordWin(db, winnerNames, loserNames, winScore, loseScore) {
  const lb = db.mus;

  const upsert = (name, won, tantos, against) => {
    let p = lb.partidas.find(e => e.name === name);
    if (!p) { p = { name, wins: 0, losses: 0, tantos: 0 }; lb.partidas.push(p); }
    if (won) p.wins++; else p.losses++;
    p.tantos += tantos;
  };

  winnerNames.forEach(n => upsert(n, true,  winScore,  loseScore));
  loserNames.forEach(n  => upsert(n, false, loseScore, winScore));

  // Sort: wins desc, then tantos desc
  lb.partidas.sort((a, b) => b.wins - a.wins || b.tantos - a.tantos);
  lb.partidas = lb.partidas.slice(0, 20);
  save(db);
}

// ── Caída helpers ──────────────────────────────────────────────────────────
function caidaRecordWin(db, winnerName, pts) {
  const lb = db.caida;
  let p = lb.top.find(e => e.name === winnerName);
  if (!p) { p = { name: winnerName, wins: 1, pts }; lb.top.push(p); }
  else { p.wins++; p.pts += pts; }
  lb.top.sort((a, b) => b.wins - a.wins || b.pts - a.pts);
  lb.top = lb.top.slice(0, 20);
  save(db);
}

// ── Poker helpers ──────────────────────────────────────────────────────────
function pokerRecordWin(db, winnerName, chips) {
  const lb = db.poker;
  let p = lb.top.find(e => e.name === winnerName);
  if (!p) { p = { name: winnerName, wins: 1, bestChips: chips }; lb.top.push(p); }
  else { p.wins++; if (chips > p.bestChips) p.bestChips = chips; }
  lb.top.sort((a, b) => b.wins - a.wins || b.bestChips - a.bestChips);
  lb.top = lb.top.slice(0, 20);
  save(db);
}

module.exports = { load, save, solSubmit, musRecordWin, caidaRecordWin, pokerRecordWin };
