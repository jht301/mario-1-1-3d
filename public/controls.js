// =============================================================================
// controls.js — unified keyboard + touch input for Mario 1-1 3D
// =============================================================================
//
// Single source of input truth. Tracks HELD state (left / right / jump) plus an
// EDGE-triggered jump press (jumpPressed) that is true for exactly one frame
// after a fresh press and is cleared by consume().
//
// Public API (satisfies BOTH the spec.md Input contract and the richer
// orchestrator contract):
//
//   createInput(containerEl) -> input
//
//   input.left         boolean   held
//   input.right        boolean   held
//   input.jump         boolean   jump currently held
//   input.jumpPressed  boolean   EDGE: true for one frame after a fresh press
//   input.state        same object as input itself (alias; { left,right,jump,jumpPressed })
//   input.mount()      build/attach the touch overlay + listeners (idempotent)
//   input.destroy()    remove all listeners + the overlay this module created
//   input.consume()    call once per frame AFTER reading state; clears jumpPressed
//
// USAGE PER FRAME (game.js):
//   stepPlayer(player, input, solids, dt);   // reads input.left / .jumpPressed ...
//   ...                                       // (any other reads of input state)
//   input.consume();                          // LAST thing before render: clears edges
//   renderer.render(scene, camera);
//
// NOTE ON consume(): jumpPressed is an EDGE flag. It becomes true the instant a
// jump begins (keydown transition up->down, or pointerdown on the jump button)
// and STAYS true until consume() is called. So the physics step can read it once
// and consume() guarantees a single press is never double-counted across frames.
// `jump` (the held bool) is independent and is used for variable jump height.
//
// MULTI-TOUCH: each button tracks the set of pointerIds currently pressing it,
// so holding LEFT with one thumb while repeatedly TAPPING JUMP with another
// works. We never rely on a single "active pointer". A button's held flag is
// true while >= 1 pointer is down on it.
//
// ROBUSTNESS: works keyboard-only if the overlay/buttons are absent or fail to
// build; never throws when DOM elements are missing.
// =============================================================================

/**
 * Create the unified input object and (optionally) the touch overlay.
 * @param {HTMLElement} [containerEl=document.body] element the overlay is
 *        appended to and on which the page-level scroll/zoom guards are set.
 * @returns {object} input — see file header for shape.
 */
