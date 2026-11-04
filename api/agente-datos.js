// Agente de datos (función de servidor de Vercel: POST /api/agente-datos).
// accion 'conversar': la IA pide al usuario los datos de una semana nueva (fecha y cifras por canal) y arma un borrador.
// accion 'guardar': un administrador guarda el borrador revisado en la tabla datos_crudos de Supabase.
// El servidor valida siempre el borrador con reglas fijas: la IA conversa, pero no decide qué datos son válidos.
// Variables de entorno en Vercel: GEMINI_API_KEY (o ANTHROPIC_API_KEY) y, para guardar, SUPABASE_SERVICE_ROLE_KEY.
import { bearer, usuario, sbJson, sbFetch, generarJSON, errorHttp, proveedorIA } from '../lib/copiloto.js';

export const config = { maxDuration: 60 };

const CAMPOS = ['inversion', 'impresiones', 'clics', 'conversiones', 'ingresos_atribuidos'];
const NOMBRE = { inversion: 'inversión (USD)', impresiones: 'impresiones', clics: 'clics', conversiones: 'conversiones', ingresos_atribuidos: 'ingresos atribuidos (USD)' };

const SYSTEM = `Eres el "Agente de datos" del Copiloto de Marketing IA de Yango. Tu trabajo es pedirle a la persona, de forma conversacional, los datos de UNA semana de campañas y armar con ellos un borrador que luego se agrega a la hoja datos_crudos.

Datos que necesitas:
- semana (número entero) y fecha_inicio (AAAA-MM-DD, el lunes de esa semana). En <contexto> tienes la semana y la fecha sugeridas (la siguiente a la última cargada); propónlas y pide confirmación.
- Para cada canal del escenario: inversion (USD), impresiones, clics, conversiones e ingresos_atribuidos (USD).

Cómo trabajar:
- Habla en español, cordial y breve. Pide los datos por canal, uno o dos canales a la vez; si la persona da todo junto, acéptalo.
- Interpreta números escritos de forma natural: "12 mil" = 12000, "1,2 millones" = 1200000, "$8.500" = 8500.
- Nunca inventes cifras. Si un dato no está claro, pregunta. Si un canal no tuvo campañas esa semana, la persona puede decirlo: entonces no lo incluyas.
- En <validacion> recibes los datos que faltan y los problemas del borrador actual: pregunta por ellos o pide confirmar las cifras raras.
- Cuando el borrador esté completo y sin problemas, muestra un resumen corto y pide a la persona que lo revise en la tabla y pulse «Guardar» o «Descargar Excel».

Responde SIEMPRE con un objeto JSON con esta forma exacta:
{"mensaje": "lo que le dices a la persona", "borrador": {"semana": 43, "fecha_inicio": "2026-10-26", "filas": [{"canal": "Google Ads", "inversion": 1000, "impresiones": 50000, "clics": 1200, "conversiones": 80, "ingresos_atribuidos": 3500}]}, "eliminar": []}
- "borrador" contiene SOLO lo que la persona dio o confirmó; deja fuera (o en null) lo que aún no sabes. Incluye las filas y campos que ya estaban en el borrador actual.
- "eliminar" lista los canales que la persona pidió quitar.`;

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
      if (r > 3 || r < 1 / 3) avisos.push(`${f.canal}: la inversión cambia mucho frente a la semana ${ref.ultimaSemana} (${Math.round(prev.inversion).toLocaleString('es-CO')} USD); confirma la cifra.`);
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
    ultima: new Map(ult.map(d => [d.canal.toLowerCase(), { inversion: +d.inversion }])),
  };
}

