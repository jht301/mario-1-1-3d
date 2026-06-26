// level-completable.mjs — DETERMINISTIC proof the level can be finished.
// Imports the real physics.js + level-1-1.js and simulates a greedy auto-player
// (hold right; jump when blocked ahead, near a ledge, or stalled). No browser.
import { LEVEL } from '../public/level-1-1.js';
import * as P from '../public/physics.js';

// ---- Build solids exactly like game.js does -------------------------------
const solids = [];
const add = (minX, minY, maxX, maxY, type) => solids.push({ minX, minY, maxX, maxY, type });
let flagX = LEVEL.flagX ?? null;
for (const o of LEVEL.objects) {
  switch (o.type) {
    case 'ground': add(o.x, -(LEVEL.groundHeight ?? 2), o.x + (o.w || 1), 0, 'ground'); break;
    case 'brick': case 'used': case 'question': add(o.x, o.y, o.x + 1, o.y + 1, o.type); break;
    case 'pipe': add(o.x, 0, o.x + 2, (o.pipeHeight || 1), 'pipe'); break;
    case 'flagpole': if (flagX == null) flagX = o.x; break;
    default: break;
  }
}
if (flagX == null) flagX = LEVEL.width - 12;

// ---- Greedy auto-player ----------------------------------------------------
const player = P.createPlayer(LEVEL.spawn, [0.8, 1.4]);
const input = { left: false, right: true, jump: false, jumpPressed: false, consume() { this.jumpPressed = false; } };

const DT = 1 / 60;
const MAX_STEPS = 60 * 90; // 90 s of sim
let maxX = player.pos.x, stuckSteps = 0, lastX = player.pos.x, won = false, deaths = 0;

function solidAt(x, yMin, yMax) {
  for (const s of solids) if (x >= s.minX && x < s.maxX && yMax > s.minY && yMin < s.maxY) return s;
  return null;
}

let jumpHold = 0; // frames to keep holding jump for full height
for (let step = 0; step < MAX_STEPS; step++) {
  const p = player;
  const feet = p.pos.y, right = p.pos.x + p.size.w;

  // Look AHEAD with anticipation (~2.5 tiles) so jumps start with run-up clearance.
  // Wall: any solid in front taller than ~knee height within the lookahead.
  let wallAhead = false;
  for (let dx = 0.3; dx <= 2.6; dx += 0.4) {
    if (solidAt(right + dx, feet + 0.4, feet + p.size.h - 0.1)) { wallAhead = true; break; }
  }
  // Pit: no floor under a spot ~1.5 tiles ahead while grounded.
  const floorAhead = solidAt(right + 1.5, feet - 0.7, feet);
  const nearGap = !floorAhead && p.onGround;
  const stalled = (p.pos.x - lastX) < 0.004;
  stuckSteps = stalled ? stuckSteps + 1 : 0;
  lastX = p.pos.x;

  // Trigger a fresh jump on the rising edge, then HOLD for full apex. Use a long
  // hold (full height) — over-clearing a short pipe is fine; under-clearing isn't.
  if (p.onGround && (wallAhead || nearGap || stuckSteps > 3)) jumpHold = 22;
  input.jumpPressed = (jumpHold === 22);   // edge only on the first frame
  input.jump = jumpHold > 0;               // held for variable height
  if (jumpHold > 0) jumpHold--;

  P.stepPlayer(player, input, solids, DT);
  input.consume();

  // death by pit -> respawn (the level is still "completable" if we can pass)
  if (player.dead) { deaths++; P.respawnPlayer(player); }

  maxX = Math.max(maxX, player.pos.x);
  if (flagX != null && player.pos.x + player.size.w >= flagX) { won = true; break; }
}

console.log(JSON.stringify({
  won, flagX, maxX: +maxX.toFixed(1), finalX: +player.pos.x.toFixed(1),
  deaths, levelWidth: LEVEL.width,
}, null, 0));
if (won) { console.log('RESULT: PASS — reachable flag at x=' + flagX + ' (maxX=' + maxX.toFixed(1) + ')'); process.exit(0); }
else { console.log('RESULT: FAIL — stuck. maxX=' + maxX.toFixed(1) + ' / flag at ' + flagX); process.exit(1); }
