// Agente de datos (función de servidor de Vercel: POST /api/agente-datos).
// accion 'conversar': la IA pide al usuario los datos de una o varias semanas (fecha y cifras por canal) y arma un borrador por semana.
// accion 'guardar': un administrador guarda el borrador revisado en la tabla datos_crudos de Supabase.
// accion 'solicitar': un usuario envía su borrador al administrador; 'solicitudes' las lista; 'aprobar' / 'rechazar' (admin) las resuelve.
// El servidor valida siempre el borrador con reglas fijas: la IA conversa, pero no decide qué datos son válidos.
// Variables de entorno en Vercel: GEMINI_API_KEY (o ANTHROPIC_API_KEY) y, para guardar, SUPABASE_SERVICE_ROLE_KEY.
import { bearer, usuario, sbJson, sbFetch, generarJSON, errorHttp, proveedorIA } from '../lib/copiloto.js';
import { correoConfigurado, crearTransporte, correoHtml } from '../lib/correo.js';

export const config = { maxDuration: 60 };

const CAMPOS = ['inversion', 'impresiones', 'clics', 'conversiones', 'ingresos_atribuidos'];
const NOMBRE = { inversion: 'inversión (USD)', impresiones: 'impresiones', clics: 'clics', conversiones: 'conversiones', ingresos_atribuidos: 'ingresos atribuidos (USD)' };

const MAX_SEMANAS = 26;        // semanas que admite un borrador
const MAX_PENDIENTES = 30;     // solicitudes pendientes por usuario (cada semana es una solicitud)
const MAX_MENSAJE = 8000;      // caracteres de un mensaje (alcanza para un párrafo con varias semanas)

const SYSTEM = `Eres el "Agente de datos" del Copiloto de Marketing IA de Yango. Tu trabajo es pedirle a la persona, de forma conversacional, los datos de una o varias semanas de campañas y armar con ellos un borrador por semana, que luego se agrega a la hoja datos_crudos.

Datos que necesitas por cada semana:
- semana (número entero) y fecha_inicio (AAAA-MM-DD, el lunes de esa semana). En <contexto> tienes la semana y la fecha sugeridas (la siguiente a la última cargada); propónlas y pide confirmación.
- Para cada canal del escenario: inversion (USD), impresiones, clics, conversiones e ingresos_atribuidos (USD).

Cómo trabajar:
- Habla en español, cordial y breve. Pide los datos por canal, uno o dos canales a la vez; si la persona da todo junto, acéptalo.
- Si la persona escribe un párrafo dividido en semanas, crea un elemento en "borradores" por CADA semana, con sus propias cifras. Nunca mezcles, sumes ni promedies cifras de semanas distintas.
- Usa el número de semana que diga la persona. Si no da números ("primera semana", "la siguiente"), numéralas de forma consecutiva desde la semana sugerida.
- Si la persona da la fecha de una semana, conviértela a AAAA-MM-DD. Si no la da, deja fecha_inicio en null: el sistema propone una.
- Interpreta números escritos de forma natural: "12 mil" = 12000, "1,2 millones" = 1200000, "$8.500" = 8500.
- Nunca inventes cifras. Si un dato no está claro, pregunta. Si un canal no tuvo campañas esa semana, la persona puede decirlo: entonces no lo incluyas en esa semana.
- En <validacion> recibes, semana por semana, los datos que faltan y los problemas del borrador actual: pregunta por ellos indicando la semana, o pide confirmar las cifras raras. Si una semana ya existe, avisa que se reemplazarían sus cifras.
- Cuando el borrador esté completo y sin problemas, muestra un resumen corto y pide a la persona que revise las tablas y pulse «Guardar» o «Descargar Excel».

Responde SIEMPRE con un objeto JSON con esta forma exacta:
{"mensaje": "lo que le dices a la persona", "borradores": [{"semana": 43, "fecha_inicio": "2026-10-26", "filas": [{"canal": "Google Ads", "inversion": 1000, "impresiones": 50000, "clics": 1200, "conversiones": 80, "ingresos_atribuidos": 3500}]}], "eliminar": []}
- "borradores" tiene un elemento por semana, con SOLO lo que la persona dio o confirmó; deja fuera (o en null) lo que aún no sabes. Las semanas y los datos del borrador actual que no cambian se conservan solos: no hace falta repetirlos.
- "eliminar" lista lo que la persona pidió quitar: {"semana": 44, "canal": "Meta Ads"} quita un canal de esa semana y {"semana": 44} quita la semana completa.`;

