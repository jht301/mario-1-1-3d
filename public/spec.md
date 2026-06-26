# Mario 1-1 3D — Module Interface Contract (spec.md)

This is the **authoritative interface contract**. Every module below MUST export
exactly the names and signatures described. Modules import siblings by relative
path (e.g. `import { loadAssets } from './assets.js'`). Vanilla JS ES modules,
no TypeScript, no build step.

## Global ground rules

- **Three.js 0.160.0** from unpkg via an importmap in `index.html`:
  ```html
  <script type="importmap">
  {
    "imports": {
      "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
      "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
    }
  }
  </script>
  ```
  Import as `import * as THREE from 'three';` and
  `import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';`.
- **Coordinate system** (matches `level-1-1.js`): X = right, Y = up, Z = depth.
  1 tile = 1 world unit. Gameplay plane is z = 0. y = 0 is the ground SURFACE
  top. A tile at integer `(x, y)` occupies world AABB
  `[x, x+1] × [y, y+1] × [-0.5, 0.5]`; its mesh center is `(x+0.5, y+0.5, 0)`.
- **Everything must run with ZERO GLBs present** via primitive fallbacks.
- All numeric units are world units; all times are **seconds** (delta time `dt`).

---

## 1) `assets.js` — asset loading + fallback primitives

Loads the manifest, attempts to load each GLB, and falls back to a colored
Three.js primitive sized per the manifest when the GLB is missing or fails.

### Exports

```js
export async function loadAssets(manifestUrl) -> Promise<AssetStore>
```

- `manifestUrl` : string URL to `assets/manifest.json` (e.g. `'./assets/manifest.json'`).
- Fetches the manifest JSON. For each key under `manifest.assets`, attempts to
  GLTF-load `assets/<file>`. On success, stores the loaded scene as the template.
  On ANY failure (404, network, parse), builds a fallback `THREE.Mesh`:
  - `size` length 3 `[w,h,d]` with all dims ≈ equal → could use either; default
    rule: **box** unless the key is `coin` or `pipe`.
  - `coin` → `THREE.CylinderGeometry` (thin disc), `pipe` → `THREE.CylinderGeometry`
    (radius from size[0]/2), everything else → `THREE.BoxGeometry(w,h,d)`.
  - Material: `THREE.MeshStandardMaterial({ color: fallbackColor })`.
- Resolves to an `AssetStore` (see below). MUST NOT reject on missing GLBs.

### `AssetStore` shape

```js
{
  // Returns a fresh CLONE of the template Object3D for `key`, ready to add to
  // the scene. Caller owns position/scale. Throws if key is unknown.
  get(key) -> THREE.Object3D,

  // Returns the manifest metadata for `key`:
  //   { file, fallbackColor, size:[w,h,d], solid, isFallback:boolean }
  // `isFallback` is true when no GLB was loaded for this key.
  meta(key) -> { file, fallbackColor, size, solid, isFallback },

  // (optional helper) true if key exists in the manifest.
  has(key) -> boolean
}
```

- `get()` MUST return a deep clone (use `template.clone(true)`), so the same key
  can be instantiated many times (every brick, coin, goomba).
- Cloned meshes default to centered geometry; the engine positions the clone by
  setting `obj.position` to the tile center `(x+0.5, y+0.5, 0)`.

---

## 2) `physics.js` — player controller + AABB collision

Authoritative side-scroller physics. 2D simulation (X, Y); Z is ignored for
collision. All solids are axis-aligned 1×1 (or n×1) tile boxes.

### Exports

```js
// Tunable constants (export so game.js / tests can read them).
export const PHYS = {
  gravity: -38,          // world units / s^2 (negative = down)
  moveAccel: 30,         // horizontal acceleration while pressing
  maxRunSpeed: 9,        // max horizontal speed
  friction: 24,          // deceleration when no input (units/s^2)
  jumpVelocity: 15,      // initial upward velocity on jump
  jumpCutoff: 0.45,      // velocity multiplier when jump released early
  maxFallSpeed: -30,     // terminal velocity
};

// Construct a player controller.
//   spawn  : { x, y } tile coords (feet on surface => y is bottom of player AABB)
//   size   : [w, h] player AABB in world units (e.g. from manifest 'mario' size)
export function createPlayer(spawn, size) -> Player
```

