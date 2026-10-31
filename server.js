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
const pendientes = new Map();  // id -> consulta esperando respuesta de Christian
let contadorConsultas = 0;
const datosConfirmados = [];   // lo que Christian ya respondió (se reutiliza)
const MAX_DATOS = 40;

function obtenerSesion(tel) {
  let s = sesiones.get(tel);
  if (!s || Date.now() - s.actualizado > SESION_TTL_MS) {
    s = { historial: [], linea: null, origen: null, nombre: null, pendiente: null, actualizado: Date.now() };
    sesiones.set(tel, s);
  }
  s.actualizado = Date.now();
  return s;
}

// ---------- Detección de origen y línea ----------
function detectarOrigen(msg, texto) {
  if (msg.referral) return `anuncio_${msg.referral.source_type || 'meta'}`;
  const t = (texto || '').toLowerCase();
  if (/^hola proytech academy/.test(t)) return /celular/.test(t) ? 'web_academy_movil' : 'web_academy';
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
const ESTILO = `ESTILO OBLIGATORIO
- Escribes como la asistente comercial de ProyTech Automatización: profesional, cordial y directa. Trato de "usted" salvo que el cliente tutee.
- Máximo 3 o 4 líneas. Nada de párrafos largos, listas extensas ni relleno.
- UNA sola pregunta de perfilamiento por mensaje.
- Saluda solo en el primer mensaje de la conversación. Máximo un emoji y solo si aporta.
- Suena natural y humana. NUNCA digas "un asesor/ingeniero/persona se comunicará", "voy a consultar", "derivo su caso" ni menciones procesos internos.
- Nunca inventes datos que no estén en el CONOCIMIENTO o en DATOS CONFIRMADOS.
- Si el cliente pregunta sinceramente si habla con un bot o una persona, no lo niegues: di con naturalidad que es el asistente virtual de ProyTech y que el equipo supervisa la atención, y continúa ayudando.`;

function bloqueDatosConfirmados() {
  if (!datosConfirmados.length) return '(ninguno todavía)';
  return datosConfirmados.map(d => `- [${d.fecha}] Ante "${d.consulta}" → Christian indicó: "${d.indicacion}"`).join('\n');
}

function construirPrompt(s) {
  return `${ESTILO}

CONOCIMIENTO
${CONOCIMIENTO}

DATOS CONFIRMADOS POR CHRISTIAN (son vigentes; úsalos para responder sin volver a consultar)
${bloqueDatosConfirmados()}

ESTADO DE LA CONVERSACIÓN
- Origen del contacto: ${s.origen || 'desconocido'}
- Línea detectada hasta ahora: ${s.linea || 'sin definir'}
- Consulta pendiente con Christian: ${s.pendiente ? 'sí (no vuelvas a consultar lo mismo; mantén al cliente atendido)' : 'no'}
Si la línea no está clara, pregunta amablemente si busca un servicio para su empresa o información del curso.
Si el mensaje claramente es personal (familia, amigos, temas no comerciales), usa linea "personal" y respuesta "".

CUÁNDO CONSULTAR A CHRISTIAN (consultar_admin=true)
- Te piden un dato que NO está en CONOCIMIENTO ni en DATOS CONFIRMADOS (precio total, fechas, descuentos, disponibilidad, cotización, plazos, condiciones especiales).
- El lead está listo para cerrar: quiere reservar/pagar, o en Servicios ya tienes rubro + necesidad.
- Queja, reclamo, urgencia de planta parada, o pide llamada/visita.
En ese caso: "respuesta" = mensaje breve y natural que mantenga la conversación (ej. "Con gusto, permítame un momento y le confirmo." o una pregunta de perfilamiento útil), SIN decir que consultarás a alguien. "pregunta_admin" = la pregunta concreta para Christian. "borrador" = tu mejor propuesta de respuesta final si puedes armarla, o "".

FORMATO DE SALIDA: ÚNICAMENTE un JSON válido, sin texto adicional:
{"linea":"servicios|academy|personal|indefinida","intencion":"frase corta","confianza":"alta|media|baja","consultar_admin":true|false,"pregunta_admin":"","borrador":"","nombre_cliente":"","resumen_lead":"","respuesta":"texto para el cliente"}`;
}

function extraerJSON(texto) {
  try { return JSON.parse(texto); } catch (_) {}
  const m = (texto || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// ---------- Claude vía OpenRouter ----------
async function llamarModelo(system, mensajes, maxTokens = 500) {
  const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0.3,
    messages: [{ role: 'system', content: system }, ...mensajes]
  }, {
    timeout: 25000,
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://proytechautomation.com',
      'X-Title': 'ProyTech WhatsApp Agent'
    }
  });
  return r.data.choices?.[0]?.message?.content || '';
}

async function consultarClaude(s) {
  const crudo = await llamarModelo(construirPrompt(s), s.historial);
  const out = extraerJSON(crudo);
  if (!out || typeof out.respuesta !== 'string') {
    console.error('Salida no JSON del modelo:', crudo);
    return { linea: 'indefinida', intencion: 'error_formato', confianza: 'baja', consultar_admin: false, respuesta: crudo.trim() };
  }
  return out;
}

