// =============================================================================
// level-1-1.js — Authoritative level data for Super Mario Bros World 1-1 (2.5D)
// =============================================================================
//
// COORDINATE SYSTEM
//   X = level progression. Right = +X. One tile = 1 world unit.
//   Y = up. y = 0 is the TOP SURFACE of the ground (i.e. the plane Mario walks
//       on when standing on flat ground). y = 1 is one tile above the ground
//       surface, y = -1 is one tile below (inside the dirt), etc.
//   Z = depth (engine renders at z = 0 for gameplay; decorative layers may be
//       pushed to negative Z by the engine, not by this file).
//   All coordinates here are INTEGER TILE COORDINATES unless noted.
//
// SCHEMA — LEVEL = { width, groundHeight, spawn, flagX, objects: [...] }
//   width        : total level width in tiles (X extent). Camera / world bound.
//   groundHeight : number of solid tile rows that make up the ground slab,
//                  measured DOWNWARD from the surface. The surface top is y = 0;
//                  the slab fills y = -1 .. y = -groundHeight. Purely visual/
//                  structural depth so the floor isn't paper-thin.
//   spawn        : { x, y } tile coords where Mario starts (y is feet position,
//                  on the ground surface => y = 0).
//   flagX        : X tile column of the flagpole (used for win detection).
//
//   objects[]    : explicit placed objects. Each object:
//     { type, x, y, w, h, pipeHeight?, contains?, count? }
//
//   COMMON FIELDS
//     type   : one of the strings below.
//     x, y   : tile coordinate of the object's ANCHOR.
//                - For most objects the anchor is the BOTTOM-LEFT tile cell.
//                - A 1x1 block at (x, y) occupies the cell whose bottom-left
//                  corner is (x, y) and top-right corner is (x+1, y+1). Its
//                  center in world space is (x + 0.5, y + 0.5).
//                - For 'ground' spans, y is the surface row index of the TOP
//                  row of the span; ground extends downward groundHeight rows.
//     w, h   : width/height in tiles. Default 1 if omitted. For multi-tile
//              structures the engine should instantiate w*h individual tiles
//              (e.g. a ground span of w=10 => 10 surface tiles side by side).
//
//   TYPE-SPECIFIC FIELDS
//     ground   : { x, y:0, w }      Solid floor span. w tiles wide starting at x.
//                                    GAPS (pits) are simply the X ranges with NO
//                                    ground object. The asset is 'ground'.
//     brick    : { x, y }           1x1 breakable brick block. Asset 'brick'.
//     question : { x, y, contains } 1x1 ? block. contains ∈ 'coin'|'mushroom'.
//                                    Asset 'question' (becomes 'used' when hit).
//     used     : { x, y }           1x1 already-spent block (solid). Asset 'used'.
//     pipe     : { x, y:0, pipeHeight } Green pipe. Occupies 2 tiles wide. Its
//                                    base sits on the ground surface (y=0) and it
//                                    rises pipeHeight tiles. Asset 'pipe' (the
//                                    engine stacks/scales to pipeHeight). Solid.
//     coin     : { x, y }           Free-floating collectible coin (the kind you
//                                    grab in mid-air). Asset 'coin'. Not solid.
//     goomba   : { x, y:0 }         Enemy spawn, standing on the surface. Walks
//                                    left initially. Asset 'goomba'.
//     flagpole : { x }              The end-of-level flagpole. Asset 'flagpole'
//                                    + 'flag'. y implied (base on ground).
//     castle   : { x }              The end castle. Asset 'castle'. Decorative.
//     cloud    : { x, y }           Background decoration. Asset 'cloud'.
//     bush     : { x, y:0 }         Background/foreground decoration on ground.
//     hill     : { x, y:0 }         Background hill decoration.
//
//   NOTES ON FAITHFULNESS
//     Tile counts are faithful-but-approximate to the NES original. The classic
//     beats appear in the correct order along X. The well-known "coin row" above
//     the first brick cluster, the mushroom in the 4th-from-left ? block, the
//     hidden mushroom brick, the staircases (4-up/4-down pyramids), the long
//     final pit, and the 8-step staircase before the flag are all encoded.
//
// =============================================================================

