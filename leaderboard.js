/**
 * leaderboard.js — Persistent leaderboard via JSON file on disk
 * Survives server restarts on Render (file persists in /opt/render/project/src/)
 */
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'leaderboard_data.json');

const DEFAULT = () => ({
  solitario: { score: [], moves: [] },
  mus:       { partidas: [] },
  caida:     { top: [] },
  poker:     { top: [] },
  uno:       { top: [] },
  chinchon:  { top: [] },
  ajedrez:   { top: [] },
});

let db = DEFAULT();

// Load from disk on startup
try {
  if (fs.existsSync(FILE)) {
    const raw = fs.readFileSync(FILE, 'utf8');
    db = Object.assign(DEFAULT(), JSON.parse(raw));
    console.log('[leaderboard] Loaded from disk ✅');
  } else {
    console.log('[leaderboard] No file found, starting fresh');
  }
} catch(e) {
  console.error('[leaderboard] Error loading:', e.message);
  db = DEFAULT();
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(db), 'utf8');
    } catch(e) {
      console.error('[leaderboard] Error saving:', e.message);
    }
  }, 2000);
}

function load() { return db; }

function solSubmit(lbDB, name, score, moves) {
  const lb = lbDB.solitario;
  const ex = lb.score.find(e => e.name === name);
  if (!ex) lb.score.push({ name, score, moves });
  else if (score > ex.score || (score === ex.score && moves < ex.moves)) { ex.score = score; ex.moves = moves; }
  lb.score.sort((a,b) => b.score - a.score || a.moves - b.moves);
  lb.score = lb.score.slice(0, 10);
  const exM = lb.moves.find(e => e.name === name);
  if (!exM) lb.moves.push({ name, moves, score });
  else if (moves < exM.moves || (moves === exM.moves && score > exM.score)) { exM.moves = moves; exM.score = score; }
  lb.moves.sort((a,b) => a.moves - b.moves || b.score - a.score);
  lb.moves = lb.moves.slice(0, 10);
  scheduleSave();
}

function musRecordWin(lbDB, winnerNames, loserNames, winScore, loseScore) {
  const lb = lbDB.mus;
  const upsert = (name, won) => {
    let p = lb.partidas.find(e => e.name === name);
    if (!p) { p = { name, wins: 0, losses: 0, tantos: 0 }; lb.partidas.push(p); }
    if (won) { p.wins++; p.tantos += winScore; } else { p.losses++; p.tantos += loseScore; }
  };
  winnerNames.forEach(n => upsert(n, true));
  loserNames.forEach(n => upsert(n, false));
  lb.partidas.sort((a,b) => b.wins - a.wins || b.tantos - a.tantos);
  lb.partidas = lb.partidas.slice(0, 20);
  scheduleSave();
}

function caidaRecordWin(lbDB, winnerName, pts) {
  const lb = lbDB.caida;
  let p = lb.top.find(e => e.name === winnerName);
  if (!p) { p = { name: winnerName, wins: 1, pts }; lb.top.push(p); }
  else { p.wins++; p.pts += pts; }
  lb.top.sort((a,b) => b.wins - a.wins || b.pts - a.pts);
  lb.top = lb.top.slice(0, 20);
  scheduleSave();
}

function pokerRecordWin(lbDB, winnerName, chips) {
  const lb = lbDB.poker;
  let p = lb.top.find(e => e.name === winnerName);
  if (!p) { p = { name: winnerName, wins: 1, bestChips: chips }; lb.top.push(p); }
  else { p.wins++; if (chips > p.bestChips) p.bestChips = chips; }
  lb.top.sort((a,b) => b.wins - a.wins || b.bestChips - a.bestChips);
  lb.top = lb.top.slice(0, 20);
  scheduleSave();
}

function unoRecordWin(lbDB, name, points) {
  const lb = lbDB.uno;
  let p = lb.top.find(e => e.name === name);
  if (!p) { p = { name, wins: 1, bestPoints: points }; lb.top.push(p); }
  else { p.wins++; if (points > p.bestPoints) p.bestPoints = points; }
  lb.top.sort((a,b) => b.wins - a.wins || b.bestPoints - a.bestPoints);
  lb.top = lb.top.slice(0, 20);
  scheduleSave();
}

function chinchonRecordWin(lbDB, name, score) {
  const lb = lbDB.chinchon;
  let p = lb.top.find(e => e.name === name);
  if (!p) { p = { name, wins: 1, bestScore: score }; lb.top.push(p); }
  else { p.wins++; if (score < p.bestScore) p.bestScore = score; } // lower = better in chinchon
  lb.top.sort((a,b) => b.wins - a.wins || a.bestScore - b.bestScore);
  lb.top = lb.top.slice(0, 20);
  scheduleSave();
}

function ajedrezRecordWin(lbDB, name) {
  const lb = lbDB.ajedrez;
  let p = lb.top.find(e => e.name === name);
  if (!p) { p = { name, wins: 1 }; lb.top.push(p); }
  else p.wins++;
  lb.top.sort((a,b) => b.wins - a.wins);
  lb.top = lb.top.slice(0, 20);
  scheduleSave();
}

module.exports = { load, solSubmit, musRecordWin, caidaRecordWin, pokerRecordWin, unoRecordWin, chinchonRecordWin, ajedrezRecordWin };
