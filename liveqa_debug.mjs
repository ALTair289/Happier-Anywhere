import { chromium } from 'playwright';

const BASE = 'http://happier-repo-remote-dev-d72117acdb.localhost:18829';
const KEY = 'TKKFL-2B6NN-ZNTCZ-L5E3I-KBMHM-V5AV7-M4K2R-GL2M5-6ZLUA-GMPNK-6Q';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  
  // Navigate to base and check state
  await page.goto(`${BASE}/?happier_hmr=0`);
  await page.waitForLoadState('networkidle');
  console.log('Base URL:', page.url());
  console.log('Title:', await page.title());
  
  // Check for login form
  const content = await page.content();
  console.log('Has login:', content.includes('login') || content.includes('Login'));
  console.log('Has key:', content.includes('key') || content.includes('Key'));
  
  // Check what's on page
  const inputs = await page.$$('input');
  console.log('Input count:', inputs.length);
  for (const inp of inputs) {
    const ph = await inp.getAttribute('placeholder');
    const type = await inp.getAttribute('type');
    console.log('  input:', type, ph);
  }
  
  // Try session directly
  await page.goto(`${BASE}/session/cmracew6101cztm5nya6yqxx4?serverId=srv_xTGdUNfHw32U8ONqT4H2xggPR42D73EJ&happier_hmr=0`);
  await page.waitForTimeout(5000);
  console.log('Session URL:', page.url());
  
  // Check for auth-related elements
  const content2 = await page.content();
  const hasTranscript = content2.includes('transcript-chat-list');
  const hasAuth = content2.includes('login') || content2.includes('auth') || content2.includes('key');
  console.log('Has transcript:', hasTranscript, 'Has auth:', hasAuth);
  
  // Check title
  console.log('Page title after session nav:', await page.title());
  
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
