import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://happier-repo-remote-dev-d72117acdb.localhost:18829';
const KEY = 'TKKFL-2B6NN-ZNTCZ-L5E3I-KBMHM-V5AV7-M4K2R-GL2M5-6ZLUA-GMPNK-6Q';
const OUT_DIR = process.env.OUT_DIR || '/tmp/p0b';
fs.mkdirSync(OUT_DIR, { recursive: true });
const SESSIONS = [
  { id: 'cmracew6101cztm5nya6yqxx4', label: 'S1' },
  { id: 'cmr3cs4mo0q1jtmtmbkabkb0l', label: 'S2' },
];
const SRV = 'srv_xTGdUNfHw32U8ONqT4H2xggPR42D73EJ';
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);

const metricsOnce = (page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="transcript-chat-list"]');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + 20, r.top + 10);
  const fid = el ? (el.closest('[data-testid]')?.getAttribute('data-testid') || '?') : '?';
  return { st: Math.round(c.scrollTop), sh: c.scrollHeight, ch: c.clientHeight,
           dfb: Math.round(c.scrollHeight - c.clientHeight - c.scrollTop), fid, path: location.pathname };
});
async function metrics(page) {
  for (let t = 0; t < 3; t++) {
    try { return await metricsOnce(page); } catch (e) { await page.waitForTimeout(500); }
  }
  return null;
}
async function focusC(page) {
  try { await page.evaluate(() => { const c = document.querySelector('[data-testid="transcript-chat-list"]'); if (c) c.focus(); }); } catch {}
}

async function login(page) {
  await page.goto(`${BASE}/?happier_hmr=0`);
  await page.waitForTimeout(5000);
  const authed = await page.evaluate(() => !document.querySelector('[data-testid="welcome-secondary-login"]'));
  if (authed) { log('already authed'); return; }
  await page.click('[data-testid="welcome-secondary-login"]');
  await page.waitForTimeout(2000);
  // find key input
  const els = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea, button, [data-testid]')).map(e => ({ tag: e.tagName, testid: e.getAttribute('data-testid'), text: (e.textContent||'').slice(0,60) })).filter(e => e.tag === 'INPUT' || e.tag === 'TEXTAREA' || (e.testid && /key|login|restore|secret|enter/i.test(e.testid))));
  log('login step els:', JSON.stringify(els.slice(0, 15)));
  const manual = await page.$('[data-testid="restore-open-manual"]');
  if (manual) { await manual.click(); await page.waitForTimeout(2000); }
  const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map(e => { const r = e.getBoundingClientRect(); return { tag: e.tagName, testid: e.getAttribute('data-testid'), ph: e.getAttribute('placeholder'), visible: r.width > 0 && r.height > 0 }; }));
  log('inputs:', JSON.stringify(inputs));
  const visInput = page.locator('input:visible, textarea:visible').first();
  await visInput.fill(KEY);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  const submitBtn = await page.$('[data-testid="restore-manual-submit"]');
  if (submitBtn) { await submitBtn.click(); await page.waitForTimeout(6000); }
  await page.waitForTimeout(4000);
  const stillUnauth = await page.$('[data-testid="welcome-secondary-login"], [data-testid="restore-open-manual"]');
  log('post-login url:', page.url(), 'stillUnauth:', !!stillUnauth);
  if (stillUnauth) throw new Error('login did not complete');
}

async function openSession(context, s) {
  const url = `${BASE}/session/${s.id}?serverId=${SRV}&happier_hmr=0`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(6000);
      if (await page.$('[data-testid="transcript-chat-list"]')) return page;
    } catch {}
    await page.close().catch(() => {});
  }
  throw new Error(`transcript never mounted for ${s.label}`);
}

async function gotoBottom(page) {
  for (let k = 0; k < 6; k++) {
    await focusC(page);
    await page.keyboard.press('End');
    await page.waitForTimeout(800);
    const m = await metrics(page);
    if (m && m.dfb <= 4) return m;
  }
  return metrics(page);
}

// Matrix A+B: sustained PageUp to top, sampling before/after every press (prepend silence from samples)
async function runScrollUp(context, s, run) {
  const page = await openSession(context, s);
  await gotoBottom(page);
  const samples = [];
  let topCount = 0;
  for (let i = 1; i <= 250; i++) {
    await focusC(page);
    const before = await metrics(page);
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(420);
    const after = await metrics(page);
    if (!after) { samples.push({ i, error: 'NOCONT' }); break; }
    samples.push({ i, before, after });
    if (after.st <= 4) { topCount++; if (topCount >= 4) break; } else topCount = 0;
  }
  fs.writeFileSync(`${OUT_DIR}/${s.label}_A_run${run}.json`, JSON.stringify(samples));
  // analyze
  const yanks = [], pins = [], prependShifts = [];
  let prev = null, stuck = 0;
  for (const smp of samples) {
    if (smp.error) continue;
    const m = smp.after;
    if (prev) {
      if (m.st > prev.st + 2000) yanks.push({ press: smp.i, from: prev.st, to: m.st, dsh: m.sh - prev.sh, dst: m.st - prev.st });
      if (Math.abs(m.st - prev.st) <= 4 && m.st > 100) { stuck++; if (stuck === 4) pins.push({ press: smp.i, st: m.st, fid: m.fid }); }
      else stuck = 0;
    }
    // B: prepend boundary = sh grew between before and after within one press
    if (smp.before && m.sh > smp.before.sh + 500) {
      const dsh = m.sh - smp.before.sh;
      const dst = m.st - smp.before.st;
      // expected dst ≈ dsh - pageup_step; visual shift = |(dst - dsh + step)|; approximate step by ch*0.87
      prependShifts.push({ press: smp.i, dsh, dst, fidBefore: smp.before.fid, fidAfter: m.fid });
    }
    prev = m;
  }
  const last = samples.filter(x => x.after).pop();
  await page.close().catch(() => {});
  return { session: s.label, run, presses: samples.length, reachedTop: last ? last.after.st <= 4 : false,
           finalSt: last?.after.st, shStart: samples[0]?.after?.sh, shFinal: last?.after.sh, yanks, pins,
           prependCount: prependShifts.length, prependShifts: prependShifts.slice(0, 10) };
}

