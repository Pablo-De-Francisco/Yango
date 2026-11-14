// Voz del Copiloto (función de servidor de Vercel: POST /api/voz).
// Convierte en audio el texto de una respuesta con la voz de Gemini (text-to-speech), con una voz distinta por módulo:
// asistente RAG, agente de datos y briefing semanal. Usa la misma GEMINI_API_KEY; responde un WAV.
// Variables opcionales: GEMINI_TTS_MODEL (modelo de voz) y VOZ_ASISTENTE / VOZ_AGENTE / VOZ_BRIEFING (nombre de la voz).
import { bearer, usuario, errorHttp } from '../lib/copiloto.js';
import { leerCuerpo, dentroDelLimite, cabecerasApi } from '../lib/seguridad.js';

export const config = { maxDuration: 60 };

const GEMINI_KEY = process.env.GEMINI_API_KEY || (/^AIza/.test(process.env.ANTHROPIC_API_KEY || '') ? process.env.ANTHROPIC_API_KEY : '');
const MAX_POR_HORA = 120;   // fragmentos de audio por usuario y hora (controla el costo)
const MAX_TEXTO = 700;      // el navegador divide los textos largos en fragmentos de este tamaño

// una voz y un estilo por módulo (voces prediseñadas de Gemini)
const VOCES = {
  asistente: { voz: process.env.VOZ_ASISTENTE || 'Kore', estilo: 'Lee en español latinoamericano, con voz clara, amable y segura, como una analista que explica un dato' },
  agente: { voz: process.env.VOZ_AGENTE || 'Puck', estilo: 'Lee en español latinoamericano, con tono cercano, ágil y práctico, como un compañero que ayuda a cargar datos' },
  briefing: { voz: process.env.VOZ_BRIEFING || 'Charon', estilo: 'Lee en español latinoamericano, con tono sereno y profesional, como un presentador de un resumen ejecutivo' },
};

// modelos de voz a probar en orden; si ninguno existe, se consulta la lista de modelos de la cuenta
const MODELOS = [...new Set([process.env.GEMINI_TTS_MODEL, 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts', 'gemini-2.5-pro-preview-tts'].filter(Boolean))];
let modeloOk = null;

async function modelosDeVoz() {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': GEMINI_KEY } });
  if (!r.ok) return [];
  const { models = [] } = await r.json();
  return models.filter(m => /tts/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
}

async function sintetizar(texto, { voz, estilo }) {
  const cuerpo = JSON.stringify({
    contents: [{ parts: [{ text: `${estilo}: ${texto}` }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voz } } } },
  });
  const pedir = model => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: cuerpo,
  });
  let candidatos = modeloOk ? [modeloOk] : MODELOS, buscado = false, ultimo = '';
  for (let i = 0; i < candidatos.length; i++) {
    const model = candidatos[i];
    const r = await pedir(model);
    if (r.status === 404 || r.status === 400 && /not (found|supported)/i.test(ultimo = await r.clone().text())) {
      if (i === candidatos.length - 1 && !buscado) { buscado = true; candidatos = [...candidatos, ...(await modelosDeVoz()).filter(m => !candidatos.includes(m))]; }
      continue;
    }
    if (!r.ok) {
      const t = await r.text();
      console.error('voz gemini', model, r.status, t.slice(0, 300));
      throw Object.assign(new Error(r.status === 429 ? 'La voz no está disponible por ahora (límite del proveedor). Intenta en un momento.' : 'No se pudo generar la voz.'), { status: r.status === 429 ? 429 : 502, publico: true });
    }
    const data = await r.json();
    const parte = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!parte) throw Object.assign(new Error('El proveedor no devolvió audio.'), { status: 502, publico: true });
    modeloOk = model;
    const tasa = Number((parte.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1]) || 24000;
    return wav(Buffer.from(parte.inlineData.data, 'base64'), tasa);
  }
  console.error('voz gemini: ningún modelo de voz disponible', ultimo.slice(0, 200));
  throw Object.assign(new Error('La voz no está disponible en esta cuenta de Gemini.'), { status: 503, publico: true });
}

// PCM de 16 bits mono -> archivo WAV
function wav(pcm, tasa) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(tasa, 24); h.writeUInt32LE(tasa * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// texto para leer: sin marcas de formato ni la línea de la fuente
const limpiar = t => String(t || '')
  .replace(/^\s*(fuente|source)\s*:.*$/gim, '')
  .replace(/[*_`]+/g, '')
  .replace(/[#>|]+/g, ' ')
  .replace(/^\s*[-•]\s+/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

export default async function handler(req, res) {
  cabecerasApi(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'La voz necesita la clave de Gemini configurada en el servidor.' });

  const user = await usuario(bearer(req));
  if (!user) return res.status(401).json({ error: 'Inicia sesión para escuchar las respuestas.' });

  try {
    const body = leerCuerpo(req, 16 * 1024);
    const perfil = VOCES[body.rol];
    if (!perfil) return res.status(400).json({ error: 'Módulo de voz no válido.' });
    const texto = limpiar(body.texto);
    if (!texto) return res.status(400).json({ error: 'No hay texto para leer.' });
    if (texto.length > MAX_TEXTO) return res.status(413).json({ error: `El fragmento supera ${MAX_TEXTO} caracteres.` });

    const permitido = await dentroDelLimite(user, 'voz', MAX_POR_HORA);
    if (permitido === false) return res.status(429).json({ error: `Llegaste al límite de ${MAX_POR_HORA} audios por hora. Intenta más tarde.` });

    const audio = await sintetizar(texto, perfil);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', audio.length);
    return res.status(200).send(audio);
  } catch (error) {
    if (error.publico) return res.status(error.status || 500).json({ error: error.message });
    return errorHttp(res, error);
  }
}
