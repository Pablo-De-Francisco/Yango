// Lógica compartida de las funciones de servidor (api/asistente.js y api/resumen-semanal.js):
// acceso a Supabase, contexto de datos con métricas calculadas y llamada a Claude.
import Anthropic from '@anthropic-ai/sdk';

export const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://xubnplutpfkxkzwuebpg.supabase.co').replace(/\/+$/, '');
export const PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_1rvoYKrN8nQFferis-y9xw_bt6B9J42';
export const MODEL = 'claude-opus-5-5';

const SYSTEM = `Eres el analista de datos del equipo de Marketing de Yango y trabajas dentro del "Copiloto de Marketing IA".
Las personas del equipo te preguntan por el desempeño de las campañas pagadas (Google Ads, Meta Ads, Yango Ads, etc.).
En cada consulta recibes, entre etiquetas <datos>, las métricas semanales del escenario que la persona tiene seleccionado, el diccionario de KPIs con sus metas y el presupuesto mensual.

Cómo trabajar:
- Basa toda cifra en esos datos (o en cálculos directos sobre ellos) y menciona de qué semana y canal sale. Si lo que preguntan no está en los datos, dilo con claridad y explica qué dato haría falta; no inventes cifras ni supongas datos externos.
- Interpreta, no solo repitas: explica qué cambió, por qué probablemente cambió según los datos, y qué implica. Cuando propongas acciones, preséntalas como sugerencias para que el equipo decida.
- Usa las definiciones y metas del diccionario cuando hables de un KPI.
- Los datos son escenarios simulados para un prototipo académico; no hace falta repetirlo en cada respuesta.
- Responde en español, en un tono profesional y cercano. Ajusta la extensión a la pregunta: breve si es puntual, más completa si piden análisis.
- Formato: texto plano. Para listas usa líneas que empiecen con "- ". Sin tablas, sin negritas ni otros símbolos de Markdown.`;

const PROMPT_RESUMEN = `Escribe el briefing semanal para la Dirección de Marketing sobre la semana {semana} (escenario {escenario}).
Debe ser un resumen detallado pero fácil de leer en 2 minutos, con estas secciones, cada una con su título en una línea que empiece con "## ":
## Resumen ejecutivo
## Qué cambió frente a la semana anterior
## Desempeño por canal
## Presupuesto: plan vs. real
## Riesgos y oportunidades
## Decisiones sugeridas
En cada sección usa párrafos cortos o líneas que empiecen con "- ". Cita cifras concretas de los datos. En "Decisiones sugeridas" propone 2 o 3 decisiones concretas, cada una con su justificación.`;