function historial(h) {
  const msgs = (Array.isArray(h) ? h : []).slice(-16)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
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
    const ref = await referencia(escenario, { token });

    if (body.accion === 'guardar') {
      const perfil = await sbJson(`perfiles?select=rol&id=eq.${user.id}`, { token }).catch(() => []);
      if (perfil[0]?.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede guardar datos en la base. Puedes descargar el Excel con tus datos.' });
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.' });
      const v = validar(unir({}, body.borrador || {}), ref);
      if (!v.completo) return res.status(400).json({ error: `El borrador no está listo: ${[...v.faltan.map(x => 'falta ' + x), ...v.errores].join('; ').replace(/\.$/, '')}.`, ...v });
      const filas = v.borrador.filas.map(f => ({ escenario: ref.id, semana: v.borrador.semana, fecha_inicio: v.borrador.fecha_inicio, canal: f.canal, ...Object.fromEntries(CAMPOS.map(k => [k, f[k]])) }));
      const servicio = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, token: process.env.SUPABASE_SERVICE_ROLE_KEY };
      // si la semana y el canal ya existen, se actualizan (clave única escenario + semana + canal)
      await sbFetch('/rest/v1/datos_crudos?on_conflict=escenario,semana,canal', {
        ...servicio, method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: filas,
      });
      await sbFetch('/rest/v1/log_ia', {
        token, method: 'POST', headers: { Prefer: 'return=minimal' },
        body: {
          tipo: 'pregunta', escenario: ref.id, semana: v.borrador.semana,
          pregunta: `Agente de datos · semana ${v.borrador.semana} guardada en datos_crudos`,
          respuesta: filas.map(f => `${f.canal}: inversión ${f.inversion}, impresiones ${f.impresiones}, clics ${f.clics}, conversiones ${f.conversiones}, ingresos ${f.ingresos_atribuidos}`).join('\n').slice(0, 5000),
          fuente: 'agente de datos · guardado por el administrador', revisado_por: String(user.email || '').slice(0, 120),
        },
      }).catch(() => { /* el registro no debe impedir informar el guardado */ });
      return res.status(200).json({ guardado: true, filas: filas.length, semana: v.borrador.semana, escenario: ref.nombre });
    }

    // validar: revisa el borrador editado a mano en la tabla, sin llamar a la IA
    if (body.accion === 'validar') return res.status(200).json({ escenario: ref.nombre, ...validar(unir({}, body.borrador || {}), ref) });

    // conversar
    if (!proveedorIA()) return res.status(503).json({ error: 'El agente necesita la IA configurada (GEMINI_API_KEY en Vercel).' });
    const anterior = validar(unir({}, body.borrador || {}), ref);
    const mensajes = historial(body.historial);
    const texto = String(body.mensaje || '').trim().slice(0, 2000) || 'Hola, quiero cargar los datos de una semana.';
    const contexto = [
      `Hoy es ${new Date().toISOString().slice(0, 10)}. Escenario: ${ref.nombre}.`,
      `Canales del escenario: ${ref.canales.join(', ') || 'ninguno todavía'}.`,
      `Última semana cargada: ${ref.ultimaSemana ?? 'ninguna'}${ref.fechaUltima ? ` (inicia ${ref.fechaUltima})` : ''}. Semana sugerida: ${ref.ultimaSemana != null ? ref.ultimaSemana + 1 : 'pregúntala'}${ref.sugerida ? `, fecha de inicio sugerida ${ref.sugerida}` : ''}.`,
    ].join('\n');
    const validacion = `Faltan: ${anterior.faltan.join('; ') || 'nada'}.\nProblemas: ${anterior.errores.join(' ') || 'ninguno'}.\nAvisos: ${anterior.avisos.join(' ') || 'ninguno'}.`;
    const { datos, modelo } = await generarJSON({
      system: SYSTEM,
      messages: [...mensajes, { role: 'user', content: `<contexto>\n${contexto}\n</contexto>\n<borrador_actual>\n${JSON.stringify(anterior.borrador)}\n</borrador_actual>\n<validacion>\n${validacion}\n</validacion>\n\n${texto}` }],
    });
    const v = validar(unir(anterior.borrador, datos.borrador || {}, datos.eliminar), ref);
    const mensaje = String(datos.mensaje || '').trim() || (v.completo ? 'El borrador está completo. Revísalo en la tabla.' : `Me falta: ${v.faltan.join(', ')}.`);
    return res.status(200).json({ mensaje, modelo, escenario: ref.nombre, ...v });
  } catch (error) {
    return errorHttp(res, error);
  }
}
