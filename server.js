// ProyTech Bot v2 — Fase 1
// WhatsApp Cloud API + Claude (OpenRouter) + Render
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const CONOCIMIENTO = require('./conocimiento');
const db = require('./db');

// ---------- Configuración (variables de entorno en Render) ----------
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1397037896829310';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'proytech_secure_verify_token';
const APP_SECRET = process.env.APP_SECRET || '';            // opcional: valida firma de Meta
const ADMIN_PHONE = process.env.ADMIN_PHONE || '51993186475'; // recibe alertas de derivación
const MODEL = process.env.MODEL || 'anthropic/claude-haiku-4.5';
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v25.0'}`;
const CRON_SECRET = process.env.CRON_SECRET || '';
const TEMPLATE_D3 = process.env.TEMPLATE_D3 || '';   // plantilla aprobada para recordatorio día 3
const TEMPLATE_D7 = process.env.TEMPLATE_D7 || '';   // plantilla aprobada para recordatorio día 7
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || 'es';
const HORA = 36e5, DIA = 24 * HORA;
const PAUSA_HORAS = Number(process.env.PAUSA_HORAS || 12); // horas que el bot calla cuando tú respondes
const INBOX_KEY = process.env.INBOX_KEY || process.env.CRON_SECRET || '';
const ETAPAS_ACTIVAS = ['perfilando', 'interesado', 'pensando', 'objecion', 'listo'];

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ---------- Memoria por número (en RAM; se pierde al reiniciar) ----------
const SESION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // la sesión se recuerda 7 días (mientras el servidor no reinicie)
const SEGUIMIENTO_HORAS = Number(process.env.SEGUIMIENTO_HORAS || 20); // < 24 h: dentro de la ventana gratuita de WhatsApp
const MAX_HISTORIAL = 12;
const sesiones = new Map();
const procesados = new Set(); // evita responder dos veces si Meta reintenta
const pendientes = new Map();  // id -> consulta esperando respuesta de Christian
let contadorConsultas = 0;
const datosConfirmados = [];   // lo que Christian ya respondió (se reutiliza)
const MAX_DATOS = 40;

function sesionNueva(tel) {
  return { tel, historial: [], linea: null, origen: null, nombre: null, resumen: null, pendiente: null, etapa: 'nuevo',
    ultimoCliente: Date.now(), proximoSeguimiento: null, pausadoHasta: null, seguimientos: 0, llamadaSugerida: false, actualizado: Date.now(), nueva: true };
}

async function obtenerSesion(tel) {
  let s = sesiones.get(tel);
  if (s && Date.now() - s.actualizado < SESION_TTL_MS) { s.actualizado = Date.now(); return s; }
  s = sesionNueva(tel);
  const lead = await db.cargarLead(tel);
  if (lead) {
    Object.assign(s, {
      nombre: lead.nombre, linea: lead.linea, origen: lead.origen, etapa: lead.etapa || 'nuevo', resumen: lead.resumen,
      pendiente: lead.pendiente, llamadaSugerida: lead.llamada_sugerida, seguimientos: lead.seguimientos || 0,
      ultimoCliente: lead.ultimo_cliente ? Date.parse(lead.ultimo_cliente) : Date.now(),
      proximoSeguimiento: lead.proximo_seguimiento ? Date.parse(lead.proximo_seguimiento) : null,
      pausadoHasta: lead.pausado_hasta ? Date.parse(lead.pausado_hasta) : null, nueva: false
    });
    s.historial = await db.cargarMensajes(tel, MAX_HISTORIAL);
  }
  sesiones.set(tel, s);
  return s;
}

async function guardarSesion(s) {
  s.nueva = false;
  await db.guardarLead(s);
}

