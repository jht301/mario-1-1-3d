// playthrough-test.mjs — headless proof the level is COMPLETABLE.
// Drives the real physics from game.js's published state with a greedy
// auto-player (hold right; jump when blocked ahead or a pit is near) and
// asserts Mario reaches the flag without getting permanently stuck.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve playwright from the npx cache (same approach as smoke-test.mjs).
async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch {}
  execSync('npx --yes playwright@1.61.1 --version', { stdio: 'ignore' });
  const npxRoot = path.join(process.env.HOME, '.npm', '_npx');
  const hashes = fs.readdirSync(npxRoot);
  for (const h of hashes) {
    const cand = path.join(npxRoot, h, 'node_modules', 'playwright', 'index.js');
    if (fs.existsSync(cand)) {
      const m = await import(pathToFileURL(cand).href);
      return m.chromium || (m.default && m.default.chromium);
    }
  }
  throw new Error('playwright not found');
}
const chromium = await loadChromium();
const ROOT = path.resolve(__dirname, '..', 'public');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.glb':'model/gltf-binary', '.png':'image/png' };

const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (f.endsWith('/')) f = path.join(f, 'index.html');
  fs.readFile(f, (err, data) => {
    if (err) { res.statusCode = 404; res.end('404'); return; }
    res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;
console.log('[PLAY] serving', base);

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--no-sandbox','--disable-gpu','--use-gl=swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME_READY === true, { timeout: 20000 });

// Start the game (tap) — required since sim is gated on `started`.
await page.mouse.click(195, 700);

// Run the real simulation headlessly: we can't easily push synthetic time into
// setAnimationLoop, so instead we let it run in real time and feed inputs by
// reading state + setting the input flags the game exposes. The game drives its
// own loop; we just observe player.x and nudge a greedy controller via key events.
const result = await page.evaluate(async () => {
  const g = window.__GAME;
  if (!g) return { ok: false, reason: 'no __GAME' };
  const flagX = g.solids?.length ? null : null; // flag read below from LEVEL via game
  const start = performance.now();
  const TIMEOUT_MS = 60000;
  let lastX = g.player.pos.x, stuckMs = 0, lastT = performance.now();
  let maxX = lastX;

  function press(code) { window.dispatchEvent(new KeyboardEvent('keydown', { code })); }
  function release(code) { window.dispatchEvent(new KeyboardEvent('keyup', { code })); }

  press('ArrowRight'); // hold right the whole time

  return await new Promise(resolve => {
    const tick = setInterval(() => {
      const now = performance.now();
      const dt = now - lastT; lastT = now;
      const p = g.player;
      maxX = Math.max(maxX, p.pos.x);

      // Greedy jump: if we've barely advanced, try a jump (clears pipes/stairs/pits).
      if (p.pos.x - lastX < 0.02) { stuckMs += dt; } else { stuckMs = 0; }
      lastX = p.pos.x;
      if (stuckMs > 120) {
        press('Space'); setTimeout(() => release('Space'), 140);
        stuckMs = 0;
      }
      // Periodic hops to cross pits even when not "stuck" yet.
      if (Math.floor(now / 900) % 2 === 0 && p.onGround) {
        press('Space'); setTimeout(() => release('Space'), 140);
      }

      const won = g.status === 'won';
      const timedOut = now - start > TIMEOUT_MS;
      if (won || timedOut) {
        clearInterval(tick);
        release('ArrowRight');
        resolve({ ok: won, status: g.status, maxX: +maxX.toFixed(1),
                  finalX: +p.pos.x.toFixed(1), elapsedS: +((now-start)/1000).toFixed(1) });
      }
    }, 33);
  });
});

await page.screenshot({ path: path.join(__dirname, 'playthrough.png') });
await browser.close();
server.close();

console.log('[PLAY] result:', JSON.stringify(result));
console.log('[PLAY] page errors:', errors.length ? errors : 'none');
if (result.ok) {
  console.log('[PLAY] RESULT: PASS — level completed (reached flag) at x=' + result.finalX + ' in ' + result.elapsedS + 's');
  process.exit(0);
} else {
  console.log('[PLAY] RESULT: FAIL — did NOT complete. maxX=' + result.maxX + ' status=' + result.status);
  process.exit(1);
}
