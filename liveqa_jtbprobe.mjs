import { chromium } from 'playwright';
const BASE = 'http://happier-repo-remote-dev-d72117acdb.localhost:18829';
const KEY = 'TKKFL-2B6NN-ZNTCZ-L5E3I-KBMHM-V5AV7-M4K2R-GL2M5-6ZLUA-GMPNK-6Q';
const SID = 'cmr3cs4mo0q1jtmtmbkabkb0l';
const SRV = 'srv_xTGdUNfHw32U8ONqT4H2xggPR42D73EJ';
const log = (...a) => console.log(new Date().toISOString().slice(11,23), ...a);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let page = await context.newPage();
// login
await page.goto(`${BASE}/?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
if (await page.$('[data-testid="welcome-secondary-login"]')) {
  await page.click('[data-testid="welcome-secondary-login"]');
  await page.waitForTimeout(2000);
  const m = await page.$('[data-testid="restore-open-manual"]'); if (m) { await m.click(); await page.waitForTimeout(2000); }
  await page.locator('input:visible').first().fill(KEY);
  await page.keyboard.press('Enter'); await page.waitForTimeout(3000);
  const sb = await page.$('[data-testid="restore-manual-submit"]'); if (sb) { await sb.click(); await page.waitForTimeout(6000); }
}
await page.close();

const metrics = (p) => p.evaluate(() => {
  const c = document.querySelector('[data-testid="transcript-chat-list"]');
  if (!c) return null;
  const pill = Array.from(document.querySelectorAll('[data-testid]')).filter(e => /jump.*bottom/i.test(e.getAttribute('data-testid'))).map(e => { const r = e.getBoundingClientRect(); return { t: e.getAttribute('data-testid'), vis: r.width > 0 }; });
  return { st: Math.round(c.scrollTop), sh: c.scrollHeight, ch: c.clientHeight, dfb: Math.round(c.scrollHeight - c.clientHeight - c.scrollTop), pills: pill };
});

for (let trial = 1; trial <= 3; trial++) {
  page = await context.newPage();
  await page.goto(`${BASE}/session/${SID}?serverId=${SRV}&happier_hmr=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  if (!await page.$('[data-testid="transcript-chat-list"]')) { log('trial', trial, 'no mount'); await page.close(); continue; }
  const focus = () => page.evaluate(() => document.querySelector('[data-testid="transcript-chat-list"]')?.focus());
  // to bottom then 15 PageUps
  await focus(); await page.keyboard.press('End'); await page.waitForTimeout(1000);
  for (let i = 0; i < 15; i++) { await focus(); await page.keyboard.press('PageUp'); await page.waitForTimeout(380); }
  await page.waitForTimeout(1500);
  const pre = await metrics(page);
  log('trial', trial, 'pre-click:', JSON.stringify(pre));
  const pill = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-testid]')).filter(e => /jump.*bottom/i.test(e.getAttribute('data-testid')));
    return els.map(e => { const r = e.getBoundingClientRect(); return { t: e.getAttribute('data-testid'), x: r.x + r.width/2, y: r.y + r.height/2, w: r.width }; }).filter(p => p.w > 0);
  });
  if (!pill.length) { log('no pill'); await page.close(); continue; }
  await page.mouse.click(pill[0].x, pill[0].y);
  for (let j = 0; j < 15; j++) {
    await page.waitForTimeout(200);
    const m = await metrics(page);
    log('trial', trial, `t+${(j+1)*200}ms`, JSON.stringify(m));
  }
  // second JTB click if pill still visible
  const m2 = await metrics(page);
  if (m2.dfb > 40) {
    const pill2 = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-testid]')).filter(e => /jump.*bottom/i.test(e.getAttribute('data-testid')));
      return els.map(e => { const r = e.getBoundingClientRect(); return { t: e.getAttribute('data-testid'), x: r.x + r.width/2, y: r.y + r.height/2, w: r.width }; }).filter(p => p.w > 0);
    });
    log('trial', trial, 'SHORTFALL', m2.dfb, 'pill visible:', JSON.stringify(pill2));
    if (pill2.length) { await page.mouse.click(pill2[0].x, pill2[0].y); await page.waitForTimeout(1500); log('trial', trial, 'after 2nd click:', JSON.stringify(await metrics(page))); }
    else {
      // press End as user would
      await focus(); await page.keyboard.press('End'); await page.waitForTimeout(1000);
      log('trial', trial, 'after End:', JSON.stringify(await metrics(page)));
    }
  }
  await page.close();
}
await browser.close();
