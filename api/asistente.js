// Asistente IA del Copiloto de Marketing (función de servidor de Vercel: POST /api/asistente).
// 1) Verifica la sesión de Supabase del usuario.  2) Recupera con su token los datos del escenario
// (las reglas RLS siguen aplicando) y calcula las métricas.  3) La IA (Gemini o Claude) responde usando solo esos datos.
// Variable de entorno en Vercel: GEMINI_API_KEY (plan gratuito) o ANTHROPIC_API_KEY.
import { bearer, usuario, sbFetch, contexto, generar, errorHttp, proveedorIA } from '../lib/copiloto.js';

export const config = { maxDuration: 60 };

const MAX_POR_HORA = 40;  // límite de consultas a la IA por usuario y hora (controla el costo)

async function consultasUltimaHora(user, token) {
  const desde = new Date(Date.now() - 3600e3).toISOString();
  const r = await sbFetch(`/rest/v1/log_ia?select=id&user_id=eq.${user.id}&created_at=gte.${encodeURIComponent(desde)}`, { token, headers: { Prefer: 'count=exact', Range: '0-0' } });
  return Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  if (!proveedorIA()) return res.status(503).json({ error: 'El asistente IA no está configurado (falta GEMINI_API_KEY o ANTHROPIC_API_KEY en Vercel).' });

  const token = bearer(req);
  const user = await usuario(token);
  if (!user) return res.status(401).json({ error: 'Inicia sesión para usar el asistente.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const modo = body.modo === 'resumen' ? 'resumen' : 'pregunta';
  const pregunta = String(body.pregunta || '').trim().slice(0, 1000);
  if (modo === 'pregunta' && !pregunta) return res.status(400).json({ error: 'Escribe una pregunta.' });

  try {
    if (await consultasUltimaHora(user, token) >= MAX_POR_HORA) {
      return res.status(429).json({ error: `Llegaste al límite de ${MAX_POR_HORA} consultas por hora. Intenta más tarde.` });
    }
    const ctx = await contexto(String(body.escenario || 'base').slice(0, 40), body.semana, { token });
    const r = await generar({ modo, pregunta, historial: body.historial, ctx });
    return res.status(200).json({ ...r, semana: ctx.semana, escenario: ctx.nombre });
  } catch (error) {
    return errorHttp(res, error);
  }
}
