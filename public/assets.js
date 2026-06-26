// =============================================================================
// assets.js — asset loading + fallback primitives + instancing
// =============================================================================
//
// The ONLY module that touches the GLTFLoader / manifest. It loads the manifest,
// attempts to GLTF-load each GLB referenced there, and — when a GLB is missing
// or fails for ANY reason (404, network, parse) — builds a colored Three.js
// primitive of the manifest-declared size so the game is fully playable with
// ZERO GLBs present.
//
// Public API (see spec.md §1):
//   loadAssets(manifestUrl) -> Promise<AssetStore>
//   AssetStore.get(key)  -> fresh THREE.Object3D clone (caller owns transform)
//   AssetStore.meta(key) -> { file, fallbackColor, size, solid, isFallback }
//   AssetStore.has(key)  -> boolean
//
// Coordinate / normalization contract:
//   Every template is normalized so that it is CENTERED on X and Z and its BASE
//   sits at y = 0 (i.e. the template's local origin is the bottom-center of its
//   bounding box). The engine positions a clone by setting its position to the
//   tile center (x + 0.5, y + 0.5, 0) for 1x1 tiles, so a y=0-based, centered
//   template lines up: a unit box ends up spanning [y, y+1] exactly. Decorative
//   / multi-tile assets are scaled to the manifest 'size' bounding box.
// =============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Keys that should fall back to a cylinder rather than a box (per spec).
const CYLINDER_KEYS = new Set(['coin', 'pipe']);

/**
 * Parse a manifest color string (e.g. "#c8702a") into a THREE.Color.
 * Falls back to magenta so a bad color value is visually obvious rather than
 * crashing the loader.
 */
function toColor(value) {
  try {
    return new THREE.Color(value);
  } catch (err) {
    console.warn('[assets] bad fallbackColor', value, err);
    return new THREE.Color(0xff00ff);
  }
}

/**
 * Build a fallback THREE.Mesh for a key from its manifest entry.
 *   size = [w, h, d] in world units.
 *   box for everything except 'coin' / 'pipe' (cylinders).
 * The returned mesh is already normalized: centered on X/Z with its base at y=0
 * (geometry is translated up by h/2), matching the GLB normalization contract.
 */
function buildFallback(key, entry) {
  const [w, h, d] = entry.size;
  const material = new THREE.MeshStandardMaterial({
    color: toColor(entry.fallbackColor),
    roughness: 0.85,
    metalness: 0.0,
  });

  let geometry;
  if (key === 'coin') {
    // Thin disc standing up to face the camera (axis along Z so the flat face
    // points down -Z toward the side-scroller camera). radius from width.
    const r = Math.max(w, h) / 2;
    const thickness = Math.max(d, 0.05);
    geometry = new THREE.CylinderGeometry(r, r, thickness, 20);
    geometry.rotateX(Math.PI / 2); // lay the disc's flat face toward +Z/-Z
  } else if (key === 'pipe') {
    // Upright pipe: radius from size[0]/2, height from size[1].
    const r = w / 2;
    geometry = new THREE.CylinderGeometry(r, r, h, 24);
  } else {
    geometry = new THREE.BoxGeometry(w, h, d);
  }

  // Normalize: base at y = 0. CylinderGeometry & BoxGeometry are centered on the
  // origin, so shift up by half-height. (The coin disc, after rotateX, has its
  // height along Y as well, so the same shift centers/bases it correctly.)
  geometry.translate(0, h / 2, 0);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `${key}__fallback`;
  return mesh;
}

/**
 * Normalize a loaded GLB scene to the manifest contract:
 *   - center on X and Z (origin at bounding-box horizontal center),
 *   - base at y = 0 (bottom of bounding box sits on the origin plane),
 *   - scale uniformly... actually per-axis to fit the manifest 'size' bounding
 *     box exactly so collision AABBs match the visual.
 *
 * We wrap the GLB in a parent Group and bake the transform onto the child so the
 * template's own local transform is identity and clones behave predictably.
 */
