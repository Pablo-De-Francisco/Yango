// Dictado por voz (función de servidor de Vercel: POST /api/escuchar).
// Recibe una grabación corta del micrófono (base64) y la transcribe con Gemini, para usarla como pregunta al asistente,
// como mensaje al agente de datos o como indicación para el briefing. Usa la misma GEMINI_API_KEY.
import { bearer, usuario, transcribir, errorHttp } from '../lib/copiloto.js';
import { leerCuerpo, dentroDelLimite, cabecerasApi } from '../lib/seguridad.js';

export const config = { maxDuration: 60 };

const MAX_POR_HORA = 60;                 // grabaciones por usuario y hora
const MAX_BASE64 = 1.4 * 1024 * 1024;    // ~1 MB de audio: más de un minuto en el formato del navegador
const TIPOS = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac'];

export default async function handler(req, res) {
  cabecerasApi(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });

  const user = await usuario(bearer(req));
  if (!user) return res.status(401).json({ error: 'Inicia sesión para dictar por voz.' });

  try {
    const body = leerCuerpo(req, 1.6 * 1024 * 1024);
    const mime = String(body.mime || '').split(';')[0].trim().toLowerCase();
    if (!TIPOS.includes(mime)) return res.status(400).json({ error: 'Formato de audio no admitido.' });
    const datos = String(body.audio || '');
    if (!datos || !/^[A-Za-z0-9+/=]+$/.test(datos)) return res.status(400).json({ error: 'No llegó el audio.' });
    if (datos.length > MAX_BASE64) return res.status(413).json({ error: 'La grabación es demasiado larga: máximo un minuto.' });

    const permitido = await dentroDelLimite(user, 'escuchar', MAX_POR_HORA);
    if (permitido === false) return res.status(429).json({ error: `Llegaste al límite de ${MAX_POR_HORA} grabaciones por hora. Intenta más tarde.` });

    const r = await transcribir({ mime, datos });
    return res.status(200).json({ texto: r.texto.slice(0, 8000), modelo: r.modelo });
  } catch (error) {
    return errorHttp(res, error);
  }
}
