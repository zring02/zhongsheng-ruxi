import {chromium} from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const page = await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
page.on('pageerror', e=>console.log('ERR', e.message));
await page.goto('http://127.0.0.1:8765/cover.html?rs=1');
await page.waitForFunction(()=>window.cover && window.ready, null, {timeout:120000});
await page.evaluate(()=>window.ready); await page.waitForTimeout(1200);
for(const v of process.argv.slice(2)){ await page.evaluate(v=>window.cover(v), v); await page.waitForTimeout(300); await page.evaluate(v=>window.cover(v), v); await page.screenshot({path:`cover_${v}.png`}); }
await browser.close();
