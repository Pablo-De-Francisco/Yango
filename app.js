/* Copiloto de Marketing IA · Yango — prototipo borrador.
   Todo se calcula en el navegador a partir de Supabase (si está configurado en config.js)
   o del Excel del escenario elegido (data/*.xlsx), o del Excel que cargue el usuario. */
'use strict';

const DEFAULT_URL = 'data/kpis_marketing.xlsx';
const LOG_KEY = 'copiloto_yango_log';
const CFG = window.COPILOTO_CONFIG || {};
const DB = CFG.supabaseUrl && CFG.supabaseAnonKey ? { url: CFG.supabaseUrl.replace(/\/+$/, ''), key: CFG.supabaseAnonKey } : null;
// cliente oficial de Supabase: solo para las cuentas (inicio de sesión y token); los datos van por la API REST
const SB = DB && window.supabase ? window.supabase.createClient(DB.url, DB.key) : null;
const FILE_SCENARIOS = CFG.escenarios && CFG.escenarios.length ? CFG.escenarios : [{ id: 'base', nombre: 'Base', archivo: DEFAULT_URL }];
// id anónimo por navegador para medir adopción en log_ia (sin datos personales)
const SESSION = (() => {
  try {
    let s = localStorage.getItem('copiloto_sesion');
    if (!s) { s = Math.random().toString(36).slice(2, 10); localStorage.setItem('copiloto_sesion', s); }
    return s;
  } catch { return ''; }
})();

const state = {
  scenarios: FILE_SCENARIOS, scenario: FILE_SCENARIOS[0].id, logRemote: false,
  user: null, isAdmin: false, logUser: '',
  wb: null, source: '', isUser: false,
  data: new Map(),   // semana -> Map(canal -> {inv, imp, clics, conv, ing})
  weeks: [], channels: [], starts: new Map(), // semana -> Date
  dict: [], budget: [], week: null,
  log: [],
};

// ---------- utilidades ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9%]+/g, ' ').trim();

function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return NaN;
  let s = String(v).replace(/[$\sUSD]/gi, '');
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if (hasDot && hasComma) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (hasComma) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
}
const dec = (n, d = 1) => n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtK = n => Math.abs(n) >= 1e6 ? dec(n / 1e6) + 'M' : Math.abs(n) >= 1e3 ? dec(n / 1e3) + 'K' : dec(n, 0);
const fmtMoney = n => Math.abs(n) >= 1e6 ? '$' + dec(n / 1e6, 2) + 'M' : Math.abs(n) >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + dec(n, 2);
const fmtX = n => dec(n) + 'x';
const fmtPct = (n, d = 1) => dec(n * 100, d) + ' %';
const fmtDelta = r => (r > 0 ? '+' : r < 0 ? '−' : '') + dec(Math.abs(r) * 100, 0) + ' %';
// número de serie de Excel -> fecha local (sin desfases de zona horaria)
const serialDate = s => { const u = new Date(Math.round((s - 25569) * 864e5)); return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()); };
const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ---------- lectura del Excel ----------
function findSheet(wb, name) {
  const target = norm(name);
  const hit = wb.SheetNames.find(n => norm(n) === target) || wb.SheetNames.find(n => norm(n).includes(target));
  return hit ? wb.Sheets[hit] : null;
}
function mapColumns(rows, spec) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const map = {};
  for (const [key, aliases] of Object.entries(spec)) {
    const h = headers.find(h => aliases.includes(norm(h))) || headers.find(h => aliases.some(a => norm(h).startsWith(a)));
    if (h) map[key] = h;
  }
  return map;
}
const sheetRows = ws => XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });

function parseWorkbook(wb) {
  const errors = [], warnings = [];
  const ws = findSheet(wb, 'datos_crudos');
  if (!ws) return { errors: ['No encuentro la pestaña «datos_crudos». No cambies el nombre de las pestañas.'], warnings };

  const rows = sheetRows(ws);
  const col = mapColumns(rows, {
    semana: ['semana'], inicio: ['fecha inicio', 'fecha'], canal: ['canal'],
    inv: ['inversion', 'gasto'], imp: ['impresiones'], clics: ['clics', 'clicks'],
    conv: ['conversiones'], ing: ['ingresos atribuidos', 'ingresos'],
  });
  const required = { semana: 'Semana', canal: 'Canal', inv: 'Inversión (USD)', conv: 'Conversiones', ing: 'Ingresos atribuidos (USD)' };
  const missing = Object.keys(required).filter(k => !col[k]).map(k => required[k]);
  if (missing.length) return { errors: [`Faltan columnas en «datos_crudos»: ${missing.join(', ')}.`], warnings };

  const data = new Map(), starts = new Map(), channels = new Set(), bad = [], dup = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    if (Object.values(r).every(v => v === '')) return;
    const semana = toNum(r[col.semana]);
    const canal = String(r[col.canal]).trim();
    const vals = {};
    for (const k of ['inv', 'imp', 'clics', 'conv', 'ing']) vals[k] = col[k] ? toNum(r[col[k]]) : 0;
    if (!Number.isFinite(semana) || !canal || ['inv', 'conv', 'ing'].some(k => !Number.isFinite(vals[k]) || vals[k] < 0)) { bad.push(line); return; }
    for (const k of ['imp', 'clics']) if (!Number.isFinite(vals[k])) vals[k] = 0;
    if (!data.has(semana)) data.set(semana, new Map());
    const wk = data.get(semana);
    if (wk.has(canal)) { dup.push(`${canal} (semana ${semana})`); for (const k in vals) wk.get(canal)[k] += vals[k]; }
    else wk.set(canal, vals);
    channels.add(canal);
    const f = col.inicio ? r[col.inicio] : '';
    const iso = typeof f === 'string' && f.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    const d = typeof f === 'number' ? serialDate(f) : iso ? new Date(+iso[1], +iso[2] - 1, +iso[3]) : null;
    if (d && !isNaN(d) && !starts.has(semana)) starts.set(semana, d);
  });
  if (!data.size) return { errors: ['La pestaña «datos_crudos» no tiene filas válidas.'], warnings };
  if (bad.length) warnings.push(`Se ignoraron ${bad.length} fila(s) de «datos_crudos» con datos vacíos o no numéricos (filas ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? '…' : ''}).`);
  if (dup.length) warnings.push(`Filas duplicadas sumadas: ${[...new Set(dup)].slice(0, 5).join('; ')}.`);
  const weeks = [...data.keys()].sort((a, b) => a - b);
  for (const w of weeks) {
    const miss = [...channels].filter(c => !data.get(w).has(c));
    if (miss.length) warnings.push(`Semana ${w}: falta información de ${miss.join(', ')} (datos incompletos).`);
  }

  // diccionario
  let dict = [];
  const wd = findSheet(wb, 'diccionario');
  if (wd) {
    const dr = sheetRows(wd);
    const dc = mapColumns(dr, { kpi: ['kpi'], def: ['definicion unica', 'definicion'], formula: ['formula'], owner: ['dueno', 'responsable'], meta: ['meta', 'objetivo'] });
    dict = dr.filter(r => dc.kpi && String(r[dc.kpi]).trim()).map(r => ({
      kpi: String(r[dc.kpi]).trim(), def: dc.def ? String(r[dc.def]) : '', formula: dc.formula ? String(r[dc.formula]) : '',
      owner: dc.owner ? String(r[dc.owner]) : '', meta: dc.meta ? String(r[dc.meta]) : '',
    }));
  } else warnings.push('No hay pestaña «diccionario»: el asistente no podrá responder definiciones.');

  // presupuesto
  let budget = [];
  const wp = findSheet(wb, 'presupuesto');
  if (wp) {
    const pr = sheetRows(wp);
    const pc = mapColumns(pr, { mes: ['mes'], canal: ['canal'], monto: ['presupuesto', 'monto'] });
    budget = pr.filter(r => pc.mes && pc.monto && r[pc.mes] !== '').map(r => {
      const m = r[pc.mes];
      const mes = typeof m === 'number' ? monthKey(serialDate(m)) : String(m).trim().slice(0, 7);
      return { mes, canal: pc.canal ? String(r[pc.canal]).trim() : 'Total', monto: toNum(r[pc.monto]) };
    }).filter(b => Number.isFinite(b.monto));
  }

  return { errors, warnings, data, weeks, channels: [...channels], starts, dict, budget };
}

