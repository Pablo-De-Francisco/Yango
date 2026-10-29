// Envío de correos (Gmail u otro SMTP) compartido por api/resumen-semanal.js y api/enviar-correo.js.
// Variables de entorno en Vercel: SMTP_USER y SMTP_PASS (contraseña de aplicación de Gmail); opcionales SMTP_HOST, SMTP_PORT, APP_URL.
import nodemailer from 'nodemailer';
import { textoAHtml } from './copiloto.js';

export const APP_URL = process.env.APP_URL || 'https://yango-seven.vercel.app/';
export const correoConfigurado = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);

export function crearTransporte() {
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER.trim();
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port, secure: port === 465,
    // Google muestra la contraseña de aplicación con espacios («abcd efgh ijkl mnop»): se quitan
    auth: { user, pass: process.env.SMTP_PASS.replace(/\s+/g, '') },
    connectionTimeout: 10e3, greetingTimeout: 10e3,
  });
  return { transporte, from: `"Copiloto de Marketing IA" <${user}>` };
}

export function correoHtml(texto, subtitulo, pie = 'Para dejar de recibir este correo, desactiva «Resumen semanal por correo» en la app.') {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1d1d1f;font-size:15px;line-height:1.5">
  <div style="background:#ff0000;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
    <div style="font-size:22px;font-weight:900;font-style:italic">YANGO</div>
    <div style="font-size:14px">${subtitulo}</div>
  </div>
  <div style="border:1px solid #e4e4e7;border-top:0;padding:8px 20px 16px;border-radius:0 0 8px 8px">
    ${textoAHtml(texto)}
    <p style="margin-top:20px;padding:10px 14px;background:#fff6e0;color:#8a5a00;border-radius:8px;font-size:13px">
      Resumen generado con IA a partir de datos simulados del prototipo. Revísalo antes de tomar decisiones.
    </p>
    <p style="font-size:13px;color:#6b6b70">Abre el <a href="${APP_URL}" style="color:#ff0000">Copiloto de Marketing</a> para hacer preguntas sobre estos datos.
    ${pie}</p>
  </div>
</div>`;
}

// Explicación legible de un fallo del servidor de correo (sin exponer la contraseña)
export function explicarFallo(motivo) {
  const detalle = [motivo.code, motivo.responseCode, motivo.response || motivo.message].filter(Boolean).join(' · ').slice(0, 220);
  const pista = /EAUTH|535|534|Username and Password|BadCredentials/i.test(detalle)
    ? 'Gmail rechazó el usuario o la contraseña: SMTP_PASS debe ser una contraseña de aplicación (16 letras), no la contraseña normal, y SMTP_USER el mismo Gmail donde la creaste.'
    : /ETIMEDOUT|ECONNECTION|ESOCKET|ENOTFOUND/i.test(detalle)
      ? 'No se pudo conectar con el servidor de correo.'
      : 'Revisa SMTP_USER y SMTP_PASS.';
  const user = (process.env.SMTP_USER || '').trim().replace(/^(.{3}).*(@.*)$/, '$1…$2');
  return `${pista} (SMTP_USER = ${user}; SMTP_PASS de ${(process.env.SMTP_PASS || '').replace(/\s+/g, '').length} caracteres, debe ser 16. Detalle: ${detalle})`;
}