// ---------- Supabase ----------
// auth: { apikey, token }. Con el token del usuario aplican sus reglas RLS; con la clave secreta, ninguna.
export async function sbFetch(path, { apikey = PUBLIC_KEY, token = PUBLIC_KEY, method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { apikey, Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Object.assign(new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
  return r;
}
export const sbJson = (path, auth) => sbFetch(`/rest/v1/${path}`, auth).then(r => r.json());

// Usuario de Supabase dueño del token (null si el token no es válido)
export async function usuario(token) {
  if (!token) return null;
  try { const u = await (await sbFetch('/auth/v1/user', { token })).json(); return u && u.id ? u : null; } catch { return null; }
}
export const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

// ---------- contexto de datos ----------
const f0 = n => Math.round(n).toLocaleString('es-CO');
const f2 = n => n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n * 100).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
const delta = (a, b) => {
  if (!b) return 's/d';
  const d = a / b - 1;
  return Math.abs(d) < 0.0005 ? 'sin cambio' : (d > 0 ? '+' : '') + pct(d);
};
const metricas = r => ({ ...r, roas: r.inv ? r.ing / r.inv : 0, cpa: r.conv ? r.inv / r.conv : 0, ctr: r.imp ? r.clics / r.imp : 0 });

// Texto con todas las semanas del escenario (métricas ya calculadas), el diccionario y el presupuesto.
export async function contexto(escenario, semanaSel, auth) {
  const [esc, datos, dict, pres] = await Promise.all([
    sbJson(`escenarios?select=nombre&id=eq.${encodeURIComponent(escenario)}`, auth),
    sbJson(`datos_crudos?select=*&escenario=eq.${encodeURIComponent(escenario)}&order=semana,canal`, auth),
    sbJson('diccionario?select=*&order=orden', auth),
    sbJson('presupuesto?select=*&order=mes,canal', auth),
  ]);
  if (!datos.length) throw Object.assign(new Error(`No hay datos del escenario «${escenario}».`), { status: 404 });

  const semanas = [...new Set(datos.map(d => d.semana))].sort((a, b) => a - b);
  const porSemana = new Map(semanas.map(s => [s, []]));
  for (const d of datos) porSemana.get(d.semana).push(metricas({ canal: d.canal, inicio: d.fecha_inicio, inv: +d.inversion, imp: +d.impresiones, clics: +d.clics, conv: +d.conversiones, ing: +d.ingresos_atribuidos }));
  const total = filas => metricas(filas.reduce((t, r) => ({ canal: 'Total', inicio: r.inicio, inv: t.inv + r.inv, imp: t.imp + r.imp, clics: t.clics + r.clics, conv: t.conv + r.conv, ing: t.ing + r.ing }), { inv: 0, imp: 0, clics: 0, conv: 0, ing: 0 }));

  const semana = semanas.includes(Number(semanaSel)) ? Number(semanaSel) : semanas.at(-1);
  const nombre = esc[0]?.nombre || escenario;
  const lineas = [`Escenario: ${nombre}. Semanas disponibles: ${semanas.join(', ')}. Semana seleccionada por el usuario: ${semana}.`, ''];
  lineas.push('MÉTRICAS SEMANALES (USD; ROAS = ingresos atribuidos / inversión; CPA = inversión / conversiones; CTR = clics / impresiones)');
  let prev = null;
  for (const s of semanas) {
    const filas = porSemana.get(s), t = total(filas);
    lineas.push(`Semana ${s} (inicia ${filas[0].inicio || 's/f'}):`);
    for (const r of [...filas, t]) {
      const p = prev && (r.canal === 'Total' ? total(prev) : prev.find(x => x.canal === r.canal));
      lineas.push(`- ${r.canal}: inversión ${f0(r.inv)}; impresiones ${f0(r.imp)}; clics ${f0(r.clics)}; conversiones ${f0(r.conv)}; ingresos ${f0(r.ing)}; ROAS ${f2(r.roas)}x; CPA ${f2(r.cpa)}; CTR ${pct(r.ctr)}` +
        (p ? ` | vs. semana anterior: inversión ${delta(r.inv, p.inv)}, conversiones ${delta(r.conv, p.conv)}, ROAS ${delta(r.roas, p.roas)}, CPA ${delta(r.cpa, p.cpa)}` : ''));
    }
    prev = filas;
  }

  lineas.push('', 'DICCIONARIO DE KPIs');
  for (const d of dict) lineas.push(`- ${d.kpi}: ${d.definicion || ''} Fórmula: ${d.formula || 's/d'}. Dueño: ${d.dueno || 's/d'}. Meta: ${d.meta || 's/d'}.`);

  lineas.push('', 'PRESUPUESTO MENSUAL vs. INVERSIÓN REAL ACUMULADA (según las semanas cuyo inicio cae en el mes)');
  for (const mes of [...new Set(pres.map(p => p.mes))]) {
    const sems = semanas.filter(s => (porSemana.get(s)[0].inicio || '').startsWith(mes));
    for (const p of pres.filter(x => x.mes === mes)) {
      const real = sems.reduce((a, s) => a + (porSemana.get(s).find(r => r.canal === p.canal)?.inv || 0), 0);
      lineas.push(`- ${mes} · ${p.canal}: presupuesto ${f0(+p.presupuesto)}; invertido ${f0(real)} (${pct(real / +p.presupuesto)}) en las semanas ${sems.join(', ') || 'ninguna'}`);
    }
  }
  return { texto: lineas.join('\n'), semana, nombre };
}

// ---------- Claude ----------
function historialValido(h) {
  if (!Array.isArray(h)) return [];
  const msgs = h.slice(-8)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();  // el primer mensaje debe ser del usuario
  return msgs;
}

// Proveedor de IA según las variables de entorno: Gemini (plan gratuito) o Claude (Anthropic).
// Una clave de Gemini («AIza…») guardada por error en ANTHROPIC_API_KEY también se reconoce.
const GEMINI_KEY = process.env.GEMINI_API_KEY || (/^AIza/.test(process.env.ANTHROPIC_API_KEY || '') ? process.env.ANTHROPIC_API_KEY : '');
export const proveedorIA = () => (GEMINI_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : null);
// Modelos gratuitos en orden de velocidad, con su nivel de razonamiento más rápido. Si uno está saturado (503),
// sin cuota (429) o tarda, se prueba el siguiente. GEMINI_MODEL (opcional) fija el primero.
const GEMINI_MODELOS = [
  ...(process.env.GEMINI_MODEL ? [[process.env.GEMINI_MODEL, 'low']] : []),
  ['gemini-3.5-flash-lite', 'minimal'],
  ['gemini-3.6-flash', 'low'],
  ['gemini-3.8-flash', 'low'],
].filter(([m], i, a) => a.findIndex(([x]) => x === m) === i);

const errorGemini = (status, msg) => Object.assign(new Error(msg), { status });

async function llamarGemini(model, nivel, modo, messages, ms) {
  const llamar = conNivel => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    signal: AbortSignal.timeout(ms),
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      // el límite incluye los tokens de razonamiento, por eso es holgado
      generationConfig: { maxOutputTokens: modo === 'resumen' ? 16000 : 8000, ...(conNivel ? { thinkingConfig: { thinkingLevel: nivel } } : {}) },
    }),
  });
  let r = await llamar(true);
  // si el modelo no acepta ese nivel de razonamiento, se reintenta sin él
  if (r.status === 400 && /thinking/i.test(await r.clone().text())) r = await llamar(false);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.error?.message || `HTTP ${r.status}`;
    if ([400, 401, 403].includes(r.status) && /api key|permission|unauth/i.test(msg)) throw errorGemini(503, 'La clave de Gemini configurada en Vercel no es válida.');
    throw errorGemini(r.status === 429 ? 429 : 502, `${model}: ${msg.slice(0, 120)}`);
  }
  const cand = data.candidates?.[0];
  const texto = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
  if (!texto && (data.promptFeedback?.blockReason || cand?.finishReason === 'SAFETY')) {
    return { texto: 'No puedo responder esa consulta. Prueba a reformularla sobre los datos de campañas.', modelo: model, truncada: false };
  }
  if (!texto) throw errorGemini(502, `${model}: respuesta vacía`);
  return { texto, modelo: data.modelVersion || model, truncada: cand?.finishReason === 'MAX_TOKENS' };
}

