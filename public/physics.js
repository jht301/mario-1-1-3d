// =============================================================================
// physics.js — Side-scroller platformer physics + player/enemy controllers.
// =============================================================================
//
// PURE LOGIC. No Three.js, no DOM. Everything operates on plain numeric structs
// so the whole module is headless-testable in Node. game.js syncs meshes <-> the
// numeric state every frame.
//
// COORDINATE SYSTEM (matches level-1-1.js + spec.md)
//   X = right (level progression), Y = up. Z is ignored for collision.
//   1 tile = 1 world unit. y = 0 is the TOP SURFACE of the ground.
//   A tile at integer (x, y) occupies the world AABB [x, x+1] x [y, y+1].
//
// PLAYER / AABB CONVENTION
//   player.pos is the AABB MIN corner (left, bottom). The player box is
//   [pos.x, pos.x + size.w] x [pos.y, pos.y + size.h]. So pos.y is the FEET.
//
// SOLIDS
//   `solids` is an Array of static AABBs: { minX, minY, maxX, maxY, type }.
//   They are axis-aligned tile boxes (1x1, or n-wide for ground spans / pipes).
//
// UNITS: world units; all times are seconds (delta time `dt`).
// =============================================================================

// ---- Tunable constants (exported so game.js / tests can read them) ----------
export const PHYS = {
  gravity: -38,          // world units / s^2 (negative = down)
  moveAccel: 30,         // horizontal acceleration while a direction is pressed
  maxRunSpeed: 9,        // max horizontal speed (units/s)
  friction: 24,          // deceleration when no horizontal input (units/s^2)
  jumpVelocity: 20,      // initial upward velocity on jump (~5.26-tile apex; clears
                         // the height-4 pipes with ~1.3 tiles margin + the 8-step
                         // staircase, so 1-1 is completable and fair on mobile)
  jumpCutoff: 0.45,      // velocity multiplier applied once when jump released early
  maxFallSpeed: -30,     // terminal velocity (units/s, negative = down)

  // ---- platformer feel extras ----
  coyoteTime: 0.10,      // seconds after leaving a ledge you can still jump
  jumpBuffer: 0.10,      // seconds a jump press is remembered before landing
  killPlaneY: -4,        // if the player's top falls below this -> dead (pit)
  stompBounce: 14,       // upward velocity given to the player after a stomp

  // ---- enemy (goomba) tuning ----
  goombaSpeed: 2.2,      // goomba patrol speed (units/s)
};

// =============================================================================
// Generic AABB helpers
// =============================================================================

// True when two AABBs overlap. Each arg is { minX, minY, maxX, maxY }.
// Touching edges (a.maxX === b.minX) does NOT count as an intersection, which
// keeps a player sliding flush along a wall from registering a phantom hit.
export function aabbIntersect(a, b) {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minY < b.maxY &&
    a.maxY > b.minY
  );
}

