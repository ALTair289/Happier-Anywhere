import { chromium } from 'playwright';

const BASE = 'http://happier-repo-remote-dev-d72117acdb.localhost:18829';
const KEY = 'TKKFL-2B6NN-ZNTCZ-L5E3I-KBMHM-V5AV7-M4K2R-GL2M5-6ZLUA-GMPNK-6Q';
const SESSIONS = [
  { id: 'cmracew6101cztm5nya6yqxx4', serverId: 'srv_xTGdUNfHw32U8ONqT4H2xggPR42D73EJ', label: 'S1' },
  { id: 'cmr3cs4mo0q1jtmtmbkabkb0l', serverId: 'srv_xTGdUNfHw32U8ONqT4H2xggPR42D73EJ', label: 'S2' },
];

async function getMetrics(page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="transcript-chat-list"]');
    if (!c) return null;
    const st = c.scrollTop, sh = c.scrollHeight, ch = c.clientHeight;
    const dfb = sh - ch - st;
    const el = document.elementFromPoint(c.getBoundingClientRect().left + 10, c.getBoundingClientRect().top + 10);
    const firstTestid = el ? (el.closest('[data-testid]')?.getAttribute('data-testid') || el.getAttribute('data-testid') || '?') : '?';
    const jtbPill = !!document.querySelector('[data-testid="jump-to-bottom"]');
    return { st: Math.round(st), sh: Math.round(sh), ch: Math.round(ch), dfb: Math.round(dfb), firstTestid, jtbPill };
  });
}

async function focusContainer(page) {
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid="transcript-chat-list"]');
    if (c) c.focus();
  });
}

async function login(page) {
  await page.goto(`${BASE}/?happier_hmr=0`);
  await page.waitForLoadState('networkidle');
  const url = page.url();
  if (url.includes('/login') || url.includes('/auth')) {
    // Try key login
    await page.evaluate(async (key) => {
      const resp = await fetch('/api/auth/key', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key }) });
      return resp.status;
    }, KEY);
    await page.waitForTimeout(2000);
  }
}

async function openSession(page, s) {
  const url = `${BASE}/session/${s.id}?serverId=${s.serverId}&happier_hmr=0`;
  await page.goto(url);
  await page.waitForTimeout(3000);
  // Ensure container is present
  try {
    await page.waitForSelector('[data-testid="transcript-chat-list"]', { timeout: 10000 });
  } catch(e) {
    // try again
    await page.goto(url);
    await page.waitForTimeout(4000);
    await page.waitForSelector('[data-testid="transcript-chat-list"]', { timeout: 10000 });
  }
}

async function runScrollUp(page, s, runNum) {
  await openSession(page, s);
  await focusContainer(page);
  const result = { session: s.label, run: runNum, presses: 0, yanks: [], pins: [], finalSt: 0, finalSh: 0, reached_top: false };
  let prevSt = null, prevSh = null, stuckCount = 0;
  const samples = [];
  for (let i = 0; i < 200; i++) {
    await focusContainer(page);
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(400);
    const m = await getMetrics(page);
    if (!m) continue;
    result.presses++;
    samples.push({ i, ...m });
    // Check for yank: scrollTop increased significantly (went toward bottom) while supposedly scrolling up
    if (prevSt !== null && m.st > prevSt + 2000) {
      result.yanks.push({ press: i, prevSt, newSt: m.st, sh: m.sh, delta: m.st - prevSt });
    }
    // Check for pin: scrollTop unchanged (±4px) for 4+ consecutive presses while st > 100
    if (prevSt !== null && Math.abs(m.st - prevSt) <= 4 && m.st > 100) {
      stuckCount++;
      if (stuckCount >= 4) {
        result.pins.push({ press: i, st: m.st, sh: m.sh });
      }
    } else {
      stuckCount = 0;
    }
    prevSt = m.st;
    prevSh = m.sh;
    if (m.st <= 4) {
      result.reached_top = true;
      result.finalSt = m.st;
      result.finalSh = m.sh;
      // Wait 4 more to confirm stable
      let stableCount = 0;
      for (let j = 0; j < 8; j++) {
        await page.waitForTimeout(300);
        const m2 = await getMetrics(page);
        if (m2 && m2.st <= 4) stableCount++;
      }
      if (stableCount >= 4) break;
    }
  }
  result.finalSt = prevSt;
  result.finalSh = prevSh;
  return result;
}

