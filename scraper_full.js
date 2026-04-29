const { chromium } = require('playwright');
const fs = require('fs');

const CHECKIN_ISO  = '2026-05-15';
const CHECKIN_DISP = '15/05/2026';
const BASE_URL     = 'https://www.looking4.com/pt/estacionamento-do-aeroporto/lisboa-lis';
const AJAX_URL     = 'https://www.looking4.com/pt/airport-parking/ajax-search-results';
const RESULTS_URL  = 'https://www.looking4.com/pt/estacionamento-do-aeroporto/resultados-da-pesquisa/lis';

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

// Parse parking cards from the AJAX HTML response
function parseParks(html) {
  // Extract all park blocks — each begins with class="product"
  const parks = [];

  // Match price pattern: e.g. 12,00 € or €12.00
  const blockRegex = /class="[^"]*product[^"]*"[\s\S]*?(?=class="[^"]*product[^"]*"|$)/g;

  // Use line-based parsing on the decoded HTML
  const lines = html
    .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')
    .replace(/\\"/g, '"').replace(/\\/g, '')
    .split('\n').map(l => l.trim()).filter(Boolean);

  let currentPark = null;
  let inPark = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect park name lines (they follow "MAIS INFO" or are h2/h3)
    if (line.includes('class="product-name"') || line.includes('class="name"') ||
        (line.includes('Valet parking') && lines[i+1] && /[A-Z]/.test(lines[i+1][0])) ||
        (line.includes('Serviço de transfer') && lines[i+1] && /[A-Z]/.test(lines[i+1][0]))) {
      if (currentPark) parks.push(currentPark);
      currentPark = { name: '', type: '', price: null, tags: [] };
    }

    // Detect park type
    if (line === 'Valet parking' || line === 'Serviço de transfer') {
      if (currentPark) currentPark.type = line;
      else { currentPark = { name: '', type: line, price: null, tags: [] }; }
    }

    // Detect park name (usually the line after the type)
    if (currentPark && currentPark.type && !currentPark.name && line.length > 5 && line.length < 120 &&
        !line.includes('class=') && !line.includes('<') && !line.includes('€') &&
        !['RESERVAR', 'MAIS INFO', 'VER MAPA', 'RECOMENDADO', 'EUR'].includes(line)) {
      currentPark.name = line;
    }

    // Detect price: "12,00 €" or "€ 12,00"
    const priceMatch = line.match(/^(\d+[,\.]\d+)\s*€\s*$/) || line.match(/^€\s*(\d+[,\.]\d+)\s*$/);
    if (priceMatch && currentPark) {
      currentPark.price = parseFloat(priceMatch[1].replace(',', '.'));
    }
  }
  if (currentPark && currentPark.name) parks.push(currentPark);

  return parks;
}

// Alternative: extract directly from rendered page DOM
async function extractFromPage(page) {
  return page.evaluate(() => {
    const parks = [];
    const body = document.body.innerText;
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // Park type detector
      if (line === 'Valet parking' || line === 'Serviço de transfer') {
        const type = line;
        // Next non-empty, non-keyword line is the name
        let name = '';
        let price = null;
        let j = i + 1;
        while (j < lines.length && j < i + 10) {
          const l = lines[j];
          if (!name && l.length > 5 && l.length < 120 &&
              !['RESERVAR','MAIS INFO','VER MAPA','RECOMENDADO','EUR',
                'Valet parking','Serviço de transfer','[+]'].includes(l) &&
              !l.startsWith('Filtrar') && !/^\[/.test(l)) {
            name = l;
          }
          const pm = l.match(/^(\d+[,\.]\d+)\s*€/) || l.match(/€\s*(\d+[,\.]\d+)/);
          if (pm) { price = parseFloat(pm[1].replace(',', '.')); break; }
          j++;
        }
        if (name && price !== null) {
          parks.push({ name, type, price });
        }
        i = j + 1;
      } else {
        i++;
      }
    }
    return parks;
  });
}