// ---------- métricas ----------
function metrics(w) {
  const wk = state.data.get(w);
  if (!wk) return null;
  const rows = [...wk.entries()].map(([canal, v]) => ({ canal, ...v }));
  const tot = rows.reduce((t, r) => { for (const k of ['inv', 'imp', 'clics', 'conv', 'ing']) t[k] += r[k]; return t; }, { canal: 'Total', inv: 0, imp: 0, clics: 0, conv: 0, ing: 0 });
  const derive = r => Object.assign(r, { roas: r.inv ? r.ing / r.inv : 0, cpa: r.conv ? r.inv / r.conv : 0, ctr: r.imp ? r.clics / r.imp : null });
  rows.forEach(derive); derive(tot);
  return { week: w, rows, tot, byCanal: new Map(rows.map(r => [r.canal, r])) };
}
const prevWeek = w => { const i = state.weeks.indexOf(w); return i > 0 ? state.weeks[i - 1] : null; };
const change = (a, b) => (b ? a / b - 1 : 0);

function goal(kpi) {
  const d = state.dict.find(x => norm(x.kpi) === norm(kpi));
  if (!d || !d.meta) return null;
  const m = d.meta.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  let v = Number(m[0].replace(',', '.'));
  if (d.meta.includes('%')) v /= 100;
  const op = /≤|<=|max|menor/i.test(d.meta) ? 'le' : 'ge';
  return { v, op, label: d.meta };
}
const meets = (g, v) => !g || (g.op === 'ge' ? v >= g.v : v <= g.v);

function budgetStatus(w) {
  const start = state.starts.get(w);
  if (!start || !state.budget.length) return null;
  const mes = monthKey(start);
  const plan = state.budget.filter(b => b.mes === mes);
  if (!plan.length) return null;
  const weeksInMonth = state.weeks.filter(x => x <= w && state.starts.get(x) && monthKey(state.starts.get(x)) === mes);
  const real = new Map();
  for (const x of weeksInMonth) for (const r of metrics(x).rows) real.set(r.canal, (real.get(r.canal) || 0) + r.inv);
  const rows = plan.map(p => ({ canal: p.canal, plan: p.monto, real: p.canal === 'Total' ? [...real.values()].reduce((a, b) => a + b, 0) : real.get(p.canal) || 0 }));
  const planT = rows.reduce((a, r) => a + r.plan, 0), realT = rows.reduce((a, r) => a + r.real, 0);
  // avance esperado del mes según el último día cubierto por la semana
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const expected = Math.min(1, (end.getMonth() === start.getMonth() ? end.getDate() : days) / days);
  return { mes, label: `${MONTHS[start.getMonth()]} ${start.getFullYear()}`, rows, planT, realT, expected, weeksInMonth };
}