// Matrix C: mid-transcript JTB after several prepends
async function runJtb(context, s, run) {
  const page = await openSession(context, s);
  await gotoBottom(page);
  for (let i = 0; i < 15; i++) { await focusC(page); await page.keyboard.press('PageUp'); await page.waitForTimeout(400); }
  await page.waitForTimeout(1500);
  const mid = await metrics(page);
  // find JTB pill
  const jtbInfo = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('[data-testid]')).filter(e => /jump|bottom/i.test(e.getAttribute('data-testid')));
    return cands.map(e => { const r = e.getBoundingClientRect(); return { testid: e.getAttribute('data-testid'), x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height }; }).filter(c => c.w > 0);
  });
  if (!jtbInfo.length) { await page.close().catch(() => {}); return { session: s.label, run, pass: false, reason: 'no JTB pill', mid }; }
  await page.mouse.click(jtbInfo[0].x, jtbInfo[0].y);
  const dfbSamples = [];
  for (let j = 0; j < 5; j++) { await page.waitForTimeout(500); const m = await metrics(page); dfbSamples.push(m ? m.dfb : -1); }
  const pass = dfbSamples.every(d => d >= 0 && d <= 40);
  await page.close().catch(() => {});
  return { session: s.label, run, mid, jtb: jtbInfo[0].testid, dfbSamples, pass };
}

// Matrix D: mixed wheel bursts with pauses
async function runWheel(context, s, run) {
  const page = await openSession(context, s);
  await gotoBottom(page);
  const samples = [];
  let prev = null; const yanks = [], pins = []; let stuck = 0; let p = 0; let moved = false;
  for (let burst = 0; burst < 8; burst++) {
    for (let w = 0; w < 5; w++) {
      p++;
      await focusC(page);
      const c = await page.$('[data-testid="transcript-chat-list"]');
      const box = await c.boundingBox();
      await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(300);
      const m = await metrics(page);
      if (!m) break;
      samples.push({ p, ...m });
      if (prev) {
        if (m.st !== prev.st) moved = true;
        if (m.st > prev.st + 2000) yanks.push({ p, from: prev.st, to: m.st, dsh: m.sh - prev.sh });
        if (Math.abs(m.st - prev.st) <= 4 && m.st > 100) { stuck++; if (stuck === 4) pins.push({ p, st: m.st }); } else stuck = 0;
      }
      prev = m;
    }
    await page.waitForTimeout(1200);
  }
  fs.writeFileSync(`${OUT_DIR}/${s.label}_D_run${run}.json`, JSON.stringify(samples));
  await page.close().catch(() => {});
  return { session: s.label, run, events: p, wheelMoved: moved, startSt: samples[0]?.st, finalSt: prev?.st, yanks, pins };
}

async function main() {
  const which = process.argv[2] || 'all'; // all | A | C | D, and optional session filter
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  context.on('page', p => p.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); }));
  const page = await context.newPage();
  await login(page);
  await page.close().catch(() => {});

  const results = [];
  const record = (r) => { results.push(r); fs.appendFileSync(`${OUT_DIR}/results.jsonl`, JSON.stringify(r) + '\n'); log(JSON.stringify(r)); };

  for (const s of SESSIONS) {
    if (which === 'all' || which === 'A') {
      for (let r = 1; r <= 3; r++) {
        try { record({ cell: 'A+B', ...(await runScrollUp(context, s, r)) }); }
        catch (e) { record({ cell: 'A+B', session: s.label, run: r, error: e.message }); }
      }
    }
    if (which === 'all' || which === 'C') {
      for (let r = 1; r <= 3; r++) {
        try { record({ cell: 'C', ...(await runJtb(context, s, r)) }); }
        catch (e) { record({ cell: 'C', session: s.label, run: r, error: e.message }); }
      }
    }
    if (which === 'all' || which === 'D') {
      for (let r = 1; r <= 3; r++) {
        try { record({ cell: 'D', ...(await runWheel(context, s, r)) }); }
        catch (e) { record({ cell: 'D', session: s.label, run: r, error: e.message }); }
      }
    }
  }
  fs.writeFileSync(`${OUT_DIR}/console_errors.json`, JSON.stringify(consoleErrors, null, 1));
  log('console errors:', consoleErrors.length);
  await browser.close();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
