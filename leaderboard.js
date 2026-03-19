/**
 * leaderboard.js — Persistent leaderboard for Render.com
 * Guarda en memoria + env var LEADERBOARD_DATA via Render API (opcional).
 * Sin credenciales: dura mientras el servidor está vivo.
 *
 * Para persistencia real: añadir en Render → Environment:
 *   RENDER_API_KEY   = tu API key de Render (render.com → Account → API Keys)
 *   RENDER_SERVICE_ID = el ID de tu servicio (render.com → tu servicio → URL: .../services/srv-XXXX)
 */

const DEFAULT = () => ({
  solitario: { score: [], moves: [] },
  mus:       { partidas: [] },
  caida:     { top: [] },
  poker:     { top: [] },
  uno:       { top: [] },
});

let db = DEFAULT();

try {
  if (process.env.LEADERBOARD_DATA) {
    db = Object.assign(DEFAULT(), JSON.parse(process.env.LEADERBOARD_DATA));
    console.log('[leaderboard] Cargado desde env var LEADERBOARD_DATA');
  }
} catch(e) { console.error('[leaderboard] Error al parsear env var:', e.message); }

const RENDER_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID = process.env.RENDER_SERVICE_ID;

let saveTimer = null;
async function persistToRender() {
  if (!RENDER_KEY || !SERVICE_ID) return;
  try {
    const res = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${RENDER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ key: 'LEADERBOARD_DATA', value: JSON.stringify(db) }]),
    });
    if (res.ok) console.log('[leaderboard] Guardado en Render');
    else console.warn('[leaderboard] Render API error:', res.status);
  } catch(e) { console.error('[leaderboard] Error al guardar:', e.message); }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistToRender, 3000);
}

function load() { return db; }

function unoRecordWin(lbDB, name, points) {
  if (!lbDB.uno) lbDB.uno = { top: [] };
  const lb = lbDB.uno;
  let p = lb.top.find(e => e.name === name);
  if (!p) { p = { name, wins: 1, bestPoints: points }; lb.top.push(p); }
  else { p.wins++; if (points > p.bestPoints) p.bestPoints = points; }
  lb.top.sort((a,b) => b.wins - a.wins || b.bestPoints - a.bestPoints);
  lb.top = lb.top.slice(0, 20);
  scheduleSave();
}

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

module.exports = { load, solSubmit, musRecordWin, caidaRecordWin, pokerRecordWin, unoRecordWin };