async function runJTB(page, s, runNum) {
  await openSession(page, s);
  await focusContainer(page);
  // Scroll up 15 presses to get away from bottom
  for (let i = 0; i < 15; i++) {
    await focusContainer(page);
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(350);
  }
  const midMetrics = await getMetrics(page);
  // Now wait for any prepends to settle and grab metrics
  await page.waitForTimeout(1500);
  const preMidMetrics = await getMetrics(page);
  // Click JTB pill
  const jtb = await page.$('[data-testid="jump-to-bottom"]');
  if (!jtb) {
    return { session: s.label, run: runNum, pass: false, reason: 'no JTB pill visible', midMetrics };
  }
  await jtb.click();
  // Sample dfb over 2.5s
  const dfbSamples = [];
  for (let j = 0; j < 5; j++) {
    await page.waitForTimeout(500);
    const m = await getMetrics(page);
    if (m) dfbSamples.push(m.dfb);
  }
  const passed = dfbSamples.every(d => d <= 40);
  return { session: s.label, run: runNum, midMetrics: preMidMetrics, dfbSamples, passed };
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  
  // Login
  await login(page);
  console.log('Logged in / session ready');
  
  const results = { scrollUp: [], jtb: [] };
  
  for (const s of SESSIONS) {
    for (let r = 1; r <= 3; r++) {
      console.log(`Running scroll-up ${s.label} R${r}...`);
      try {
        const res = await runScrollUp(page, s, r);
        results.scrollUp.push(res);
        console.log(`  ${s.label}R${r}: presses=${res.presses} reached_top=${res.reached_top} yanks=${res.yanks.length} pins=${res.pins.length} finalSt=${res.finalSt} finalSh=${res.finalSh}`);
      } catch(e) {
        console.log(`  ${s.label}R${r} ERROR: ${e.message}`);
        results.scrollUp.push({ session: s.label, run: r, error: e.message });
      }
    }
    // JTB ×2
    for (let r = 1; r <= 2; r++) {
      console.log(`Running JTB ${s.label} J${r}...`);
      try {
        const res = await runJTB(page, s, r);
        results.jtb.push(res);
        console.log(`  ${s.label}J${r}: passed=${res.passed} dfbSamples=${JSON.stringify(res.dfbSamples)} midSt=${res.midMetrics?.st} midDfb=${res.midMetrics?.dfb}`);
      } catch(e) {
        console.log(`  ${s.label}J${r} ERROR: ${e.message}`);
        results.jtb.push({ session: s.label, run: r, error: e.message });
      }
    }
  }
  
  await browser.close();
  
  // Summary
  const scrollFails = results.scrollUp.filter(r => r.error || r.yanks?.length > 0 || !r.reached_top);
  const jtbFails = results.jtb.filter(r => r.error || !r.passed);
  console.log('\n=== SUMMARY ===');
  console.log(`Scroll-up runs: ${results.scrollUp.length}/6, fails: ${scrollFails.length}`);
  console.log(`JTB runs: ${results.jtb.length}/4, fails: ${jtbFails.length}`);
  console.log(`VERDICT: ${scrollFails.length === 0 && jtbFails.length === 0 ? 'PASS' : 'FAIL'}`);
  
  // Write JSON
  const fs = await import('fs');
  fs.writeFileSync('/tmp/p0b_qa_results.json', JSON.stringify(results, null, 2));
  console.log('Results written to /tmp/p0b_qa_results.json');
}

main().catch(e => { console.error(e); process.exit(1); });
