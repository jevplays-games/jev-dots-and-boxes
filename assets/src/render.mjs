// Renders the Box Score art sources to PNG with headless Chromium (Playwright).
// Usage: npm i --no-save playwright@1.55.1 && npx playwright install chromium && node assets/src/render.mjs
// (or set PLAYWRIGHT_FROM to any package.json whose node_modules has playwright).
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=createRequire(process.env.PLAYWRIGHT_FROM??import.meta.url)('playwright');
const pages=[
  ['assets/src/banner.html','assets/banner.png',1280,420,2],
  ['assets/src/social.html','assets/social-preview.png',1280,640,1],
  ['assets/src/og.html','public/brand/og.png',1200,630,1],
];
const icons=[['public/brand/favicon-32.png',32,0,null],['public/brand/apple-touch-icon.png',180,18,'#F386A1']];
const browser=await chromium.launch();
for(const [src,out,width,height,scale] of pages){
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:scale});
  await page.goto(pathToFileURL(root+src).href);await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:root+out});await page.close();console.log(out,width*scale+'x'+height*scale);
}
// Only the root <svg> loses its fixed size; inner shapes keep their width/height.
const svg=readFileSync(root+'public/brand/icon.svg','utf8').replace(/<svg[^>]*>/,tag=>tag.replace(/\s(width|height)="\d+"/g,''));
for(const [out,size,pad,bg] of icons){
  const page=await browser.newPage({viewport:{width:size,height:size}});
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;background:${bg??'transparent'};display:grid;place-items:center"><div style="width:${size-2*pad}px;height:${size-2*pad}px">${svg.replace('<svg','<svg width="100%" height="100%"')}</div></body></html>`);
  await page.screenshot({path:root+out,omitBackground:!bg});await page.close();console.log(out,size+'x'+size);
}
await browser.close();