const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const fechaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(f || '') && !isNaN(new Date(f + 'T00:00:00Z'));

// Une el borrador anterior con lo que devolvió la IA (la IA no puede borrar datos por omisión).
function unir(anterior = {}, nuevo = {}, eliminar = []) {
  const b = { semana: anterior.semana ?? null, fecha_inicio: anterior.fecha_inicio ?? null, filas: [...(anterior.filas || [])] };
  if (nuevo.semana != null && nuevo.semana !== '') b.semana = nuevo.semana;
  if (nuevo.fecha_inicio) b.fecha_inicio = String(nuevo.fecha_inicio).slice(0, 10);
  for (const f of Array.isArray(nuevo.filas) ? nuevo.filas : []) {
    const canal = String(f?.canal || '').trim().slice(0, 60);
    if (!canal) continue;
    let fila = b.filas.find(x => x.canal.toLowerCase() === canal.toLowerCase());
    if (!fila) { fila = { canal }; b.filas.push(fila); }
    for (const k of CAMPOS) if (f[k] != null && f[k] !== '') fila[k] = f[k];
  }
  const fuera = new Set((Array.isArray(eliminar) ? eliminar : []).map(c => String(c).toLowerCase()));
  b.filas = b.filas.filter(f => !fuera.has(f.canal.toLowerCase())).slice(0, 20);
  return b;
}

const claveSemana = s => { const n = num(s); return n === null || Number.isNaN(n) ? null : n; };
const tieneCifras = b => (b.filas || []).some(f => CAMPOS.some(k => f[k] != null && f[k] !== ''));

// Borradores que envía el navegador (acepta también el formato anterior, de una sola semana).
export function listaBorradores(body) {
  const lista = Array.isArray(body.borradores) ? body.borradores : body.borrador ? [body.borrador] : [];
  return lista.filter(b => b && typeof b === 'object').slice(0, MAX_SEMANAS).map(b => unir({}, b));
}

// Une las semanas del borrador con las que devolvió la IA, emparejándolas por número de semana.
export function unirVarias(anteriores, nuevos, eliminar) {
  let semanas = anteriores.map(b => unir({}, b));
  const lista = (Array.isArray(nuevos) ? nuevos : []).filter(n => n && typeof n === 'object');
  for (const n of lista) {
    const k = claveSemana(n.semana);
    // sin número solo se puede asignar si no hay ninguna duda de a qué semana pertenece
    const i = k !== null ? semanas.findIndex(b => claveSemana(b.semana) === k) : (semanas.length === 1 && lista.length === 1 ? 0 : -1);
    if (i >= 0) semanas[i] = unir(semanas[i], n); else semanas.push(unir({}, n));
  }
  for (const e of Array.isArray(eliminar) ? eliminar : []) {
    const obj = e && typeof e === 'object';
    const canal = String((obj ? e.canal : e) || '').trim().toLowerCase();
    const k = obj ? claveSemana(e.semana) : null;
    if (canal) semanas = semanas.map(b => (k === null || claveSemana(b.semana) === k) ? { ...b, filas: b.filas.filter(f => f.canal.toLowerCase() !== canal) } : b);
    else if (k !== null) semanas = semanas.filter(b => claveSemana(b.semana) !== k);
  }
  // la semana propuesta al inicio (vacía) sobra cuando los datos que llegaron son de otras semanas
  const citadas = new Set(lista.map(n => claveSemana(n.semana)));
  if (semanas.some(tieneCifras)) semanas = semanas.filter(b => tieneCifras(b) || citadas.has(claveSemana(b.semana)));
  return semanas.sort((a, b) => (claveSemana(a.semana) ?? Infinity) - (claveSemana(b.semana) ?? Infinity));
}

// Propone la fecha de las semanas que no la traen: la que ya tiene esa semana o, si es nueva, la que le corresponde tras la última cargada.
export function completarFechas(lista, ref) {
  return lista.map(b => {
    const s = claveSemana(b.semana);
    if (b.fecha_inicio || !Number.isInteger(s)) return b;
    let fecha = ref.fechas?.get(s) || null;
    if (!fecha && ref.sugerida && ref.ultimaSemana != null && s > ref.ultimaSemana) {
      fecha = new Date(Date.parse(ref.sugerida + 'T00:00:00Z') + (s - ref.ultimaSemana - 1) * 7 * 864e5).toISOString().slice(0, 10);
    }
    return fecha ? { ...b, fecha_inicio: fecha } : b;
  });
}

