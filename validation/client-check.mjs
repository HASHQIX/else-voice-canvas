import {chromium} from '@playwright/test';

const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:900}});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await page.goto('http://127.0.0.1:5173');
await page.waitForSelector('.mic');
await page.waitForTimeout(900);
const mic=await page.locator('.mic').boundingBox();
const viewport=page.viewportSize();
if(!mic||!viewport||Math.abs((mic.x+mic.width/2)-viewport.width/2)>8||Math.abs((mic.y+mic.height/2)-viewport.height/2)>8)throw new Error('Microphone is not centered on the empty canvas');
for(const selector of ['.topbar','.crumb','.text-row','.conversation-tools','.privacy','.react-flow__attribution']){
  if(await page.locator(selector).evaluateAll(nodes=>nodes.some(n=>getComputedStyle(n).display!=='none')))throw new Error(`Voice-only chrome is visible: ${selector}`);
}
await page.screenshot({path:'validation/client-voice-only.png'});
console.log('voice canvas centered',Math.round(mic.x+mic.width/2),Math.round(mic.y+mic.height/2));
console.log('errors',JSON.stringify(errors));
if(errors.length)process.exitCode=1;
await browser.close();
