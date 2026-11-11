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

// Cabeceras de seguridad para las respuestas de la API (no se guardan en caché ni se interpretan como HTML).
export function cabecerasApi(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