async function enviarYRegistrar(s, textoOriginal) {
  const texto = formatearParaCliente(textoOriginal);
  const ok = await enviarWhatsApp(s.tel, texto);
  if (ok) {
    s.historial.push({ role: 'assistant', content: texto });
    if (s.historial.length > MAX_HISTORIAL) s.historial = s.historial.slice(-MAX_HISTORIAL);
    await db.guardarMensaje(s.tel, 'assistant', texto);
  }
  return ok;
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
- FORMATO WHATSAPP: no uses asteriscos, negritas, almohadillas ni Markdown. Si enumeras 2 a 4 puntos, usa viñetas "• " (una por línea, frases cortas). Para todo lo demás, texto corrido.
- Saluda solo en el primer mensaje de la conversación. Máximo un emoji y solo si aporta.
- Suena natural y humana. NUNCA digas "un asesor/ingeniero/persona se comunicará", "voy a consultar", "derivo su caso" ni menciones procesos internos.
- Nunca inventes datos que no estén en el CONOCIMIENTO o en DATOS CONFIRMADOS.
AGENDA (visitas, reuniones, llamadas, visitas técnicas a planta)
- Tú NO tienes acceso a la agenda: nunca confirmes, agendes ni des por hecho una fecha u hora.
- Pregunta qué día y hora le acomodan, dile que lo verificas y consulta a Christian (consultar_admin=true).
- Mientras Christian no haya confirmado, usa frases como "lo estoy verificando y le confirmo apenas tenga la disponibilidad". Nunca prometas plazos ("en los próximos minutos") ni digas "le confirmo la visita para…".
- Si el cliente insiste, responde con cortesía que aún lo estás verificando, sin repetir la fecha como confirmada.
- Ofrece "coordinar una visita" como siguiente paso, nunca como algo ya agendado.
ESTRATEGIA COMERCIAL (venta consultiva, persuasión ética)
- Entiende primero la necesidad (situación → problema → impacto) y conecta el curso/servicio con su objetivo concreto (empleo, ascenso, reducir paradas, seguridad de la planta).
- Destaca valor real, nunca inventado: práctica en equipos reales, máximo 2 alumnos por estación, certificado, soporte post-curso; en servicios: experiencia en normativas y marcas indicadas.
- Objeciones: reconoce primero ("Entiendo"), luego responde con valor o una alternativa (pago en partes, separación con S/ 200). Precio: no te disculpes; compara con el beneficio.
- Usa compromisos pequeños: ofrece el siguiente paso concreto (separar con S/ 200, proponer coordinar una visita, enviar ficha).
- Urgencia y escasez SOLO si son reales y están en CONOCIMIENTO o DATOS CONFIRMADOS. Nunca inventes cupos, testimonios ni promociones.
- Si dice "lo voy a pensar": valida, pregunta qué duda le queda y ofrece resolverla. No presiones más de una vez por mensaje.
- Si dice claramente que no le interesa: agradece con cordialidad, deja la puerta abierta y no insistas.
- Si el cliente pregunta sinceramente si habla con un bot o una persona, no lo niegues: di con naturalidad que es el asistente virtual de ProyTech y que el equipo supervisa la atención, y continúa ayudando.`;

function bloqueDatosConfirmados() {
  if (!datosConfirmados.length) return '(ninguno todavía)';
  return datosConfirmados.map(d => `- [${d.fecha}] Ante "${d.consulta}" → Christian indicó: "${d.indicacion}"`).join('\n');
}

function saludoSegunHora() {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Lima', hour: 'numeric', hour12: false })) % 24;
  const hora = new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' });
  const saludo = h >= 5 && h < 12 ? 'Buenos días' : h >= 12 && h < 19 ? 'Buenas tardes' : 'Buenas noches';
  return { hora, saludo };
}

function construirPrompt(s) {
  const { hora, saludo } = saludoSegunHora();
  return `${ESTILO}

CONOCIMIENTO
${CONOCIMIENTO}

DATOS CONFIRMADOS POR CHRISTIAN (son vigentes; úsalos para responder sin volver a consultar)
${bloqueDatosConfirmados()}

ESTADO DE LA CONVERSACIÓN
- Hora actual en Lima: ${hora}. Si es el primer mensaje de la conversación (o el cliente saluda de nuevo tras mucho tiempo), empieza con "${saludo}" seguido del nombre del cliente si lo conoces. Nunca uses otro saludo de horario distinto.
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
{"linea":"servicios|academy|personal|indefinida","intencion":"frase corta","confianza":"alta|media|baja","etapa":"nuevo|perfilando|interesado|pensando|objecion|listo|ganado|perdido","consultar_admin":true|false,"pregunta_admin":"","borrador":"","sugerir_llamada":true|false,"motivo_llamada":"","nombre_cliente":"","resumen_lead":"","respuesta":"texto para el cliente"}
- Si un cliente que estuvo interesado (pidió precio/fechas o quiso reservar) ahora rechaza o se enfría por precio u otra objeción: cierra con cordialidad y marca sugerir_llamada=true (Christian intentará el último empujón).
- sugerir_llamada=true si una llamada de Christian aumentaría claramente la probabilidad de cierre (duda compleja, objeción que se repite, cliente corporativo, proyecto grande, cliente indeciso pero muy interesado).`;
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
  const crudo = '{' + await llamarModelo(construirPrompt(s), [...s.historial, { role: 'assistant', content: '{' }]);
  const out = extraerJSON(crudo);
  if (!out || typeof out.respuesta !== 'string') {
    console.error('Salida no JSON del modelo:', crudo);
    const limpio = crudo.replace(/^\{\s*/, '').trim();
    return { linea: 'indefinida', intencion: 'error_formato', confianza: 'baja', consultar_admin: false, respuesta: limpio };
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
Mantén el mismo trato (usted o tú) que venías usando con el cliente, aunque la indicación de Christian esté escrita de otra forma.
Devuelve SOLO el texto del mensaje, sin comillas ni explicaciones.`;
  const mensajes = [...s.historial, { role: 'user', content: '[Instrucción interna, no visible al cliente] Redacta ahora el mensaje final para el cliente según la indicación de Christian.' }];
  let texto = (await llamarModelo(system, mensajes, 400)).trim().replace(/^"|"$/g, '');
  if (!texto) texto = (await llamarModelo(system, mensajes, 400)).trim().replace(/^"|"$/g, '');
  return texto;
}