// Valida cada semana; cada una se compara con la anterior del borrador o, si no hay, con la última cargada.
export function validarVarias(lista, ref) {
  const vistas = new Set();
  const semanas = lista.map(b => {
    const s = claveSemana(b.semana);
    const previa = s === null ? null : lista.filter(o => { const x = claveSemana(o.semana); return x !== null && x < s; })
      .sort((a, c) => claveSemana(c.semana) - claveSemana(a.semana))[0];
    let r = ref;
    if (previa) {
      const ultima = new Map(ref.ultima);
      for (const f of previa.filas) { const v = num(f.inversion); if (v !== null && !Number.isNaN(v)) ultima.set(f.canal.toLowerCase(), { inversion: v, semana: previa.semana }); }
      r = { ...ref, ultima };
    }
    const v = validar(b, r);
    if (s !== null && vistas.has(s)) { v.errores.push(`La semana ${s} está repetida en el borrador.`); v.completo = false; }
    if (s !== null) vistas.add(s);
    return v;
  });
  return {
    borradores: semanas.map(v => v.borrador),
    semanas: semanas.map(({ faltan, errores, avisos, completo }) => ({ faltan, errores, avisos, completo })),
    completo: semanas.length > 0 && semanas.every(v => v.completo),
  };
}

// Reglas fijas: qué falta (bloquea guardar), qué está mal (bloquea) y qué es raro (solo avisa).
export function validar(borrador, ref) {
  const faltan = [], errores = [], avisos = [];
  const semana = num(borrador.semana);
  const b = { semana: Number.isInteger(semana) ? semana : borrador.semana ?? null, fecha_inicio: borrador.fecha_inicio || null, filas: [] };
  if (semana === null) faltan.push('número de semana');
  else if (!Number.isInteger(semana) || semana < 1 || semana > 99999) errores.push('La semana debe ser un número entero positivo.');
  if (!b.fecha_inicio) faltan.push('fecha de inicio de la semana');
  else if (!fechaValida(b.fecha_inicio)) errores.push('La fecha de inicio debe tener el formato AAAA-MM-DD.');
  if (Number.isInteger(semana) && ref.semanas.includes(semana)) avisos.push(`La semana ${semana} ya existe: al guardar se reemplazarán sus cifras en los canales del borrador.`);

  for (const f of borrador.filas || []) {
    const fila = { canal: f.canal };
    for (const k of CAMPOS) {
      const v = num(f[k]);
      fila[k] = v;
      if (v === null) faltan.push(`${NOMBRE[k]} de ${f.canal}`);
      else if (Number.isNaN(v) || v < 0) errores.push(`${f.canal}: ${NOMBRE[k]} debe ser un número mayor o igual a 0.`);
      else if ((k === 'impresiones' || k === 'clics') && !Number.isInteger(v)) fila[k] = Math.round(v);
    }
    const ok = k => typeof fila[k] === 'number' && !Number.isNaN(fila[k]);
    if (ok('clics') && ok('impresiones') && fila.clics > fila.impresiones) errores.push(`${f.canal}: los clics no pueden superar las impresiones.`);
    if (ok('conversiones') && ok('clics') && fila.conversiones > fila.clics) avisos.push(`${f.canal}: hay más conversiones que clics; confirma la cifra.`);
    const prev = ref.ultima.get(f.canal.toLowerCase());
    if (prev && ok('inversion') && prev.inversion > 0) {
      const r = fila.inversion / prev.inversion;
      if (r > 3 || r < 1 / 3) avisos.push(`${f.canal}: la inversión cambia mucho frente a la semana ${prev.semana ?? ref.ultimaSemana} (${Math.round(prev.inversion).toLocaleString('es-CO')} USD); confirma la cifra.`);
    }
    if (!prev) avisos.push(`${f.canal} es un canal nuevo en este escenario.`);
    b.filas.push(fila);
  }
  if (!b.filas.length) faltan.push('cifras de al menos un canal');
  const sinDatos = ref.canales.filter(c => !b.filas.some(f => f.canal.toLowerCase() === c.toLowerCase()));
  if (b.filas.length && sinDatos.length) avisos.push(`Sin datos de: ${sinDatos.join(', ')} (si no tuvieron campañas esa semana, está bien).`);
  return { borrador: b, faltan, errores, avisos, completo: !faltan.length && !errores.length };
}

