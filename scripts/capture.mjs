// capture.mjs — take mobile screenshots at several points for visual QA.
import http from 'http'; import fs from 'fs'; import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'public');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary','.png':'image/png' };

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch {}
  execSync('npx --yes playwright@1.61.1 --version', { stdio: 'ignore' });
  const npxRoot = path.join(process.env.HOME, '.npm', '_npx');
  for (const h of fs.readdirSync(npxRoot)) {
    const cand = path.join(npxRoot, h, 'node_modules', 'playwright', 'index.js');
    if (fs.existsSync(cand)) { const m = await import(pathToFileURL(cand).href); return m.chromium || m.default?.chromium; }
  }
  throw new Error('no playwright');
}
const chromium = await loadChromium();

const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (f.endsWith('/')) f = path.join(f, 'index.html');
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; res.end('404'); } else { res.setHeader('Content-Type', MIME[path.extname(f)]||'application/octet-stream'); res.end(d); } });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true, args: ['--no-sandbox','--disable-gpu','--use-gl=swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME_READY === true, { timeout: 20000 });

const out = path.join(__dirname);
// 1) Start screen (overlay visible)
await page.screenshot({ path: path.join(out, 'shot-1-start.png') });

// 2) Tap to begin, settle a moment
await page.mouse.click(195, 700);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, 'shot-2-begin.png') });

// 3) Walk right ~2.5s (will reach the first pipe / goomba area)
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' })));
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, 'shot-3-walk.png') });

// 4) Teleport camera/player mid-level to capture pipes+stairs region for visual QA
await page.evaluate(() => { const g = window.__GAME; if (g) { g.player.pos.x = 40; g.player.pos.y = 0; g.player.vel.x = 0; g.player.vel.y = 0; } });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(out, 'shot-4-pipes.png') });

// 5) Near the flag/castle
await page.evaluate(() => { const g = window.__GAME; if (g) { g.player.pos.x = 190; g.player.pos.y = 0; g.player.vel.x = 0; g.player.vel.y = 0; } });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(out, 'shot-5-flag.png') });

await browser.close(); server.close();
console.log('captured 5 shots. page errors:', errs.length ? errs : 'none');