// ---- helper builders (keep the data terse + readable) -----------------------
const ground = (x, w) => ({ type: 'ground', x, y: 0, w });
const brick = (x, y) => ({ type: 'brick', x, y });
const q = (x, y, contains = 'coin') => ({ type: 'question', x, y, contains });
const pipe = (x, pipeHeight) => ({ type: 'pipe', x, y: 0, pipeHeight });
const coin = (x, y) => ({ type: 'coin', x, y });
const goomba = (x) => ({ type: 'goomba', x, y: 0 });
const cloud = (x, y) => ({ type: 'cloud', x, y });
const bush = (x) => ({ type: 'bush', x, y: 0 });
const hill = (x) => ({ type: 'hill', x, y: 0 });

// Build a staircase of solid 'used'-style blocks (Mario's staircases are made of
// the dark stair blocks; we use 'used' as the solid stair tile). `dir` = +1 up
// to the right, -1 down to the right. `steps` columns, max height `steps`.
function stairsUp(startX, steps) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const colX = startX + i;
    const colH = i + 1; // 1 tall, then 2, ...
    for (let yy = 0; yy < colH; yy++) out.push({ type: 'used', x: colX, y: yy });
  }
  return out;
}
function stairsDown(startX, steps) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const colX = startX + i;
    const colH = steps - i; // tall first, shrinking to the right
    for (let yy = 0; yy < colH; yy++) out.push({ type: 'used', x: colX, y: yy });
  }
  return out;
}

// =============================================================================
// THE LEVEL
// =============================================================================
// X budget (approx NES-faithful, ~212 tiles wide):
//   0..68    : start flat, first ?, brick/? row, first Goomba, pipes 2/3/4/4
//   69..86   : first pit, then floating bricks + coins, two Goombas
//   87..118  : ground, hidden-1up/coin bricks, pyramid #1 (up & down)
//   119..152 : pipe(2), pit jumps, more bricks, pyramid #2
//   153..198 : final ground run, the long pit, 8-step staircase
//   198..212 : flagpole + castle
// =============================================================================

const objects = [];

// ---- GROUND SPANS (gaps between spans are the pits) -------------------------
// Famous pits of 1-1: a small one after the pipes, a mid one, and the long one
// right before the final staircase.
objects.push(ground(0, 69));     // long opening run up to first pit (ends x=68)
// PIT #1: x = 69..70 (2 tiles wide)
objects.push(ground(71, 15));    // 71..85
// PIT #2: x = 86..87 (2 tiles)
objects.push(ground(88, 65));    // 88..152
// PIT #3 (the long one): x = 153..155 (3 tiles wide — the famous jump)
objects.push(ground(156, 56));   // 156..211 — final run to flag + castle

// ---- BACKGROUND DECOR (clouds, hills, bushes) -------------------------------
objects.push(hill(0));
objects.push(bush(11));
objects.push(cloud(8, 9));
objects.push(cloud(19, 10));
objects.push(hill(16));
objects.push(cloud(27, 9));
objects.push(bush(23));
objects.push(cloud(36, 10));
objects.push(hill(47));
objects.push(bush(41));
objects.push(cloud(56, 9));
objects.push(cloud(67, 10));
objects.push(hill(64));
objects.push(bush(59));
objects.push(cloud(87, 9));
objects.push(hill(96));
objects.push(bush(89));
objects.push(cloud(103, 10));
objects.push(cloud(118, 9));
objects.push(hill(112));
objects.push(bush(107));
objects.push(cloud(135, 10));
objects.push(hill(128));
objects.push(bush(125));
objects.push(cloud(152, 9));
objects.push(hill(160));
objects.push(bush(157));
objects.push(cloud(168, 10));
objects.push(cloud(183, 9));
objects.push(bush(175));

// ---- BEAT 1: first ? block (a lone coin block) ------------------------------
// In 1-1 the very first ? block sits ~16 tiles in, 4 tiles above the ground.
objects.push(q(16, 4, 'coin'));

// ---- BEAT 2: the brick + ? row (one ? hides a MUSHROOM) ---------------------
// Row at y = 4: brick, ?(coin), brick, ?(MUSHROOM — the famous power-up), brick.
// And a single ? high above at y = 8 (coin).
objects.push(brick(20, 4));
objects.push(q(21, 4, 'coin'));
objects.push(brick(22, 4));
objects.push(q(23, 4, 'mushroom'));   // <-- first power-up of the game
objects.push(brick(24, 4));
objects.push(q(22, 8, 'coin'));       // lone high ? block above the row