async function generarGemini({ modo, messages }) {
  const fin = Date.now() + 52e3;  // todo debe terminar antes del límite de 60 s de la función
  const fallos = [];
  for (const [i, [model, nivel]] of GEMINI_MODELOS.entries()) {
    const restante = fin - Date.now();
    if (restante < 4e3) break;
    // cada intento recibe una parte del tiempo, salvo el último, que usa todo lo que queda
    const ms = i === GEMINI_MODELOS.length - 1 ? restante : Math.min(restante, 18e3);
    try {
      return await llamarGemini(model, nivel, modo, messages, ms);
    } catch (e) {
      if (e.status === 503 && /clave/.test(e.message)) throw e;  // clave inválida: no tiene sentido seguir
      fallos.push(e.name === 'TimeoutError' || e.name === 'AbortError' ? `${model}: tardó demasiado` : e.message);
    }
  }
  throw errorGemini(503, `Gemini está saturado en este momento; intenta de nuevo en un minuto. (${fallos.join(' · ')})`);
}

// modo 'pregunta' (chat) o 'resumen' (briefing semanal). Devuelve { texto, modelo, truncada }.
export async function generar({ modo, pregunta = '', historial = [], ctx, effort }) {
  const instruccion = modo === 'resumen'
    ? PROMPT_RESUMEN.replace('{semana}', ctx.semana).replace('{escenario}', ctx.nombre)
    : pregunta;
  if (proveedorIA() === 'gemini') {
    return generarGemini({ modo, messages: [
      ...(modo === 'pregunta' ? historialValido(historial) : []),
      { role: 'user', content: `<datos>\n${ctx.texto}\n</datos>\n\n${instruccion}` },
    ] });
  }
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: modo === 'resumen' ? 8000 : 4000,
    output_config: { effort: effort || (modo === 'resumen' ? 'medium' : 'low') },
    // si el modelo declina por política, la API reintenta con un modelo alternativo dentro de la misma llamada
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [
      ...(modo === 'pregunta' ? historialValido(historial) : []),
      { role: 'user', content: `<datos>\n${ctx.texto}\n</datos>\n\n${instruccion}` },
    ],
  });
  if (response.stop_reason === 'refusal') {
    return { texto: 'No puedo responder esa consulta. Prueba a reformularla sobre los datos de campañas.', modelo: response.model, truncada: false };
  }
  const texto = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { texto: texto || 'No obtuve respuesta. Intenta de nuevo.', modelo: response.model, truncada: response.stop_reason === 'max_tokens' };
}

// Respuesta HTTP para errores de Claude o de Supabase
export function errorHttp(res, error) {
  if (error instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: 'La clave de Anthropic configurada en Vercel no es válida.' });
  if (error instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'El servicio de IA está ocupado. Intenta en un minuto.' });
  if (error instanceof Anthropic.APIError) return res.status(502).json({ error: `Error del servicio de IA (${error.status}).` });
  return res.status([404, 429, 502, 503, 504].includes(error.status) ? error.status : 500).json({ error: error.message || 'Error inesperado.' });
}

// texto del resumen ("## título", "- punto") -> HTML para el correo
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function textoAHtml(text) {
  let html = '', list = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const item = line.match(/^[-•]\s+(.*)/);
    if (list && !item) { html += '</ul>'; list = false; }
    if (!line) continue;
    if (item) { if (!list) { html += '<ul style="margin:6px 0;padding-left:22px">'; list = true; } html += `<li style="margin:4px 0">${escHtml(item[1])}</li>`; }
    else if (/^#{1,3}\s/.test(line)) html += `<h3 style="color:#ff0000;font-size:18px;margin:18px 0 6px">${escHtml(line.replace(/^#{1,3}\s+/, ''))}</h3>`;
    else html += `<p style="margin:6px 0">${escHtml(line)}</p>`;
  }
  return html + (list ? '</ul>' : '');
}