async function fetchPricesForDays(page, days) {
  const checkOutIso = addDays(CHECKIN_ISO, days);

  // Use the AJAX endpoint via fetch from within the page (inherits session cookies)
  const result = await page.evaluate(async ({ from, to, ajaxUrl }) => {
    try {
      const resp = await fetch(ajaxUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify({
          Dates: {
            From: { Date: from, Time: '12:00' },
            To:   { Date: to,   Time: '12:00' }
          },
          DiscountCode: null,
          Campaign: null,
          CurrencySymbol: 'EUR',
          LocationCode: 'LIS',
          VelocityMemberNumber: null
        })
      });
      const json = await resp.json();
      return { ok: resp.ok, status: resp.status, html: json.data || '' };
    } catch (e) {
      return { ok: false, error: String(e), html: '' };
    }
  }, { from: CHECKIN_ISO, to: checkOutIso, ajaxUrl: AJAX_URL });

  return { days, checkOut: checkOutIso, ...result };
}

// Parse HTML string to extract parks
function parseHtml(html) {
  if (!html) return [];

  // Decode unicode escapes
  const decoded = html
    .replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>').replace(/\\"/g, '"')
    .replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\r/g, '');

  const parks = [];
  // Grab park blocks between MAIS INFO anchors or product divs
  // Simple regex approach: find name + price pairs

  // Look for patterns: name then price on nearby lines
  const lines = decoded.replace(/<[^>]+>/g, '\n').split('\n')
    .map(l => l.trim()).filter(l => l.length > 0);

  let parkType = '';
  let parkName = '';
  const SKIP = new Set(['RESERVAR','MAIS INFO','VER MAPA','RECOMENDADO','EUR','[+]',
    'Filtrar:','Todos','Ordenar Por:','Recomendado','Mais','Todos os terminais',
    'Terminal 1','Terminal 2','Distância: mais próximo','Distância: mais distante',
    'Preço: o mais baixo','Preço: o mais alto','Classificação mais baixa','Melhor Avaliado',
    'Valet parking (20)','Serviço de transfer (13)']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line === 'Valet parking' || line === 'Serviço de transfer') {
      parkType = line;
      parkName = '';
      continue;
    }

    if (parkType && !parkName && !SKIP.has(line) && line.length > 8 && line.length < 110 &&
        !/^\d/.test(line) && !line.includes('€') && !line.includes('http')) {
      parkName = line;
      continue;
    }

    if (parkType && parkName) {
      const pm = line.match(/^(\d+[,\.]\d+)\s*€/) || line.match(/^€\s*(\d+[,\.]\d+)/);
      if (pm) {
        parks.push({
          name: parkName,
          type: parkType,
          price: parseFloat(pm[1].replace(',', '.'))
        });
        parkType = '';
        parkName = '';
      }
    }
  }
  return parks;
}