// Build an AABB from a min-corner + size. Handy for the engine.
export function boxFrom(x, y, w, h) {
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

// =============================================================================
// Player
// =============================================================================

// Construct a player controller.
//   spawn : { x, y } tile coords. y is the FEET (bottom of the AABB) so the
//           player stands ON the surface at that y.
//   size  : [w, h] player AABB in world units (e.g. manifest 'mario' size's
//           [w, h] -- the depth component is ignored).
export function createPlayer(spawn, size) {
  const w = size[0];
  const h = size[1];
  return {
    // pos is the AABB MIN corner (left, bottom).
    pos: { x: spawn.x, y: spawn.y },
    vel: { x: 0, y: 0 },
    size: { w, h },

    onGround: false,
    facing: 1,            // 1 = right, -1 = left (for sprite flip)
    dead: false,
    won: false,

    // internal feel timers (seconds)
    _coyote: 0,           // counts down after leaving the ground
    _buffer: 0,           // counts down after a jump press
    _jumpHeld: false,     // tracks jump-button hold for variable-height cutoff
    _spawn: { x: spawn.x, y: spawn.y },

    // Convenience: current world-space AABB.
    aabb() {
      return {
        minX: this.pos.x,
        minY: this.pos.y,
        maxX: this.pos.x + this.size.w,
        maxY: this.pos.y + this.size.h,
      };
    },
  };
}

// Reset a player back to its spawn (called by game.js after a death beat).
export function respawnPlayer(player) {
  player.pos.x = player._spawn.x;
  player.pos.y = player._spawn.y;
  player.vel.x = 0;
  player.vel.y = 0;
  player.onGround = false;
  player.facing = 1;
  player.dead = false;
  player.won = false;
  player._coyote = 0;
  player._buffer = 0;
  player._jumpHeld = false;
}

// -----------------------------------------------------------------------------
// stepPlayer — advance the player one frame. Mutates `player` in place.
//   player : Player (from createPlayer)
//   input  : { left, right, jump, jumpPressed } from controls.js
//   solids : Array<{ minX, minY, maxX, maxY, type }>
//   dt     : seconds since last frame (clamp upstream to ~1/30 max)
// Returns: { hitBelow: [solid,...] } — solids struck from below this frame, so
//          the engine can trigger ? / brick reactions. (Return is optional info;
//          all gameplay state is on `player`.)
// -----------------------------------------------------------------------------
export function stepPlayer(player, input, solids, dt) {
  if (player.dead || player.won) {
    // Frozen: let the engine play its death/win beat. Still integrate nothing.
    return { hitBelow: [] };
  }

  const wasOnGround = player.onGround;

  // --- 1) Horizontal acceleration / friction ---------------------------------
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir !== 0) {
    player.vel.x += dir * PHYS.moveAccel * dt;
    // clamp to max run speed
    if (player.vel.x > PHYS.maxRunSpeed) player.vel.x = PHYS.maxRunSpeed;
    if (player.vel.x < -PHYS.maxRunSpeed) player.vel.x = -PHYS.maxRunSpeed;
    player.facing = dir;
  } else {
    // friction toward 0
    const f = PHYS.friction * dt;
    if (player.vel.x > f) player.vel.x -= f;
    else if (player.vel.x < -f) player.vel.x += f;
    else player.vel.x = 0;
  }

  // --- 2) Jump (with coyote time + input buffering) --------------------------
  // Buffer a fresh press so a tap just before landing still jumps.
  if (input.jumpPressed) player._buffer = PHYS.jumpBuffer;
  else player._buffer = Math.max(0, player._buffer - dt);

  // Coyote: allow jumping for a short window after walking off a ledge.
  player._coyote = wasOnGround ? PHYS.coyoteTime : Math.max(0, player._coyote - dt);

  if (player._buffer > 0 && player._coyote > 0) {
    player.vel.y = PHYS.jumpVelocity;
    player.onGround = false;
    player._buffer = 0;
    player._coyote = 0;
    player._jumpHeld = true;
  }

  // Variable jump height: when the player releases jump while still rising,
  // cut the upward velocity ONCE so a tap = short hop, a hold = full hop.
  if (player._jumpHeld && !input.jump) {
    if (player.vel.y > 0) player.vel.y *= PHYS.jumpCutoff;
    player._jumpHeld = false;
  }
  // Safety: if we somehow start falling, the cutoff is no longer relevant.
  if (player.vel.y <= 0) player._jumpHeld = player._jumpHeld && input.jump;

  // --- 3) Gravity ------------------------------------------------------------
  player.vel.y += PHYS.gravity * dt;
  if (player.vel.y < PHYS.maxFallSpeed) player.vel.y = PHYS.maxFallSpeed;

  // --- 4) Resolve movement per-axis (X first, then Y) ------------------------
  // onGround is recomputed below: false unless a downward collision lands us.
  player.onGround = false;

  resolveAxisX(player, solids, player.vel.x * dt);
  const hitBelow = resolveAxisY(player, solids, player.vel.y * dt);

  // --- 5) Pit / kill-plane death --------------------------------------------
  if (player.pos.y + player.size.h < PHYS.killPlaneY) {
    player.dead = true;
  }

  return { hitBelow };
}

