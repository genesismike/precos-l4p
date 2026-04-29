const fs = require('fs');

const raw = JSON.parse(fs.readFileSync('parking_data.json', 'utf8'));
const CHECKIN_ISO = '2026-05-15';

// ── 1. Decode HTML entities & normalize park names ─────────────────────────
function decodeHtml(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── 2. Build clean dataset ─────────────────────────────────────────────────
// parkMap: canonicalName -> {day -> price}
// typeMap: canonicalName -> type
const parkMap = {};
const typeMap  = {};

Object.entries(raw).forEach(([d, parks]) => {
  const day = +d;
  parks.forEach(p => {
    const name = decodeHtml(p.name);
    if (!parkMap[name]) { parkMap[name] = {}; typeMap[name] = p.type; }
    // Keep lowest price if somehow duplicated within same day
    if (parkMap[name][day] == null || p.price < parkMap[name][day]) {
      parkMap[name][day] = p.price;
    }
  });
});

// Sort park names
const parkNames = Object.keys(parkMap).sort((a, b) => {
  const pa = parkMap[a][1] ?? 9999;
  const pb = parkMap[b][1] ?? 9999;
  return pa - pb;
});

const DAYS = Array.from({length: 30}, (_, i) => i + 1);

console.log(`Parks (clean): ${parkNames.length}`);
parkNames.forEach((n, i) => {
  const p1 = parkMap[n][1], p7 = parkMap[n][7], p30 = parkMap[n][30];
  console.log(`${String(i+1).padStart(2)}. ${n.padEnd(70)} 1d:${p1??'-'} 7d:${p7??'-'} 30d:${p30??'-'}`);
});

// ── 3. KPIs ────────────────────────────────────────────────────────────────
const prices1d = parkNames.map(n => ({name:n, price: parkMap[n][1] ?? null})).filter(x=>x.price!=null);
prices1d.sort((a,b)=>a.price-b.price);
const cheapest = prices1d[0];
const priciest = prices1d[prices1d.length-1];
const p7vals   = parkNames.map(n=>parkMap[n][7]).filter(v=>v!=null);
const avg7d    = p7vals.length ? (p7vals.reduce((a,b)=>a+b,0)/p7vals.length).toFixed(2) : '—';
const valetCnt = parkNames.filter(n=>typeMap[n]==='Valet parking').length;
const xferCnt  = parkNames.filter(n=>typeMap[n]==='Serviço de transfer').length;
const autoCnt  = parkNames.filter(n=>!['Valet parking','Serviço de transfer'].includes(typeMap[n])).length;

// ── 4. Table rows ──────────────────────────────────────────────────────────
const TABLE_DAYS = [1,2,3,4,5,6,7,10,14,21,30];

function tableRows() {
  return parkNames.map(name => {
    const type = typeMap[name] || '';
    let badge = '';
    if (type === 'Valet parking')          badge = '<span class="badge valet">Valet</span>';
    else if (type === 'Serviço de transfer') badge = '<span class="badge transfer">Transfer</span>';
    else                                   badge = '<span class="badge other">Outro</span>';

    const priceByDay = parkMap[name];
    const shortName = name.replace(' - Lisboa', '').replace(' - Lisbon', '').trim();

    // Highlight min/max per row
    const vals = TABLE_DAYS.map(d => priceByDay[d]).filter(v => v != null);
    const rowMin = Math.min(...vals);
    const rowMax = Math.max(...vals);

    const cells = TABLE_DAYS.map(d => {
      const p = priceByDay[d];
      if (p == null) return `<td class="na">—</td>`;
      const cls = p === rowMin ? ' class="cell-min"' : p === rowMax ? ' class="cell-max"' : '';
      return `<td${cls}>${p.toFixed(2)} €</td>`;
    }).join('');

    return `<tr data-type="${type}">
      <td class="park-name">${badge} ${shortName}</td>
      ${cells}
    </tr>`;
  }).join('\n');
}

// ── 5. Chart colours ───────────────────────────────────────────────────────
const COLORS = parkNames.map((n, i) => {
  const h = (i * 37) % 360;
  if (typeMap[n] === 'Valet parking')          return `hsl(${h},75%,65%)`;
  if (typeMap[n] === 'Serviço de transfer')    return `hsl(${(h+120)%360},65%,65%)`;
  return `hsl(${(h+240)%360},55%,65%)`;
});

// ── 6. Generate HTML ───────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parques Lisboa · Looking4 Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}

  /* ── Header ─────────────────────────────────────────── */
  header{
    background:linear-gradient(135deg,#1e1b4b 0%,#2d1b69 50%,#1e1b4b 100%);
    padding:36px 48px 28px;
    border-bottom:1px solid #312e81;
  }
  header h1{font-size:2.1rem;font-weight:800;color:#fff;display:flex;align-items:center;gap:12px}
  header h1 .icon{font-size:2.4rem}
  header p{color:#a5b4fc;margin-top:8px;font-size:0.92rem;line-height:1.6}
  .header-meta{display:flex;gap:24px;margin-top:14px;flex-wrap:wrap}
  .meta-chip{background:#1e1b4b;border:1px solid #3730a3;border-radius:20px;padding:5px 14px;font-size:0.8rem;color:#c4b5fd}

  /* ── KPIs ────────────────────────────────────────────── */
  .kpi-row{display:flex;gap:16px;padding:28px 48px;flex-wrap:wrap}
  .kpi{
    background:#1e293b;border:1px solid #334155;border-radius:14px;
    padding:20px 24px;flex:1;min-width:160px;position:relative;overflow:hidden;
  }
  .kpi::before{
    content:'';position:absolute;top:0;left:0;right:0;height:3px;
    background:linear-gradient(90deg,#7c3aed,#a78bfa);
  }
  .kpi.blue::before{background:linear-gradient(90deg,#2563eb,#60a5fa)}
  .kpi.green::before{background:linear-gradient(90deg,#059669,#34d399)}
  .kpi.red::before{background:linear-gradient(90deg,#dc2626,#f87171)}
  .kpi.orange::before{background:linear-gradient(90deg,#d97706,#fbbf24)}
  .kpi .label{font-size:0.74rem;text-transform:uppercase;letter-spacing:1.2px;color:#64748b;margin-bottom:6px}
  .kpi .value{font-size:1.9rem;font-weight:800;color:#a78bfa;line-height:1}
  .kpi.blue .value{color:#60a5fa}
  .kpi.green .value{color:#34d399}
  .kpi.red .value{color:#f87171}
  .kpi.orange .value{color:#fbbf24}
  .kpi .sub{font-size:0.78rem;color:#475569;margin-top:6px;line-height:1.4}

  /* ── Sections ────────────────────────────────────────── */
  .section{padding:0 48px 40px}
  .section-title{
    font-size:1.1rem;font-weight:700;color:#c4b5fd;
    padding:0 0 12px;margin-bottom:20px;
    border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:8px;
  }
  .section-title .dot{width:8px;height:8px;border-radius:50%;background:#7c3aed;display:inline-block}

  /* ── Charts ──────────────────────────────────────────── */
  .chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px}
  .chart-box{
    background:#1e293b;border:1px solid #334155;border-radius:14px;
    padding:22px;
  }
  .chart-box.full{grid-column:1/-1}
  .chart-box h3{font-size:0.78rem;color:#64748b;margin-bottom:14px;text-transform:uppercase;letter-spacing:0.8px}

  /* ── Slider ──────────────────────────────────────────── */
  .slider-row{display:flex;align-items:center;gap:14px;margin-bottom:14px}
  .slider-row label{color:#94a3b8;font-size:0.85rem;white-space:nowrap}
  .slider-row input[type=range]{flex:1;accent-color:#7c3aed;cursor:pointer}
  #sliderVal{font-size:1.3rem;font-weight:800;color:#a78bfa;min-width:70px;text-align:right}

  /* ── Filters ─────────────────────────────────────────── */
  .filters{display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;align-items:center}
  .filters span{color:#64748b;font-size:0.82rem;margin-right:4px}
  .filter-btn{
    background:#1e293b;border:1px solid #334155;border-radius:8px;
    padding:7px 16px;color:#94a3b8;cursor:pointer;font-size:0.83rem;transition:all .15s;
  }
  .filter-btn:hover{background:#2d3748;border-color:#4a5568;color:#cbd5e1}
  .filter-btn.active{background:#4c1d95;border-color:#7c3aed;color:#e9d5ff}
  .filter-btn.active.blue{background:#1e3a8a;border-color:#2563eb;color:#bfdbfe}

  /* ── Table ───────────────────────────────────────────── */
  .table-wrap{overflow-x:auto;border-radius:14px;border:1px solid #334155}
  table{width:100%;border-collapse:collapse;font-size:0.85rem}
  thead{background:#1e293b;position:sticky;top:0;z-index:2}
  thead th{
    padding:13px 12px;text-align:center;font-weight:700;color:#64748b;
    border-bottom:2px solid #334155;font-size:0.74rem;text-transform:uppercase;letter-spacing:0.5px;
  }
  thead th.park-col{text-align:left;min-width:280px;padding-left:16px}
  tbody tr{border-bottom:1px solid #172033;transition:background .1s}
  tbody tr:hover{background:#1a2744}
  tbody td{padding:11px 12px;text-align:center;color:#94a3b8;font-variant-numeric:tabular-nums}
  tbody td.park-name{text-align:left;color:#e2e8f0;font-weight:500;padding-left:16px}
  tbody td.na{color:#334155}
  tbody td.cell-min{color:#34d399;font-weight:700}
  tbody td.cell-max{color:#f87171;font-weight:600}

  /* ── Badges ──────────────────────────────────────────── */
  .badge{
    display:inline-block;border-radius:4px;padding:2px 7px;
    font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.3px;
    margin-right:6px;vertical-align:middle;
  }
  .badge.valet   {background:#3b0764;color:#ddd6fe;border:1px solid #7c3aed}
  .badge.transfer{background:#1e3a5f;color:#bfdbfe;border:1px solid #2563eb}
  .badge.other   {background:#1c3031;color:#a7f3d0;border:1px solid #059669}

  /* ── Search ──────────────────────────────────────────── */
  .search-wrap{margin-bottom:14px}
  .search-wrap input{
    background:#1e293b;border:1px solid #334155;border-radius:8px;
    padding:9px 16px;color:#e2e8f0;font-size:0.88rem;width:320px;outline:none;
  }
  .search-wrap input::placeholder{color:#475569}
  .search-wrap input:focus{border-color:#7c3aed}

  footer{text-align:center;padding:24px;color:#334155;font-size:0.8rem;border-top:1px solid #1e293b;margin-top:8px}
  @media(max-width:768px){
    header{padding:24px 20px 18px}
    .kpi-row{padding:16px 20px}
    .section{padding:0 20px 28px}
    .chart-grid{grid-template-columns:1fr}
    .chart-box.full{grid-column:1}
  }
</style>
</head>
<body>

<header>
  <h1><span class="icon">🅿️</span> Parques Lisboa · Looking4.com</h1>
  <p>Preços recolhidos automaticamente do looking4.com para o Aeroporto de Lisboa (LIS)</p>
  <div class="header-meta">
    <span class="meta-chip">📅 Check-in: ${CHECKIN_ISO}</span>
    <span class="meta-chip">🅿️ ${parkNames.length} parques</span>
    <span class="meta-chip">📊 1 a 30 dias</span>
    <span class="meta-chip">🕐 ${new Date().toLocaleDateString('pt-PT', {day:'2-digit',month:'long',year:'numeric'})}</span>
  </div>
</header>

<div class="kpi-row">
  <div class="kpi">
    <div class="label">Total de Parques</div>
    <div class="value">${parkNames.length}</div>
    <div class="sub">Aeroporto Lisboa (LIS)<br>${valetCnt} valet · ${xferCnt} transfer${autoCnt?` · ${autoCnt} outro`:''}</div>
  </div>
  <div class="kpi green">
    <div class="label">Mais Barato · 1 dia</div>
    <div class="value">${cheapest.price.toFixed(2)} €</div>
    <div class="sub">${cheapest.name.replace(' - Lisboa','').replace(' - Lisbon','')}</div>
  </div>
  <div class="kpi red">
    <div class="label">Mais Caro · 1 dia</div>
    <div class="value">${priciest.price.toFixed(2)} €</div>
    <div class="sub">${priciest.name.replace(' - Lisboa','').replace(' - Lisbon','')}</div>
  </div>
  <div class="kpi blue">
    <div class="label">Preço Médio · 7 dias</div>
    <div class="value">${avg7d} €</div>
    <div class="sub">Média de todos os ${p7vals.length} parques</div>
  </div>
  <div class="kpi orange">
    <div class="label">Poupança Máx. (1d)</div>
    <div class="value">${(priciest.price - cheapest.price).toFixed(2)} €</div>
    <div class="sub">Entre o mais caro e o mais barato</div>
  </div>
</div>

<div class="section">
  <div class="section-title"><span class="dot"></span> Evolução de Preços por Número de Dias</div>

  <div class="filters">
    <span>Mostrar:</span>
    <button class="filter-btn active" onclick="filterType('all',this)">Todos (${parkNames.length})</button>
    <button class="filter-btn" onclick="filterType('Valet parking',this)">Valet (${valetCnt})</button>
    <button class="filter-btn blue" onclick="filterType('Serviço de transfer',this)">Transfer (${xferCnt})</button>
  </div>

  <div class="chart-grid">
    <div class="chart-box full">
      <h3>Evolução do preço por número de dias — todos os parques</h3>
      <canvas id="lineAll" height="90"></canvas>
    </div>
    <div class="chart-box">
      <h3>Ranking de preços para N dias</h3>
      <div class="slider-row">
        <label>Dias de estacionamento:</label>
        <input type="range" id="daySlider" min="1" max="30" value="1" oninput="updateBar(+this.value)">
        <span id="sliderVal">1 dia</span>
      </div>
      <canvas id="barDay" height="220"></canvas>
    </div>
    <div class="chart-box">
      <h3>Preço médio por tipo (Valet vs Transfer)</h3>
      <canvas id="lineAvg" height="220"></canvas>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title"><span class="dot"></span> Tabela Completa de Preços</div>

  <div class="filters">
    <span>Filtrar:</span>
    <button class="filter-btn active" onclick="filterTable('all',this)">Todos</button>
    <button class="filter-btn" onclick="filterTable('Valet parking',this)">Valet</button>
    <button class="filter-btn blue" onclick="filterTable('Serviço de transfer',this)">Transfer</button>
    <div class="search-wrap" style="margin:0 0 0 auto">
      <input type="text" id="tableSearch" placeholder="🔍 Pesquisar parque..." oninput="searchTable(this.value)">
    </div>
  </div>
  <p style="font-size:0.78rem;color:#475569;margin-bottom:12px">
    🟢 Verde = mínimo da linha &nbsp;·&nbsp; 🔴 Vermelho = máximo da linha
  </p>

  <div class="table-wrap">
    <table id="priceTable">
      <thead>
        <tr>
          <th class="park-col">Parque</th>
          <th>1d</th><th>2d</th><th>3d</th><th>4d</th><th>5d</th><th>6d</th>
          <th>7d</th><th>10d</th><th>14d</th><th>21d</th><th>30d</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows()}
      </tbody>
    </table>
  </div>
</div>

<footer>
  Dashboard gerado automaticamente por Claude · Dados: <a href="https://www.looking4.com/pt" style="color:#7c3aed">looking4.com</a> · ${new Date().toLocaleDateString('pt-PT')}
</footer>

<script>
const RAW      = ${JSON.stringify(Object.fromEntries(Object.entries(raw).map(([d,parks]) => [d, parks])))};
const NAMES    = ${JSON.stringify(parkNames)};
const TYPES    = ${JSON.stringify(typeMap)};
const PARK_MAP = ${JSON.stringify(parkMap)};
const COLORS   = ${JSON.stringify(COLORS)};
const DAYS     = Array.from({length:30},(_,i)=>i+1);

// ── Line all ─────────────────────────────────────────────────────────────
let lineAllChart = new Chart(document.getElementById('lineAll'),{
  type:'line',
  data:{
    labels: DAYS,
    datasets: NAMES.map((name,i)=>({
      label: name.replace(' - Lisboa','').replace(' - Lisbon','').trim(),
      data:  DAYS.map(d=>PARK_MAP[name][d]??null),
      borderColor: COLORS[i], backgroundColor:'transparent',
      tension:.3, spanGaps:true, borderWidth:1.5, pointRadius:1.5
    }))
  },
  options:{
    responsive:true,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{display:false},
      tooltip:{
        backgroundColor:'#1e293b',borderColor:'#334155',borderWidth:1,
        titleColor:'#94a3b8',bodyColor:'#cbd5e1',
        callbacks:{label:c=>\`\${c.dataset.label}: \${c.parsed.y?.toFixed(2)} €\`}
      }
    },
    scales:{
      x:{title:{display:true,text:'Número de dias',color:'#475569'},ticks:{color:'#475569'},grid:{color:'#1e293b'}},
      y:{title:{display:true,text:'Preço (€)',color:'#475569'},ticks:{color:'#475569',callback:v=>v+'€'},grid:{color:'#1e293b'}}
    }
  }
});

// ── Bar chart ────────────────────────────────────────────────────────────
let barChart;
function updateBar(d){
  document.getElementById('sliderVal').textContent = d+(d===1?' dia':' dias');
  const items = NAMES.map((n,i)=>({
    name: n.replace(' - Lisboa','').replace(' - Lisbon','').trim(),
    price: PARK_MAP[n][d]??null, color: COLORS[i]
  })).filter(x=>x.price!=null).sort((a,b)=>a.price-b.price);

  const data={
    labels: items.map(x=>x.name),
    datasets:[{
      data: items.map(x=>x.price),
      backgroundColor: items.map(x=>x.color+'bb'),
      borderColor:     items.map(x=>x.color),
      borderWidth:1, borderRadius:4
    }]
  };
  if(barChart){barChart.data=data;barChart.update();return;}
  barChart=new Chart(document.getElementById('barDay'),{
    type:'bar', data,
    options:{
      indexAxis:'y', responsive:true,
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'#1e293b',borderColor:'#334155',borderWidth:1,
          titleColor:'#94a3b8',bodyColor:'#cbd5e1',
          callbacks:{label:c=>c.parsed.x.toFixed(2)+' €'}
        }
      },
      scales:{
        x:{ticks:{color:'#475569',callback:v=>v+'€'},grid:{color:'#1e293b'}},
        y:{ticks:{color:'#94a3b8',font:{size:9}},grid:{display:false}}
      }
    }
  });
}
updateBar(1);
document.getElementById('daySlider').addEventListener('input',e=>updateBar(+e.target.value));

// ── Avg by type ───────────────────────────────────────────────────────────
const valetN = NAMES.filter(n=>TYPES[n]==='Valet parking');
const xferN  = NAMES.filter(n=>TYPES[n]==='Serviço de transfer');
function avgDay(names,d){
  const v=names.map(n=>PARK_MAP[n][d]).filter(x=>x!=null);
  return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
}
new Chart(document.getElementById('lineAvg'),{
  type:'line',
  data:{
    labels:DAYS,
    datasets:[
      {label:'Valet Parking (média)',data:DAYS.map(d=>avgDay(valetN,d)),
       borderColor:'#a78bfa',backgroundColor:'#a78bfa18',tension:.4,fill:true,spanGaps:true,borderWidth:2},
      {label:'Serviço de Transfer (média)',data:DAYS.map(d=>avgDay(xferN,d)),
       borderColor:'#60a5fa',backgroundColor:'#60a5fa18',tension:.4,fill:true,spanGaps:true,borderWidth:2}
    ]
  },
  options:{
    responsive:true,
    plugins:{
      legend:{labels:{color:'#94a3b8',font:{size:11}}},
      tooltip:{
        backgroundColor:'#1e293b',borderColor:'#334155',borderWidth:1,
        titleColor:'#94a3b8',bodyColor:'#cbd5e1',
        callbacks:{label:c=>\`\${c.dataset.label}: \${c.parsed.y?.toFixed(2)} €\`}
      }
    },
    scales:{
      x:{ticks:{color:'#475569'},grid:{color:'#1e293b'}},
      y:{ticks:{color:'#475569',callback:v=>v+'€'},grid:{color:'#1e293b'}}
    }
  }
});

// ── Filters ───────────────────────────────────────────────────────────────
let currentTableType='all', currentSearch='';
function applyFilters(){
  document.querySelectorAll('#priceTable tbody tr').forEach(row=>{
    const type=row.dataset.type||'';
    const text=row.textContent.toLowerCase();
    const typeOk=currentTableType==='all'||type===currentTableType;
    const searchOk=!currentSearch||text.includes(currentSearch);
    row.style.display=typeOk&&searchOk?'':'none';
  });
}
function filterTable(type,btn){
  currentTableType=type;
  document.querySelectorAll('.filters .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}
function searchTable(val){
  currentSearch=val.toLowerCase();
  applyFilters();
}

// Chart filter
function filterType(type,btn){
  document.querySelectorAll('.filters .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const filtered=type==='all'?NAMES:NAMES.filter(n=>TYPES[n]===type);
  lineAllChart.data.datasets=filtered.map((name,_)=>{
    const i=NAMES.indexOf(name);
    return{
      label:name.replace(' - Lisboa','').replace(' - Lisbon','').trim(),
      data:DAYS.map(d=>PARK_MAP[name][d]??null),
      borderColor:COLORS[i],backgroundColor:'transparent',
      tension:.3,spanGaps:true,borderWidth:1.5,pointRadius:1.5
    };
  });
  lineAllChart.update();
}
<\/script>
</body>
</html>`;

fs.writeFileSync('dashboard.html', html);
console.log('\n✅ dashboard.html gerado com sucesso!');