// Limpia Markdown para que el cliente vea un texto profesional en WhatsApp
function formatearParaCliente(t) {
  return String(t || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')          // **negrita** -> texto
    .replace(/(^|\s)\*(\S[^*\n]*?\S|\S)\*(?=\s|[.,;:!?)]|$)/g, '$1$2') // *negrita* -> texto
    .replace(/__(.+?)__/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')          // # títulos
    .replace(/^\s*[-*+]\s+/gm, '• ')             // - lista -> •
    .replace(/^\s*\d+[.)]\s+(?=\S)/gm, m => m) // listas numeradas se mantienen
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  const consulta = out.pregunta_admin || out.intencion;
  const fila = await db.crearConsulta({ tel, consulta, borrador: out.borrador || '' });
  const id = fila?.id || ++contadorConsultas;
  pendientes.set(id, { tel, consulta, borrador: out.borrador || '', creado: Date.now() });
  s.pendiente = id;
  await guardarSesion(s);
  const msg = `❓ *Consulta #${id}*\n` +
    `Cliente: +${tel}${s.nombre ? ' (' + s.nombre + ')' : ''} · ${s.linea || out.linea || '-'} · origen ${s.origen}\n` +
    `Dijo: "${textoCliente}"\n` +
    (out.resumen_lead ? `Perfil: ${out.resumen_lead}\n` : '') +
    `👉 ${consulta}\n` +
    (out.borrador ? `\nBorrador:\n"${out.borrador}"\n` : '') +
    `\nResponde:  *#${id} tu indicación*` + (out.borrador ? `   o   *#${id} ok*` : '');
  await enviarWhatsApp(ADMIN_PHONE, msg);
  console.log(JSON.stringify({ evento: 'consulta_admin', id, tel, pregunta: consulta }));
}

// Christian responde él mismo (texto literal) y el bot se pausa en ese chat
async function responderManual(tel, texto, avisar) {
  const s = await obtenerSesion(tel);
  if (s.nueva) await guardarSesion(s);
  const ok = await enviarYRegistrar(s, texto);
  if (ok) { s.pausadoHasta = Date.now() + PAUSA_HORAS * HORA; await guardarSesion(s); }
  if (avisar) await enviarWhatsApp(ADMIN_PHONE, ok ? `✅ Enviado a +${tel}. Bot en pausa ${PAUSA_HORAS} h en ese chat (reactiva con /bot ${tel}).` : `⚠️ No se pudo enviar a +${tel}.`);
  return ok;
}