### `Player` shape

```js
{
  pos:  THREE.Vector2 | {x,y},  // BOTTOM-CENTER? -> NO: pos is the AABB MIN corner
                                 // (left, bottom). AABB = [pos.x, pos.x+w] ×
                                 // [pos.y, pos.y+h].
  vel:  {x, y},                  // current velocity (units/s)
  size: {w, h},                  // AABB size
  onGround: boolean,             // true when standing on a solid this frame
  facing: 1 | -1,                // last horizontal direction (for sprite flip)
  dead: boolean,                 // set true on pit-fall / enemy hit
  won: boolean,                  // set true when flag reached

  aabb() -> { minX, minY, maxX, maxY }  // convenience, world coords
}
```

### Stepping the simulation

```js
// Advance one fixed-ish frame.
//   player : Player
//   input  : Input state from controls.js ({left,right,jump,jumpPressed,...})
//   solids : Array<{minX,minY,maxX,maxY, type}>  // static solid AABBs (tiles)
//   dt     : seconds since last frame (clamp upstream to ~1/30 max)
// Returns nothing; mutates `player` in place.
export function stepPlayer(player, input, solids, dt)
```

Required behavior:
- Apply horizontal input → accel toward ±maxRunSpeed; friction when no input.
- Apply gravity each frame; clamp to `maxFallSpeed`.
- **Jump**: only when `player.onGround && input.jumpPressed` → set
  `vel.y = jumpVelocity`. Variable height: if `!input.jump` while `vel.y > 0`,
  multiply `vel.y *= jumpCutoff` once (apply on the frame jump is released).
- **Collision resolution**: move X then Y (or swept), resolving against `solids`
  using AABB overlap. On landing on top of a solid set `onGround = true` and
  `vel.y = 0`. On hitting a solid from below set `vel.y = 0` (and the engine may
  inspect which block was hit to trigger ? / brick reactions).
- Set `player.onGround = false` at the start of each step; set true only if a
  downward collision is resolved.
- If `player.pos.y + h < pitFloor` (well below ground, e.g. y < -4) set
  `player.dead = true`.

### Helpers (export for the engine)

```js
// Generic swept/overlap AABB test used by the engine for coins, goombas, flag.
export function aabbIntersect(a, b) -> boolean   // a,b each {minX,minY,maxX,maxY}
```

---

## 3) `controls.js` — unified keyboard + touch input

Single source of input truth. Tracks held state and edge-triggered presses.

### Exports

```js
// Attach listeners. `domElement` is the element hosting touch buttons (usually
// document.body or the renderer canvas wrapper). Returns an Input object.
export function createInput(domElement) -> Input
```

### `Input` shape

```js
{
  left:  boolean,        // held
  right: boolean,        // held
  jump:  boolean,        // jump currently held
  jumpPressed: boolean,  // EDGE: true for one consume() cycle after a fresh press

  // Call once per frame AFTER reading state. Clears edge flags (jumpPressed).
  consume() -> void
}
```

Required behavior:
- **Keyboard**: ArrowLeft / `A` → left; ArrowRight / `D` → right;
  Space / ArrowUp / `W` → jump. `keydown` sets held + sets `jumpPressed` true on
  the transition from up→down (ignore auto-repeat: only set on first down).
  `keyup` clears held.
- **Touch / pointer**: three on-screen buttons (left, right, jump) defined as
  HTML overlay elements with ids `#btn-left`, `#btn-right`, `#btn-jump`. Use
  `pointerdown`/`pointerup`/`pointercancel`/`pointerleave`. MUST support
  **multi-touch** (hold left while tapping jump): track per-button pointer state
  independently, do not rely on a single active pointer.
  - `pointerdown` on a button → set that button's held flag; for jump also set
    `jumpPressed`. Call `e.preventDefault()` to stop scrolling/zoom.
- `consume()` resets `jumpPressed = false` (the engine calls it at the end of
  each frame so a press is read exactly once).