// Move the player along X by `dx` and resolve against solids (slide along walls).
function resolveAxisX(player, solids, dx) {
  if (dx === 0) return;
  player.pos.x += dx;
  const box = player.aabb();

  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (!aabbIntersect(box, s)) continue;
    if (dx > 0) {
      // moving right -> push out to the solid's left face
      player.pos.x = s.minX - player.size.w;
    } else {
      // moving left -> push out to the solid's right face
      player.pos.x = s.maxX;
    }
    player.vel.x = 0;
    // refresh box after the correction so subsequent solids resolve correctly
    box.minX = player.pos.x;
    box.maxX = player.pos.x + player.size.w;
  }
}

// Move the player along Y by `dy` and resolve. Returns solids hit from BELOW
// (i.e. the player's head struck their underside) for ?/brick reactions.
function resolveAxisY(player, solids, dy) {
  const hitBelow = [];
  if (dy === 0) return hitBelow;
  player.pos.y += dy;
  const box = player.aabb();

  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (!aabbIntersect(box, s)) continue;
    if (dy < 0) {
      // moving down -> land on top of the solid
      player.pos.y = s.maxY;
      player.vel.y = 0;
      player.onGround = true;
    } else {
      // moving up -> bonk the underside of the solid
      player.pos.y = s.minY - player.size.h;
      player.vel.y = 0;
      hitBelow.push(s);
    }
    box.minY = player.pos.y;
    box.maxY = player.pos.y + player.size.h;
  }
  return hitBelow;
}

// =============================================================================
// Goombas (patrol enemies)
// =============================================================================

// Construct a goomba. spawn.y is the FEET (bottom). size is [w, h] (depth
// ignored). Goombas walk LEFT initially (faithful to 1-1).
export function createGoomba(spawn, size) {
  const w = size[0];
  const h = size[1];
  return {
    pos: { x: spawn.x, y: spawn.y },
    vel: { x: -PHYS.goombaSpeed, y: 0 },
    size: { w, h },
    dir: -1,              // -1 left, +1 right
    onGround: false,
    dead: false,          // stomped/removed
    aabb() {
      return {
        minX: this.pos.x,
        minY: this.pos.y,
        maxX: this.pos.x + this.size.w,
        maxY: this.pos.y + this.size.h,
      };
    },
  };
}

// Advance all enemies one frame: gravity, walk, turn at walls AND at ledges
// (so goombas pace on a platform instead of marching off into pits — faithful
// to SMB ground goombas, which in 1-1 are confined by walls/pipes; edge-turning
// keeps them from suiciding into the famous gaps). Mutates each goomba.
//   goombas : Array<Goomba>
//   solids  : Array<solid AABB>
//   dt      : seconds
export function stepEnemies(goombas, solids, dt) {
  for (let i = 0; i < goombas.length; i++) {
    const g = goombas[i];
    if (g.dead) continue;

    // --- gravity ---
    g.vel.y += PHYS.gravity * dt;
    if (g.vel.y < PHYS.maxFallSpeed) g.vel.y = PHYS.maxFallSpeed;

    // horizontal velocity is just direction * speed
    g.vel.x = g.dir * PHYS.goombaSpeed;

    // --- resolve X: turn around when bumping a wall ---
    if (g.vel.x !== 0) {
      g.pos.x += g.vel.x * dt;
      const box = g.aabb();
      for (let j = 0; j < solids.length; j++) {
        const s = solids[j];
        if (!aabbIntersect(box, s)) continue;
        if (g.vel.x > 0) g.pos.x = s.minX - g.size.w;
        else g.pos.x = s.maxX;
        g.dir = -g.dir;     // flip
        g.vel.x = 0;
        box.minX = g.pos.x;
        box.maxX = g.pos.x + g.size.w;
      }
    }

    // --- resolve Y: gravity + ground detection ---
    g.onGround = false;
    if (g.vel.y !== 0) {
      g.pos.y += g.vel.y * dt;
      const box = g.aabb();
      for (let j = 0; j < solids.length; j++) {
        const s = solids[j];
        if (!aabbIntersect(box, s)) continue;
        if (g.vel.y < 0) {
          g.pos.y = s.maxY;
          g.vel.y = 0;
          g.onGround = true;
        } else {
          g.pos.y = s.minY - g.size.h;
          g.vel.y = 0;
        }
        box.minY = g.pos.y;
        box.maxY = g.pos.y + g.size.h;
      }
    }

    // --- ledge detection: turn around before walking off a platform edge ---
    // Only when grounded. Probe a thin box just past the leading foot and one
    // step below the feet; if there is NO solid under that probe, flip.
    if (g.onGround) {
      const aheadX = g.dir > 0 ? g.pos.x + g.size.w + 0.02 : g.pos.x - 0.02;
      const probe = {
        minX: aheadX - 0.02,
        maxX: aheadX + 0.02,
        minY: g.pos.y - 0.15,   // just below the feet
        maxY: g.pos.y - 0.02,
      };
      let groundAhead = false;
      for (let j = 0; j < solids.length; j++) {
        if (aabbIntersect(probe, solids[j])) { groundAhead = true; break; }
      }
      if (!groundAhead) g.dir = -g.dir;
    }
  }
}