// ---------- briefing ----------
function briefing(w) {
  const cur = metrics(w), pw = prevWeek(w), prev = pw != null ? metrics(pw) : null;
  const t = cur.tot, out = { html: '', text: '' };
  const parts = [];
  const gR = goal('ROAS');
  const sorted = [...cur.rows].sort((a, b) => b.roas - a.roas);
  const best = sorted[0], worst = sorted[sorted.length - 1];

  // Resumen
  let resumen;
  if (prev) {
    const dc = change(t.conv, prev.tot.conv), dr = change(t.roas, prev.tot.roas), di = change(t.inv, prev.tot.inv);
    const verbo = Math.abs(dr) < 0.005 ? 'se mantuvo en' : dr < 0 ? 'bajó a' : 'subió a';
    resumen = `Conversiones ${fmtDelta(dc)} (${fmtK(t.conv)}). El ROAS ${verbo} ${fmtX(t.roas)} (${fmtDelta(dr)}). Inversión de ${fmtMoney(t.inv)} (${fmtDelta(di)} vs. semana ${pw}).`;
  } else {
    resumen = `Conversiones: ${fmtK(t.conv)}. ROAS total: ${fmtX(t.roas)}. Inversión: ${fmtMoney(t.inv)}. (No hay semana anterior para comparar.)`;
  }
  parts.push(['Resumen de la semana', [resumen], false]);

  // Qué explica el cambio
  const bullets = [];
  let driver = null;
  if (prev) {
    const dTot = t.roas - prev.tot.roas;
    const effects = cur.rows.filter(r => prev.byCanal.has(r.canal)).map(r => {
      const p = prev.byCanal.get(r.canal);
      return { r, p, eff: (r.ing - p.roas * r.inv) / t.inv };
    });
    if (Math.abs(dTot) >= 0.01 && effects.length) {
      driver = effects.sort((a, b) => (dTot < 0 ? a.eff - b.eff : b.eff - a.eff))[0];
      const share = Math.abs(dTot) > 0 ? Math.round(Math.min(1, Math.abs(driver.eff / dTot)) * 100) : 0;
      const tipo = dTot < 0 ? 'la caída' : 'la mejora';
      bullets.push(`${driver.r.canal} explica ${share >= 50 ? 'la mayor parte' : 'una parte'} de ${tipo} del ROAS (${fmtX(driver.r.roas)} vs. ${fmtX(driver.p.roas)} la semana anterior).`);
    }
    const prevBest = [...prev.rows].sort((a, b) => b.roas - a.roas)[0];
    bullets.push(`${best.canal} ${prevBest && prevBest.canal === best.canal ? 'sigue siendo' : 'pasa a ser'} el canal más eficiente (${fmtX(best.roas)}).`);
  } else {
    bullets.push(`${best.canal} es el canal más eficiente (${fmtX(best.roas)}); ${worst.canal} el menos eficiente (${fmtX(worst.roas)}).`);
  }
  if (gR) {
    const below = cur.rows.filter(r => !meets(gR, r.roas));
    if (below.length) bullets.push(`Por debajo de la meta de ROAS (${gR.label}): ${below.map(r => `${r.canal} (${fmtX(r.roas)})`).join(', ')}.`);
  }
  const gC = goal('CPA');
  if (gC) {
    const over = cur.rows.filter(r => !meets(gC, r.cpa));
    if (over.length) bullets.push(`CPA por encima de la meta (${gC.label}): ${over.map(r => `${r.canal} ($${dec(r.cpa, 2)})`).join(', ')}.`);
  }
  const b = budgetStatus(w);
  if (b) {
    const exec = b.planT ? b.realT / b.planT : 0;
    bullets.push(`Plan vs. real de ${b.label}: ${fmtMoney(b.realT)} invertidos de ${fmtMoney(b.planT)} presupuestados (${fmtPct(exec, 0)}; avance esperado del mes ${fmtPct(b.expected, 0)}).`);
  }
  parts.push(['Qué explica el cambio', bullets, true]);

  // Qué decidir
  let q;
  if (gR && worst !== best && !meets(gR, worst.roas) && meets(gR, best.roas)) q = `¿Movemos parte del presupuesto de ${worst.canal} a ${best.canal} la próxima semana?`;
  else if (prev && t.roas < prev.tot.roas && driver) q = `¿Revisamos las campañas de ${driver.r.canal} antes de aumentar su inversión?`;
  else q = `¿Aumentamos la inversión en ${best.canal}, que mantiene el mejor ROAS (${fmtX(best.roas)})?`;
  parts.push(['Qué decidir', [q], false]);

  out.html = parts.map(([h, items, list]) => `<h3>${esc(h)}</h3>` + (list ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : items.map(i => `<p>${esc(i)}</p>`).join(''))).join('');
  out.text = parts.map(([h, items, list]) => `${h}\n${items.map(i => (list ? '• ' : '') + i).join('\n')}`).join('\n\n');
  out.resumen = resumen; out.decision = q;
  return out;
}