// Canales, semanas y última semana cargada del escenario (con el token del usuario: aplican sus reglas RLS)
async function referencia(escenario, auth) {
  const [esc, datos] = await Promise.all([
    sbJson(`escenarios?select=id,nombre&id=eq.${encodeURIComponent(escenario)}`, auth),
    sbJson(`datos_crudos?select=semana,fecha_inicio,canal,inversion&escenario=eq.${encodeURIComponent(escenario)}&order=semana,canal`, auth),
  ]);
  if (!esc.length) throw Object.assign(new Error(`No existe el escenario «${escenario}».`), { status: 404 });
  const semanas = [...new Set(datos.map(d => d.semana))].sort((a, b) => a - b);
  const ultimaSemana = semanas.at(-1) ?? null;
  const ult = datos.filter(d => d.semana === ultimaSemana);
  const fecha = ult[0]?.fecha_inicio;
  const sugerida = fecha && fechaValida(fecha) ? new Date(Date.parse(fecha + 'T00:00:00Z') + 7 * 864e5).toISOString().slice(0, 10) : null;
  return {
    id: esc[0].id, nombre: esc[0].nombre, semanas, ultimaSemana, fechaUltima: fecha || null, sugerida,
    canales: [...new Set(datos.map(d => d.canal))],
    fechas: new Map(datos.filter(d => d.fecha_inicio).map(d => [d.semana, d.fecha_inicio])),
    ultima: new Map(ult.map(d => [d.canal.toLowerCase(), { inversion: +d.inversion }])),
  };
}

const SERVICIO = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, token: process.env.SUPABASE_SERVICE_ROLE_KEY } : null;
const resumenProblemas = v => [...v.faltan.map(x => 'falta ' + x), ...v.errores].join('; ').replace(/\.$/, '');
const resumenVarias = (v, lista) => v.semanas.map((s, i) => s.completo ? '' : `semana ${lista[i].semana ?? 'sin número'}: ${resumenProblemas(s)}`).filter(Boolean).join(' · ') || 'no tiene ninguna semana';
const nombreSemanas = l => `${l.length === 1 ? 'semana' : 'semanas'} ${l.map(b => b.semana).join(', ')}`;

// Escribe las semanas en datos_crudos de una sola vez, de modo que se guardan todas o ninguna
// (si la semana y el canal ya existen, se actualizan), y deja cada semana en el registro.
async function guardarSemanas(ref, lista, token, email, origen) {
  const filasDe = b => b.filas.map(f => ({ escenario: ref.id, semana: b.semana, fecha_inicio: b.fecha_inicio, canal: f.canal, ...Object.fromEntries(CAMPOS.map(k => [k, f[k]])) }));
  const filas = lista.flatMap(filasDe);
  await sbFetch('/rest/v1/datos_crudos?on_conflict=escenario,semana,canal', {
    ...SERVICIO, method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: filas,
  });
  await Promise.allSettled(lista.map(b => sbFetch('/rest/v1/log_ia', {
    token, method: 'POST', headers: { Prefer: 'return=minimal' },
    body: {
      tipo: 'pregunta', escenario: ref.id, semana: b.semana,
      pregunta: `Agente de datos · semana ${b.semana} guardada en datos_crudos`,
      respuesta: filasDe(b).map(f => `${f.canal}: inversión ${f.inversion}, impresiones ${f.impresiones}, clics ${f.clics}, conversiones ${f.conversiones}, ingresos ${f.ingresos_atribuidos}`).join('\n').slice(0, 5000),
      fuente: `agente de datos · ${origen}`.slice(0, 300), revisado_por: String(email || '').slice(0, 120),
    },
  })));  // el registro no debe impedir informar el guardado
  return { guardado: true, filas: filas.length, semana: lista[0].semana, semanas: lista.map(b => b.semana), escenario: ref.nombre };
}

// Aviso por correo (si el correo está configurado); un fallo no detiene la solicitud.
async function avisar(destinos, asunto, texto) {
  const para = destinos.filter(Boolean);
  if (!para.length || !correoConfigurado()) return;
  try {
    const { transporte, from } = crearTransporte();
    await Promise.allSettled(para.map(to => transporte.sendMail({ from, to, subject: asunto, text: texto, html: correoHtml(texto, asunto, '') })));
  } catch { /* sin aviso por correo */ }
}

