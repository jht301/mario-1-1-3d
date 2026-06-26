// =============================================================================
// game.js — main loop wiring (entry module) for Mario 1-1 3D
// =============================================================================
//
// Boots Three.js, loads assets (with primitive fallbacks for missing GLBs),
// builds the level from level-1-1.js, wires physics + controls, and runs the
// render loop: camera follow, enemy + coin logic, stomp/death/win.
//
// COORDINATE CONTRACT (see spec.md / level-1-1.js / assets.js):
//   X = right, Y = up, Z = depth. 1 tile = 1 world unit. Gameplay at z = 0.
//   y = 0 is the TOP SURFACE of the ground.
//   A tile at integer (x, y) occupies world AABB [x,x+1] x [y,y+1]; its mesh
//   center is (x+0.5, y+0.5, 0).
//   Asset templates are CENTERED on X/Z with their BASE at y = 0, so a clone is
//   positioned by setting its position to the tile's bottom-center
//   (x_min + w/2, y_min, 0).
//
//   player.pos is the AABB MIN corner (left, bottom). Mario's mesh (centered X/Z,
//   base at y=0) is therefore placed at (pos.x + size.w/2, pos.y, 0).
// =============================================================================

import * as THREE from 'three';

import { loadAssets } from './assets.js';
import { LEVEL } from './level-1-1.js';
import {
  PHYS,
  createPlayer,
  respawnPlayer,
  stepPlayer,
  createGoomba,
  stepEnemies,
  resolveEnemyHits,
  coinOverlap,
  aabbIntersect,
} from './physics.js';
import { createInput } from './controls.js';

// ---- camera / loop tuning ---------------------------------------------------
const CAM_Z = 12;          // fixed +Z offset (looks down -Z)
const CAM_Y = 3;           // slight Y lift
const CAM_LOOK_Y = 1.5;    // look at ~Mario height so the play plane is centered
const CAM_LERP = 0.12;     // smoothing factor for horizontal follow
const MAX_DT = 1 / 30;     // clamp delta time so a stutter can't tunnel collisions
const DEATH_BEAT = 1.0;    // seconds to pause on death before respawn
const DEPTH_DECOR = -3;    // push background decor behind the gameplay plane

/**
 * startGame() — bootstrap everything. Exported and called by index.html.
 * Resolves once the loop is running (window.__GAME_READY is also set true).
 */
