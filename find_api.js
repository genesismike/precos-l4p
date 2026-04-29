const { chromium } = require('playwright');
const fs = require('fs');

const CHECKIN_ISO  = '2026-05-15';
const CHECKIN_DISP = '15/05/2026';
const BASE_URL = 'https://www.looking4.com/pt/estacionamento-do-aeroporto/lisboa-lis';

function addDays(d, n) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().split('T')[0];
}
function toDisp(iso) {
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
async function nativeSet(page, sel, val) {
  await page.evaluate(({ s, v }) => {
    const el = document.querySelector(s);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { s: sel, v: val });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-PT',
    viewport: { width: 1366, height: 900 }
  });
  const page = await ctx.newPage();

  const checkOutIso  = addDays(CHECKIN_ISO, 1);
  const checkOutDisp = toDisp(checkOutIso);

  // Collect ALL network calls
  const allRequests = [];
  const allResponses = [];

  page.on('request', req => {
    const url = req.url();
    if (!url.includes('feefo') && !url.includes('google') && !url.includes('datadog') &&
        !url.includes('mparticle') && !url.includes('storyblok') && !url.includes('.css') &&
        !url.includes('.js') && !url.includes('.png') && !url.includes('.svg') &&
        !url.includes('.woff') && !url.includes('.ico')) {
      allRequests.push({ method: req.method(), url, postData: req.postData() });
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('feefo') && !url.includes('google') && !url.includes('datadog') &&
        !url.includes('mparticle') && !url.includes('storyblok') && !url.includes('.css') &&
        !url.includes('.js') && !url.includes('.png') && !url.includes('.svg')) {
      try {
        const ct = res.headers()['content-type'] || '';
        const status = res.status();
        let body = null;
        if (ct.includes('json') || ct.includes('text')) {
          body = await res.text().catch(() => null);
        }
        allResponses.push({ url, status, ct, body: body ? body.substring(0, 500) : null });
      } catch {}
    }
  });

  // 1. Load landing page
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 2. Set dates
  await nativeSet(page, '#fromDateInput', CHECKIN_DISP);
  await nativeSet(page, '#toDateInput',   checkOutDisp);
  await nativeSet(page, 'input[name="Itinerary.Dates.From.Date"]',             CHECKIN_ISO);
  await nativeSet(page, 'input[name="Itinerary.Dates.To.Date"]',               checkOutIso);
  await nativeSet(page, 'input[name="Quote.Itinerary.Dates.From.Date_local"]', CHECKIN_ISO);
  await page.waitForTimeout(500);

  // 3. Submit
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
    page.click('button[type="submit"].submit')
  ]);

  console.log('After submit URL:', page.url());

  // 4. Wait up to 60s for results to appear
  console.log('Waiting for results...');
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body.innerText);
    const hasPrice = /€\s*[\d]/.test(text);
    const isLoading = text.includes('Por favor aguarde');
    process.stdout.write(`\r  [${i+1}s] loading=${isLoading} prices=${hasPrice}    `);
    if (hasPrice && !isLoading) { console.log('\n  ✓ Results loaded!'); break; }
    if (!isLoading && !hasPrice && i > 10) { console.log('\n  ✗ Stopped loading but no prices'); break; }
  }

  // 5. Final screenshot
  await page.screenshot({ path: 'results_loaded.png', fullPage: true });

  // 6. Final page text
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('\n--- Final body text (first 2000 chars) ---');
  console.log(bodyText.substring(0, 2000));

  // 7. Report all API calls
  console.log('\n\n=== ALL REQUESTS (non-asset) ===');
  allRequests.forEach(r => {
    console.log(`${r.method} ${r.url}`);
    if (r.postData) console.log('  POST:', r.postData.substring(0, 200));
  });

  console.log('\n=== ALL RESPONSES (non-asset) ===');
  allResponses.forEach(r => {
    if (r.body && r.body.includes('€') || r.url.includes('quote') || r.url.includes('search') ||
        r.url.includes('park') || r.url.includes('product')) {
      console.log(`[${r.status}] ${r.url}`);
      if (r.body) console.log('  BODY:', r.body.substring(0, 300));
    }
  });

  fs.writeFileSync('api_calls.json', JSON.stringify({ allRequests, allResponses }, null, 2));
  await browser.close();
  console.log('\nSaved api_calls.json and results_loaded.png');
}

main().catch(console.error);