// ---------- asistente ----------
const METRICS = [
  { key: 'roas', re: /\broas\b|retorno/, name: 'ROAS', fmt: fmtX, higherBetter: true },
  { key: 'cpa', re: /\bcpa\b|costo por (adquisicion|conversion)/, name: 'CPA', fmt: v => '$' + dec(v, 2), higherBetter: false },
  { key: 'ctr', re: /\bctr\b|tasa de clic/, name: 'CTR', fmt: v => (v == null ? 's/d' : fmtPct(v, 2)), higherBetter: true },
  { key: 'conv', re: /conversion|convirti|pedidos|viajes/, name: 'conversiones', fmt: fmtK, higherBetter: true },
  { key: 'inv', re: /inversion|invirti|invert|gasto|gastamos|gastado/, name: 'inversión', fmt: fmtMoney, higherBetter: null },
  { key: 'ing', re: /ingreso|ventas|revenue/, name: 'ingresos atribuidos', fmt: fmtMoney, higherBetter: true },
  { key: 'clics', re: /\bclic|\bclick/, name: 'clics', fmt: fmtK, higherBetter: true },
  { key: 'imp', re: /impresion/, name: 'impresiones', fmt: fmtK, higherBetter: true },
];
function findChannel(n) {
  return state.channels.find(c => n.includes(norm(c))) ||
    state.channels.find(c => norm(c).split(' ').some(tok => tok.length > 3 && !['ads'].includes(tok) && new RegExp(`\\b${tok}\\b`).test(n)));
}
function answer(q) {
  const n = norm(q);
  if (!n) return null;
  let w = state.week;
  const wm = n.match(/semana (\d+)/);
  if (wm) {
    if (!state.data.has(+wm[1])) return { text: `No tengo datos de la semana ${wm[1]} en la hoja. Semanas disponibles: ${state.weeks.join(', ')}.`, src: 'hoja «datos_crudos»' };
    w = +wm[1];
  } else if (/semana (pasada|anterior)/.test(n) && prevWeek(state.week) != null && !/(cambi|compar|vs|frente)/.test(n)) w = prevWeek(state.week);
  const cur = metrics(w), src = `hoja «kpis», semana ${w}`;
  const metric = METRICS.find(m => m.re.test(n));
  const canal = findChannel(n);

  // definiciones
  const dictHit = state.dict.find(d => new RegExp(`\\b${norm(d.kpi)}\\b`).test(n));
  if (dictHit && /(que es|que significa|como (se )?calcul|definicion|formula|dueno|responsable|meta de|significa)/.test(n)) {
    const d = dictHit;
    return { text: `${d.kpi}: ${d.def}${d.formula ? `\nFórmula: ${d.formula}.` : ''}${d.owner ? `\nDueño: ${d.owner}.` : ''}${d.meta ? `\nMeta: ${d.meta}.` : ''}`, src: 'pestaña «diccionario»' };
  }
  if (/(que es|que significa|como (se )?calcul|definicion|formula)/.test(n)) {
    return { text: `Ese término no está en el diccionario de KPIs. Términos definidos: ${state.dict.map(d => d.kpi).join(', ') || 'ninguno'}.`, src: 'pestaña «diccionario»' };
  }

  // listados
  if (/(que|cuales) canales|lista de canales|canales (hay|tenemos)/.test(n)) return { text: `Canales en la hoja: ${state.channels.join(', ')}.`, src: 'hoja «datos_crudos»' };
  if (/(que|cuales) semanas|semanas (hay|disponibles)/.test(n)) return { text: `Semanas disponibles: ${state.weeks.join(', ')}. Se muestra por defecto la ${state.weeks.at(-1)}.`, src: 'hoja «datos_crudos»' };

  // presupuesto
  if (/presupuest|plan vs|plan contra|ejecucion|ejecutado/.test(n)) {
    const b = budgetStatus(w);
    if (!b) return { text: 'No encuentro presupuesto para el mes de esa semana en la pestaña «presupuesto».', src: 'pestaña «presupuesto»' };
    if (canal) {
      const r = b.rows.find(x => x.canal === canal);
      if (!r) return { text: `No hay presupuesto de ${canal} para ${b.label}.`, src: 'pestaña «presupuesto»' };
      return { text: `${canal} lleva ${fmtMoney(r.real)} de ${fmtMoney(r.plan)} presupuestados en ${b.label} (${fmtPct(r.plan ? r.real / r.plan : 0, 0)}). Avance esperado del mes: ${fmtPct(b.expected, 0)}.`, src: `pestaña «presupuesto» y «kpis», semanas ${b.weeksInMonth.join(', ')}` };
    }
    return { text: `En ${b.label} se han invertido ${fmtMoney(b.realT)} de ${fmtMoney(b.planT)} presupuestados (${fmtPct(b.planT ? b.realT / b.planT : 0, 0)}). Avance esperado del mes: ${fmtPct(b.expected, 0)}.\n` + b.rows.map(r => `• ${r.canal}: ${fmtMoney(r.real)} / ${fmtMoney(r.plan)}`).join('\n'), src: `pestaña «presupuesto» y «kpis», semanas ${b.weeksInMonth.join(', ')}` };
  }

  // resumen / briefing
  if (/resumen|briefing|como (nos )?fue|como vamos|que paso/.test(n) && !metric && !canal) {
    const br = briefing(w);
    return { text: `${br.resumen}\nDecisión sugerida: ${br.decision}`, src };
  }

  // variación vs semana anterior
  if (/(cambi|variacion|compar|subio|bajo|aument|disminu|cayo|crecio|semana anterior|semana pasada|vs|frente a)/.test(n) && !/(peor|mejor|mas alto|mas bajo|mayor|menor)/.test(n)) {
    const pw = prevWeek(w);
    if (pw == null) return { text: `No hay una semana anterior a la ${w} para comparar.`, src };
    const prev = metrics(pw), ms = metric ? [metric] : METRICS.filter(m => ['roas', 'conv', 'inv'].includes(m.key));
    const a = canal ? cur.byCanal.get(canal) : cur.tot, p = canal ? prev.byCanal.get(canal) : prev.tot;
    if (!a || !p) return { text: `No hay datos de ${canal} en ambas semanas.`, src };
    const who = canal || 'El total';
    return { text: `${who}, semana ${w} vs. ${pw}:\n` + ms.map(m => `• ${m.name}: ${m.fmt(a[m.key])} vs. ${m.fmt(p[m.key])} (${fmtDelta(change(a[m.key], p[m.key]))})`).join('\n'), src: `hoja «kpis», semanas ${pw} y ${w}` };
  }

  // ranking peor / mejor
  const rk = n.match(/(peor|mejor|mas alto|mas alta|mas bajo|mas baja|mayor|menor|mas eficiente|menos eficiente|ranking|orden)/);
  if (rk) {
    const m = metric || METRICS[0];
    const word = rk[1];
    let wantHigh;
    if (/mas alt|mayor/.test(word)) wantHigh = true;
    else if (/mas baj|menor/.test(word)) wantHigh = false;
    else if (/peor|menos eficiente/.test(word)) wantHigh = m.higherBetter === false;
    else if (/ranking|orden/.test(word)) wantHigh = null;
    else wantHigh = m.higherBetter !== false;
    const sorted = [...cur.rows].filter(r => r[m.key] != null).sort((x, y) => y[m.key] - x[m.key]);
    if (wantHigh === null) return { text: `Ranking por ${m.name}, semana ${w}:\n` + sorted.map((r, i) => `${i + 1}. ${r.canal}: ${m.fmt(r[m.key])}`).join('\n'), src };
    const r = wantHigh ? sorted[0] : sorted.at(-1);
    return { text: `${r.canal}, con ${m.fmt(r[m.key])} frente a ${m.fmt(cur.tot[m.key])} del total. Invirtió ${fmtMoney(r.inv)} y logró ${fmtK(r.conv)} conversiones.`, src };
  }

  // canal (+ métrica)
  if (canal) {
    const r = cur.byCanal.get(canal);
    if (!r) return { text: `${canal} no tiene datos en la semana ${w}.`, src };
    if (metric) return { text: `${canal}, semana ${w}: ${metric.name} de ${metric.fmt(r[metric.key])} (total de la semana: ${metric.fmt(cur.tot[metric.key])}).`, src };
    return { text: `${canal}, semana ${w}: inversión ${fmtMoney(r.inv)}, ${fmtK(r.conv)} conversiones, ingresos ${fmtMoney(r.ing)}, ROAS ${fmtX(r.roas)}, CPA $${dec(r.cpa, 2)}${r.ctr != null ? `, CTR ${fmtPct(r.ctr, 2)}` : ''}.`, src };
  }

  // métrica total
  if (metric) {
    return { text: `Total de la semana ${w} (${metric.name}): ${metric.fmt(cur.tot[metric.key])}.\nPor canal: ` + cur.rows.map(r => `${r.canal} ${metric.fmt(r[metric.key])}`).join(' · '), src };
  }

  return { text: 'No encuentro ese dato en la hoja. Solo respondo con cifras de «datos_crudos», «diccionario» y «presupuesto». Prueba con: "¿qué canal tuvo el peor ROAS?", "¿cómo calculamos el CPA?" o "¿cómo vamos frente al presupuesto?".', src: 'regla: no inventar cifras' };
}

