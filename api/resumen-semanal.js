// Resumen semanal por correo (función de servidor de Vercel: /api/resumen-semanal).
// La ejecuta Vercel Cron cada lunes (vercel.json) o un administrador desde la app («Enviar ahora»).
// Genera el briefing de la última semana con Claude y lo envía a cada usuario con recibir_resumen = true.
// Variables de entorno en Vercel: GEMINI_API_KEY (o ANTHROPIC_API_KEY), SUPABASE_SERVICE_ROLE_KEY (clave secreta), CRON_SECRET,
// SMTP_USER y SMTP_PASS (p. ej. Gmail + contraseña de aplicación); opcionales SMTP_HOST, SMTP_PORT, RESUMEN_ESCENARIO, APP_URL.
import { bearer, usuario, sbJson, sbFetch, contexto, generar, errorHttp, proveedorIA } from '../lib/copiloto.js';
import { crearTransporte, correoHtml, explicarFallo } from '../lib/correo.js';

export const config = { maxDuration: 60 };

// Vercel Cron envía «Authorization: Bearer <CRON_SECRET>»; desde la app, solo una cuenta admin.
async function autorizado(req) {
  const token = bearer(req);
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return 'cron';
  const user = await usuario(token);
  if (!user) return null;
  const perfil = await sbJson(`perfiles?select=rol&id=eq.${user.id}`, { token }).catch(() => []);
  return perfil[0]?.rol === 'admin' ? 'admin' : null;
}

export default async function handler(req, res) {
  const quien = await autorizado(req);
  if (!quien) return res.status(401).json({ error: 'No autorizado: solo la tarea programada o un administrador pueden enviar el resumen.' });

  const faltan = ['SUPABASE_SERVICE_ROLE_KEY', 'SMTP_USER', 'SMTP_PASS'].filter(k => !process.env[k]);
  if (!proveedorIA()) faltan.unshift('GEMINI_API_KEY');
  if (faltan.length) return res.status(503).json({ error: `Falta configurar en Vercel: ${faltan.join(', ')}.` });

  const servicio = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, token: process.env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    const destinatarios = (await sbJson('perfiles?select=email&recibir_resumen=eq.true&email=not.is.null', servicio)).map(p => p.email);
    if (!destinatarios.length) return res.status(200).json({ enviados: 0, mensaje: 'No hay usuarios suscritos al resumen semanal.' });

    const ctx = await contexto(process.env.RESUMEN_ESCENARIO || 'base', null, servicio);
    // effort 'low' para que la generación termine con holgura dentro del límite de 60 s de la función
    const { texto, modelo } = await generar({ modo: 'resumen', ctx, effort: 'low' });

    const { transporte, from } = crearTransporte();
    const asunto = `Briefing IA · semana ${ctx.semana} · Marketing Yango`;
    const html = correoHtml(texto, `Briefing semanal IA · semana ${ctx.semana} · escenario ${ctx.nombre}`);
    // un correo por persona: nadie ve las direcciones de los demás
    const resultados = await Promise.allSettled(destinatarios.map(to => transporte.sendMail({
      from, to, subject: asunto, text: texto, html,
    })));
    const fallidos = destinatarios.filter((_, i) => resultados[i].status === 'rejected');
    const enviados = destinatarios.length - fallidos.length;
    const motivo = fallidos.length ? resultados.find(r => r.status === 'rejected').reason : null;

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
      ...(motivo ? { error: `No se pudo enviar a ${fallidos.length} usuario(s). ${explicarFallo(motivo)}` } : {}),
    });
  } catch (error) {
    return errorHttp(res, error);
  }
}