// ---- BEAT 3: first Goomba ---------------------------------------------------
objects.push(goomba(22));

// ---- BEAT 4: the pipes — heights 2, 3, 4, 4 ---------------------------------
objects.push(pipe(28, 2));
objects.push(pipe(38, 3));
objects.push(pipe(46, 4));
objects.push(pipe(57, 4));
// Two Goombas pacing between the taller pipes (a classic pinch point).
objects.push(goomba(51));
objects.push(goomba(53));

// ---- BEAT 5: after the 4th pipe, run to PIT #1 (x 69..70) --------------------
// (ground span already leaves the gap)

// ---- BEAT 6: floating brick structures + coins past the first pit -----------
// A short hop over pit #1 lands here. Bricks at y=4 with coins, plus a couple
// Goombas on the flat 71..85 stretch.
objects.push(brick(77, 4));
objects.push(q(78, 4, 'coin'));
objects.push(brick(79, 4));
objects.push(coin(78, 5));
objects.push(goomba(80));
objects.push(goomba(82));

// PIT #2 at x = 86..87 handled by ground gap.

// ---- BEAT 7: the long brick stair-into-a-wall + hidden blocks ---------------
// After pit #2 (land at 88) there is the famous multi-brick formation: a high
// row of bricks, and one ? among them (coin). Plus a hidden region of coins.
objects.push(brick(91, 4));
objects.push(brick(92, 4));
objects.push(brick(93, 4));
objects.push(q(94, 4, 'coin'));
objects.push(brick(94, 8));   // lone high brick (the "1-up" style isolated brick)
objects.push(coin(94, 9));
objects.push(goomba(97));
objects.push(goomba(99));

// ---- BEAT 8: PYRAMID #1 — staircase UP (4) then DOWN (4) ---------------------
// Classic 1-1 step pyramids built from solid stair blocks.
objects.push(...stairsUp(106, 4));    // up: heights 1,2,3,4 at x=106..109
objects.push(...stairsDown(111, 4));  // down: heights 4,3,2,1 at x=111..114
// (gap of 1 tile between the two halves at x=110 — faithful to the original)

// ---- BEAT 9: a mid pipe + more enemies --------------------------------------
objects.push(pipe(119, 2));
objects.push(goomba(125));
objects.push(goomba(127));

// ---- BEAT 10: floating bricks + ? with coins, second cluster ----------------
objects.push(brick(129, 4));
objects.push(q(130, 4, 'coin'));
objects.push(brick(131, 4));
objects.push(brick(132, 4));
objects.push(coin(130, 5));
objects.push(coin(131, 5));

// ---- BEAT 11: PYRAMID #2 — another up/down staircase -------------------------
objects.push(...stairsUp(138, 4));    // x=138..141
objects.push(...stairsDown(143, 4));  // x=143..146
objects.push(goomba(149));

// ---- BEAT 12: short brick run then THE LONG PIT (x 153..155) -----------------
objects.push(brick(150, 4));
objects.push(brick(151, 4));
objects.push(coin(150, 5));
objects.push(coin(151, 5));
// long pit handled by ground gap 153..155 (the famous "big jump")

// ---- BEAT 13: final ground run, last enemies, last coins --------------------
objects.push(goomba(162));
objects.push(coin(165, 4));
objects.push(coin(166, 4));
objects.push(coin(167, 4));

// ---- BEAT 14: the 8-step staircase before the flag --------------------------
// A single ascending staircase 8 tiles tall (no descending half — you leap from
// the top toward the flagpole).
objects.push(...stairsUp(181, 8));   // heights 1..8 at x=181..188

// ---- BEAT 15: the flagpole ---------------------------------------------------
// Stands ~3 tiles past the top of the staircase.
const FLAG_X = 198;
objects.push({ type: 'flagpole', x: FLAG_X });

// ---- BEAT 16: the castle -----------------------------------------------------
objects.push({ type: 'castle', x: 202 });

// =============================================================================
export const LEVEL = {
  width: 212,
  groundHeight: 2,         // ground slab is 2 tiles deep below the surface
  spawn: { x: 3, y: 0 },   // Mario starts on the flat opening run
  flagX: FLAG_X,
  objects,
};

export default LEVEL;