// ---------- Supabase (API REST) ----------
async function sb(path, opts = {}) {
  // con sesión iniciada se envía el token del usuario: las reglas RLS dependen de quién consulta
  const session = SB ? (await SB.auth.getSession()).data.session : null;
  const r = await fetch(`${DB.url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: DB.key, Authorization: `Bearer ${session ? session.access_token : DB.key}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 201 || r.status === 204 ? null : r.json();
}
const scenarioName = id => (state.scenarios.find(s => s.id === id) || { nombre: id }).nombre;

// Convierte las tablas en un libro con las mismas pestañas y encabezados del Excel, para reutilizar parseWorkbook.
async function dbWorkbook(scenario) {
  const [datos, dict, pres] = await Promise.all([
    sb(`datos_crudos?select=*&escenario=eq.${encodeURIComponent(scenario)}&order=semana,canal`),
    sb('diccionario?select=*&order=orden'),
    sb('presupuesto?select=*&order=mes,canal'),
  ]);
  if (!datos.length) throw new Error(`la tabla datos_crudos no tiene filas del escenario «${scenario}»`);
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  add('datos_crudos', datos.map(r => ({
    'Semana': r.semana, 'Fecha inicio': r.fecha_inicio || '', 'Canal': r.canal, 'Inversión (USD)': +r.inversion,
    'Impresiones': +r.impresiones, 'Clics': +r.clics, 'Conversiones': +r.conversiones, 'Ingresos atribuidos (USD)': +r.ingresos_atribuidos,
  })));
  add('diccionario', dict.map(r => ({ 'KPI': r.kpi, 'Definición única': r.definicion || '', 'Fórmula': r.formula || '', 'Dueño': r.dueno || '', 'Meta': r.meta || '' })));
  add('presupuesto', pres.map(r => ({ 'Mes': r.mes, 'Canal': r.canal, 'Presupuesto (USD)': +r.presupuesto })));
  return wb;
}
async function loadScenarios() {
  if (DB) {
    try {
      const rows = await sb('escenarios?select=id,nombre&order=orden');
      if (rows.length) state.scenarios = rows;
    } catch { /* se usan los escenarios de config.js */ }
  }
  if (!state.scenarios.some(s => s.id === state.scenario)) state.scenario = state.scenarios[0].id;
  $('#escSel').innerHTML = state.scenarios.map(s => `<option value="${esc(s.id)}" ${s.id === state.scenario ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('');
}

// ---------- registro ----------
async function loadLog() {
  if (DB) {
    try {
      // las reglas RLS devuelven solo las consultas propias, o todas si la cuenta es admin
      const rows = await sb('log_ia_detalle?select=*&order=created_at.desc&limit=500');
      state.log = rows.reverse().map(r => ({
        fecha: new Date(r.created_at).toLocaleString('es-CO'), usuario: r.email || '(sin cuenta)', tipo: r.tipo, escenario: r.escenario || '', semana: r.semana,
        q: r.pregunta, a: r.respuesta || '', src: r.fuente || '', rev: r.revisado_por || '', fb: r.decision || '',
      }));
      state.logRemote = true;
    } catch (e) {
      state.logRemote = false;
      renderAlerts([['err', `No pude leer el registro de Supabase (${esc(e.message)}). Se usa el registro de este navegador.`]]);
    }
  }
  if (!state.logRemote) { try { state.log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { state.log = []; } }
  $('#clearLogBtn').style.display = state.logRemote ? 'none' : '';
  $('#logNote').textContent = !state.logRemote
    ? 'El registro vive en este navegador. Descarga el Excel para guardarlo en la pestaña log_ia y medir calidad y adopción.'
    : state.isAdmin
      ? 'Registro central en Supabase: preguntas y briefings de todos los usuarios (eres administrador). Últimos 500.'
      : 'Tus preguntas y briefings guardados en Supabase. Solo tú y el administrador pueden verlos.';
  renderLogUsers();
  renderLog();
}
// filtro por usuario, solo para el administrador
function renderLogUsers() {
  $('#logUserField').hidden = !state.isAdmin;
  if (!state.isAdmin) return;
  const counts = new Map();
  for (const r of state.log) counts.set(r.usuario, (counts.get(r.usuario) || 0) + 1);
  if (state.logUser && !counts.has(state.logUser)) state.logUser = '';
  $('#logUserSel').innerHTML = `<option value="">Todos (${state.log.length})</option>` +
    [...counts].sort((a, b) => b[1] - a[1]).map(([u, n]) => `<option value="${esc(u)}" ${u === state.logUser ? 'selected' : ''}>${esc(u)} (${n})</option>`).join('');
}
function saveLog() { try { localStorage.setItem(LOG_KEY, JSON.stringify(state.log)); } catch { /* sin almacenamiento */ } }
function addLog(entry) {
  const e = { fecha: new Date().toLocaleString('es-CO'), usuario: state.user ? state.user.email : '', escenario: state.isUser ? 'archivo propio' : state.scenario, ...entry };
  state.log.push(e);
  if (state.isAdmin) renderLogUsers();
  renderLog();
  if (!state.logRemote) { saveLog(); return; }
  const cut = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
  sb('log_ia', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      tipo: e.tipo, escenario: cut(e.escenario, 40), semana: e.semana, pregunta: cut(e.q, 1000) || '—', respuesta: cut(e.a, 5000),
      fuente: cut(e.src, 300), revisado_por: cut(e.rev, 120), decision: cut(e.fb, 1000), sesion: SESSION || null,
    }),
  }).catch(err => renderAlerts([['err', `No se pudo guardar en Supabase: ${esc(err.message)}`]]));
}

// ---------- render ----------
function renderAlerts(list) {
  $('#alerts').innerHTML = list.map(([type, msg]) => `<div class="alert ${type}">${msg}</div>`).join('');
}
function deltaHTML(r, invert) {
  if (r == null) return '<span class="delta flat">sin semana previa</span>';
  const good = invert ? r < 0 : r > 0;
  const cls = Math.abs(r) < 0.005 ? 'flat' : good ? 'up' : 'down';
  return `<span class="delta ${cls}">${r > 0 ? '▲' : r < 0 ? '▼' : '■'} ${fmtDelta(r)} vs. sem. ${prevWeek(state.week)}</span>`;
}
function renderKPIs() {
  const w = state.week, cur = metrics(w), pw = prevWeek(w), prev = pw != null ? metrics(pw) : null, t = cur.tot;
  const d = k => (prev ? change(t[k], prev.tot[k]) : null);
  $('#cards').innerHTML = [
    ['Inversión', fmtMoney(t.inv), d('inv'), false],
    ['Conversiones', fmtK(t.conv), d('conv'), false],
    ['Ingresos atribuidos', fmtMoney(t.ing), d('ing'), false],
    ['ROAS total', fmtX(t.roas), d('roas'), false],
    ['CPA total', '$' + dec(t.cpa, 2), d('cpa'), true],
  ].map(([l, v, r, inv]) => `<div class="card"><div class="lbl">${l}</div><div class="val">${v}</div>${deltaHTML(r, inv)}</div>`).join('');

  const start = state.starts.get(w);
  $('#kpiTitle').textContent = `Semana ${w}${start ? ' · desde ' + start.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) : ''} · pestaña «kpis»`;
  const gR = goal('ROAS');
  $('#kpiTable').innerHTML = `<thead><tr><th>Canal</th><th class="n">Inversión</th><th class="n">Conv.</th><th class="n">Ingresos</th><th class="n">ROAS</th><th class="n">CPA</th></tr></thead><tbody>` +
    cur.rows.map(r => `<tr><td>${esc(r.canal)}</td><td class="n">${fmtMoney(r.inv)}</td><td class="n">${fmtK(r.conv)}</td><td class="n">${fmtMoney(r.ing)}</td><td class="n ${meets(gR, r.roas) ? '' : 'bad'}">${fmtX(r.roas)}</td><td class="n">$${dec(r.cpa, 2)}</td></tr>`).join('') +
    `<tr class="total"><td>Total</td><td class="n">${fmtMoney(t.inv)}</td><td class="n">${fmtK(t.conv)}</td><td class="n">${fmtMoney(t.ing)}</td><td class="n">${fmtX(t.roas)}</td><td class="n">$${dec(t.cpa, 2)}</td></tr></tbody>`;

  const max = Math.max(...cur.rows.map(r => r.roas), gR ? gR.v : 0) * 1.1 || 1;
  $('#roasBars').innerHTML = cur.rows.map(r => `<div class="bar-row"><span>${esc(r.canal)}</span><div class="bar-track"><div class="bar-fill ${meets(gR, r.roas) ? 'ok' : ''}" style="width:${(r.roas / max) * 100}%"></div>${gR ? `<div class="bar-goal" style="left:${(gR.v / max) * 100}%"></div>` : ''}</div><b>${fmtX(r.roas)}</b></div>`).join('') +
    (gR ? `<div class="bar-legend">Línea verde = meta de ROAS del diccionario (${esc(gR.label)}). Rojo = por debajo de la meta.</div>` : '');

  const ws = state.weeks.slice(-6);
  const ms = ws.map(metrics);
  $('#trendTable').innerHTML = `<thead><tr><th>Canal</th>${ws.map(x => `<th class="n">S${x}</th>`).join('')}</tr></thead><tbody>` +
    state.channels.map(c => `<tr><td>${esc(c)}</td>${ms.map(m => { const r = m.byCanal.get(c); return `<td class="n ${r && !meets(gR, r.roas) ? 'bad' : ''}">${r ? fmtX(r.roas) : '—'}</td>`; }).join('')}</tr>`).join('') +
    `<tr class="total"><td>Total</td>${ms.map(m => `<td class="n">${fmtX(m.tot.roas)}</td>`).join('')}</tr></tbody>`;

  const b = budgetStatus(w);
  $('#budget').innerHTML = !b ? '<p class="note">No hay presupuesto para el mes de esta semana (pestaña «presupuesto», columna Mes en formato AAAA-MM).</p>' :
    `<h3>${b.label[0].toUpperCase() + b.label.slice(1)} · acumulado hasta la semana ${w}</h3>` +
    b.rows.concat([{ canal: 'Total', plan: b.planT, real: b.realT }]).map(r => {
      const p = r.plan ? r.real / r.plan : 0;
      return `<div class="meter"><div class="bar-row"><span>${esc(r.canal)}</span><div class="bar-track"><div class="bar-fill ${p > b.expected + 0.1 ? '' : 'ok'}" style="width:${Math.min(100, p * 100)}%"></div><div class="bar-goal" style="left:${b.expected * 100}%"></div></div><b>${fmtPct(p, 0)}</b></div><div class="bar-legend">${fmtMoney(r.real)} de ${fmtMoney(r.plan)}</div></div>`;
    }).join('') + `<div class="bar-legend">Línea verde = avance esperado del mes (${fmtPct(b.expected, 0)}). Rojo = gasto adelantado más de 10 puntos.</div>`;

  $('#dictTable').innerHTML = `<thead><tr><th>KPI</th><th>Definición única</th><th>Dueño</th><th>Meta</th></tr></thead><tbody>` +
    (state.dict.length ? state.dict.map(d => `<tr><td><b>${esc(d.kpi)}</b></td><td>${esc(d.def)}${d.formula ? `<br><span class="note">${esc(d.formula)}</span>` : ''}</td><td>${esc(d.owner)}</td><td>${esc(d.meta)}</td></tr>`).join('') : '<tr><td colspan="4">Sin diccionario.</td></tr>') + '</tbody>';
}
let currentBrief = null;
function renderBriefing() {
  currentBrief = briefing(state.week);
  $('#mailSubject').textContent = `Briefing IA · semana ${state.week}`;
  $('#briefing').innerHTML = currentBrief.html;
  $('#briefFoot').textContent = `Borrador generado desde la hoja «kpis» (semana ${state.week}) · pendiente de revisión por: analista de marketing`;
}
function renderLog() {
  const showUser = state.isAdmin;
  const rows = state.log.filter(r => !showUser || !state.logUser || r.usuario === state.logUser);
  $('#logTable').innerHTML = `<thead><tr><th>Fecha</th>${showUser ? '<th>Usuario</th>' : ''}<th>Tipo</th><th>Escenario</th><th>Semana</th><th>Pregunta / briefing</th><th>Respuesta</th><th>Revisado por</th></tr></thead><tbody>` +
    (rows.length ? rows.slice().reverse().map(r => `<tr><td>${esc(r.fecha)}</td>${showUser ? `<td>${esc(r.usuario)}</td>` : ''}<td>${esc(r.tipo)}</td><td>${esc(r.escenario ? scenarioName(r.escenario) : '')}</td><td>${esc(r.semana)}</td><td>${esc(r.q).slice(0, 160)}</td><td>${esc(r.a).slice(0, 220)}</td><td>${esc(r.rev)}</td></tr>`).join('') : `<tr><td colspan="${showUser ? 8 : 7}">Aún no hay registros. Haz preguntas al asistente o aprueba un briefing.</td></tr>`) + '</tbody>';
}
function renderChips() {
  const c = state.channels[0] || 'Google Ads';
  const qs = ['¿Qué canal tuvo el peor ROAS esta semana?', '¿Cómo calculamos el ROAS?', `¿Cuánto invertimos en ${c}?`, '¿Cómo vamos frente al presupuesto?', '¿Cómo cambió el ROAS vs. la semana anterior?', 'Ranking de canales por CPA'];
  $('#chips').innerHTML = qs.map(q => `<button class="chip" type="button">${esc(q)}</button>`).join('');
}
function renderAll() {
  const sel = $('#weekSel');
  sel.innerHTML = state.weeks.slice().reverse().map(w => `<option value="${w}" ${w === state.week ? 'selected' : ''}>Semana ${w}</option>`).join('');
  renderKPIs(); renderBriefing(); renderChips(); renderLog();
}

// ---------- chat ----------
function pushMsg(who, text, src) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  if (src) { const s = document.createElement('span'); s.className = 'src'; s.textContent = 'Fuente: ' + src; el.appendChild(s); }
  $('#chatLog').appendChild(el);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}
function ask(q) {
  if (!q.trim() || !state.data.size) return;
  pushMsg('user', q);
  const a = answer(q);
  pushMsg('bot', a.text, a.src);
  addLog({ tipo: 'pregunta', semana: state.week, q, a: a.text, src: a.src, rev: '', fb: '' });
}

// ---------- carga ----------
// kind: 'db' (Supabase), 'excel' (Excel publicado del escenario) o 'user' (archivo cargado por el usuario)
function applyWorkbook(wb, source, kind, extraAlerts = []) {
  const isUser = kind === 'user';
  const res = parseWorkbook(wb);
  if (res.errors.length) {
    renderAlerts([['err', `<b>No pude usar ${esc(source)}:</b><ul>${res.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>Revisa la pestaña «instrucciones» del Excel base.`]]);
    if (!state.data.size) setSource('Sin datos', 'err');
    return false;
  }
  Object.assign(state, { wb, source, isUser, data: res.data, weeks: res.weeks, channels: res.channels, starts: res.starts, dict: res.dict, budget: res.budget });
  state.week = state.weeks.at(-1);
  const al = [...extraAlerts];
  if (isUser) al.push(['ok', `Excel cargado: <b>${esc(source)}</b> · ${state.weeks.length} semana(s) (${state.weeks[0]}–${state.week}) · canales: ${esc(state.channels.join(', '))}. Los datos solo viven en tu navegador.`]);
  if (res.warnings.length) al.push(['', `<b>Validaciones de calidad de datos:</b><ul>${res.warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`]);
  renderAlerts(al);
  const escName = scenarioName(state.scenario);
  setSource(isUser ? `Tu archivo: ${source} (solo en este navegador)`
    : kind === 'db' ? `Fuente: base de datos Supabase · escenario ${escName}`
    : `Fuente: ${source} (Excel publicado) · escenario ${escName}`, isUser ? 'user' : 'ok');
  $('#chatLog').innerHTML = '';
  pushMsg('bot', `Hola, soy el asistente de Marketing. Respondo solo con las cifras ${isUser ? 'de tu Excel' : `del escenario ${escName}`} (semanas ${state.weeks[0]}–${state.week}, ${state.channels.length} canales). ¿Qué quieres saber?`);
  renderAll();
  return true;
}
function setSource(text, cls) { $('#srcLabel').textContent = text; $('#srcDot').className = 'dot ' + (cls || ''); }
const readWb = buf => XLSX.read(buf, { type: 'array' });

async function loadDefault() {
  const extra = [];
  if (DB) {
    setSource('Cargando datos de Supabase…');
    try { applyWorkbook(await dbWorkbook(state.scenario), 'Supabase', 'db'); return; }
    catch (e) { extra.push(['err', `No pude leer Supabase (${esc(e.message)}). Muestro el Excel publicado del escenario.`]); }
  }
  const url = (FILE_SCENARIOS.find(s => s.id === state.scenario) || {}).archivo || DEFAULT_URL;
  setSource('Cargando Excel…');
  try {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    applyWorkbook(readWb(await r.arrayBuffer()), url, 'excel', extra);
  } catch (e) {
    setSource('No se pudo leer el Excel publicado', 'err');
    renderAlerts([...extra, ['err', `No pude descargar <b>${esc(url)}</b> (${esc(e.message)}). Usa «Cargar mi Excel».`]]);
  }
}
async function loadFile(file) {
  if (!file) return;
  if (!/\.xlsx?$/i.test(file.name)) { renderAlerts([['err', 'El archivo debe ser .xlsx o .xls.']]); return; }
  try { applyWorkbook(readWb(await file.arrayBuffer()), file.name, 'user'); }
  catch (e) { renderAlerts([['err', `No pude leer ${esc(file.name)}: ${esc(e.message)}`]]); }
}

function exportWorkbook() {
  if (!state.wb) return;
  const wb = XLSX.utils.book_new();
  const logName = state.wb.SheetNames.find(n => norm(n) === 'log ia') || 'log_ia';
  const existing = state.wb.Sheets[logName] ? sheetRows(state.wb.Sheets[logName]) : [];
  const header = ['Fecha', 'Usuario', 'Tipo', 'Escenario', 'Semana', 'Pregunta / briefing', 'Respuesta', 'Fuente', 'Revisado por', 'Decisión / feedback'];
  const rows = existing.map(r => header.map(h => r[h] ?? '')).concat(state.log.map(r => [r.fecha, r.usuario || '', r.tipo, r.escenario || '', r.semana, r.q, r.a, r.src, r.rev, r.fb]));
  for (const n of state.wb.SheetNames) if (n !== logName) XLSX.utils.book_append_sheet(wb, state.wb.Sheets[n], n);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), logName);
  XLSX.writeFile(wb, 'kpis_marketing_con_log.xlsx');
}

// ---------- eventos ----------
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
}));
$('#weekSel').addEventListener('change', e => { state.week = +e.target.value; renderKPIs(); renderBriefing(); });
$('#escSel').addEventListener('change', e => { state.scenario = e.target.value; loadDefault(); });
$('#fileInput').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
$('#reloadBtn').addEventListener('click', loadDefault);
$('#regenBtn').addEventListener('click', renderBriefing);
$('#copyBtn').addEventListener('click', async () => {
  const text = `Asunto: Briefing IA · semana ${state.week}\n\n${$('#briefing').innerText}`;
  try { await navigator.clipboard.writeText(text); $('#copyBtn').textContent = 'Copiado ✓'; } catch { $('#copyBtn').textContent = 'No se pudo copiar'; }
  setTimeout(() => ($('#copyBtn').textContent = 'Copiar texto'), 1800);
});
$('#approveBtn').addEventListener('click', () => {
  const rev = $('#reviewer').value.trim();
  if (!rev) { $('#reviewer').focus(); $('#reviewer').placeholder = 'Escribe quién revisó antes de aprobar'; return; }
  addLog({ tipo: 'briefing', semana: state.week, q: `Briefing IA · semana ${state.week}`, a: $('#briefing').innerText, src: `hoja «kpis», semana ${state.week}`, rev, fb: currentBrief ? currentBrief.decision : '' });
  $('#briefFoot').textContent = `Generado con IA desde la hoja «kpis» · revisado por: ${rev} · registrado en log_ia`;
});
$('#chatForm').addEventListener('submit', e => { e.preventDefault(); const i = $('#chatInput'); ask(i.value); i.value = ''; });
$('#chips').addEventListener('click', e => { if (e.target.classList.contains('chip')) ask(e.target.textContent); });
$('#exportBtn').addEventListener('click', exportWorkbook);
$('#clearLogBtn').addEventListener('click', () => { state.log = []; saveLog(); renderLog(); });

let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); loadFile(e.dataTransfer.files[0]); });

$('#logUserSel').addEventListener('change', e => { state.logUser = e.target.value; renderLog(); });

// ---------- cuentas ----------
async function startApp() {
  await loadScenarios();
  if (window.XLSX) await loadDefault();
  else renderAlerts([['err', 'No se pudo cargar la librería de Excel (SheetJS). Revisa tu conexión a internet.']]);
  await loadLog();
}
function showGate(msg = '', cls = '') {
  document.body.classList.add('locked');
  $('#authGate').hidden = false;
  $('#userBox').hidden = true;
  $('#authMsg').textContent = msg; $('#authMsg').className = 'gate-msg ' + cls;
}
async function onSignedIn(user) {
  state.user = user;
  try { state.isAdmin = (await sb(`perfiles?select=rol&id=eq.${user.id}`))[0]?.rol === 'admin'; } catch { state.isAdmin = false; }
  $('#authGate').hidden = true;
  document.body.classList.remove('locked');
  $('#userEmail').textContent = user.email;
  $('#userRole').textContent = state.isAdmin ? 'Administrador' : 'Usuario';
  $('#userRole').className = 'role' + (state.isAdmin ? ' admin' : '');
  $('#userBox').hidden = false;
  await startApp();
}
const AUTH_ERRORS = [
  [/invalid login credentials/i, 'Correo o contraseña incorrectos.'],
  [/email not confirmed/i, 'Tu correo aún no está confirmado. Revisa tu bandeja de entrada (y spam).'],
  [/already registered|already been registered/i, 'Ese correo ya tiene una cuenta. Usa «Entrar».'],
  [/password should be at least/i, 'La contraseña debe tener al menos 6 caracteres.'],
  [/signups not allowed|signup.*disabled/i, 'La creación de cuentas está desactivada. Pide acceso al administrador.'],
  [/rate limit/i, 'Demasiados intentos. Espera unos minutos y vuelve a probar.'],
];
const authError = e => (AUTH_ERRORS.find(([re]) => re.test(e.message)) || [, e.message])[1];

$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const signup = e.submitter && e.submitter.value === 'signup';
  const email = $('#authEmail').value.trim(), password = $('#authPass').value;
  showGate(signup ? 'Creando la cuenta…' : 'Entrando…');
  const { data, error } = signup
    ? await SB.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
    : await SB.auth.signInWithPassword({ email, password });
  if (error) return showGate(authError(error), 'err');
  if (!data.session) return showGate('Cuenta creada. Te enviamos un correo para confirmarla; después vuelve aquí y pulsa «Entrar».', 'ok');
  $('#authPass').value = '';
  await onSignedIn(data.session.user);
});
$('#logoutBtn').addEventListener('click', async () => { await SB.auth.signOut(); location.reload(); });

(async () => {
  if (!DB) return startApp();  // sin Supabase no hay cuentas: la app usa los Excel
  if (!SB) { showGate('No se pudo cargar el módulo de cuentas de Supabase. Revisa tu conexión y recarga la página.', 'err'); return; }
  const { data } = await SB.auth.getSession();
  if (data.session) await onSignedIn(data.session.user);
  else showGate();
})();