// Mensaje enviado por Christian desde la app (coexistencia): se guarda y el bot se pausa en ese chat
async function registrarEcoManual(eco) {
  const tel = eco.to;
  const texto = eco.text?.body || (eco.type ? `[${eco.type} enviado desde la app]` : '');
  if (!tel || !texto) return;
  const s = await obtenerSesion(tel);
  if (s.nueva) await guardarSesion(s);
  s.historial.push({ role: 'assistant', content: texto });
  if (s.historial.length > MAX_HISTORIAL) s.historial = s.historial.slice(-MAX_HISTORIAL);
  await db.guardarMensaje(tel, 'assistant', texto);
  s.pausadoHasta = Date.now() + PAUSA_HORAS * HORA;
  await guardarSesion(s);
  console.log(JSON.stringify({ evento: 'eco_app', tel, pausa_h: PAUSA_HORAS }));
}

// Christian responde una consulta: "#12 el precio es ..." / "#12 ok"
async function procesarComandoAdmin(texto) {
  const t = texto.trim();
  if (/^\/pendientes$/i.test(t)) {
    const filas = db.activo ? await db.consultasAbiertas() : [...pendientes.entries()].map(([id, p]) => ({ id, tel: p.tel, consulta: p.consulta }));
    await enviarWhatsApp(ADMIN_PHONE, filas.map(p => `#${p.id} +${p.tel}: ${p.consulta}`).join('\n') || 'No hay consultas pendientes.');
    return true;
  }
  if (/^\/borrardatos$/i.test(t)) {
    datosConfirmados.length = 0; await db.borrarDatos();
    await enviarWhatsApp(ADMIN_PHONE, '🧹 Datos confirmados borrados.');
    return true;
  }
  if (/^\/leads$/i.test(t)) {
    const filas = db.activo ? await db.listarLeads()
      : [...sesiones.values()].map(v => ({ tel: v.tel, nombre: v.nombre, linea: v.linea, etapa: v.etapa, origen: v.origen, seguimientos: v.seguimientos }));
    const lista = filas.filter(l => l.tel !== ADMIN_PHONE).map(l => `+${l.tel} ${l.nombre || ''} · ${l.linea || '-'} · ${l.etapa} · ${l.origen || ''} · seg ${l.seguimientos || 0}`).join('\n');
    await enviarWhatsApp(ADMIN_PHONE, lista || 'Sin leads registrados.');
    return true;
  }
  if (/^\/datos$/i.test(t)) {
    await enviarWhatsApp(ADMIN_PHONE, datosConfirmados.length ? bloqueDatosConfirmados().slice(0, 3500) : 'Aún no hay datos confirmados.');
    return true;
  }
  const mr = t.match(/^\/r\s+\+?(\d{8,15})\s+([\s\S]+)$/i);
  if (mr) { await responderManual(mr[1], mr[2].trim(), true); return true; }
  const mb = t.match(/^\/bot\s+\+?(\d{8,15})$/i);
  if (mb) {
    const sx = await obtenerSesion(mb[1]); sx.pausadoHasta = null; await guardarSesion(sx);
    await enviarWhatsApp(ADMIN_PHONE, `🤖 Bot reactivado para +${mb[1]}.`); return true;
  }
  const m = t.match(/^#(\d+)\s+([\s\S]+)$/);
  if (!m) return false;
  const id = Number(m[1]); const indicacion = m[2].trim();
  let p = pendientes.get(id);
  if (!p) { const f = await db.cargarConsulta(id); if (f) p = { tel: f.tel, consulta: f.consulta, borrador: f.borrador }; }
  if (!p) { await enviarWhatsApp(ADMIN_PHONE, `No encuentro la consulta #${id} abierta. Usa /pendientes.`); return true; }
  const s = await obtenerSesion(p.tel);
  const esOk = /^ok$/i.test(indicacion);
  let final = esOk && p.borrador ? p.borrador : await redactarConIndicacion(s, p.consulta, indicacion);
  if (!final) { await enviarWhatsApp(ADMIN_PHONE, `⚠️ No pude redactar #${id}. Reintenta con otra indicación o escribe: #${id} ok`); return true; }
  if (await enviarYRegistrar(s, final)) {
    s.pendiente = null; pendientes.delete(id); await db.cerrarConsulta(id);
    s.proximoSeguimiento = Date.now() + SEGUIMIENTO_HORAS * HORA;
    await guardarSesion(s);
    if (!esOk) {
      const d = { consulta: p.consulta, indicacion, fecha: new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) };
      datosConfirmados.push(d); if (datosConfirmados.length > MAX_DATOS) datosConfirmados.shift();
      await db.guardarDato({ consulta: d.consulta, indicacion: d.indicacion });
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
  const s = await obtenerSesion(tel);
  if (!s.nombre && contacto?.profile?.name) s.nombre = contacto.profile.name;

  // Mensajes que no son texto (audio, imagen, documento...)
  if (msg.type !== 'text') {
    const t = msg.type === 'interactive' ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title)
      : msg.type === 'button' ? msg.button?.text : null; // botones de respuesta rápida de plantillas
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
      sesiones.delete(tel); await db.borrarLead(tel);
      await enviarWhatsApp(tel, '🔄 Sesión reiniciada (modo prueba).');
      return;
    }
    if (/^(#\d+\s|\/pendientes|\/datos|\/borrardatos|\/leads|\/r\s|\/bot\s)/i.test(texto)) {
      try { await procesarComandoAdmin(texto); } catch (e) { console.error('Error comando admin:', e.message); }
      return;
    }
  }

  // Derecho de eliminación (Ley 29733): "ELIMINAR MIS DATOS"
  if (/^\s*eliminar\s+mis\s+datos\s*$/i.test(texto)) {
    await enviarWhatsApp(tel, 'Listo. Eliminamos su historial y sus datos de contacto de nuestros registros. Si en el futuro desea escribirnos, aquí estaremos.');
    sesiones.delete(tel); await db.borrarLead(tel);
    await enviarWhatsApp(ADMIN_PHONE, `🗑️ +${tel} solicitó ELIMINAR MIS DATOS. Su ficha e historial fueron borrados.`);
    console.log(JSON.stringify({ evento: 'eliminacion_datos', tel }));
    return;
  }

  if (!s.origen) s.origen = detectarOrigen(msg, texto);
  if (!s.linea) s.linea = detectarLinea(texto);

  console.log(`Mensaje recibido de ${tel}: "${texto}"`);
  s.ultimoCliente = Date.now(); s.seguimientos = 0;
  s.proximoSeguimiento = Date.now() + SEGUIMIENTO_HORAS * HORA;
  if (s.nueva) await guardarSesion(s);
  s.historial.push({ role: 'user', content: texto });
  if (s.historial.length > MAX_HISTORIAL) s.historial = s.historial.slice(-MAX_HISTORIAL);
  await db.guardarMensaje(tel, 'user', texto);

  if (s.pausadoHasta && Date.now() < s.pausadoHasta) {
    await guardarSesion(s);
    await enviarWhatsApp(ADMIN_PHONE, `💬 +${tel}${s.nombre ? ' (' + s.nombre + ')' : ''}: "${texto}"\n(bot en pausa — responde con /r ${tel} tu mensaje)`);
    return;
  }

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
    console.log(`Chat personal de ${tel}; el bot no responde ni guarda historial.`);
    sesiones.delete(tel); await db.borrarLead(tel);
    return;
  }

  if (out.respuesta) await enviarYRegistrar(s, out.respuesta);

  if (out.etapa) s.etapa = out.etapa;
  if (out.resumen_lead) s.resumen = out.resumen_lead;
  if (out.consultar_admin && !s.pendiente) await consultarAdmin(tel, s, out, texto);
  else if (out.consultar_admin && s.pendiente) {
    // consulta abierta: reenviar a Christian la nueva información del cliente
    await enviarWhatsApp(ADMIN_PHONE, `📝 *Actualización consulta #${s.pendiente}* (+${tel}${s.nombre ? ' ' + s.nombre : ''})\nCliente: "${texto}"\n${out.pregunta_admin ? '👉 ' + out.pregunta_admin + '\n' : ''}Responde: *#${s.pendiente} tu indicación*`);
  }
  if (out.sugerir_llamada && !s.llamadaSugerida) {
    s.llamadaSugerida = true;
    await enviarWhatsApp(ADMIN_PHONE, `📞 *Te sugiero llamar* a +${tel}${s.nombre ? ' (' + s.nombre + ')' : ''}\nMotivo: ${out.motivo_llamada || out.intencion}\nEtapa: ${s.etapa} · ${s.linea || ''}\nPerfil: ${out.resumen_lead || '-'}\nLlamar: tel:+${tel}`);
  }

  // Cliente que no quiere: se cierra y se borra el historial (queda solo la ficha mínima)
  if (s.etapa === 'perdido' && !s.pendiente) {
    s.historial = []; s.proximoSeguimiento = null;
    await db.borrarHistorial(tel);
    console.log(JSON.stringify({ evento: 'lead_cerrado', tel }));
  }
  if (s.etapa === 'ganado') s.proximoSeguimiento = null;
  await guardarSesion(s);
}