export async function startGame() {
  // =========================================================================
  // 1) THREE scene / camera / renderer / lights
  // =========================================================================
  const root = document.getElementById('game-root') || document.body;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x5c94fc); // SMB sky blue

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(LEVEL.spawn.x, CAM_Y, CAM_Z);
  camera.lookAt(LEVEL.spawn.x, CAM_LOOK_Y, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  root.appendChild(renderer.domElement);

  // Lights: a hemisphere for soft sky/ground fill + a directional "sun".
  const hemi = new THREE.HemisphereLight(0xffffff, 0x4a7a2a, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(-5, 12, 8);
  scene.add(sun);
  // Faithful-ish ambient so fallback materials never render pitch black.
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  // =========================================================================
  // 2) Load assets (never rejects on missing GLBs — falls back to primitives)
  // =========================================================================
  const assets = await loadAssets('./assets/manifest.json');

  // =========================================================================
  // 3) Build the level from LEVEL.objects
  // =========================================================================
  const solids = [];      // { minX, minY, maxX, maxY, type } — static collision
  const coins = [];       // { mesh, box, taken }
  const goombaList = [];  // { ent (physics goomba), mesh }
  const questionBlocks = []; // ?-block solids, for respawn restoration
  let marioMesh = null;
  let flagInfo = null;    // { x } — flag column for win detection

  // Helper: place a centered/based template clone at a tile's bottom-center.
  //   bottomCenterX, bottomY in world units; the template's base sits at bottomY.
  function placeClone(key, bottomCenterX, bottomY, z = 0) {
    const obj = assets.get(key);
    obj.position.set(bottomCenterX, bottomY, z);
    scene.add(obj);
    return obj;
  }

  // Add a solid AABB for collision.
  function addSolid(minX, minY, maxX, maxY, type) {
    solids.push({ minX, minY, maxX, maxY, type });
  }

  for (const o of LEVEL.objects) {
    switch (o.type) {
      // ---- GROUND SPAN: w tiles wide, surface top at y = 0, slab below -----
      case 'ground': {
        const w = o.w || 1;
        const depth = LEVEL.groundHeight || 1;
        // Visual: one ground clone per surface tile (the famous block grid).
        for (let i = 0; i < w; i++) {
          // Surface row tile (top at y=0 -> bottom at y=-1).
          placeClone('ground', o.x + i + 0.5, -1);
          // Fill the slab depth below so the floor isn't paper-thin.
          for (let d = 1; d < depth; d++) {
            placeClone('ground', o.x + i + 0.5, -1 - d, 0);
          }
        }
        // Collision: ONE merged box for the whole span. Top surface at y = 0.
        addSolid(o.x, -depth, o.x + w, 0, 'ground');
        break;
      }

      // ---- 1x1 SOLID BLOCKS (brick / question / used) ---------------------
      case 'brick':
      case 'used': {
        placeClone(o.type, o.x + 0.5, o.y);
        addSolid(o.x, o.y, o.x + 1, o.y + 1, o.type);
        break;
      }
      case 'question': {
        const mesh = placeClone('question', o.x + 0.5, o.y);
        // Pre-build the 'used' mesh too and keep it hidden; bonk toggles
        // visibility instead of remove/add so respawn can restore cleanly (QA H1).
        const usedMesh = placeClone('used', o.x + 0.5, o.y);
        usedMesh.visible = false;
        const s = { minX: o.x, minY: o.y, maxX: o.x + 1, maxY: o.y + 1, type: 'question' };
        s.qMesh = mesh;
        s.usedMesh = usedMesh;
        s.contains = o.contains || 'coin';
        s.spent = false;
        s.tileX = o.x;
        s.tileY = o.y;
        solids.push(s);
        questionBlocks.push(s); // for respawn restoration
        break;
      }

      // ---- PIPE: 2 wide, base at y=0, rises pipeHeight tiles ---------------
      case 'pipe': {
        const ph = o.pipeHeight || 1;
        const mesh = placeClone('pipe', o.x + 1, 0); // 2 wide => center at x+1
        // Manifest pipe size is [2,1,2]; scale Y to pipeHeight (base stays at 0
        // because the template's base is at y=0).
        mesh.scale.y = ph;
        addSolid(o.x, 0, o.x + 2, ph, 'pipe');
        break;
      }

      // ---- COIN: free-floating collectible (not solid) --------------------
      case 'coin': {
        const mesh = placeClone('coin', o.x + 0.5, o.y + 0.5 - metaHalfH('coin'));
        // Coin AABB from tile center +/- half its manifest size (a small box).
        const sz = assets.meta('coin').size;
        const cx = o.x + 0.5;
        const cy = o.y + 0.5;
        coins.push({
          mesh,
          box: {
            minX: cx - sz[0] / 2,
            minY: cy - sz[1] / 2,
            maxX: cx + sz[0] / 2,
            maxY: cy + sz[1] / 2,
          },
          taken: false,
        });
        break;
      }

      // ---- GOOMBA: enemy spawn on the surface, walks left ------------------
      case 'goomba': {
        const sz = assets.meta('goomba').size; // [w,h,d]
        const ent = createGoomba({ x: o.x + 0.5 - sz[0] / 2, y: o.y }, sz);
        const mesh = assets.get('goomba');
        scene.add(mesh);
        goombaList.push({ ent, mesh });
        break;
      }

      // ---- FLAGPOLE: pole + flag, base on the ground ----------------------
      case 'flagpole': {
        placeClone('flagpole', o.x + 0.5, 0);
        // The flag sits near the top of the pole.
        const poleH = assets.meta('flagpole').size[1];
        placeClone('flag', o.x + 0.5 + 0.5, poleH - 1);
        flagInfo = { x: o.x };
        break;
      }

      // ---- CASTLE: decorative end structure --------------------------------
      case 'castle': {
        const cw = assets.meta('castle').size[0];
        placeClone('castle', o.x + cw / 2, 0);
        break;
      }

      // ---- DECOR: clouds / bushes / hills (pushed behind gameplay) ---------
      case 'cloud': {
        const cw = assets.meta('cloud').size[0];
        placeClone('cloud', o.x + cw / 2, o.y, DEPTH_DECOR);
        break;
      }
      case 'bush': {
        const bw = assets.meta('bush').size[0];
        placeClone('bush', o.x + bw / 2, 0, DEPTH_DECOR + 1.5);
        break;
      }
      case 'hill': {
        const hw = assets.meta('hill').size[0];
        placeClone('hill', o.x + hw / 2, 0, DEPTH_DECOR);
        break;
      }

      default:
        // Unknown type — ignore so bad data can't crash the build.
        console.warn('[game] unknown object type:', o.type);
    }
  }

  // Small helper used above: half-height of an asset's manifest size.
  function metaHalfH(key) {
    return assets.meta(key).size[1] / 2;
  }

  // =========================================================================
  // 4) Input
  // =========================================================================
  const input = createInput(document.body);

  // =========================================================================
  // 5) Player + Mario mesh
  // =========================================================================
  const marioSize = assets.meta('mario').size; // [w,h,d]
  const player = createPlayer(LEVEL.spawn, marioSize);
  marioMesh = assets.get('mario');
  scene.add(marioMesh);

  // Sync Mario's mesh to physics. pos is the AABB min corner; the mesh is
  // centered on X and based at y=0, so place at (pos.x + w/2, pos.y, 0).
  function syncMario() {
    marioMesh.position.set(
      player.pos.x + player.size.w / 2,
      player.pos.y,
      0
    );
    // Flip on facing direction (cheap sprite-like flip).
    marioMesh.scale.x = Math.abs(marioMesh.scale.x) * (player.facing >= 0 ? 1 : -1);
  }
  syncMario();

  // Sync a goomba mesh to its physics entity (centered X, base at y=0).
  function syncGoomba(g) {
    g.mesh.position.set(
      g.ent.pos.x + g.ent.size.w / 2,
      g.ent.pos.y,
      0
    );
  }
  for (const g of goombaList) syncGoomba(g);

  // =========================================================================
  // HUD + banner helpers
  // =========================================================================
  const coinCountEl = document.getElementById('coin-count');
  const bannerEl = document.getElementById('banner');
  const bannerText = document.getElementById('banner-text');
  const bannerSub = document.getElementById('banner-sub');
  const startOverlay = document.getElementById('start-overlay');

  let score = 0;
  function updateHud() {
    if (coinCountEl) {
      coinCountEl.textContent = String(score).padStart(2, '0');
    }
  }
  updateHud();

  function showBanner(state, text, sub) {
    if (!bannerEl) return;
    bannerEl.dataset.state = state;
    if (bannerText) bannerText.textContent = text;
    if (bannerSub) bannerSub.textContent = sub;
    bannerEl.hidden = false;
  }
  function hideBanner() {
    if (bannerEl) bannerEl.hidden = true;
  }

  // =========================================================================
  // Game state shared for testing
  // =========================================================================
  const state = { status: 'playing' }; // 'playing' | 'dead' | 'won'
  let deathTimer = 0;
  let started = false; // gated on first tap/key (mobile audio/gesture unlock)

  // Reset the whole level back to the start (respawn after death).
  function resetForRespawn() {
    respawnPlayer(player);
    // Revive + reset goombas to their spawns. We rebuild from scratch is
    // overkill; instead just reset position/dir/dead and re-show meshes.
    for (const g of goombaList) {
      g.ent.dead = false;
      g.ent.dir = -1;
      g.ent.vel.x = -PHYS.goombaSpeed;
      g.ent.vel.y = 0;
      g.ent.pos.x = g._spawnX;
      g.ent.pos.y = g._spawnY;
      g.mesh.visible = true;
      syncGoomba(g);
    }
    // Restore collected coins (QA H1).
    for (const c of coins) {
      c.taken = false;
      c.mesh.visible = true;
    }
    // Restore bonked ?-blocks (QA H1).
    for (const s of questionBlocks) {
      s.spent = false;
      s.type = 'question';
      if (s.qMesh) s.qMesh.visible = true;
      if (s.usedMesh) s.usedMesh.visible = false;
    }
    state.status = 'playing';
    deathTimer = 0;
  }

  // Remember goomba spawns for respawn.
  for (const g of goombaList) {
    g._spawnX = g.ent.pos.x;
    g._spawnY = g.ent.pos.y;
  }

  // =========================================================================
  // Win / start handling
  // =========================================================================
  function handleWin() {
    if (state.status === 'won') return;
    state.status = 'won';
    player.won = true;
    showBanner('win', 'YOU WIN!', 'Tap to play again');
  }

  function restartGame() {
    hideBanner();
    score = 0;
    updateHud();
    resetForRespawn();
    player.won = false;
    state.status = 'playing';
  }

  // First interaction starts the loop (hide the start overlay).
  function beginPlay() {
    if (started) return;
    started = true;
    if (startOverlay) startOverlay.hidden = true;
  }
  // Hide overlay + start on first tap or key.
  window.addEventListener('pointerdown', beginPlay, { once: false });
  window.addEventListener('keydown', beginPlay, { once: false });
  // Banner tap restarts (only when shown).
  if (bannerEl) {
    bannerEl.addEventListener('pointerdown', (e) => {
      if (!bannerEl.hidden && (state.status === 'won' || state.status === 'dead')) {
        e.stopPropagation();
        restartGame();
      }
    });
  }

  // =========================================================================
  // 6) Main loop
  // =========================================================================
  let last = performance.now() / 1000;

  function frame() {
    const now = performance.now() / 1000;
    let dt = now - last;
    last = now;
    if (dt > MAX_DT) dt = MAX_DT; // clamp to avoid tunneling on stutter
    if (dt < 0) dt = 0;

    // Don't run the simulation until the player taps "TAP TO START" — otherwise
    // gravity, goombas and timers advance behind the start overlay (QA H2).
    if (!started) {
      renderer.render(scene, camera);
      return;
    }

    if (state.status === 'playing') {
      // --- physics: player ---
      const result = stepPlayer(player, input, solids, dt);

      // --- ?-block bonk reaction: swap question -> used, score a coin ---
      if (result && result.hitBelow && result.hitBelow.length) {
        for (const s of result.hitBelow) {
          if (s.type === 'question' && !s.spent) {
            s.spent = true;
            s.type = 'used'; // becomes a plain solid
            // Toggle the pre-built meshes (so respawn can restore — QA H1).
            if (s.qMesh) s.qMesh.visible = false;
            if (s.usedMesh) s.usedMesh.visible = true;
            // Contents: a coin bumps the score (mushroom also scores here).
            score += 1;
            updateHud();
          }
        }
      }

      // --- physics: enemies ---
      stepEnemies(goombaList.map((g) => g.ent), solids, dt);

      // --- player vs goombas (stomp / death) ---
      const stomped = resolveEnemyHits(player, goombaList.map((g) => g.ent));
      if (stomped > 0) score += stomped; // a beat of feedback

      // --- sync meshes to physics ---
      syncMario();
      for (const g of goombaList) {
        if (g.ent.dead) {
          g.mesh.visible = false;
        } else {
          syncGoomba(g);
        }
      }

      // --- coin pickup ---
      for (const c of coins) {
        if (c.taken) continue;
        if (coinOverlap(player, c.box)) {
          c.taken = true;
          c.mesh.visible = false;
          score += 1;
          updateHud();
        } else {
          // gentle spin for a little life
          c.mesh.rotation.y += dt * 4;
        }
      }

      // --- win: reached the flag column ---
      if (flagInfo && player.pos.x + player.size.w >= flagInfo.x) {
        handleWin();
      }

      // --- death: pit or goomba ---
      if (player.dead) {
        state.status = 'dead';
        deathTimer = 0;
        showBanner('lose', 'GAME OVER', 'Respawning…');
      }
    } else if (state.status === 'dead') {
      // Pause on death for a beat, then auto-respawn.
      deathTimer += dt;
      if (deathTimer >= DEATH_BEAT) {
        hideBanner();
        resetForRespawn();
      }
    }

    // --- camera follow: clamp to level bounds, never scroll left of start ---
    const halfViewW = CAM_Z * Math.tan((camera.fov * Math.PI) / 180 / 2) * camera.aspect;
    const minX = LEVEL.spawn.x;
    const maxX = Math.max(minX, LEVEL.width - halfViewW);
    let targetX = player.pos.x + player.size.w / 2;
    if (targetX < minX) targetX = minX;
    if (targetX > maxX) targetX = maxX;
    camera.position.x += (targetX - camera.position.x) * CAM_LERP;
    camera.position.y = CAM_Y;
    camera.position.z = CAM_Z;
    camera.lookAt(camera.position.x, CAM_LOOK_Y, 0);

    // --- consume input edges (LAST, before render) ---
    input.consume();

    renderer.render(scene, camera);
  }

  // =========================================================================
  // Resize handling
  // =========================================================================
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  // =========================================================================
  // Publish minimal state for testing, then start the loop.
  // =========================================================================
  window.__GAME = {
    get player() { return player; },
    get coins() { return score; },
    get status() { return state.status; },
    scene,
    camera,
    solids,
    goombas: goombaList,
  };

  renderer.setAnimationLoop(frame);
  window.__GAME_READY = true;
}

export default startGame;
