import {chromium} from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const [,, mode, a, b, out='frames'] = process.argv; const fps=30;
const browser = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page = await browser.newPage({viewport:{width:1080,height:1920},deviceScaleFactor:1});
page.on('console', m=>console.log('PAGE', m.text())); page.on('pageerror', e=>console.log('ERR', e.message));
await page.goto('http://127.0.0.1:8765/trailer.html?rs=0.75');
await page.waitForFunction(()=>window.renderAt && window.ready, null, {timeout:120000});
await page.evaluate(()=>window.ready); await page.waitForTimeout(1500);
fs.mkdirSync(out,{recursive:true});
if(mode==='stills'){ for(const t of a.split(',')){ await page.evaluate(t=>window.renderAt(t), +t); await page.screenshot({path:`${out}/s_${t}.jpg`,type:'jpeg',quality:80}); } }
else { const f0=Math.round(+a*fps), f1=Math.round(+b*fps); const st=Date.now();
  for(let f=f0; f<f1; f++){ await page.evaluate(t=>window.renderAt(t), f/fps); await page.screenshot({path:`${out}/f_${String(f).padStart(5,'0')}.jpg`,type:'jpeg',quality:92});
    if(f%60===0) console.log('frame',f, ((Date.now()-st)/(f-f0+1)).toFixed(0)+'ms/f'); } }
await browser.close();