export function createInput(containerEl = document.body) {
  // Resolve the container; tolerate being called before <body> exists.
  const container =
    containerEl || (typeof document !== 'undefined' ? document.body : null);

  // ---- Public state object ------------------------------------------------
  // This same object is exposed as both the top-level input (so `input.left`,
  // `input.jumpPressed`, `input.consume()` work per spec.md) and as
  // `input.state` (per the orchestrator's { state, ... } contract).
  const input = {
    left: false,
    right: false,
    jump: false,
    jumpPressed: false,
  };

  // ---- Internal bookkeeping ----------------------------------------------
  // Per-button sets of active pointer ids -> enables independent multi-touch.
  const pointerSets = {
    left: new Set(),
    right: new Set(),
    jump: new Set(),
  };

  // Track which keyboard keys are currently held so we can ignore key-repeat
  // (a held key fires repeated keydown events; jumpPressed must edge only once).
  const keyHeld = new Set();

  // DOM references created in mount(); used for cleanup in destroy().
  let overlayEl = null;          // the #touch-controls overlay (only if WE made it)
  let buttonEls = {};            // { left, right, jump } -> HTMLElement
  let mounted = false;           // guard against double-mount
  // Remember elements we attached listeners to but did NOT create, so we can
  // detach without deleting author-provided DOM.
  const boundButtonEls = [];     // [{ el, button }]

  // ---- Derived held-state recompute --------------------------------------
  // A button is "held" if at least one pointer OR the keyboard says so. We keep
  // keyboard and pointer contributions separate via small helper closures.
  const keyboardState = { left: false, right: false, jump: false };

  function recompute(button) {
    const pointerHeld = pointerSets[button].size > 0;
    const held = pointerHeld || keyboardState[button];
    input[button] = held;
  }

  // Fire an edge press for `jump` (sets jumpPressed once for this press).
  function pressJumpEdge() {
    // jumpPressed is only meaningful as "a NEW press happened since last
    // consume()". We set it true; consume() will clear it. Multiple presses in
    // one frame still read as a single edge (intended — one jump per frame).
    input.jumpPressed = true;
  }

  // =========================================================================
  // Keyboard handling
  // =========================================================================
  function onKeyDown(e) {
    const code = e.code;
    let handled = true;
    switch (code) {
      case 'ArrowLeft':
      case 'KeyA':
        keyboardState.left = true;
        recompute('left');
        break;
      case 'ArrowRight':
      case 'KeyD':
        keyboardState.right = true;
        recompute('right');
        break;
      case 'ArrowUp':
      case 'KeyW':
      case 'Space':
        // Edge only on the first transition down->held (ignore auto-repeat).
        if (!keyHeld.has(code) && !e.repeat) {
          pressJumpEdge();
        }
        keyboardState.jump = true;
        recompute('jump');
        break;
      default:
        handled = false;
    }
    if (handled) {
      keyHeld.add(code);
      // Stop Space/arrows from scrolling the page.
      e.preventDefault();
    }
  }

  function onKeyUp(e) {
    const code = e.code;
    let handled = true;
    switch (code) {
      case 'ArrowLeft':
      case 'KeyA':
        keyboardState.left = false;
        recompute('left');
        break;
      case 'ArrowRight':
      case 'KeyD':
        keyboardState.right = false;
        recompute('right');
        break;
      case 'ArrowUp':
      case 'KeyW':
      case 'Space':
        keyboardState.jump = false;
        recompute('jump');
        break;
      default:
        handled = false;
    }
    if (handled) {
      keyHeld.delete(code);
      e.preventDefault();
    }
  }

  // If the window loses focus, release everything so keys don't "stick".
  function onBlur() {
    keyHeld.clear();
    keyboardState.left = keyboardState.right = keyboardState.jump = false;
    // Pointer holds are also released on blur to avoid stuck buttons.
    pointerSets.left.clear();
    pointerSets.right.clear();
    pointerSets.jump.clear();
    refreshButtonVisuals();
    input.left = input.right = input.jump = false;
    // Do NOT clear jumpPressed here; consume() owns that edge lifecycle.
  }

  // =========================================================================
  // Pointer (touch / mouse / pen) handling on the on-screen buttons
  // =========================================================================
  // We use Pointer Events which unify touch + mouse + pen and give us a stable
  // pointerId per finger for clean multi-touch tracking.

  function makePointerDown(button) {
    return function onPointerDown(e) {
      // Capture this pointer so we still get up/cancel even if the finger
      // slides off the button slightly.
      try {
        e.currentTarget.setPointerCapture &&
          e.currentTarget.setPointerCapture(e.pointerId);
      } catch (_) {
        /* setPointerCapture can throw on some browsers; non-fatal. */
      }
      pointerSets[button].add(e.pointerId);
      if (button === 'jump') pressJumpEdge();
      recompute(button);
      setPressedVisual(button, true);
      // Prevent the touch from scrolling/zooming or generating a click.
      e.preventDefault();
    };
  }

  function makePointerUp(button) {
    return function onPointerUp(e) {
      pointerSets[button].delete(e.pointerId);
      recompute(button);
      if (pointerSets[button].size === 0) setPressedVisual(button, false);
      e.preventDefault();
    };
  }

  // pointercancel / pointerleave / pointerout all mean "this pointer is gone".
  function makePointerLost(button) {
    return function onPointerLost(e) {
      pointerSets[button].delete(e.pointerId);
      recompute(button);
      if (pointerSets[button].size === 0) setPressedVisual(button, false);
    };
  }

  // Visual press feedback (CSS class). No-op if the element is absent.
  function setPressedVisual(button, on) {
    const el = buttonEls[button];
    if (el && el.classList) el.classList.toggle('tc-pressed', on);
  }
  function refreshButtonVisuals() {
    setPressedVisual('left', pointerSets.left.size > 0);
    setPressedVisual('right', pointerSets.right.size > 0);
    setPressedVisual('jump', pointerSets.jump.size > 0);
  }

  // Per-button listener bundles, stored so destroy() can detach them exactly.
  const pointerListenerBundles = []; // [{ el, type, fn }]

  function bindButton(el, button) {
    if (!el) return;
    buttonEls[button] = el;
    const down = makePointerDown(button);
    const up = makePointerUp(button);
    const cancel = makePointerLost(button);

    // Pointer events (primary path).
    el.addEventListener('pointerdown', down, { passive: false });
    el.addEventListener('pointerup', up, { passive: false });
    el.addEventListener('pointercancel', cancel, { passive: false });
    el.addEventListener('pointerleave', cancel, { passive: false });

    // Touch events as a belt-and-braces fallback for older mobile browsers
    // that mis-handle pointer events; touchstart preventDefault also reliably
    // blocks the synthetic 300ms click + double-tap zoom.
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', cancel, { passive: false });
    // Stop the synthetic click + context menu (long-press) entirely.
    const noop = (ev) => ev.preventDefault();
    el.addEventListener('contextmenu', noop, { passive: false });

    pointerListenerBundles.push(
      { el, type: 'pointerdown', fn: down },
      { el, type: 'pointerup', fn: up },
      { el, type: 'pointercancel', fn: cancel },
      { el, type: 'pointerleave', fn: cancel },
      { el, type: 'touchstart', fn: down },
      { el, type: 'touchend', fn: up },
      { el, type: 'touchcancel', fn: cancel },
      { el, type: 'contextmenu', fn: noop }
    );
    boundButtonEls.push({ el, button });
  }

  // =========================================================================
  // Overlay construction
  // =========================================================================
  // If the page already provides #btn-left/#btn-right/#btn-jump we bind to them.
  // Otherwise we build the overlay ourselves so the module is self-contained and
  // the game has working touch controls even if index.html omitted them.
  function buildOverlay() {
    if (typeof document === 'undefined' || !container) return;

    // Prefer existing author-provided buttons.
    const existingLeft = document.getElementById('btn-left');
    const existingRight = document.getElementById('btn-right');
    const existingJump = document.getElementById('btn-jump');

    if (existingLeft || existingRight || existingJump) {
      bindButton(existingLeft, 'left');
      bindButton(existingRight, 'right');
      bindButton(existingJump, 'jump');
      return;
    }

    // None present -> create our own overlay.
    overlayEl = document.createElement('div');
    overlayEl.id = 'touch-controls';
    overlayEl.setAttribute('aria-hidden', 'true'); // assistive: it's a game pad

    const clusterLeft = document.createElement('div');
    clusterLeft.className = 'tc-cluster-left';

    const clusterRight = document.createElement('div');
    clusterRight.className = 'tc-cluster-right';

    const btnLeft = makeButtonEl('btn-left', 'left', '◀');   // ◀
    const btnRight = makeButtonEl('btn-right', 'right', '▶'); // ▶
    const btnJump = makeButtonEl('btn-jump', 'jump', 'JUMP');

    clusterLeft.appendChild(btnLeft);
    clusterLeft.appendChild(btnRight);
    clusterRight.appendChild(btnJump);

    overlayEl.appendChild(clusterLeft);
    overlayEl.appendChild(clusterRight);
    container.appendChild(overlayEl);

    bindButton(btnLeft, 'left');
    bindButton(btnRight, 'right');
    bindButton(btnJump, 'jump');
  }

  function makeButtonEl(id, button, label) {
    const b = document.createElement('button');
    b.id = id;
    b.className = 'tc-btn';
    b.type = 'button';
    b.setAttribute('aria-label', button);
    b.textContent = label;
    // Inline guard in case controls.css didn't load: still suppress gestures.
    b.style.touchAction = 'none';
    b.style.userSelect = 'none';
    b.style.webkitUserSelect = 'none';
    return b;
  }

  // =========================================================================
  // Page-level scroll / zoom guards
  // =========================================================================
  // Prevent the whole page from panning/zooming during play. We block default
  // on touchmove that originates on the overlay or the WebGL canvas, and disable
  // double-tap / pinch zoom via touch-action on those elements.
  let touchMoveGuard = null;
  let gestureGuards = [];

  function installScrollGuards() {
    if (typeof document === 'undefined') return;

    // Disable native gestures on the canvas + overlay via touch-action.
    const canvas = document.querySelector('canvas');
    if (canvas) canvas.style.touchAction = 'none';
    if (container && container.style) container.style.touchAction = 'none';

    // Block scroll from touchmove that starts on our controls/canvas.
    touchMoveGuard = (e) => {
      const t = e.target;
      if (
        (overlayEl && overlayEl.contains(t)) ||
        (t && t.closest && (t.closest('#touch-controls') || t.closest('canvas')))
      ) {
        e.preventDefault();
      }
    };
    document.addEventListener('touchmove', touchMoveGuard, { passive: false });

    // Suppress iOS Safari pinch-zoom gesture events globally during play.
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
      const fn = (e) => e.preventDefault();
      document.addEventListener(type, fn, { passive: false });
      gestureGuards.push({ type, fn });
    });
  }

  function removeScrollGuards() {
    if (typeof document === 'undefined') return;
    if (touchMoveGuard) {
      document.removeEventListener('touchmove', touchMoveGuard);
      touchMoveGuard = null;
    }
    gestureGuards.forEach(({ type, fn }) =>
      document.removeEventListener(type, fn)
    );
    gestureGuards = [];
  }

  // =========================================================================
  // Lifecycle: mount / destroy
  // =========================================================================
  /**
   * Attach all listeners and build the overlay. Idempotent: calling twice is a
   * no-op after the first. Safe to call before or after DOM is ready.
   */
  function mount() {
    if (mounted) return;
    mounted = true;

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKeyDown, { passive: false });
      window.addEventListener('keyup', onKeyUp, { passive: false });
      window.addEventListener('blur', onBlur);
    }

    buildOverlay();
    installScrollGuards();
  }

  /**
   * Detach everything and remove the overlay this module created. Author-
   * provided buttons are left in the DOM (only their listeners are removed).
   */
  function destroy() {
    if (!mounted) return;
    mounted = false;

    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    }

    // Remove per-button listeners.
    pointerListenerBundles.forEach(({ el, type, fn }) => {
      el.removeEventListener(type, fn);
    });
    pointerListenerBundles.length = 0;
    boundButtonEls.length = 0;

    removeScrollGuards();

    // Only remove the overlay if WE created it.
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
    buttonEls = {};

    // Reset state so a fresh mount starts clean.
    pointerSets.left.clear();
    pointerSets.right.clear();
    pointerSets.jump.clear();
    keyHeld.clear();
    keyboardState.left = keyboardState.right = keyboardState.jump = false;
    input.left = input.right = input.jump = false;
    input.jumpPressed = false;
  }

  /**
   * Clear edge-triggered flags. Call ONCE per frame, after reading input state
   * and before the next frame. Currently clears jumpPressed.
   */
  function consume() {
    input.jumpPressed = false;
  }

  // ---- Assemble the public object ----------------------------------------
  // `input` already carries left/right/jump/jumpPressed. We attach methods and
  // a `state` alias so it satisfies both contract shapes.
  input.state = input;        // alias: input.state === input (same live object)
  input.mount = mount;
  input.destroy = destroy;
  input.consume = consume;

  // Auto-mount for convenience: spec's game.js does `createInput(document.body)`
  // and immediately uses the input each frame without calling mount(). We mount
  // now so it "just works". destroy()/mount() remain available for explicit
  // lifecycle control (e.g. tests or scene teardown).
  mount();

  return input;
}

export default createInput;
