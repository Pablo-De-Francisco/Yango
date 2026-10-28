// Resumen semanal por correo (función de servidor de Vercel: /api/resumen-semanal).
// La ejecuta Vercel Cron cada lunes (vercel.json) o un administrador desde la app («Enviar ahora»).
// Genera el briefing de la última semana con Claude y lo envía a cada usuario con recibir_resumen = true.
// Variables de entorno en Vercel: ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY (clave secreta), CRON_SECRET,
// SMTP_USER y SMTP_PASS (p. ej. Gmail + contraseña de aplicación); opcionales SMTP_HOST, SMTP_PORT, RESUMEN_ESCENARIO, APP_URL.
import nodemailer from 'nodemailer';
import { bearer, usuario, sbJson, sbFetch, contexto, generar, errorHttp, textoAHtml } from '../lib/copiloto.js';

export const config = { maxDuration: 60 };

const APP_URL = process.env.APP_URL || 'https://yango-seven.vercel.app/';

// Vercel Cron envía «Authorization: Bearer <CRON_SECRET>»; desde la app, solo una cuenta admin.
async function autorizado(req) {
  const token = bearer(req);
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return 'cron';
  const user = await usuario(token);
  if (!user) return null;
  const perfil = await sbJson(`perfiles?select=rol&id=eq.${user.id}`, { token }).catch(() => []);
  return perfil[0]?.rol === 'admin' ? 'admin' : null;
}

function correoHtml(texto, ctx) {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1d1d1f;font-size:15px;line-height:1.5">
  <div style="background:#ff0000;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
    <div style="font-size:22px;font-weight:900;font-style:italic">YANGO</div>
    <div style="font-size:14px">Briefing semanal IA · semana ${ctx.semana} · escenario ${ctx.nombre}</div>
  </div>
  <div style="border:1px solid #e4e4e7;border-top:0;padding:8px 20px 16px;border-radius:0 0 8px 8px">
    ${textoAHtml(texto)}
    <p style="margin-top:20px;padding:10px 14px;background:#fff6e0;color:#8a5a00;border-radius:8px;font-size:13px">
      Resumen generado automáticamente con IA a partir de datos simulados del prototipo. Revísalo antes de tomar decisiones.
    </p>
    <p style="font-size:13px;color:#6b6b70">Abre el <a href="${APP_URL}" style="color:#ff0000">Copiloto de Marketing</a> para hacer preguntas sobre estos datos.
    Para dejar de recibir este correo, desactiva «Resumen semanal por correo» en la app.</p>
  </div>
</div>`;
}

export default async function handler(req, res) {
  const quien = await autorizado(req);
  if (!quien) return res.status(401).json({ error: 'No autorizado: solo la tarea programada o un administrador pueden enviar el resumen.' });

  const faltan = ['ANTHROPIC_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SMTP_USER', 'SMTP_PASS'].filter(k => !process.env[k]);
  if (faltan.length) return res.status(503).json({ error: `Falta configurar en Vercel: ${faltan.join(', ')}.` });

  const servicio = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, token: process.env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    const destinatarios = (await sbJson('perfiles?select=email&recibir_resumen=eq.true&email=not.is.null', servicio)).map(p => p.email);
    if (!destinatarios.length) return res.status(200).json({ enviados: 0, mensaje: 'No hay usuarios suscritos al resumen semanal.' });

    const ctx = await contexto(process.env.RESUMEN_ESCENARIO || 'base', null, servicio);
    // effort 'low' para que la generación termine con holgura dentro del límite de 60 s de la función
    const { texto, modelo } = await generar({ modo: 'resumen', ctx, effort: 'low' });

    const transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const asunto = `Briefing IA · semana ${ctx.semana} · Marketing Yango`;
    const html = correoHtml(texto, ctx);
    // un correo por persona: nadie ve las direcciones de los demás
    const resultados = await Promise.allSettled(destinatarios.map(to => transporte.sendMail({
      from: `"Copiloto de Marketing IA" <${process.env.SMTP_USER}>`, to, subject: asunto, text: texto, html,
    })));
    const fallidos = destinatarios.filter((_, i) => resultados[i].status === 'rejected');
    const enviados = destinatarios.length - fallidos.length;

    await sbFetch('/rest/v1/log_ia', {
      ...servicio, method: 'POST', headers: { Prefer: 'return=minimal' },
      body: {
        tipo: 'briefing', escenario: process.env.RESUMEN_ESCENARIO || 'base', semana: ctx.semana,
        pregunta: `Resumen semanal por correo · semana ${ctx.semana}`, respuesta: texto.slice(0, 5000),
        fuente: `IA (${modelo}) · envío ${quien === 'cron' ? 'automático' : 'manual del administrador'}`,
        revisado_por: `enviado a ${enviados} de ${destinatarios.length} usuario(s)`,
      },
    }).catch(() => { /* el registro no debe impedir informar el envío */ });

    return res.status(fallidos.length && !enviados ? 502 : 200).json({
      enviados, total: destinatarios.length, semana: ctx.semana,
      ...(fallidos.length ? { error: `No se pudo enviar a ${fallidos.length} usuario(s). Revisa SMTP_USER y SMTP_PASS.` } : {}),
    });
  } catch (error) {
    return errorHttp(res, error);
  }
}