- Must not throw if the button elements are absent (keyboard-only fallback).

---

## 4) `game.js` — main loop wiring (entry module)

Boots Three.js, loads assets, builds the level from `level-1-1.js`, wires
physics + controls, runs the render loop, camera follow, enemy + coin logic.

### Exports

```js
// Bootstrap the whole game. Typically called from index.html as:
//   import { startGame } from './game.js'; startGame();
export async function startGame() -> Promise<void>
```

Required wiring (prescriptive):
1. Create `THREE.Scene`, `THREE.PerspectiveCamera`, `THREE.WebGLRenderer`
   (antialias on, append canvas to DOM, handle resize). Add ambient +
   directional light. Sky-blue background (`0x5c94fc`).
2. `const assets = await loadAssets('./assets/manifest.json');`
3. Import `LEVEL` from `./level-1-1.js`. Iterate `LEVEL.objects`:
   - For each tile/structure, `assets.get(type)` (mapping object `type` →
     asset key; `used`→'used', `flagpole`→'flagpole' + 'flag', etc.), position
     the clone at tile center, add to scene.
   - Expand spans: `ground` w-wide → w tiles; pipes scaled to `pipeHeight`;
     staircase blocks (`used`) placed per their `(x,y)`.
   - Build a `solids[]` array of `{minX,minY,maxX,maxY,type}` for every object
     whose asset `meta(key).solid === true` (ground, brick, question, used,
     pipe). Ground spans contribute one merged box per span (optimization OK).
   - Collect `coins[]`, `goombas[]`, `flag`, with their meshes + AABBs.
4. `const input = createInput(document.body);`
5. `const player = createPlayer(LEVEL.spawn, assets.meta('mario').size);`
   Add Mario mesh (`assets.get('mario')`).
6. **Loop** via `renderer.setAnimationLoop`:
   - Compute `dt` (clamp to ≤ 1/30 s).
   - `stepPlayer(player, input, solids, dt);`
   - Update Mario mesh position from `player.pos` (+ size offset to center).
   - Move goombas (walk, flip at solids/edges); for each, if
     `aabbIntersect(playerAABB, goombaAABB)`: stomp (player.vel.y>0 / coming
     from above → kill goomba, bounce player) else `player.dead = true`.
   - Coins: on overlap, hide mesh + increment score.
   - Question/brick reaction: when player hits a solid from below at that tile,
     swap `question`→`used` mesh and spawn coin/mushroom per `contains`.
   - Camera follow: `camera.position.x = max(startX, player.pos.x)`, fixed +Z
     offset (e.g. 12) and slight +Y lift (e.g. 4); never scroll left past start.
   - Win: when `player.pos.x >= LEVEL.flagX` → `player.won = true`, play slide.
   - Death: `player.dead` → reset to spawn (or restart) after a beat.
   - `input.consume();` then `renderer.render(scene, camera);`
7. Mobile: ensure the touch overlay (`#btn-left/#btn-right/#btn-jump`) exists in
   `index.html`; `game.js` only reads input via `controls.js`.

### Asset-key mapping (object.type → manifest key)

| object.type | asset key(s)        |
|-------------|---------------------|
| ground      | `ground`            |
| brick       | `brick`             |
| question    | `question` / `used` |
| used        | `used`              |
| pipe        | `pipe`              |
| coin        | `coin`              |
| goomba      | `goomba`            |
| flagpole    | `flagpole` + `flag` |
| castle      | `castle`            |
| cloud       | `cloud`             |
| bush        | `bush`              |
| hill        | `hill`              |
| (player)    | `mario`             |

---

## Determinism / sequencing contract (so modules compose)

- `controls.js` is read-only state; `game.js` calls `input.consume()` once per
  frame, last thing before render.
- `physics.js` never imports Three meshes — it works purely on numeric AABBs and
  the `player` struct. `game.js` syncs meshes ⇄ physics each frame.
- `assets.js` is the only module that touches the GLTFLoader / manifest.
- `level-1-1.js` is pure data (no Three import). It is the single source of the
  layout; the schema is documented in its top comment and consumed verbatim.
