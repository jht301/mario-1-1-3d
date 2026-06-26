import fs from 'fs'; import path from 'path'; import http from 'http';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname,'..','public');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary'};
async function loadChromium(){try{return (await import('playwright')).chromium;}catch{}
  execSync('npx --yes playwright@1.61.1 --version',{stdio:'ignore'});
  const r=path.join(process.env.HOME,'.npm','_npx');
  for(const h of fs.readdirSync(r)){const c=path.join(r,h,'node_modules','playwright','index.js');
    if(fs.existsSync(c)){const m=await import(pathToFileURL(c).href);return m.chromium||m.default?.chromium;}}
  throw 0;}
const chromium=await loadChromium();
const srv=http.createServer((q,s)=>{let f=path.join(ROOT,decodeURIComponent(q.url.split('?')[0]));if(f.endsWith('/'))f=path.join(f,'index.html');fs.readFile(f,(e,d)=>{if(e){s.statusCode=404;s.end();}else{s.setHeader('Content-Type',MIME[path.extname(f)]||'application/octet-stream');s.end(d);}});});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${srv.address().port}/`;
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome-stable',headless:true,args:['--no-sandbox','--disable-gpu','--use-gl=swiftshader']});

async function check(label, opts){
  const ctx=await b.newContext(opts);
  const p=await ctx.newPage();
  await p.goto(base,{waitUntil:'load'});
  await p.waitForFunction(()=>window.__GAME_READY===true,{timeout:20000});
  const vis = await p.evaluate(()=>{
    const el=document.getElementById('touch-controls');
    if(!el) return 'NO-OVERLAY-ELEMENT';
    const cs=getComputedStyle(el);
    const btns=el.querySelectorAll('.tc-btn').length;
    return cs.display+'/btns='+btns+'/htmlNoTouch='+document.documentElement.classList.contains('no-touch');
  });
  console.log(label+': '+vis);
  await ctx.close();
}
// Touch phone context -> controls MUST be visible
await check('TOUCH phone', {viewport:{width:390,height:844},hasTouch:true,isMobile:true});
// Desktop no-touch context -> controls hidden (keyboard play)
await check('DESKTOP no-touch', {viewport:{width:1280,height:800},hasTouch:false});
await b.close(); srv.close();