// ---------- Seguimiento automático ----------
// Paso 1 (~20 h): mensaje libre redactado por Claude (dentro de la ventana de 24 h, gratis).
// Paso 2 (día 3) y paso 3 (día 7): plantilla aprobada por Meta. Sin plantilla → te aviso para hacerlo a mano.
async function enviarPlantilla(tel, nombrePlantilla, nombreCliente) {
  try {
    await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to: tel, type: 'template',
      template: { name: nombrePlantilla, language: { code: TEMPLATE_LANG },
        components: [{ type: 'body', parameters: [{ type: 'text', text: (nombreCliente || '').split(' ')[0] || 'estimado(a)' }] }] }
    }, { timeout: 15000, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    console.log(`Plantilla ${nombrePlantilla} enviada a ${tel}`);
    return true;
  } catch (e) { console.error(`Error plantilla a ${tel}:`, JSON.stringify(e.response?.data || e.message)); return false; }
}

async function ejecutarSeguimientos() {
  const ahora = Date.now();
  let candidatos;
  if (db.activo) candidatos = await Promise.all((await db.leadsParaSeguimiento()).map(l => obtenerSesion(l.tel)));
  else candidatos = [...sesiones.values()].filter(s => ETAPAS_ACTIVAS.includes(s.etapa) && !s.pendiente && s.proximoSeguimiento && s.proximoSeguimiento <= ahora);
  const manuales = []; let enviados = 0;
  for (const s of candidatos) {
    if (s.tel === ADMIN_PHONE && !process.env.SEGUIMIENTO_ADMIN) continue;
    const horas = (ahora - s.ultimoCliente) / HORA;
    try {
      if (s.seguimientos === 0 && horas < 23.5) {
        const mensajes = [...s.historial, { role: 'user', content: '[Instrucción interna] El cliente no responde hace varias horas. Escribe UN mensaje breve de seguimiento, cálido y útil (resolver una duda, recordar el beneficio principal o proponer el siguiente paso). Sin presión y sin repetir lo ya dicho. Devuelve solo el texto.' }];
        const texto = (await llamarModelo(ESTILO + '\n\nCONOCIMIENTO\n' + CONOCIMIENTO + '\n\nDATOS CONFIRMADOS\n' + bloqueDatosConfirmados(), mensajes, 250)).trim();
        if (texto && await enviarYRegistrar(s, texto)) enviados++;
        s.seguimientos = 1; s.proximoSeguimiento = s.ultimoCliente + 3 * DIA;
      } else if (s.seguimientos <= 1) {
        if (TEMPLATE_D3 && await enviarPlantilla(s.tel, TEMPLATE_D3, s.nombre)) { enviados++; await db.guardarMensaje(s.tel, 'assistant', `[Plantilla ${TEMPLATE_D3}]`); }
        else manuales.push(`+${s.tel} ${s.nombre || ''} (${s.linea || '-'}, ${s.etapa}) — recordatorio día 3`);
        s.seguimientos = 2; s.proximoSeguimiento = s.ultimoCliente + 7 * DIA;
      } else if (s.seguimientos === 2) {
        if (TEMPLATE_D7 && await enviarPlantilla(s.tel, TEMPLATE_D7, s.nombre)) { enviados++; await db.guardarMensaje(s.tel, 'assistant', `[Plantilla ${TEMPLATE_D7}]`); }
        else manuales.push(`+${s.tel} ${s.nombre || ''} (${s.linea || '-'}, ${s.etapa}) — último recordatorio día 7`);
        s.seguimientos = 3; s.proximoSeguimiento = null;
      } else { s.proximoSeguimiento = null; }
      await guardarSesion(s);
    } catch (e) { console.error('Error seguimiento', s.tel, e.message); }
  }
  if (manuales.length) await enviarWhatsApp(ADMIN_PHONE, `⏰ *Recordatorios para enviar a mano* (aún no hay plantilla aprobada):\n${manuales.join('\n')}`);
  console.log(JSON.stringify({ evento: 'seguimientos', revisados: candidatos.length, enviados, manuales: manuales.length }));
  return { revisados: candidatos.length, enviados, manuales: manuales.length };
}

