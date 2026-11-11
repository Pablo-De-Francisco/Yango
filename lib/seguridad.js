// Utilidades de seguridad compartidas por las funciones de servidor (api/*.js).
import { timingSafeEqual } from 'node:crypto';
import { sbFetch } from './copiloto.js';

const MAX_CUERPO = 64 * 1024;  // 64 KB por defecto; el agente de datos pide más (historial y varias semanas)

// Lee el cuerpo JSON de forma segura: rechaza cuerpos demasiado grandes o que no son JSON.
export function leerCuerpo(req, max = MAX_CUERPO) {
  let crudo = req.body;
  if (crudo == null || crudo === '') return {};
  if (typeof crudo !== 'string') {
    if (typeof crudo === 'object') {
      if (Array.isArray(crudo)) return {};
      if (JSON.stringify(crudo).length > max) throw Object.assign(new Error('La solicitud es demasiado grande.'), { status: 413, publico: true });
      return crudo;
    }
    crudo = String(crudo);
  }
  if (crudo.length > max) throw Object.assign(new Error('La solicitud es demasiado grande.'), { status: 413, publico: true });
  try {
    const datos = JSON.parse(crudo);
    return datos && typeof datos === 'object' && !Array.isArray(datos) ? datos : {};
  } catch {
    throw Object.assign(new Error('La solicitud no tiene un formato válido.'), { status: 400, publico: true });
  }
}

// Validaciones de entrada que se usan para armar consultas a la base: solo pasan valores con el formato esperado.
export const ESCENARIO = /^[a-z0-9_]{1,40}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function escenarioValido(valor, porDefecto = 'base') {
  const e = String(valor ?? porDefecto).trim().toLowerCase();
  if (!ESCENARIO.test(e)) throw Object.assign(new Error('El escenario no es válido.'), { status: 400, publico: true });
  return e;
}
export function enteroValido(valor, { min = 1, max = 1e9, nombre = 'valor' } = {}) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`El ${nombre} no es válido.`), { status: 400, publico: true });
  return n;
}

// Comparación de secretos en tiempo constante (evita adivinarlos midiendo el tiempo de respuesta).
export function mismoSecreto(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Oculta un correo para los registros: «pa…@gmail.com».
export const ocultarCorreo = c => String(c || '').replace(/^(.{2})[^@]*(@.*)$/, '$1…$2');

const SERVICIO = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, token: process.env.SUPABASE_SERVICE_ROLE_KEY } : null;

// Rate limiting por usuario y función, con la tabla uso_api (solo el servidor la lee y escribe).
// Devuelve true si la persona todavía puede usar la función y registra el uso.
// Si la tabla no existe todavía (falta ejecutar supabase/seguridad.sql), no bloquea: devuelve null.
export async function dentroDelLimite(user, endpoint, maxPorHora) {
  if (!SERVICIO || !UUID.test(user.id)) return null;
  const desde = new Date(Date.now() - 3600e3).toISOString();
  try {
    const r = await sbFetch(`/rest/v1/uso_api?select=id&user_id=eq.${user.id}&endpoint=eq.${encodeURIComponent(endpoint)}&created_at=gte.${encodeURIComponent(desde)}`,
      { ...SERVICIO, headers: { Prefer: 'count=exact', Range: '0-0' } });
    const usados = Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
    if (usados >= maxPorHora) return false;
    await sbFetch('/rest/v1/uso_api', { ...SERVICIO, method: 'POST', headers: { Prefer: 'return=minimal' }, body: { user_id: user.id, endpoint } });
    if (Math.random() < 0.02) sbFetch('/rest/v1/rpc/limpiar_uso_api', { ...SERVICIO, method: 'POST', body: {} }).catch(() => {});
    return true;
  } catch (e) {
    if (/uso_api/.test(e.message) && /PGRST205|does not exist|Could not find/i.test(e.message)) return null;
    throw e;
  }
}

// ---------- CAPTCHA cada 5 consultas a la IA ----------
// Cuenta las consultas a la IA desde la última verificación aprobada; a la quinta pide un CAPTCHA nuevo,
// que se valida aquí con Cloudflare (TURNSTILE_SECRET en Vercel). Así un script con una sesión robada
// no puede usar la IA sin parar. Si falta la clave o la tabla uso_api, no bloquea.
export const CONSULTAS_POR_CAPTCHA = 5;
const ENDPOINTS_IA = ['asistente', 'agente-conversar'];

async function verificarConCloudflare(token, ip) {
  if (!token || String(token).length > 2048) return false;
  const datos = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET, response: String(token) });
  if (ip) datos.set('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: datos, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return j.success === true;
  } catch { return false; }
}

// Devuelve null si puede seguir; si no, la respuesta que hay que enviar (428 con captcha: true).
export async function exigirCaptcha(req, user, token) {
  if (!process.env.TURNSTILE_SECRET || !SERVICIO || !UUID.test(user.id)) return null;
  try {
    const ultima = await (await sbFetch(`/rest/v1/uso_api?select=created_at&user_id=eq.${user.id}&endpoint=eq.captcha&order=created_at.desc&limit=1`, SERVICIO)).json();
    const desde = ultima[0]?.created_at || new Date(Date.now() - 7 * 864e5).toISOString();
    const r = await sbFetch(`/rest/v1/uso_api?select=id&user_id=eq.${user.id}&endpoint=in.(${ENDPOINTS_IA.join(',')})&created_at=gt.${encodeURIComponent(desde)}`,
      { ...SERVICIO, headers: { Prefer: 'count=exact', Range: '0-0' } });
    const usadas = Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
    if (usadas < CONSULTAS_POR_CAPTCHA) return null;
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (!(await verificarConCloudflare(token, ip))) {
      return { status: 428, body: { captcha: true, error: `Por seguridad, después de ${CONSULTAS_POR_CAPTCHA} consultas a la IA hay que confirmar que no eres un robot.` } };
    }
    await sbFetch('/rest/v1/uso_api', { ...SERVICIO, method: 'POST', headers: { Prefer: 'return=minimal' }, body: { user_id: user.id, endpoint: 'captcha' } });
    return null;
  } catch (e) {
    if (/uso_api/.test(e.message) && /PGRST205|does not exist|Could not find/i.test(e.message)) return null;
    throw e;
  }
}

// Cabeceras de seguridad para las respuestas de la API (no se guardan en caché ni se interpretan como HTML).
export function cabecerasApi(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
