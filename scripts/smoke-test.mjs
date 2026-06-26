// =============================================================================
// smoke-test.mjs — headless Playwright smoke test for Mario 1-1 3D
// =============================================================================
//
// Serves public/ via a tiny zero-dependency node http+fs static server, launches
// system Chrome (headless, swiftshader GL) at a mobile viewport, and verifies:
//   - no uncaught page errors
//   - <canvas> is present
//   - window.__GAME_READY === true
//   - player.y stabilizes (Mario LANDS — not falling forever)
//   - holding "right" ~3s increases player.x (movement works)
// Writes a screenshot to scripts/smoke.png. Exits non-zero with a clear message
// on any failure.
//
// Run: cd mario-1-1-3d && node scripts/smoke-test.mjs
//   (Playwright is imported via `npx --yes playwright@1.61.1`; we use SYSTEM
//    chrome via executablePath and do NOT trigger Playwright's browser download.)
// =============================================================================

import http from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const SCREENSHOT = join(__dirname, 'smoke.png');
const CHROME = '/usr/bin/google-chrome-stable';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function fail(msg) {
  console.error('\n[SMOKE] FAIL: ' + msg + '\n');
  process.exitCode = 1;
}

// ---- tiny static file server -----------------------------------------------
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        let rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
        if (rel === '/' || rel === '\\' || rel === '') rel = '/index.html';
        let filePath = join(PUBLIC_DIR, rel);
        if (existsSync(filePath) && statSync(filePath).isDirectory()) {
          filePath = join(filePath, 'index.html');
        }
        if (!existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found: ' + rel);
          return;
        }
        const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error: ' + err.message);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// Resolve Playwright. ESM does not honor NODE_PATH for bare specifiers, so we
// try a plain import first and fall back to PLAYWRIGHT_DIR (set by the runner to
// the npx-installed playwright@1.61.1 location) imported by absolute path.
async function loadChromium() {
  try {
    const m = await import('playwright');
    return m.chromium;
  } catch (_) {
    // 1) Explicit override.
    let dir = process.env.PLAYWRIGHT_DIR;
    // 2) Auto-discover an npx-cached playwright@1.61.x install. `npx --yes
    //    playwright@1.61.1 --version` (run by the runner once) leaves it under
    //    ~/.npm/_npx/<hash>/node_modules/playwright.
    if (!dir) {
      const npxRoot = join(homedir(), '.npm', '_npx');
      if (existsSync(npxRoot)) {
        for (const hash of readdirSync(npxRoot)) {
          const cand = join(npxRoot, hash, 'node_modules', 'playwright');
          const pkg = join(cand, 'package.json');
          if (existsSync(pkg)) {
            try {
              const v = JSON.parse(readFileSync(pkg, 'utf8')).version || '';
              if (v.startsWith('1.61.')) { dir = cand; break; }
            } catch (_e) { /* ignore bad cache entry */ }
          }
        }
      }
    }
    if (!dir) {
      throw new Error(
        'playwright not found. Run `npx --yes playwright@1.61.1 --version` first, ' +
          'or set PLAYWRIGHT_DIR to a playwright@1.61.1 install.'
      );
    }
    const url = pathToFileURL(join(dir, 'index.js')).href;
    const m = await import(url);
    return (m.default && m.default.chromium) || m.chromium;
  }
}

async function main() {
  // Import Playwright (provided via `npx playwright@1.61.1`).
  const chromium = await loadChromium();

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}/`;
  console.log('[SMOKE] serving public/ at ' + base);

  let browser;
  const pageErrors = [];

  try {
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
    });

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();

    page.on('pageerror', (err) => {
      pageErrors.push(err.message || String(err));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        // Console errors are noted but only page (uncaught) errors fail the run.
        console.log('[page console.error] ' + msg.text());
      }
    });

    await page.goto(base, { waitUntil: 'load', timeout: 30000 });

    // --- canvas present ---
    await page.waitForSelector('canvas', { timeout: 15000 });
    console.log('[SMOKE] canvas present: OK');

    // --- __GAME_READY ---
    await page.waitForFunction(() => window.__GAME_READY === true, null, {
      timeout: 20000,
    });
    console.log('[SMOKE] __GAME_READY: OK');

    // Kick off the game (first-tap gate) by tapping the screen.
    await page.mouse.click(195, 422);

    // --- player.y stabilizes (lands, not falling forever) ---
    // Sample y over time; require it to settle (small change) and not be in
    // free-fall below the kill plane.
    async function getPlayer() {
      return await page.evaluate(() => {
        const p = window.__GAME && window.__GAME.player;
        return p ? { x: p.pos.x, y: p.pos.y, onGround: p.onGround } : null;
      });
    }

    // Let physics settle.
    await page.waitForTimeout(1500);
    const y1 = (await getPlayer()).y;
    await page.waitForTimeout(800);
    const p2 = await getPlayer();
    const y2 = p2.y;

    if (!Number.isFinite(y2)) {
      fail('player.y is not finite (' + y2 + ')');
    } else if (y2 < -10) {
      fail('player fell into the void (y=' + y2.toFixed(2) + ') — never landed');
    } else if (Math.abs(y2 - y1) > 0.5) {
      fail(
        'player.y did not stabilize (y1=' +
          y1.toFixed(2) +
          ', y2=' +
          y2.toFixed(2) +
          ') — still falling?'
      );
    } else {
      console.log(
        '[SMOKE] player.y stabilized: OK (y=' +
          y2.toFixed(2) +
          ', onGround=' +
          p2.onGround +
          ')'
      );
    }

    // --- holding right ~3s increases player.x ---
    const xBefore = (await getPlayer()).x;
    // Drive input directly via the touch button so we exercise controls.js.
    // Dispatch a real pointerdown on #btn-right, hold ~3s, then release.
    await page.evaluate(() => {
      const el = document.getElementById('btn-right');
      if (el) {
        const ev = new PointerEvent('pointerdown', {
          pointerId: 1,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
      } else {
        // Fallback: keyboard.
        window.dispatchEvent(
          new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true })
        );
      }
    });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const el = document.getElementById('btn-right');
      if (el) {
        const ev = new PointerEvent('pointerup', {
          pointerId: 1,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
      } else {
        window.dispatchEvent(
          new KeyboardEvent('keyup', { code: 'ArrowRight', bubbles: true })
        );
      }
    });
    const xAfter = (await getPlayer()).x;

    if (xAfter > xBefore + 1.0) {
      console.log(
        '[SMOKE] holding right increases player.x: OK (' +
          xBefore.toFixed(2) +
          ' -> ' +
          xAfter.toFixed(2) +
          ')'
      );
    } else {
      fail(
        'holding right did not move player (x ' +
          xBefore.toFixed(2) +
          ' -> ' +
          xAfter.toFixed(2) +
          ')'
      );
    }

    // --- screenshot ---
    await page.screenshot({ path: SCREENSHOT });
    console.log('[SMOKE] screenshot -> ' + SCREENSHOT);

    // --- no uncaught page errors ---
    if (pageErrors.length) {
      fail('uncaught page errors:\n  - ' + pageErrors.join('\n  - '));
    } else {
      console.log('[SMOKE] no uncaught page errors: OK');
    }
  } catch (err) {
    fail('exception during test: ' + (err && err.stack ? err.stack : err));
  } finally {
    if (browser) await browser.close();
    server.close();
  }

  if (process.exitCode === 1) {
    console.error('[SMOKE] RESULT: FAIL');
  } else {
    console.log('[SMOKE] RESULT: PASS');
  }
}

main().catch((err) => {
  fail('fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