async function enviarResumenDiario() {
  const leads = db.activo ? await db.listarLeads() : [...sesiones.values()];
  const activos = leads.filter(l => l.tel !== ADMIN_PHONE && ETAPAS_ACTIVAS.includes(l.etapa));
  const abiertas = db.activo ? await db.consultasAbiertas() : [...pendientes.keys()];
  const porEtapa = {}; activos.forEach(l => { porEtapa[l.etapa] = (porEtapa[l.etapa] || 0) + 1; });
  const txt = `📊 *Resumen ProyTech* (${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' })})\n` +
    `Leads activos: ${activos.length} — ${Object.entries(porEtapa).map(([k, v]) => `${k}: ${v}`).join(', ') || '-'}\n` +
    `Consultas sin responder: ${abiertas.length}${abiertas.length ? ' (usa /pendientes)' : ''}\n` +
    (activos.length ? `\nTop:\n${activos.slice(0, 8).map(l => `• +${l.tel} ${l.nombre || ''} · ${l.linea || '-'} · ${l.etapa}`).join('\n')}` : '');
  await enviarWhatsApp(ADMIN_PHONE, txt);
  return { activos: activos.length, consultas: abiertas.length };
}

setInterval(() => ejecutarSeguimientos().catch(e => console.error(e)), 30 * 60 * 1000);

