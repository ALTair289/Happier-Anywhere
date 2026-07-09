import { chromium } from 'playwright';
const KEY = 'TKKFL-2B6NN-ZNTCZ-L5E3I-KBMHM-V5AV7-M4K2R-GL2M5-6ZLUA-GMPNK-6Q';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto('http://happier-repo-remote-dev-d72117acdb.localhost:18829/?happier_hmr=0');
await page.waitForTimeout(6000);
// Dump visible interactive elements
const els = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('button, a, input, [role="button"], [data-testid]').forEach(e => {
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ tag: e.tagName, testid: e.getAttribute('data-testid'), text: (e.textContent||'').slice(0,80), type: e.getAttribute('type') });
  });
  return out.slice(0, 40);
});
console.log(JSON.stringify(els, null, 1));
await page.screenshot({ path: '/tmp/login_page.png' });
await browser.close();