function historial(h) {
  const msgs = (Array.isArray(h) ? h : []).slice(-16)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MENSAJE) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  const token = bearer(req);
  const user = await usuario(token);
  if (!user) return res.status(401).json({ error: 'Inicia sesión para usar el agente de datos.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const escenario = String(body.escenario || 'base').slice(0, 40);
  try {
    const accion = body.accion;
    const esAdmin = async () => (await sbJson(`perfiles?select=rol&id=eq.${user.id}`, { token }).catch(() => []))[0]?.rol === 'admin';
    const necesitaServicio = ['guardar', 'solicitar', 'solicitudes', 'aprobar', 'rechazar'].includes(accion);
    if (necesitaServicio && !SERVICIO) return res.status(503).json({ error: 'Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.' });

    // ---- solicitudes: los usuarios piden; el administrador aprueba (se guarda) o rechaza ----
    if (accion === 'solicitudes') {
      const admin = await esAdmin();
      const filtro = admin ? '' : `&user_id=eq.${user.id}`;
      const lista = await sbJson(`solicitudes_datos?select=*&order=created_at.desc&limit=50${filtro}`, SERVICIO);
      return res.status(200).json({ admin, solicitudes: lista });
    }
    if (accion === 'aprobar' || accion === 'rechazar') {
      if (!(await esAdmin())) return res.status(403).json({ error: 'Solo un administrador puede revisar solicitudes.' });
      const id = Number(body.id);
      const [sol] = await sbJson(`solicitudes_datos?select=*&id=eq.${id}`, SERVICIO);
      if (!sol) return res.status(404).json({ error: 'No encuentro esa solicitud.' });
      if (sol.estado !== 'pendiente') return res.status(409).json({ error: `Esa solicitud ya fue ${sol.estado}.` });
      const comentario = String(body.comentario || '').trim().slice(0, 500) || null;
      let resultado = {};
      if (accion === 'aprobar') {
        // se valida otra vez contra los datos de hoy (pudieron cambiar desde que se pidió)
        const ref = await referencia(sol.escenario, SERVICIO);
        const v = validar(unir({}, { semana: sol.semana, fecha_inicio: sol.fecha_inicio, filas: sol.filas }), ref);
        if (!v.completo) return res.status(400).json({ error: `La solicitud ya no pasa la validación: ${resumenProblemas(v)}.` });
        resultado = await guardarSemanas(ref, [v.borrador], token, user.email, `solicitud #${id} de ${sol.email}`);
      }
      await sbFetch(`/rest/v1/solicitudes_datos?id=eq.${id}&estado=eq.pendiente`, {
        ...SERVICIO, method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: { estado: accion === 'aprobar' ? 'aprobada' : 'rechazada', revisado_por: user.email, revisado_at: new Date().toISOString(), comentario },
      });
      await avisar([sol.email], `Tu solicitud de datos fue ${accion === 'aprobar' ? 'aprobada' : 'rechazada'} · semana ${sol.semana}`,
        `El administrador ${accion === 'aprobar' ? 'aprobó y guardó' : 'rechazó'} tu solicitud para agregar la semana ${sol.semana} (escenario ${sol.escenario}).${comentario ? `\n\nComentario: ${comentario}` : ''}`);
      return res.status(200).json({ ok: true, estado: accion === 'aprobar' ? 'aprobada' : 'rechazada', ...resultado });
    }

    const ref = await referencia(escenario, { token });

    if (accion === 'guardar' || accion === 'solicitar') {
      const admin = await esAdmin();
      if (accion === 'guardar' && !admin) return res.status(403).json({ error: 'Solo un administrador puede guardar datos en la base. Envía tu borrador como solicitud.' });
      const lista = listaBorradores(body);
      const v = validarVarias(lista, ref);
      if (!v.completo) return res.status(400).json({ error: `El borrador no está listo: ${resumenVarias(v, lista)}.`, ...v });
      if (accion === 'guardar') return res.status(200).json(await guardarSemanas(ref, v.borradores, token, user.email, 'guardado directo del administrador'));

      // una solicitud por semana: el administrador puede aprobar o rechazar cada una
      const pendientes = await sbJson(`solicitudes_datos?select=id&user_id=eq.${user.id}&estado=eq.pendiente`, SERVICIO);
      if (pendientes.length + v.borradores.length > MAX_PENDIENTES) return res.status(429).json({ error: `Tienes ${pendientes.length} solicitudes pendientes y el máximo es ${MAX_PENDIENTES}. Espera a que el administrador las revise.` });
      const nota = String(body.nota || '').trim().slice(0, 500) || null;
      const creadas = await (await sbFetch('/rest/v1/solicitudes_datos', {
        ...SERVICIO, method: 'POST', headers: { Prefer: 'return=representation' },
        body: v.borradores.map(b => ({ user_id: user.id, email: user.email, escenario: ref.id, semana: b.semana, fecha_inicio: b.fecha_inicio, filas: b.filas, nota })),
      })).json();
      const admins = (await sbJson('perfiles?select=email&rol=eq.admin&email=not.is.null', SERVICIO).catch(() => [])).map(p => p.email);
      const quePide = nombreSemanas(v.borradores);
      await avisar(admins, `Nueva solicitud de datos · ${quePide} · ${ref.nombre}`,
        `${user.email} pide agregar ${quePide} al escenario ${ref.nombre}.${nota ? `\n\nNota: ${nota}` : ''}\n\nRevísala en la pestaña «Agente de datos» del Copiloto.`);
      return res.status(200).json({ solicitada: true, ids: creadas.map(s => s.id), semanas: v.borradores.map(b => b.semana), escenario: ref.nombre });
    }

    // validar: revisa el borrador editado a mano en las tablas, sin llamar a la IA
    if (body.accion === 'validar') return res.status(200).json({ escenario: ref.nombre, ...validarVarias(listaBorradores(body), ref) });

    // conversar
    if (!proveedorIA()) return res.status(503).json({ error: 'El agente necesita la IA configurada (GEMINI_API_KEY en Vercel).' });
    const crudo = String(body.mensaje || '').trim();
    if (crudo.length > MAX_MENSAJE) return res.status(400).json({ error: `El mensaje es muy largo (máximo ${MAX_MENSAJE} caracteres). Envíalo por partes.` });
    const anteriores = listaBorradores(body);
    const anterior = validarVarias(anteriores, ref);
    const mensajes = historial(body.historial);
    const texto = crudo || 'Hola, quiero cargar datos.';
    const contexto = [
      `Hoy es ${new Date().toISOString().slice(0, 10)}. Escenario: ${ref.nombre}.`,
      `Canales del escenario: ${ref.canales.join(', ') || 'ninguno todavía'}.`,
      `Última semana cargada: ${ref.ultimaSemana ?? 'ninguna'}${ref.fechaUltima ? ` (inicia ${ref.fechaUltima})` : ''}. Semana sugerida: ${ref.ultimaSemana != null ? ref.ultimaSemana + 1 : 'pregúntala'}${ref.sugerida ? `, fecha de inicio sugerida ${ref.sugerida}` : ''}.`,
    ].join('\n');
    const validacion = anterior.semanas.map((s, i) => `Semana ${anterior.borradores[i].semana ?? 'sin número'} · Faltan: ${s.faltan.join('; ') || 'nada'}. Problemas: ${s.errores.join(' ') || 'ninguno'}. Avisos: ${s.avisos.join(' ') || 'ninguno'}.`).join('\n') || 'El borrador no tiene semanas.';
    const { datos, modelo } = await generarJSON({
      system: SYSTEM,
      messages: [...mensajes, { role: 'user', content: `<contexto>\n${contexto}\n</contexto>\n<borrador_actual>\n${JSON.stringify(anterior.borradores)}\n</borrador_actual>\n<validacion>\n${validacion}\n</validacion>\n\n${texto}` }],
    });
    const nuevos = Array.isArray(datos.borradores) ? datos.borradores : datos.borrador ? [datos.borrador] : [];
    const unidas = completarFechas(unirVarias(anterior.borradores, nuevos, datos.eliminar), ref);
    const v = validarVarias(unidas.slice(0, MAX_SEMANAS), ref);
    const sobran = unidas.length - v.borradores.length;
    const base = String(datos.mensaje || '').trim() || (v.completo ? 'El borrador está completo. Revisa las tablas.' : 'Revisa en las tablas lo que falta.');
    const mensaje = sobran > 0 ? `${base}\n\nSolo puedo manejar ${MAX_SEMANAS} semanas a la vez: quedaron por fuera las últimas ${sobran}. Guárdalas primero y envíame el resto.` : base;
    return res.status(200).json({ mensaje, modelo, escenario: ref.nombre, ...v });
  } catch (error) {
    if (/solicitudes_datos/.test(error.message) && /PGRST205|does not exist|Could not find/i.test(error.message)) {
      return res.status(503).json({ error: 'Falta crear la tabla de solicitudes en Supabase: ejecuta el archivo supabase/solicitudes.sql en el SQL Editor.' });
    }
    return errorHttp(res, error);
  }
}