// ---------- Endpoints ----------
app.get('/', (_req, res) => res.send(`ProyTech Bot v3 activo · BD ${db.activo ? 'conectada' : 'en RAM'}`));

require('./bandeja')(app, { db, sesiones, obtenerSesion, guardarSesion, responderManual, INBOX_KEY, PAUSA_HORAS });

function cronAutorizado(req) { return CRON_SECRET && req.query.key === CRON_SECRET; }
app.get('/cron/seguimientos', async (req, res) => {
  if (!cronAutorizado(req)) return res.sendStatus(403);
  res.json(await ejecutarSeguimientos());
});
app.get('/cron/resumen', async (req, res) => {
  if (!cronAutorizado(req)) return res.sendStatus(403);
  res.json(await enviarResumenDiario());
});

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
      // Coexistencia: Christian respondió desde la app WhatsApp Business del celular
      if (change.field === 'smb_message_echoes') {
        for (const eco of value.message_echoes || []) registrarEcoManual(eco).catch(e => console.error('Error eco:', e.message));
        continue;
      }
      if (change.field && change.field !== 'messages') continue; // history / smb_app_state_sync: se ignoran
      const contactos = value.contacts || [];
      for (const msg of value.messages || []) {
        const contacto = contactos.find(c => c.wa_id === msg.from) || contactos[0];
        procesarMensaje(msg, contacto).catch(e => console.error('Error procesando mensaje:', e));
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`ProyTech Bot v3 corriendo en el puerto ${PORT} · BD ${db.activo ? 'Supabase' : 'RAM'}`);
  const datos = await db.cargarDatos();
  datos.forEach(d => datosConfirmados.push({ consulta: d.consulta, indicacion: d.indicacion, fecha: new Date(d.creado).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) }));
  if (datos.length) console.log(`Datos confirmados cargados: ${datos.length}`);
});