// Redacta la respuesta final al cliente a partir de lo que indicó Christian
async function redactarConIndicacion(s, consulta, indicacion) {
  const system = `${ESTILO}

CONOCIMIENTO
${CONOCIMIENTO}

TAREA: Christian (gerente) te indicó qué responder al cliente. Redacta el siguiente mensaje para el cliente usando EXACTAMENTE los datos que él indicó (montos, fechas, condiciones), con tu estilo profesional y breve, continuando la conversación de forma natural. No digas que consultaste a nadie. Si conviene, cierra con UNA pregunta que avance la venta.
Pregunta pendiente: "${consulta}"
Indicación de Christian: "${indicacion}"
Devuelve SOLO el texto del mensaje, sin comillas ni explicaciones.`;
  const texto = await llamarModelo(system, s.historial, 400);
  return texto.trim().replace(/^"|"$/g, '');
}

// ---------- WhatsApp ----------
async function enviarWhatsApp(to, body) {
  try {
    await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
      { timeout: 15000, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    console.log(`Respuesta enviada exitosamente a ${to}: ${JSON.stringify(body)}`);
    return true;
  } catch (e) {
    console.error(`Error enviando a ${to}:`, JSON.stringify(e.response?.data || e.message));
    return false;
  }
}

async function consultarAdmin(tel, s, out, textoCliente) {
  const id = ++contadorConsultas;
  pendientes.set(id, { tel, consulta: out.pregunta_admin || out.intencion, borrador: out.borrador || '', creado: Date.now() });
  s.pendiente = id;
  const msg = `❓ *Consulta #${id}*\n` +
    `Cliente: +${tel}${s.nombre ? ' (' + s.nombre + ')' : ''} · ${s.linea || out.linea || '-'} · origen ${s.origen}\n` +
    `Dijo: "${textoCliente}"\n` +
    (out.resumen_lead ? `Perfil: ${out.resumen_lead}\n` : '') +
    `👉 ${out.pregunta_admin || out.intencion}\n` +
    (out.borrador ? `\nBorrador:\n"${out.borrador}"\n` : '') +
    `\nResponde:  *#${id} tu indicación*` + (out.borrador ? `   o   *#${id} ok*` : '');
  await enviarWhatsApp(ADMIN_PHONE, msg);
  console.log(JSON.stringify({ evento: 'consulta_admin', id, tel, pregunta: out.pregunta_admin }));
}

// Christian responde una consulta: "#12 el precio es ..." / "#12 ok"
async function procesarComandoAdmin(texto) {
  const t = texto.trim();
  if (/^\/pendientes$/i.test(t)) {
    const lista = [...pendientes.entries()].map(([id, p]) => `#${id} +${p.tel}: ${p.consulta}`).join('\n');
    await enviarWhatsApp(ADMIN_PHONE, lista || 'No hay consultas pendientes.');
    return true;
  }
  if (/^\/datos$/i.test(t)) {
    await enviarWhatsApp(ADMIN_PHONE, datosConfirmados.length ? bloqueDatosConfirmados().slice(0, 3500) : 'Aún no hay datos confirmados.');
    return true;
  }
  const m = t.match(/^#(\d+)\s+([\s\S]+)$/);
  if (!m) return false;
  const id = Number(m[1]); const indicacion = m[2].trim();
  const p = pendientes.get(id);
  if (!p) { await enviarWhatsApp(ADMIN_PHONE, `No encuentro la consulta #${id} (puede haberse reiniciado el servidor). Usa /pendientes.`); return true; }
  const s = obtenerSesion(p.tel);
  let final;
  if (/^ok$/i.test(indicacion) && p.borrador) final = p.borrador;
  else final = await redactarConIndicacion(s, p.consulta, indicacion);
  const ok = await enviarWhatsApp(p.tel, final);
  if (ok) {
    s.historial.push({ role: 'assistant', content: final });
    s.pendiente = null;
    pendientes.delete(id);
    if (!/^ok$/i.test(indicacion)) {
      datosConfirmados.push({ consulta: p.consulta, indicacion, fecha: new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) });
      if (datosConfirmados.length > MAX_DATOS) datosConfirmados.shift();
    }
    await enviarWhatsApp(ADMIN_PHONE, `✅ #${id} enviado a +${p.tel}:\n"${final}"`);
  } else {
    await enviarWhatsApp(ADMIN_PHONE, `⚠️ No se pudo enviar #${id} a +${p.tel}. Revisa los logs.`);
  }
  return true;
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

  // Comandos del administrador (#id respuesta, /pendientes, /datos, /reset)
  if (tel === ADMIN_PHONE) {
    if (texto.toLowerCase() === '/reset') {
      sesiones.delete(tel);
      await enviarWhatsApp(tel, '🔄 Sesión reiniciada (modo prueba).');
      return;
    }
    if (/^(#\d+\s|\/pendientes|\/datos)/i.test(texto)) {
      try { await procesarComandoAdmin(texto); } catch (e) { console.error('Error comando admin:', e.message); }
      return;
    }
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
    await consultarAdmin(tel, s, { linea: s.linea, intencion: 'error_ia', pregunta_admin: 'La IA falló; ¿qué le respondo?' }, texto);
    return;
  }

  if (out.linea && ['servicios', 'academy'].includes(out.linea)) s.linea = out.linea;
  if (out.nombre_cliente && !s.nombre) s.nombre = out.nombre_cliente;

  console.log(JSON.stringify({ evento: 'clasificacion', tel, origen: s.origen, linea: out.linea, intencion: out.intencion, confianza: out.confianza, consultar_admin: !!out.consultar_admin }));

  if (out.linea === 'personal') {
    console.log(`Chat personal de ${tel}; el bot no responde.`);
    return;
  }

  if (out.respuesta) {
    s.historial.push({ role: 'assistant', content: out.respuesta });
    await enviarWhatsApp(tel, out.respuesta);
  }

  if (out.consultar_admin && !s.pendiente) await consultarAdmin(tel, s, out, texto);
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
