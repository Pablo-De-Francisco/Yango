// Envía el briefing que el usuario tiene en pantalla al correo que escriba (función de servidor de Vercel: POST /api/enviar-correo).
// Cualquier cuenta con sesión puede usarlo; el texto llega ya revisado/editado desde la pestaña Briefing.
// Variables de entorno en Vercel: SMTP_USER y SMTP_PASS (ver lib/correo.js).
import { bearer, usuario, sbFetch, errorHttp } from '../lib/copiloto.js';
import { correoConfigurado, crearTransporte, correoHtml, explicarFallo } from '../lib/correo.js';

const MAX_POR_HORA = 10;  // correos por usuario y hora (evita usar la app para enviar spam)
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;

async function enviosUltimaHora(user, token) {
  const desde = new Date(Date.now() - 3600e3).toISOString();
  const r = await sbFetch(`/rest/v1/log_ia?select=id&user_id=eq.${user.id}&pregunta=like.Correo*&created_at=gte.${encodeURIComponent(desde)}`, { token, headers: { Prefer: 'count=exact', Range: '0-0' } });
  return Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  const token = bearer(req);
  const user = await usuario(token);
  if (!user) return res.status(401).json({ error: 'Inicia sesión para enviar correos.' });
  if (!correoConfigurado()) return res.status(503).json({ error: 'El envío de correos no está configurado (faltan SMTP_USER y SMTP_PASS en Vercel).' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const para = String(body.para || '').trim().toLowerCase();
  const texto = String(body.texto || '').trim().slice(0, 20000);
  const asunto = String(body.asunto || 'Briefing IA · Marketing Yango').trim().slice(0, 150);
  if (!EMAIL.test(para)) return res.status(400).json({ error: 'Escribe un correo válido.' });
  if (!texto) return res.status(400).json({ error: 'No hay texto para enviar.' });

  try {
    if (await enviosUltimaHora(user, token) >= MAX_POR_HORA) {
      return res.status(429).json({ error: `Llegaste al límite de ${MAX_POR_HORA} correos por hora. Intenta más tarde.` });
    }
    const { transporte, from } = crearTransporte();
    try {
      await transporte.sendMail({
        from, to: para, replyTo: user.email, subject: asunto, text: texto,
        html: correoHtml(texto, `${asunto} · enviado por ${user.email}`, ''),
      });
    } catch (motivo) {
      return res.status(502).json({ error: `El servidor no pudo enviar el correo. ${explicarFallo(motivo)}` });
    }
    await sbFetch('/rest/v1/log_ia', {
      token, method: 'POST', headers: { Prefer: 'return=minimal' },
      body: {
        tipo: 'briefing', escenario: body.escenario ? String(body.escenario).slice(0, 40) : null, semana: Number(body.semana) || null,
        pregunta: `Correo · ${asunto}`, respuesta: texto.slice(0, 5000), fuente: 'envío por correo desde la app', revisado_por: `enviado a ${para}`.slice(0, 120),
      },
    }).catch(() => { /* el registro no debe impedir informar el envío */ });
    return res.status(200).json({ enviado: true, para });
  } catch (error) {
    return errorHttp(res, error);
  }
}