// -----------------------------------------------------------------------------
// resolveEnemyHits — player vs goombas interaction.
//   Stomp: player is falling (vel.y < 0) AND their feet are above the goomba's
//          mid-line at contact -> kill goomba, bounce the player.
//   Side : any other contact -> the player dies.
// Mutates player + goombas. Returns the number of goombas stomped this frame
// (so the engine can add score / spawn squash effects).
// -----------------------------------------------------------------------------
export function resolveEnemyHits(player, goombas) {
  if (player.dead || player.won) return 0;
  let stomped = 0;
  const pbox = player.aabb();

  for (let i = 0; i < goombas.length; i++) {
    const g = goombas[i];
    if (g.dead) continue;
    const gbox = g.aabb();
    if (!aabbIntersect(pbox, gbox)) continue;

    // Stomp test: player descending and their feet started above the goomba's
    // vertical midpoint (i.e. coming down onto the top, not walking into a side).
    const goombaMid = g.pos.y + g.size.h * 0.5;
    const fallingOnTop = player.vel.y < 0 && player.pos.y >= goombaMid;

    if (fallingOnTop) {
      g.dead = true;
      player.vel.y = PHYS.stompBounce;   // bounce
      player.onGround = false;
      // lift the player just clear of the (now dead) goomba's top
      player.pos.y = g.pos.y + g.size.h;
      pbox.minY = player.pos.y;
      pbox.maxY = player.pos.y + player.size.h;
      stomped++;
    } else {
      player.dead = true;
      return stomped;
    }
  }
  return stomped;
}

// =============================================================================
// Collectibles / win / death helpers (thin AABB overlaps for the engine)
// =============================================================================

// True if the player overlaps a coin AABB. The engine builds coin AABBs from the
// coin's tile center +/- half-size and hides + scores the mesh on a true return.
export function coinOverlap(player, coinBox) {
  return aabbIntersect(player.aabb(), coinBox);
}

// Flagpole / win check. Either pass the flagpole AABB OR a flagX column.
//   flag : { minX, minY, maxX, maxY }  OR  a number (tile column flagX).
// Sets player.won = true and returns true on first contact.
export function checkFlag(player, flag) {
  if (player.won) return true;
  let hit;
  if (typeof flag === 'number') {
    // X-column crossing: player's right edge reaches the flag column.
    hit = player.pos.x + player.size.w >= flag;
  } else {
    hit = aabbIntersect(player.aabb(), flag);
  }
  if (hit) player.won = true;
  return player.won;
}

// Pit / kill-plane check (also enforced inside stepPlayer; exported so the engine
// can test independently or with a custom floor). Sets player.dead, returns it.
export function checkPit(player, killPlaneY = PHYS.killPlaneY) {
  if (player.pos.y + player.size.h < killPlaneY) player.dead = true;
  return player.dead;
}