function normalizeGltf(key, scene, entry) {
  const [w, h, d] = entry.size;

  // Compute the current world-space bounding box of the loaded scene.
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) {
    // Degenerate GLB (no geometry) — treat as a failure; caller will fall back.
    throw new Error(`GLB for "${key}" has no geometry / empty bounds`);
  }

  const sizeVec = new THREE.Vector3();
  box.getSize(sizeVec);
  const center = new THREE.Vector3();
  box.getCenter(center);

  // Guard against zero-extent axes (flat models) before dividing.
  const sx = sizeVec.x > 1e-6 ? w / sizeVec.x : 1;
  const sy = sizeVec.y > 1e-6 ? h / sizeVec.y : 1;
  const sz = sizeVec.z > 1e-6 ? d / sizeVec.z : 1;

  // Build the normalized template: a Group we control, with the GLB scene as a
  // child positioned/scaled so that, in the Group's local space, the model is
  // centered on X/Z and based at y = 0.
  const template = new THREE.Group();
  template.name = `${key}__gltf`;

  // Re-center the model on its own bounding box, then scale to target size, then
  // lift so its base is at y = 0. Order matters: we apply via the child's local
  // matrix. Easiest robust approach: parent a centering group.
  const inner = new THREE.Group();
  inner.add(scene);
  // Move the model so its bbox center is at the inner-group origin.
  scene.position.sub(center);
  // Scale the inner group to fit the target size.
  inner.scale.set(sx, sy, sz);
  // After scaling, the model spans [-h/2, +h/2] in Y; lift to base at y = 0.
  inner.position.y = h / 2;

  template.add(inner);

  // Ensure shadows on all meshes in the loaded model.
  template.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  return template;
}

/**
 * Attempt to GLTF-load a single asset. Resolves to a normalized template
 * Object3D on success; REJECTS on any failure so the caller can fall back.
 */
function loadGltfTemplate(loader, key, url, entry) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        try {
          resolve(normalizeGltf(key, gltf.scene, entry));
        } catch (err) {
          reject(err);
        }
      },
      undefined, // onProgress — unused
      (err) => reject(err)
    );
  });
}

/**
 * Resolve the directory of the manifest URL so asset files load relative to the
 * manifest (the manifest references files by bare name, e.g. "ground.glb").
 * Works for both './assets/manifest.json' and absolute URLs.
 */
function assetBaseFrom(manifestUrl) {
  const slash = manifestUrl.lastIndexOf('/');
  return slash >= 0 ? manifestUrl.slice(0, slash + 1) : '';
}

/**
 * loadAssets(manifestUrl) -> Promise<AssetStore>
 *
 * Fetches the manifest, then for each key attempts a GLB load and falls back to
 * a colored primitive on failure. NEVER rejects on a missing/broken GLB — one
 * bad asset cannot break the others. The only way this rejects is if the
 * manifest itself cannot be fetched/parsed.
 */
export async function loadAssets(manifestUrl) {
  const res = await fetch(manifestUrl);
  if (!res.ok) {
    throw new Error(`[assets] failed to fetch manifest ${manifestUrl}: ${res.status}`);
  }
  const manifest = await res.json();
  const assetDefs = manifest.assets || {};
  const base = assetBaseFrom(manifestUrl);

  const loader = new GLTFLoader();

  // Per-key state: { entry, template, isFallback }.
  const store = new Map();

  // Kick off all loads in parallel; each settles independently.
  const keys = Object.keys(assetDefs);
  await Promise.all(
    keys.map(async (key) => {
      const entry = assetDefs[key];
      const url = base + entry.file;
      try {
        const template = await loadGltfTemplate(loader, key, url, entry);
        store.set(key, { entry, template, isFallback: false });
      } catch (err) {
        // 404 / network / parse / empty-geometry — build a primitive fallback.
        // Keep this quiet-ish: expected before GLBs are authored.
        console.info(`[assets] using fallback primitive for "${key}" (${entry.file})`);
        const template = buildFallback(key, entry);
        store.set(key, { entry, template, isFallback: true });
      }
    })
  );

  // ----- AssetStore --------------------------------------------------------
  return {
    /**
     * get(key) -> fresh deep clone of the template, ready to add to the scene.
     * Caller owns position/scale. Throws on unknown key.
     */
    get(key) {
      const record = store.get(key);
      if (!record) {
        throw new Error(`[assets] unknown asset key: "${key}"`);
      }
      const clone = record.template.clone(true);
      // clone(true) shares geometries/materials (cheap + correct here). We keep
      // shared materials so per-clone tinting is opt-in; the engine can clone a
      // material itself if it needs to recolor a single instance.
      return clone;
    },

    /**
     * meta(key) -> { file, fallbackColor, size, solid, isFallback }.
     * Throws on unknown key so callers fail loudly on typos.
     */
    meta(key) {
      const record = store.get(key);
      if (!record) {
        throw new Error(`[assets] unknown asset key: "${key}"`);
      }
      const e = record.entry;
      return {
        file: e.file,
        fallbackColor: e.fallbackColor,
        size: e.size.slice(), // defensive copy so callers can't mutate manifest
        solid: !!e.solid,
        isFallback: record.isFallback,
      };
    },

    /** has(key) -> true if the key exists in the manifest. */
    has(key) {
      return store.has(key);
    },
  };
}

export default loadAssets;
