import fs from 'fs'; import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
async function loadChromium(){ try{return (await import('playwright')).chromium;}catch{}
  execSync('npx --yes playwright@1.61.1 --version',{stdio:'ignore'});
  const r=path.join(process.env.HOME,'.npm','_npx');
  for(const h of fs.readdirSync(r)){const c=path.join(r,h,'node_modules','playwright','index.js');
    if(fs.existsSync(c)){const m=await import(pathToFileURL(c).href);return m.chromium||m.default?.chromium;}}
  throw new Error('no pw');}
const chromium=await loadChromium();
const URL='https://jht301.github.io/mario-1-1-3d/';
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome-stable',headless:true,args:['--no-sandbox','--disable-gpu','--use-gl=swiftshader']});
const ctx=await b.newContext({viewport:{width:390,height:844},hasTouch:true,deviceScaleFactor:2});
const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.goto(URL,{waitUntil:'load',timeout:30000});
await p.waitForFunction(()=>window.__GAME_READY===true,{timeout:25000});
await p.screenshot({path:path.join(__dirname,'live-1-start.png')});
await p.mouse.click(195,700); await p.waitForTimeout(400);
// hold right + periodic jumps for ~6s to actually traverse some level
await p.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowRight'})));
for(let i=0;i<12;i++){await p.evaluate(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space'}));setTimeout(()=>window.dispatchEvent(new KeyboardEvent('keyup',{code:'Space'})),140);}); await p.waitForTimeout(500);}
const st=await p.evaluate(()=>({x:+window.__GAME.player.pos.x.toFixed(1),status:window.__GAME.status}));
await p.screenshot({path:path.join(__dirname,'live-2-play.png')});
await b.close();
console.log('LIVE TEST: ready=OK, player advanced to x='+st.x+', status='+st.status+', pageErrors='+(errs.length?JSON.stringify(errs):'none'));
