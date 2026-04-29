const { chromium } = require('playwright');
const fs = require('fs');

const CHECKIN_ISO  = '2026-05-15';   // YYYY-MM-DD
const CHECKIN_DISP = '15/05/2026';   // DD/MM/YYYY (what the form shows)
const BASE_URL = 'https://www.looking4.com/pt/estacionamento-do-aeroporto/lisboa-lis';

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function toDisplay(iso) {
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ----------------------------------------------------------------
// Set a <input> value in a way that triggers Vue/React reactivity
// ----------------------------------------------------------------
async function nativeSet(page, selector, value) {
  await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(el, val);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });
}

// ----------------------------------------------------------------
// Fill in the form dates and submit, then wait for AJAX results
// ----------------------------------------------------------------
async function scrapeDays(page, days) {
  const checkOutIso  = addDays(CHECKIN_ISO, days);
  const checkOutDisp = toDisplay(checkOutIso);
  console.log(`[${String(days).padStart(2,'0')}d] ${CHECKIN_ISO} → ${checkOutIso}`);

  // 1. Load the landing page
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // 2. Set visible text inputs (DD/MM/YYYY)
  await nativeSet(page, '#fromDateInput', CHECKIN_DISP);
  await nativeSet(page, '#toDateInput',   checkOutDisp);

  // 3. Set hidden inputs (YYYY-MM-DD)
  await nativeSet(page, 'input[name="Itinerary.Dates.From.Date"]',             CHECKIN_ISO);
  await nativeSet(page, 'input[name="Itinerary.Dates.To.Date"]',               checkOutIso);
  await nativeSet(page, 'input[name="Quote.Itinerary.Dates.From.Date_local"]', CHECKIN_ISO);

  await page.waitForTimeout(400);

  // 4. Click "Compare os preços" and wait for navigation
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
    page.click('button[type="submit"].submit')
  ]);

  const resultsUrl = page.url();
  console.log(`   → ${resultsUrl}`);

  // 5. Wait for the AJAX results spinner to disappear
  //    (the loading text "Por favor aguarde" leaves when results arrive)
  try {
    await page.waitForFunction(
      () => !document.body.innerText.includes('Por favor aguarde'),
      { timeout: 30000, polling: 500 }
    );
  } catch {
    console.log('   ⚠ Timeout waiting for results – using what is loaded');
  }
  await page.waitForTimeout(1000);

  // 6. Extract all parking cards
  const parks = await page.evaluate(() => {
    const results = [];

    // The results page uses a classic server-rendered table / list.
    // Try progressively more generic selectors.
    const selectors = [
      '.car-park', '.carpark', '[class*="car-park"]', '[class*="CarPark"]',
      '.product', '[class*="product"]',
      '[data-product-id]', '[data-park-id]',
      'tr[data-id]', 'li[data-id]',
      '.result', '[class*="result"]',
    ];

    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length > 0) {
        els.forEach(el => {
          const text = el.textContent.trim();
          const priceMatch = text.match(/€\s*([\d]+[,\.][\d]+|[\d]+)/g);
          const nameEl = el.querySelector('h2,h3,h4,[class*="name"],[class*="title"],strong');
          if (priceMatch) {
            results.push({
              name: nameEl ? nameEl.textContent.trim() : text.substring(0, 60),
              prices: priceMatch,
              rawText: text.substring(0, 200)
            });
          }
        });
        if (results.length > 0) break;
      }
    }

    // Fallback: grab every line that has a price
    if (results.length === 0) {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
      lines.forEach((line, i) => {
        if (/€\s*[\d]/.test(line) && line.length < 150) {
          results.push({
            name: lines[i - 1] || '',
            prices: line.match(/€\s*[\d,\.]+/g) || [],
            rawText: line
          });
        }
      });
    }

    return results;
  });

  // 7. Also get the full page text for debugging
  const bodyText = await page.evaluate(() => document.body.innerText);

  return { days, checkIn: CHECKIN_ISO, checkOut: checkOutIso, parks, bodyText };
}

// ----------------------------------------------------------------
// Main – first test 1 day, then iterate 1-30
// ----------------------------------------------------------------
async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-PT',
    viewport: { width: 1366, height: 900 }
  });
  const page = await ctx.newPage();

  // ---- Test with 1 day ----
  const test = await scrapeDays(page, 1);
  await page.screenshot({ path: 'results_1day.png', fullPage: false });

  console.log('\n=== 1-DAY RESULTS ===');
  console.log('Parks found:', test.parks.length);
  test.parks.slice(0, 10).forEach(p =>
    console.log(`  ${p.name.substring(0,50).padEnd(50)} | ${p.prices.join(' / ')}`)
  );
  if (test.parks.length === 0) {
    console.log('\n--- Page body sample ---');
    console.log(test.bodyText.substring(0, 1500));
  }

  fs.writeFileSync('test_1day.json', JSON.stringify(test, null, 2));
  await browser.close();
  console.log('\nDone. Check test_1day.json and results_1day.png');
}

main().catch(console.error);
