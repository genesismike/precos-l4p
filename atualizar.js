/**
 * atualizar.js — Faz tudo de uma vez:
 *   1. Define o check-in como amanhã (automaticamente)
 *   2. Faz scraping de 1-30 dias no looking4.com
 *   3. Regenera o index.html (dashboard)
 *   4. Faz git commit + push para o GitHub
 *
 * Uso:  node atualizar.js
 */

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── 1. Calcular data de check-in (amanhã) ─────────────────────────────────
function getCheckin() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── 2. Injetar a data nova nos scripts ────────────────────────────────────
function updateDate(file, newDate) {
  let content = fs.readFileSync(file, 'utf8');
  // Substitui qualquer data no formato YYYY-MM-DD na linha CHECKIN_ISO
  content = content.replace(
    /(const CHECKIN_ISO\s*=\s*')[^']+(')/,
    `$1${newDate}$2`
  );
  // Substitui também CHECKIN_DISP (DD/MM/YYYY)
  const [y, m, d] = newDate.split('-');
  content = content.replace(
    /(const CHECKIN_DISP\s*=\s*')[^']+(')/,
    `$1${d}/${m}/${y}$2`
  );
  fs.writeFileSync(file, content, 'utf8');
}

// ── 3. Correr um script node e mostrar output em tempo real ───────────────
function runScript(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [script], { stdio: 'inherit' });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} saiu com código ${code}`)));
  });
}

// ── 4. Git commit + push ──────────────────────────────────────────────────
function gitPush(checkin) {
  const today = new Date().toLocaleDateString('pt-PT');
  execSync('git add index.html parking_data.json', { stdio: 'inherit' });
  execSync(`git commit -m "Atualizar preços — check-in ${checkin} (${today})"`, { stdio: 'inherit' });
  execSync('git push origin main', { stdio: 'inherit' });
}

// ── MAIN ──────────────────────────────────────────────────────────────────
(async () => {
  const checkin = getCheckin();
  const dataAtual = new Date().toLocaleDateString('pt-PT', { day:'2-digit', month:'long', year:'numeric' });

  console.log('═══════════════════════════════════════════════════');
  console.log(' 🅿️  Looking4 Lisboa — Atualização automática');
  console.log(`    Check-in: ${checkin}  |  ${dataAtual}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Passo 1 — Atualizar datas nos scripts
  console.log('📅 [1/4] A atualizar datas nos scripts...');
  updateDate('scraper_full.js',    checkin);
  updateDate('build_dashboard.js', checkin);
  console.log(`   ✓ Check-in definido para ${checkin}\n`);

  // Passo 2 — Scraping
  console.log('🌐 [2/4] A recolher preços do looking4.com (1–30 dias)...\n');
  await runScript('scraper_full.js');
  console.log('');

  // Passo 3 — Gerar dashboard
  console.log('📊 [3/4] A gerar dashboard (index.html)...\n');
  await runScript('build_dashboard.js');
  console.log('');

  // Passo 4 — Git push
  console.log('🚀 [4/4] A publicar no GitHub...');
  gitPush(checkin);

  console.log('\n✅ Site atualizado com sucesso!');
  console.log('   → https://github.com/genesismike/precos-l4p\n');
})().catch(err => {
  console.error('\n❌ Erro:', err.message);
  process.exit(1);
});
