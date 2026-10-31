// ProyTech Bot v2 — Fase 1
// WhatsApp Cloud API + Claude (OpenRouter) + Render
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const CONOCIMIENTO = require('./conocimiento');

// ---------- Configuración (variables de entorno en Render) ----------
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1397037896829310';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'proytech_secure_verify_token';
const APP_SECRET = process.env.APP_SECRET || '';            // opcional: valida firma de Meta
const ADMIN_PHONE = process.env.ADMIN_PHONE || '51993186475'; // recibe alertas de derivación
const MODEL = process.env.MODEL || 'anthropic/claude-haiku-4.5';
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v25.0'}`;

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ---------- Memoria por número (en RAM; se pierde al reiniciar) ----------
const SESION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORIAL = 12;
const sesiones = new Map();
const procesados = new Set(); // evita responder dos veces si Meta reintenta

function obtenerSesion(tel) {
  let s = sesiones.get(tel);
  if (!s || Date.now() - s.actualizado > SESION_TTL_MS) {
    s = { historial: [], linea: null, origen: null, nombre: null, derivado: false, actualizado: Date.now() };
    sesiones.set(tel, s);
  }
  s.actualizado = Date.now();
  return s;
}

// ---------- Detección de origen y línea ----------
function detectarOrigen(msg, texto) {
  if (msg.referral) return `anuncio_${msg.referral.source_type || 'meta'}`;
  const t = (texto || '').toLowerCase();
  if (/vengo de la (web|p[aá]gina)|desde la web|proytechautomation/.test(t)) return 'web';
  if (/facebook|fb\b/.test(t)) return 'facebook';
  if (/instagram|\big\b/.test(t)) return 'instagram';
  if (/tiktok/.test(t)) return 'tiktok';
  if (/linkedin/.test(t)) return 'linkedin';
  return 'directo';
}

function detectarLinea(texto) {
  const t = (texto || '').toLowerCase();
  if (/academy|curso|capacitaci|clases|aprender|certificado|alumno|inscrib|matr[ií]cul/.test(t)) return 'academy';
  if (/servicio|proyecto|tablero|migraci|retrofit|planta|m[aá]quina|cotiz|falla|seguridad|variador|robot/.test(t)) return 'servicios';
  return null;
}

// ---------- Prompt ----------
function construirPrompt(s) {
  return `Eres el asistente de WhatsApp de ProyTech Automatización. Respondes como un asesor técnico-comercial senior.

ESTILO OBLIGATORIO
- Español profesional, cordial y directo. Trato de "usted" salvo que el cliente tutee.
- Máximo 3 o 4 líneas. Nada de párrafos largos, listas extensas ni relleno.
- Haz UNA sola pregunta de perfilamiento por mensaje.
- Saluda solo en el primer mensaje de la conversación. Firma "— ProyTech" solo en el primer mensaje.
- Máximo un emoji y solo si aporta. Nunca inventes datos que no estén en el CONOCIMIENTO.

CONOCIMIENTO
${CONOCIMIENTO}

ESTADO DE LA CONVERSACIÓN
- Origen del contacto: ${s.origen || 'desconocido'}
- Línea detectada hasta ahora: ${s.linea || 'sin definir'}
- Ya derivado a ingeniero: ${s.derivado ? 'sí' : 'no'}
Si la línea no está clara, pregunta amablemente si busca un servicio para su empresa o información de cursos.
Si el mensaje claramente no es comercial (conversación personal), usa linea "personal", respuesta vacía "".

FORMATO DE SALIDA: responde ÚNICAMENTE con un JSON válido, sin texto adicional:
{"linea":"servicios|academy|personal|indefinida","intencion":"frase corta","confianza":"alta|media|baja","derivar":true|false,"motivo_derivacion":"","nombre_cliente":"","resumen_lead":"","respuesta":"texto para el cliente"}
- confianza "alta": la respuesta está cubierta por el CONOCIMIENTO. "media": parcialmente. "baja": no está cubierta (en ese caso responde con cautela y di que un asesor confirmará).
- derivar true según las políticas del CONOCIMIENTO, o si hay queja, urgencia de planta parada, o pide llamada/visita.
- Si derivar es true, en "respuesta" indica que un ingeniero/asesor de ProyTech lo contactará a la brevedad.`;
}

function extraerJSON(texto) {
  try { return JSON.parse(texto); } catch (_) {}
  const m = (texto || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// ---------- Claude vía OpenRouter ----------
async function consultarClaude(s) {
  const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: MODEL,
    max_tokens: 500,
    temperature: 0.3,
    messages: [{ role: 'system', content: construirPrompt(s) }, ...s.historial]
  }, {
    timeout: 25000,
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://proytechautomation.com',
      'X-Title': 'ProyTech WhatsApp Agent'
    }
  });
  const crudo = r.data.choices?.[0]?.message?.content || '';
  const out = extraerJSON(crudo);
  if (!out || typeof out.respuesta !== 'string') {
    console.error('Salida no JSON del modelo:', crudo);
    return { linea: 'indefinida', intencion: 'error_formato', confianza: 'baja', derivar: false, respuesta: crudo.trim() };
  }
  return out;
}