async function main() {
  console.log('=== Looking4 Lisboa Parking Scraper ===');
  console.log(`Check-in: ${CHECKIN_ISO} | Periods: 1–30 days\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-PT',
    viewport: { width: 1366, height: 900 }
  });
  const page = await ctx.newPage();

  // ── STEP 1: Load landing page & submit form to get session ──────────────────
  console.log('[Setup] Loading landing page and establishing session...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Set dates for tomorrow (just to get the session going)
  const tmpOut = addDays(CHECKIN_ISO, 1);
  await nativeSet(page, '#fromDateInput', CHECKIN_DISP);
  await nativeSet(page, '#toDateInput',   toDisp(tmpOut));
  await nativeSet(page, 'input[name="Itinerary.Dates.From.Date"]',             CHECKIN_ISO);
  await nativeSet(page, 'input[name="Itinerary.Dates.To.Date"]',               tmpOut);
  await nativeSet(page, 'input[name="Quote.Itinerary.Dates.From.Date_local"]', CHECKIN_ISO);
  await page.waitForTimeout(400);

  // Submit form → navigate to results page
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
    page.click('button[type="submit"].submit')
  ]);
  await page.waitForTimeout(3000);
  console.log(`[Setup] Session established. URL: ${page.url()}\n`);

  // ── STEP 2: Fetch prices for each period via AJAX ──────────────────────────
  const allData = {};   // days → array of parks

  for (let days = 1; days <= 30; days++) {
    process.stdout.write(`[${String(days).padStart(2,'0')}d] Fetching... `);

    try {
      const res = await fetchPricesForDays(page, days);

      if (!res.ok || !res.html) {
        // Fallback: interact with page directly for this period
        console.log(`AJAX failed (${res.status || res.error}) → trying page interaction`);
        allData[days] = [];
        continue;
      }

      const parks = parseHtml(res.html);
      allData[days] = parks;
      console.log(`✓  ${parks.length} parks found`);

    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      allData[days] = [];
    }

    // Small delay between requests
    await page.waitForTimeout(800);
  }

  await browser.close();

  // ── STEP 3: Save raw data ─────────────────────────────────────────────────
  fs.writeFileSync('parking_data.json', JSON.stringify(allData, null, 2));
  console.log('\nRaw data saved to parking_data.json');

  // ── STEP 4: Print summary table ───────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  const sample = allData[1] || [];
  const parkNames = [...new Set(Object.values(allData).flat().map(p => p.name))].sort();
  console.log(`Parks discovered: ${parkNames.length}`);
  parkNames.forEach(n => console.log(' -', n));

  console.log('\nPrices for 1 day:');
  (allData[1] || []).sort((a,b) => a.price - b.price).forEach(p =>
    console.log(`  ${String(p.price.toFixed(2) + ' €').padStart(8)} — ${p.name}`)
  );

  // ── STEP 5: Build dashboard ───────────────────────────────────────────────
  buildDashboard(allData, parkNames);
  console.log('\nDashboard saved to dashboard.html');
}

function buildDashboard(allData, parkNames) {
  // Build a pivot: park → array of [days, price]
  const parkMap = {};
  parkNames.forEach(name => { parkMap[name] = {}; });

  Object.entries(allData).forEach(([days, parks]) => {
    parks.forEach(p => {
      if (!parkMap[p.name]) parkMap[p.name] = {};
      parkMap[p.name][days] = p.price;
    });
  });

  // Collect types
  const typeMap = {};
  Object.values(allData).flat().forEach(p => {
    if (!typeMap[p.name]) typeMap[p.name] = p.type;
  });

  const days = Array.from({length: 30}, (_, i) => i + 1);

  // Color per park type
  const typeColors = {
    'Valet parking': '#7c3aed',
    'Serviço de transfer': '#2563eb',
  };

  // Chart datasets
  const datasets = parkNames.map((name, idx) => {
    const hue = (idx * 37) % 360;
    const color = typeColors[typeMap[name]] || `hsl(${hue},70%,50%)`;
    return {
      label: name.replace(' - Lisboa', '').replace('Lisboa', '').trim(),
      data: days.map(d => parkMap[name][d] ?? null),
      borderColor: color,
      backgroundColor: color + '22',
      tension: 0.3,
      spanGaps: true
    };
  });

  // Table HTML
  let tableRows = '';
  const sorted = Object.keys(parkMap).sort((a, b) => {
    const pa = parkMap[a][1] ?? 9999;
    const pb = parkMap[b][1] ?? 9999;
    return pa - pb;
  });

  sorted.forEach(name => {
    const priceByDay = parkMap[name];
    const type = typeMap[name] || '';
    const badge = type === 'Valet parking'
      ? '<span class="badge valet">Valet</span>'
      : '<span class="badge transfer">Transfer</span>';

    let cells = '';
    [1,2,3,4,5,6,7,10,14,21,30].forEach(d => {
      const p = priceByDay[d];
      cells += `<td>${p != null ? p.toFixed(2) + ' €' : '—'}</td>`;
    });

    tableRows += `<tr>
      <td class="park-name">${badge} ${name.replace(' - Lisboa','').replace('Lisboa','').trim()}</td>
      ${cells}
    </tr>`;
  });

  const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Parques Lisboa – Looking4 Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }

  header {
    background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%);
    padding: 32px 40px;
    border-bottom: 1px solid #4338ca;
  }
  header h1 { font-size: 2rem; font-weight: 800; color: #fff; letter-spacing: -0.5px; }
  header p  { color: #a5b4fc; margin-top: 6px; font-size: 0.95rem; }

  .kpi-row {
    display: flex; gap: 20px; padding: 28px 40px;
    flex-wrap: wrap;
  }
  .kpi {
    background: #1e293b; border: 1px solid #334155; border-radius: 12px;
    padding: 20px 28px; flex: 1; min-width: 180px;
  }
  .kpi .label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; }
  .kpi .value { font-size: 2rem; font-weight: 800; color: #a78bfa; margin-top: 4px; }
  .kpi .sub   { font-size: 0.82rem; color: #64748b; margin-top: 2px; }

  .section { padding: 0 40px 40px; }
  .section h2 { font-size: 1.2rem; font-weight: 700; color: #c4b5fd; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #1e293b; }

  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .chart-box {
    background: #1e293b; border: 1px solid #334155; border-radius: 12px;
    padding: 20px; position: relative;
  }
  .chart-box.full { grid-column: 1 / -1; }
  .chart-box h3 { font-size: 0.9rem; color: #94a3b8; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }

  .table-wrap { overflow-x: auto; border-radius: 12px; border: 1px solid #334155; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  thead { background: #1e293b; }
  thead th {
    padding: 12px 14px; text-align: center; font-weight: 700;
    color: #94a3b8; border-bottom: 2px solid #334155;
    font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px;
  }
  thead th.park-col { text-align: left; min-width: 260px; }
  tbody tr { border-bottom: 1px solid #1e293b; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: #1a2744; }
  tbody td { padding: 11px 14px; text-align: center; color: #cbd5e1; }
  tbody td.park-name { text-align: left; color: #e2e8f0; font-weight: 500; }

  .badge {
    display: inline-block; border-radius: 4px; padding: 2px 7px;
    font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.3px; margin-right: 6px;
  }
  .badge.valet    { background: #4c1d95; color: #ddd6fe; }
  .badge.transfer { background: #1e3a8a; color: #bfdbfe; }

  .filters {
    display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap;
  }
  .filter-btn {
    background: #1e293b; border: 1px solid #334155; border-radius: 8px;
    padding: 8px 18px; color: #94a3b8; cursor: pointer; font-size: 0.85rem;
    transition: all 0.2s;
  }
  .filter-btn:hover, .filter-btn.active {
    background: #4c1d95; border-color: #7c3aed; color: #e9d5ff;
  }

  .day-slider-wrap { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
  .day-slider-wrap label { color: #94a3b8; font-size: 0.9rem; white-space: nowrap; }
  .day-slider-wrap input[type=range] { flex: 1; accent-color: #7c3aed; }
  #sliderVal { font-size: 1.4rem; font-weight: 800; color: #a78bfa; width: 60px; text-align: right; }

  footer { text-align: center; padding: 24px; color: #475569; font-size: 0.82rem; border-top: 1px solid #1e293b; }
</style>
</head>
<body>

<header>
  <h1>🅿️ Parques Lisboa — Looking4.com</h1>
  <p>Preços recolhidos automaticamente · Check-in: ${CHECKIN_ISO} · ${parkNames.length} parques · 1–30 dias</p>
</header>

<div class="kpi-row">
  <div class="kpi">
    <div class="label">Total de Parques</div>
    <div class="value">${parkNames.length}</div>
    <div class="sub">Aeroporto de Lisboa (LIS)</div>
  </div>
  <div class="kpi">
    <div class="label">Mais Barato (1 dia)</div>
    <div class="value" id="cheapest1d">—</div>
    <div class="sub" id="cheapest1d-name">—</div>
  </div>
  <div class="kpi">
    <div class="label">Mais Caro (1 dia)</div>
    <div class="value" id="priciest1d">—</div>
    <div class="sub" id="priciest1d-name">—</div>
  </div>
  <div class="kpi">
    <div class="label">Preço Médio (7 dias)</div>
    <div class="value" id="avg7d">—</div>
    <div class="sub">Todos os parques</div>
  </div>
  <div class="kpi">
    <div class="label">Valet / Transfer</div>
    <div class="value" id="typeSplit">—</div>
    <div class="sub">parques por tipo</div>
  </div>
</div>

<div class="section">
  <h2>Evolução de Preços por Número de Dias</h2>

  <div class="filters">
    <button class="filter-btn active" onclick="filterType('all',this)">Todos</button>
    <button class="filter-btn" onclick="filterType('Valet parking',this)">Valet Parking</button>
    <button class="filter-btn" onclick="filterType('Serviço de transfer',this)">Serviço de Transfer</button>
  </div>

  <div class="chart-grid">
    <div class="chart-box full">
      <h3>Evolução do preço por número de dias (todos os parques)</h3>
      <canvas id="lineAll" height="120"></canvas>
    </div>
    <div class="chart-box">
      <h3>Preços para N dias (slider)</h3>
      <div class="day-slider-wrap">
        <label>Dias:</label>
        <input type="range" id="daySlider" min="1" max="30" value="1" oninput="updateBarChart(this.value)">
        <span id="sliderVal">1 dia</span>
      </div>
      <canvas id="barDay" height="200"></canvas>
    </div>
    <div class="chart-box">
      <h3>Preço médio por tipo (1–30 dias)</h3>
      <canvas id="lineAvg" height="200"></canvas>
    </div>
  </div>
</div>

<div class="section">
  <h2>Tabela Completa de Preços</h2>
  <div class="table-wrap">
    <table id="priceTable">
      <thead>
        <tr>
          <th class="park-col">Parque</th>
          <th>1 dia</th>
          <th>2 dias</th>
          <th>3 dias</th>
          <th>4 dias</th>
          <th>5 dias</th>
          <th>6 dias</th>
          <th>7 dias</th>
          <th>10 dias</th>
          <th>14 dias</th>
          <th>21 dias</th>
          <th>30 dias</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>
</div>

<footer>
  Dashboard gerado automaticamente por Claude · Dados: looking4.com · ${new Date().toLocaleDateString('pt-PT')}
</footer>

<script>
const RAW = ${JSON.stringify(allData)};
const NAMES = ${JSON.stringify(parkNames)};
const TYPES = ${JSON.stringify(typeMap)};
const DAYS  = Array.from({length:30},(_,i)=>i+1);

// Build parkMap: name -> {day -> price}
const parkMap = {};
NAMES.forEach(n => { parkMap[n] = {}; });
Object.entries(RAW).forEach(([d, parks]) => {
  parks.forEach(p => {
    if (!parkMap[p.name]) parkMap[p.name] = {};
    parkMap[p.name][d] = p.price;
  });
});

// KPIs
const prices1d = NAMES.map(n => ({name: n, price: parkMap[n][1] ?? null})).filter(x => x.price !== null);
prices1d.sort((a,b) => a.price - b.price);
if (prices1d.length) {
  document.getElementById('cheapest1d').textContent = prices1d[0].price.toFixed(2) + ' €';
  document.getElementById('cheapest1d-name').textContent = prices1d[0].name.replace(' - Lisboa','').slice(0,40);
  document.getElementById('priciest1d').textContent = prices1d[prices1d.length-1].price.toFixed(2) + ' €';
  document.getElementById('priciest1d-name').textContent = prices1d[prices1d.length-1].name.replace(' - Lisboa','').slice(0,40);
}
const p7 = NAMES.map(n => parkMap[n][7]).filter(v => v != null);
document.getElementById('avg7d').textContent = p7.length ? (p7.reduce((a,b)=>a+b,0)/p7.length).toFixed(2)+' €' : '—';

const valetCount    = NAMES.filter(n => TYPES[n] === 'Valet parking').length;
const transferCount = NAMES.filter(n => TYPES[n] === 'Serviço de transfer').length;
document.getElementById('typeSplit').textContent = valetCount + ' / ' + transferCount;

// ── Line chart: all parks ─────────────────────────────────────────────────
const COLORS = NAMES.map((n,i) => {
  const h = (i*37)%360;
  return TYPES[n]==='Valet parking' ? \`hsl(\${h},70%,65%)\` : \`hsl(\${(h+180)%360},60%,65%)\`;
});

let lineAllChart = new Chart(document.getElementById('lineAll'), {
  type: 'line',
  data: {
    labels: DAYS,
    datasets: NAMES.map((name, idx) => ({
      label: name.replace(' - Lisboa','').replace('Lisboa','').trim(),
      data: DAYS.map(d => parkMap[name][d] ?? null),
      borderColor: COLORS[idx],
      backgroundColor: 'transparent',
      tension: 0.3, spanGaps: true,
      borderWidth: 2,
      pointRadius: 2
    }))
  },
  options: {
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: 'index', intersect: false,
        callbacks: { label: ctx => \`\${ctx.dataset.label}: \${ctx.parsed.y?.toFixed(2)} €\` }
      }
    },
    scales: {
      x: { title: { display: true, text: 'Número de dias', color: '#64748b' }, ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
      y: { title: { display: true, text: 'Preço (€)', color: '#64748b' }, ticks: { color: '#64748b', callback: v => v+'€' }, grid: { color: '#1e293b' } }
    }
  }
});

// ── Bar chart: prices for selected day ────────────────────────────────────
let barChart;
function updateBarChart(val) {
  const d = +val;
  document.getElementById('sliderVal').textContent = d + (d===1?' dia':' dias');

  const filtered = NAMES.map((n,i) => ({
    name: n.replace(' - Lisboa','').replace('Lisboa','').trim(),
    price: parkMap[n][d] ?? null,
    color: COLORS[i]
  })).filter(x => x.price !== null).sort((a,b) => a.price - b.price);

  const data = {
    labels: filtered.map(x => x.name),
    datasets: [{
      data: filtered.map(x => x.price),
      backgroundColor: filtered.map(x => x.color + 'cc'),
      borderColor: filtered.map(x => x.color),
      borderWidth: 1, borderRadius: 4
    }]
  };

  if (barChart) { barChart.data = data; barChart.update(); return; }

  barChart = new Chart(document.getElementById('barDay'), {
    type: 'bar',
    data,
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ctx.parsed.x.toFixed(2) + ' €' } }
      },
      scales: {
        x: { ticks: { color: '#64748b', callback: v => v+'€' }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
}
updateBarChart(1);

// ── Line chart: avg by type ───────────────────────────────────────────────
const valetNames    = NAMES.filter(n => TYPES[n]==='Valet parking');
const transferNames = NAMES.filter(n => TYPES[n]==='Serviço de transfer');

function avgForDay(names, d) {
  const vals = names.map(n => parkMap[n][d]).filter(v => v != null);
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
}

new Chart(document.getElementById('lineAvg'), {
  type: 'line',
  data: {
    labels: DAYS,
    datasets: [
      {
        label: 'Valet Parking (média)',
        data: DAYS.map(d => avgForDay(valetNames, d)),
        borderColor: '#a78bfa', backgroundColor: '#a78bfa22',
        tension: 0.4, fill: true, spanGaps: true, borderWidth: 2
      },
      {
        label: 'Serviço de Transfer (média)',
        data: DAYS.map(d => avgForDay(transferNames, d)),
        borderColor: '#60a5fa', backgroundColor: '#60a5fa22',
        tension: 0.4, fill: true, spanGaps: true, borderWidth: 2
      }
    ]
  },
  options: {
    responsive: true,
    plugins: {
      legend: { labels: { color: '#94a3b8', font: { size: 11 } } },
      tooltip: { callbacks: { label: ctx => \`\${ctx.dataset.label}: \${ctx.parsed.y?.toFixed(2)} €\` } }
    },
    scales: {
      x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
      y: { ticks: { color: '#64748b', callback: v => v+'€' }, grid: { color: '#1e293b' } }
    }
  }
});

// ── Type filter ───────────────────────────────────────────────────────────
let currentType = 'all';
function filterType(type, btn) {
  currentType = type;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const newDatasets = NAMES
    .filter(n => type==='all' || TYPES[n]===type)
    .map((name, idx) => ({
      label: name.replace(' - Lisboa','').replace('Lisboa','').trim(),
      data: DAYS.map(d => parkMap[name][d] ?? null),
      borderColor: COLORS[NAMES.indexOf(name)],
      backgroundColor: 'transparent',
      tension: 0.3, spanGaps: true, borderWidth: 2, pointRadius: 2
    }));

  lineAllChart.data.datasets = newDatasets;
  lineAllChart.update();

  // Also filter table
  document.querySelectorAll('#priceTable tbody tr').forEach(row => {
    const badge = row.querySelector('.badge');
    if (!badge) return;
    if (type==='all') { row.style.display=''; return; }
    const isValet = badge.classList.contains('valet');
    row.style.display = (type==='Valet parking'&&isValet)||(type!=='Valet parking'&&!isValet) ? '' : 'none';
  });
}
</script>
</body>
</html>`;

  fs.writeFileSync('dashboard.html', html);
}

main().catch(console.error);