// ---------- WhatsApp ----------
async function enviarWhatsApp(to, body) {
  try {
    await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
      { timeout: 15000, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    console.log(`Respuesta enviada exitosamente a ${to}`);
    return true;
  } catch (e) {
    console.error(`Error enviando a ${to}:`, JSON.stringify(e.response?.data || e.message));
    return false;
  }
}

async function avisarAdmin(tel, s, out, textoCliente) {
  if (!ADMIN_PHONE) return;
  const ficha = `🔔 *Lead para atender*\n` +
    `Cliente: +${tel}${s.nombre ? ' (' + s.nombre + ')' : ''}\n` +
    `Línea: ${out.linea} | Origen: ${s.origen}\n` +
    `Motivo: ${out.motivo_derivacion || out.intencion}\n` +
    `Confianza bot: ${out.confianza}\n` +
    `Resumen: ${out.resumen_lead || '-'}\n` +
    `Último mensaje: "${textoCliente}"\n` +
    `Responder: https://wa.me/${tel}`;
  await enviarWhatsApp(ADMIN_PHONE, ficha);
}

// ---------- Firma de Meta (si APP_SECRET está configurado) ----------
function firmaValida(req) {
  if (!APP_SECRET) return true;
  const firma = req.get('x-hub-signature-256') || '';
  const esperada = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
  return firma.length === esperada.length && crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
}

// ---------- Procesamiento de un mensaje ----------
async function procesarMensaje(msg, contacto) {
  if (procesados.has(msg.id)) return;
  procesados.add(msg.id);
  if (procesados.size > 2000) procesados.delete(procesados.values().next().value);

  const tel = msg.from;
  const s = obtenerSesion(tel);
  if (!s.nombre && contacto?.profile?.name) s.nombre = contacto.profile.name;

  // Mensajes que no son texto (audio, imagen, documento...)
  if (msg.type !== 'text') {
    const t = msg.type === 'interactive' ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title) : null;
    if (!t) {
      await enviarWhatsApp(tel, 'Gracias, recibimos su archivo. Para atenderle mejor, ¿podría indicarnos en un mensaje de texto qué necesita?');
      console.log(JSON.stringify({ evento: 'no_texto', tel, tipo: msg.type }));
      return;
    }
    msg.text = { body: t };
  }

  const texto = (msg.text?.body || '').trim();
  if (!texto) return;

  // Comandos de prueba (solo administrador)
  if (tel === ADMIN_PHONE && texto.toLowerCase() === '/reset') {
    sesiones.delete(tel);
    await enviarWhatsApp(tel, '🔄 Sesión reiniciada (modo prueba).');
    return;
  }

  if (!s.origen) s.origen = detectarOrigen(msg, texto);
  if (!s.linea) s.linea = detectarLinea(texto);

  console.log(`Mensaje recibido de ${tel}: "${texto}"`);
  s.historial.push({ role: 'user', content: texto });
  if (s.historial.length > MAX_HISTORIAL) s.historial = s.historial.slice(-MAX_HISTORIAL);

  let out;
  try {
    out = await consultarClaude(s);
  } catch (e) {
    console.error('Error OpenRouter:', JSON.stringify(e.response?.data || e.message));
    await enviarWhatsApp(tel, 'Disculpe, tenemos un inconveniente técnico momentáneo. Un asesor de ProyTech le responderá a la brevedad.');
    await avisarAdmin(tel, s, { linea: s.linea, intencion: 'error_ia', confianza: 'baja', motivo_derivacion: 'Falla de OpenRouter' }, texto);
    return;
  }

  if (out.linea && ['servicios', 'academy'].includes(out.linea)) s.linea = out.linea;
  if (out.nombre_cliente && !s.nombre) s.nombre = out.nombre_cliente;

  console.log(JSON.stringify({ evento: 'clasificacion', tel, origen: s.origen, linea: out.linea, intencion: out.intencion, confianza: out.confianza, derivar: !!out.derivar }));

  if (out.linea === 'personal' || !out.respuesta) {
    console.log(`Chat personal o sin respuesta para ${tel}; el bot no responde.`);
    return;
  }

  s.historial.push({ role: 'assistant', content: out.respuesta });
  await enviarWhatsApp(tel, out.respuesta);

  const debeAvisar = (out.derivar && !s.derivado) || out.confianza === 'baja';
  if (out.derivar) s.derivado = true;
  if (debeAvisar) await avisarAdmin(tel, s, out, texto);
}

// ---------- Endpoints ----------
app.get('/', (_req, res) => res.send('ProyTech Bot v2 activo'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(mode && token ? 403 : 400);
});

app.post('/webhook', (req, res) => {
  if (!firmaValida(req)) { console.warn('Firma inválida, solicitud rechazada'); return res.sendStatus(401); }
  res.sendStatus(200); // responder rápido a Meta; procesar después

  const entries = req.body?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactos = value.contacts || [];
      for (const msg of value.messages || []) {
        const contacto = contactos.find(c => c.wa_id === msg.from) || contactos[0];
        procesarMensaje(msg, contacto).catch(e => console.error('Error procesando mensaje:', e));
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProyTech Bot v2 corriendo en el puerto ${PORT}`));
