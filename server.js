// ProyTech Bot v2 — Fase 1
// WhatsApp Cloud API + Claude (OpenRouter) + Render
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const CONOCIMIENTO = require('./conocimiento');
const db = require('./db');
const cal = require('./calendario');
const correo = require('./correo');

// ---------- Configuración (variables de entorno en Render) ----------
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1397037896829310';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'proytech_secure_verify_token';
const APP_SECRET = process.env.APP_SECRET || '';            // opcional: valida firma de Meta
const ADMIN_PHONE = process.env.ADMIN_PHONE || '51993186475'; // recibe alertas de derivación
const MODEL = process.env.MODEL || 'anthropic/claude-haiku-4.5';
const MODELOS_GRATIS = (process.env.MODELOS_GRATIS || 'google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free').split(',').map(x => x.trim()).filter(Boolean);
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v25.0'}`;
const CRON_SECRET = process.env.CRON_SECRET || '';
const TEMPLATE_D3 = process.env.TEMPLATE_D3 || 'seguimiento_dia3';   // plantilla para recordatorio día 3
const TEMPLATE_D7 = process.env.TEMPLATE_D7 || 'seguimiento_dia7';   // plantilla para recordatorio día 7
const TEMPLATE_RECORDATORIO = process.env.TEMPLATE_RECORDATORIO || 'recordatorio_cita';
const WABA_ID = process.env.WABA_ID || '2317633745718895';
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || 'es';
const HORA = 36e5, DIA = 24 * HORA;
const PAUSA_HORAS = Number(process.env.PAUSA_HORAS || 12); // horas que el bot calla cuando tú respondes
const INBOX_KEY = process.env.INBOX_KEY || process.env.CRON_SECRET || '';
const ETAPAS_ACTIVAS = ['perfilando', 'interesado', 'pensando', 'objecion', 'listo'];

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/archivos', express.static(require('path').join(__dirname, 'public'), { maxAge: '1h' }));
const URL_PUBLICA = process.env.RENDER_EXTERNAL_URL || 'https://proytech-bot.onrender.com';

// ---------- Memoria por número (en RAM; se pierde al reiniciar) ----------
const SESION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // la sesión se recuerda 7 días (mientras el servidor no reinicie)
const SEGUIMIENTO_HORAS = Number(process.env.SEGUIMIENTO_HORAS || 20);
const PRIMER_SEG_MIN = Number(process.env.PRIMER_SEG_MIN || 10); // 1er seguimiento: minutos sin respuesta
const VENTANA_SEG_H = Number(process.env.VENTANA_SEG_H || 20);    // seguimientos libres solo dentro de estas horas
// Días de las plantillas tras el último mensaje del cliente: Academy decide rápido (grupo con fecha), Servicios B2B más lento
const DIAS_PLANTILLA = { academy: [2, 5], servicios: [3, 7] }; // < 24 h: dentro de la ventana gratuita de WhatsApp
const MAX_HISTORIAL = 12;
const sesiones = new Map();
const procesados = new Set(); // evita responder dos veces si Meta reintenta
const pendientes = new Map();  // id -> consulta esperando respuesta de Christian
let contadorConsultas = 0;
const mensajeAConsulta = new Map(); // id del mensaje de WhatsApp enviado a Christian -> nº de consulta
const datosConfirmados = [];   // lo que Christian ya respondió (se reutiliza)
const MAX_DATOS = 40;
const DATOS_DIAS = Number(process.env.DATOS_DIAS || 45);   // un dato confirmado caduca a los N días
const ejemplos = [];                                        // biblioteca de estilo de Christian
const MAX_EJEMPLOS = 80;

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
- Máximo 3 o 4 líneas. Nada de párrafos largos ni relleno. Excepción: cuando piden información del curso o el temario, entrega el detalle técnico completo en viñetas (ver CONOCIMIENTO, punto 0).
- UNA sola pregunta de perfilamiento por mensaje.
- FORMATO WHATSAPP: no uses asteriscos, negritas, almohadillas ni Markdown. Si enumeras 2 a 4 puntos, usa viñetas "• " (una por línea, frases cortas). Para todo lo demás, texto corrido.
- Saluda solo en el primer mensaje de la conversación. Máximo un emoji y solo si aporta.
- Suena natural y humana. NUNCA digas "un asesor/persona se comunicará", "voy a consultar", "derivo su caso" ni menciones procesos internos. Única excepción: al ofrecer la LLAMADA PERSONAL sí puedes decir "uno de nuestros ingenieros le llamará". Nunca des nombres del equipo.
- Nunca inventes datos que no estén en el CONOCIMIENTO o en DATOS CONFIRMADOS.
AGENDA (visitas, reuniones, llamadas, visitas técnicas a planta)
- Tú NO tienes acceso a la agenda: nunca confirmes, agendes ni des por hecho una fecha u hora.
- Pregunta qué día y hora le acomodan, dile que lo verificas y consulta a Christian (consultar_admin=true).
- Mientras Christian no haya confirmado, usa frases como "lo estoy verificando y le confirmo apenas tenga la disponibilidad". Nunca prometas plazos ("en los próximos minutos") ni digas "le confirmo la visita para…".
- Si el cliente insiste, responde con cortesía que aún lo estás verificando, sin repetir la fecha como confirmada.
- Ofrece "coordinar una visita" como siguiente paso, nunca como algo ya agendado.
ESTRATEGIA COMERCIAL (venta consultiva, persuasión ética)
- Cultura peruana: al cliente le da confianza el trato cercano, que le insistan con amabilidad y que lo llamen. Usa su nombre, sé cálida y muestra interés genuino en su caso.
- LLAMADA O VISITA (como servicio, no como oferta): cuando el cliente muestre interés, dudas o diga que lo va a pensar, ofrécele UNA vez opciones para conocer más, en este orden: "Si gusta, podemos darle más detalles del curso por una llamada de WhatsApp con uno de nuestros ingenieros, o puede visitarnos en el laboratorio de Surquillo. Y si ya le interesa, puede separar su vacante con S/ 200, con la garantía de que si el curso no inicia se le reembolsa." Adapta a Servicios: detalles por llamada con uno de nuestros ingenieros o una visita técnica sin compromiso. No pidas su número (la llamada es por este chat) ni des nombres del equipo.
- Si el cliente ACEPTA la llamada o da un horario: consultar_admin=true y pregunta_admin="📞 Acepta llamada por WhatsApp — horario: …". En la respuesta agradece y di que le confirmas la hora en un momento. Nunca confirmes tú la hora.
- Entiende primero la necesidad (situación → problema → impacto) y conecta el curso/servicio con su objetivo concreto (empleo, ascenso, reducir paradas, seguridad de la planta).
- Destaca valor real, nunca inventado: práctica en equipos reales, máximo 2 alumnos por estación, certificado, soporte post-curso; en servicios: experiencia en normativas y marcas indicadas.
- Objeciones: reconoce primero ("Entiendo"), luego responde con valor o una alternativa (pago en partes, separación con S/ 200). Precio: no te disculpes; compara con el beneficio.
- Usa compromisos pequeños: ofrece el siguiente paso concreto (separar con S/ 200, proponer coordinar una visita, enviar ficha).
- Urgencia y escasez SOLO si son reales y están en CONOCIMIENTO o DATOS CONFIRMADOS. Nunca inventes cupos, testimonios ni promociones.
- Si dice "lo voy a pensar": valida, pregunta qué duda le queda y ofrece resolverla. No presiones más de una vez por mensaje.
- Si dice claramente que no le interesa: agradece con cordialidad, deja la puerta abierta y no insistas.
- Si el cliente pregunta sinceramente si habla con un bot o una persona, no lo niegues: di con naturalidad que es el asistente virtual de ProyTech y que el equipo supervisa la atención, y continúa ayudando.`;

function hoyLima() {
  return new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function bloqueDatosConfirmados() {
  const limite = Date.now() - DATOS_DIAS * DIA;
  const vigentes = datosConfirmados.filter(d => !d.ts || d.ts >= limite);
  if (!vigentes.length) return '(ninguno todavía)';
  return vigentes.map(d => `- [registrado el ${d.fecha}] Ante "${d.consulta}" → Christian indicó: "${d.indicacion}"`).join('\n');
}

function saludoSegunHora() {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Lima', hour: 'numeric', hour12: false })) % 24;
  const hora = new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' });
  const saludo = h >= 5 && h < 12 ? 'Buenos días' : h >= 12 && h < 19 ? 'Buenas tardes' : 'Buenas noches';
  return { hora, saludo };
}

function construirPrompt(s) {
  const { hora, saludo } = saludoSegunHora();
  const hoy = hoyLima();
  return `${ESTILO}

CONOCIMIENTO
${CONOCIMIENTO}

Si la línea no está clara, pregunta amablemente si busca un servicio para su empresa o información del curso.
Usa linea "personal" y respuesta "" SOLO si es el primer contacto y claramente es familia o amigos de Christian (saludos personales, temas familiares). Nunca uses "personal" si ya hay una conversación comercial.
PREGUNTAS CONFIDENCIALES O FUERA DE TEMA de un cliente (cuánto costó el laboratorio o los equipos, márgenes, ganancias, proveedores, sueldos, cuántos alumnos/clientes hay, datos de otros clientes): NO es "personal". Responde con cortesía y naturalidad que es información interna de la empresa, sin incomodar, y redirige en la misma respuesta al valor para el cliente (qué incluye, qué ganará, siguiente paso). Mantén la línea de la conversación (academy o servicios). Ejemplo: "Esa es información interna de la empresa, pero lo que sí le puedo contar es que el laboratorio tiene equipos Siemens reales y practicará con ellos desde la primera clase. ¿Le separo su vacante?"

CUÁNDO CONSULTAR A CHRISTIAN (consultar_admin=true)
- Te piden un dato que NO está en CONOCIMIENTO ni en DATOS CONFIRMADOS (precio total, fechas, descuentos, disponibilidad, cotización, plazos, condiciones especiales).
- El lead está listo para cerrar: quiere reservar/pagar, o en Servicios ya tienes rubro + necesidad.
- Queja, reclamo, urgencia de planta parada, o pide llamada/visita.
En ese caso: "respuesta" = mensaje breve y natural que mantenga la conversación (ej. "Con gusto, permítame un momento y le confirmo." o una pregunta de perfilamiento útil), SIN decir que consultarás a alguien. "pregunta_admin" = la pregunta concreta para Christian. "borrador" = tu mejor propuesta de respuesta final si puedes armarla, o "".

FORMATO DE SALIDA: ÚNICAMENTE un JSON válido, sin texto adicional:
{"linea":"servicios|academy|personal|indefinida","intencion":"frase corta","confianza":"alta|media|baja","etapa":"nuevo|perfilando|interesado|pensando|objecion|listo|ganado|perdido","consultar_admin":true|false,"pregunta_admin":"","borrador":"","sugerir_llamada":true|false,"motivo_llamada":"","pedir_video":true|false,"enviar_temario":true|false,"enviar_brochure":true|false,"motivo_video":"","nombre_cliente":"","resumen_lead":"","respuesta":"texto para el cliente"}
- Si un cliente que estuvo interesado (pidió precio/fechas o quiso reservar) ahora rechaza o se enfría por precio u otra objeción: cierra con cordialidad y marca sugerir_llamada=true (Christian intentará el último empujón).
- sugerir_llamada=true si una llamada de Christian aumentaría claramente la probabilidad de cierre (duda compleja, objeción que se repite, cliente corporativo, proyecto grande, cliente indeciso pero muy interesado).
- pedir_video=true (solo ACADEMY, una vez por cliente) si ver el laboratorio ayudaría a cerrar: duda de la calidad, los equipos o el lugar; no puede venir a la visita; pide fotos o videos; o está "pensando" tras conocer el precio. En la respuesta al cliente di con naturalidad que en un momento le compartes un video corto del laboratorio. motivo_video = por qué le ayudaría (máx. 1 línea).

<<DINAMICO>>
FECHA DE HOY (Lima): ${hoy}

EJEMPLOS REALES DE CÓMO RESPONDE CHRISTIAN (imita su tono, longitud y estructura; NO copies precios ni fechas de aquí, esos datos solo valen si están en DATOS CONFIRMADOS y vigentes)
${bloqueEjemplos(s)}

DATOS CONFIRMADOS POR CHRISTIAN
Antes de usar un dato, compáralo con la FECHA DE HOY:
- Si menciona una fecha de inicio, grupo, visita o promoción que YA PASÓ o es de hoy y ya no es posible, NO la ofrezcas: consultar_admin=true para pedir la fecha actualizada.
- Si el dato no tiene fecha (por ejemplo, un precio), úsalo; si fue registrado hace mucho y el cliente está por cerrar, confírmalo con Christian.
${bloqueDatosConfirmados()}

ESTADO DE LA CONVERSACIÓN
- Hora actual en Lima: ${hora}. Si es el primer mensaje de la conversación (o el cliente saluda de nuevo tras mucho tiempo), empieza con "${saludo}" seguido del nombre del cliente si lo conoces. Nunca uses otro saludo de horario distinto.
- Origen del contacto: ${s.origen || 'desconocido'}
- Línea detectada hasta ahora: ${s.linea || 'sin definir'}
- Consulta pendiente con Christian: ${s.pendiente ? 'sí (no vuelvas a consultar lo mismo; mantén al cliente atendido)' : 'no'}
`;
}

function extraerJSON(texto) {
  try { return JSON.parse(texto); } catch (_) {}
  const m = (texto || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// ---------- Claude vía OpenRouter ----------
let avisoSaldo = 0, avisoSaldoBajo = 0;
const SALDO_MINIMO = Number(process.env.SALDO_MINIMO || 1); // US$
// Saldo de OpenRouter (prepago): créditos comprados − usados
async function saldoIA() {
  try {
    const r = await axios.get('https://openrouter.ai/api/v1/credits', { timeout: 10000, headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` } });
    const d = r.data?.data || {};
    return { ok: true, saldo: Math.round(((d.total_credits || 0) - (d.total_usage || 0)) * 100) / 100, usado: Math.round((d.total_usage || 0) * 100) / 100 };
  } catch (e) { return { ok: false, error: e.response?.status || e.message }; }
}
async function revisarSaldoIA() {
  const r = await saldoIA();
  if (r.ok && r.saldo < SALDO_MINIMO && Date.now() - avisoSaldoBajo > 24 * HORA) {
    avisoSaldoBajo = Date.now();
    await enviarWhatsApp(ADMIN_PHONE, `🔋 *Saldo de IA bajo*: te quedan US$ ${r.saldo.toFixed(2)} en OpenRouter.\nRecarga en https://openrouter.ai/settings/credits para que el bot siga respondiendo con la IA principal.`);
  }
  return r;
}
// opts.interna=true → primero modelos gratis (correo, revisión semanal); clientes → Haiku y, si falla, respaldo gratis
async function llamarModelo(system, mensajes, maxTokens = 500, intento = 1, opts = {}) {
  if (opts.interna && intento === 1) {
    try { const t = await llamarModeloUnaVez(system, mensajes, maxTokens, MODELOS_GRATIS); if (t) return t; } catch (e) { console.error('Modelo gratis falló, uso Haiku:', e.response?.status || e.message); }
  }
  try { return await llamarModeloUnaVez(system, mensajes, maxTokens); }
  catch (e) {
    const st = e.response?.status;
    if ((st === 402 || st === 429 || st >= 500) && intento < 3) { await new Promise(r => setTimeout(r, 6000 * intento)); return llamarModelo(system, mensajes, maxTokens, intento + 1, opts); }
    if (!opts.sinRespaldo && MODELOS_GRATIS.length) {
      try { const t = await llamarModeloUnaVez(system, mensajes, maxTokens, MODELOS_GRATIS); if (t) { console.log(JSON.stringify({ evento: 'respaldo_gratis', motivo: st || e.message })); return t; } }
      catch (e2) { console.error('Respaldo gratis también falló:', e2.response?.status || e2.message); }
    }
    if (st === 402 && Date.now() - avisoSaldo > 6 * HORA) {
      avisoSaldo = Date.now();
      enviarWhatsApp(ADMIN_PHONE, '⚠️ *Saldo de IA agotado* (OpenRouter). El bot no puede redactar respuestas hasta recargar créditos en https://openrouter.ai/settings/credits').catch(() => {});
    }
    throw e;
  }
}
async function llamarModeloUnaVez(system, mensajes, maxTokens, modelos = null) {
  const gratis = Array.isArray(modelos);
  let sys = system.replace('<<DINAMICO>>\n', '');
  // Caché de prompt (Anthropic): la parte estática (estilo + conocimiento + reglas) se cobra ~10 % al repetirse
  if (!gratis && system.includes('<<DINAMICO>>')) {
    const [fijo, variable] = system.split('<<DINAMICO>>');
    sys = [{ type: 'text', text: fijo, cache_control: { type: 'ephemeral' } }, { type: 'text', text: variable }];
  }
  const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    ...(gratis ? { models: modelos } : { model: MODEL }),
    max_tokens: maxTokens,
    temperature: 0.3,
    usage: { include: true },
    messages: [{ role: 'system', content: sys }, ...mensajes]
  }, {
    timeout: 25000,
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://proytechautomation.com',
      'X-Title': 'ProyTech WhatsApp Agent'
    }
  });
  const u = r.data.usage || {};
  console.log(JSON.stringify({ evento: 'uso_ia', modelo: r.data.model, entrada: u.prompt_tokens, cache: u.prompt_tokens_details?.cached_tokens || 0, salida: u.completion_tokens, costo_usd: u.cost ?? null }));
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

EJEMPLOS DE ESTILO DE CHRISTIAN
${bloqueEjemplos(s)}

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
const esTelefono = id => /^\d{6,16}$/.test(String(id || ''));
const destino = id => (esTelefono(id) ? { to: id } : { recipient: id });

async function enviarDocumento(to, link, filename, caption) {
  try {
    await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', ...destino(to), type: 'document', document: { link, filename, caption } },
      { timeout: 15000, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    console.log(`Documento ${filename} enviado a ${to}`);
    return true;
  } catch (e) { console.error(`Error documento a ${to}:`, JSON.stringify(e.response?.data || e.message)); return false; }
}

async function enviarWhatsApp(to, body) {
  if (!to) { console.error('enviarWhatsApp sin destinatario'); return false; }
  try {
    const r = await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', ...destino(to), type: 'text', text: { body } },
      { timeout: 15000, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    console.log(`Respuesta enviada exitosamente a ${to}: ${JSON.stringify(body)}`);
    return r.data?.messages?.[0]?.id || true;
  } catch (e) {
    console.error(`Error enviando a ${to}:`, JSON.stringify(e.response?.data || e.message));
    return false;
  }
}

const AYUDA_ADMIN = 'Comandos:\n• /status — resumen del negocio\n• /saldo — saldo de la IA\n• /ultimoscupos [fecha] — campaña últimos cupos (vista previa)\n• /agenda [días] — eventos agendados\n• /vencimientos — plazos próximos 30 días\n• /correo [horas] — revisar correo ahora\n• /libres — horarios disponibles\n• /agendar 51XXXXXXXXX AAAA-MM-DD HH:MM [min] título\n• /pendientes · /leads · /datos\n• /r 51XXXXXXXXX texto · /bot 51XXXXXXXXX';

// Revisa el correo de la empresa y convierte compromisos con fecha en plazos del calendario
async function revisarCorreos(horas = 3) {
  if (!correo.activo || !cal.activo || !db.activo) return { revisados: 0, plazos: 0 };
  const lista = await correo.correosDesde(new Date(Date.now() - horas * HORA));
  let plazos = 0; const avisos = [];
  for (const m of lista) {
    if (await db.plazoProcesado(m.id)) continue;
    const enviado = /sent|enviad/i.test(m.buzon);
    const system = `Hoy es ${hoyLima()} (Lima). Eres el asistente del gerente de ProyTech Automatización (ingeniería y automatización industrial, Lima). Lee el correo y extrae SOLO plazos o compromisos con fecha concreta que el gerente debe cumplir o recordar: entregar cotización/propuesta, enviar documentos o consultas, visitas, reuniones, pagos, vencimientos tributarios, fechas de adjudicación. Ignora publicidad y fechas pasadas. Convierte fechas relativas ("el viernes", "mañana") en fechas reales a partir de la fecha del correo. Devuelve SOLO JSON: {"plazos":[{"fecha":"YYYY-MM-DD","accion":"verbo + qué + cliente, máx 80 caracteres","linea":"servicios|academy"}]}. Si no hay, {"plazos":[]}.`;
    const user = `${enviado ? 'CORREO ENVIADO por el gerente' : 'CORREO RECIBIDO'}\nFecha: ${m.fecha?.toISOString?.() || ''}\nDe: ${m.de}\nPara: ${m.para}\nAsunto: ${m.asunto}\n\n${m.texto}`;
    let r = null;
    try { r = extraerJSON('{' + await llamarModelo(system, [{ role: 'user', content: user }, { role: 'assistant', content: '{' }], 400, 1, { interna: true })); } catch (e) { console.error('Plazos LLM:', e.message); continue; }
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const validos = (r?.plazos || []).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.fecha || '') && x.fecha >= hoy && x.accion);
    for (const x of validos) {
      const ev = await cal.crearPlazo({ linea: x.linea, titulo: `⏰ ${x.accion}`, fecha: x.fecha, descripcion: `Detectado en correo ${enviado ? 'enviado' : 'de ' + m.de}\nAsunto: ${m.asunto}` });
      if (ev) { plazos++; avisos.push(`• ${cal.fmt(new Date(x.fecha + 'T12:00:00-05:00')).slice(0, -6)}: ${x.accion}`); }
    }
    await db.marcarCorreo(m.id, validos.map(x => `${x.fecha} ${x.accion}`).join(' | ').slice(0, 500) || '-');
  }
  if (avisos.length) await enviarWhatsApp(ADMIN_PHONE, `📧 *Plazos detectados en tu correo* (agregados al calendario):\n${avisos.join('\n')}\nSi alguno no corresponde, bórralo en Google Calendar.`);
  console.log(JSON.stringify({ evento: 'revision_correo', revisados: lista.length, plazos }));
  return { revisados: lista.length, plazos };
}

async function bloqueVencimientos(dias = 7) {
  const ev = await cal.eventos(dias);
  if (!ev) return '';
  const v = ev.filter(e => e.todoElDia || /^⏰/.test(e.titulo));
  return v.length ? v.map(e => '• ' + e.txt).join('\n') : 'Sin vencimientos.';
}

async function registrarCita(s, ev, titulo, inicio) {
  if (!ev) return;
  const [f, hm] = inicio.split('T');
  await db.guardarCita({ tel: s.tel, nombre: s.nombre || null, linea: s.linea || null, titulo, inicio: new Date(`${f}T${hm}:00-05:00`).toISOString(), evento_id: ev.id || null });
}

async function bloqueAgenda(dias) {
  const ev = await cal.eventos(dias);
  if (ev === null) return cal.activo ? '⚠️ No pude leer el calendario.' : 'Calendario no configurado.';
  return ev.length ? ev.map(e => '• ' + e.txt).join('\n') : 'Sin eventos.';
}

async function enviarStatus() {
  const leads = db.activo ? await db.listarLeads() : [...sesiones.values()];
  const activos = leads.filter(l => l.tel !== ADMIN_PHONE && ETAPAS_ACTIVAS.includes(l.etapa));
  const porEtapa = {}; activos.forEach(l => { porEtapa[l.etapa] = (porEtapa[l.etapa] || 0) + 1; });
  const abiertas = db.activo ? await db.consultasAbiertas() : [...pendientes.keys()];
  const calientes = activos.filter(l => ['interesado', 'listo'].includes(l.etapa));
  const txt = `📊 *Status ProyTech* (${hoyLima()})\n` +
    `• Leads activos: ${activos.length}${Object.keys(porEtapa).length ? ' (' + Object.entries(porEtapa).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : ''}\n` +
    `• Consultas por responder: ${abiertas.length}\n` +
    (calientes.length ? `• Calientes: ${calientes.slice(0, 5).map(l => `${l.nombre || '+' + l.tel} (${l.linea || '-'})`).join(', ')}\n` : '') +
    `\n🗓️ *Agenda próximos 3 días*\n${await bloqueAgenda(3)}` +
    (cal.activo ? `\n\n⏰ *Vencimientos próximos 14 días*\n${await bloqueVencimientos(14)}` : '') +
    await saldoIA().then(r => r.ok ? `\n\n🔋 Saldo IA: US$ ${r.saldo.toFixed(2)}${r.saldo < SALDO_MINIMO ? ' ⚠️ recargar' : ''}` : '');
  await enviarWhatsApp(ADMIN_PHONE, txt);
}

// Recordatorios de citas: ~24 h antes y ~2 h antes
async function ejecutarRecordatorios() {
  if (!db.activo) return;
  const citas = await db.citasProximas(26);
  for (const c of citas) {
    const faltan = (Date.parse(c.inicio) - Date.now()) / HORA;
    const tipo = !c.recordado_24 && faltan <= 24 && faltan > 3 ? 'recordado_24' : (!c.recordado_2 && faltan <= 3 ? 'recordado_2' : null);
    if (!tipo) continue;
    const s = await obtenerSesion(c.tel);
    const cuando = cal.fmt(new Date(c.inicio));
    const que = (c.titulo || 'reunión').split(' – ')[0].toLowerCase();
    const texto = tipo === 'recordado_24'
      ? `${saludoSegunHora().saludo}${s.nombre ? ' ' + s.nombre.split(' ')[0] : ''}, le recordamos su ${que} con ProyTech programada para el ${cuando}. ¿Nos confirma su disponibilidad?`
      : `${saludoSegunHora().saludo}, le recordamos que su ${que} con ProyTech es hoy a las ${cuando.slice(-5)}. Cualquier novedad, nos avisa por aquí.`;
    let ok = false;
    if ((Date.now() - s.ultimoCliente) / HORA < 23.5) ok = await enviarYRegistrar(s, texto);
    else ok = await enviarPlantilla(c.tel, TEMPLATE_RECORDATORIO, s.nombre, [que, cuando]);
    if (!ok) await enviarWhatsApp(ADMIN_PHONE, `⏰ Recordar a mano a +${c.tel}${s.nombre ? ' (' + s.nombre + ')' : ''}: ${c.titulo} — ${cuando}. (Fuera de la ventana de 24 h; falta plantilla aprobada.)`);
    await db.marcarCita(c.id, { [tipo]: true });
  }
}

const RX_AGENDA = /visita|reuni[oó]n|llamada|agend|cita|horario|disponib|coordinar|zoom|meet/i;

// Tras la confirmación de Christian: extrae fecha/hora y crea el evento en su Google Calendar
async function intentarAgendar(s, consulta, indicacion, respuestaCliente) {
  if (!cal.activo) return;
  const system = `Hoy es ${hoyLima()} (Lima). Analiza la indicación que el dueño de ProyTech dio sobre una solicitud de agenda de un cliente. Devuelve SOLO JSON: {"agendar":true|false,"inicio":"YYYY-MM-DDTHH:MM","duracion_min":60,"tipo":"Visita técnica|Reunión|Llamada|Clase|Otro","lugar":""}. agendar=true solo si el dueño CONFIRMA una fecha y hora concretas (no si pide preguntar, propone opciones o rechaza). Interpreta "sábado 14" o "jueves 10am" como la próxima fecha futura.`;
  const user = `Solicitud: ${consulta}\nIndicación del dueño: ${indicacion}\nRespuesta enviada al cliente: ${respuestaCliente}`;
  let d;
  try { d = extraerJSON('{' + await llamarModelo(system, [{ role: 'user', content: user }, { role: 'assistant', content: '{' }], 150)); } catch (e) { return; }
  if (!d?.agendar || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.inicio || '')) return;
  const quien = s.nombre ? `${s.nombre} (+${s.tel})` : `+${s.tel}`;
  const ev = await cal.crearEvento({
    linea: s.linea, titulo: `${d.tipo || 'Reunión'} – ${quien}`, inicio: d.inicio, duracionMin: Number(d.duracion_min) || 60, lugar: d.lugar || '',
    descripcion: `Línea: ${s.linea || '-'}\nWhatsApp: https://wa.me/${s.tel}\nPerfil: ${s.resumen || '-'}\nSolicitud: ${consulta}\nIndicación: ${indicacion}`,
  });
  await registrarCita(s, ev, `${d.tipo || 'Reunión'} – ${quien}`, d.inicio);
  const nombreCal = s.linea === 'academy' ? 'ProyTech Academy' : 'ProyTech Automatización';
  await enviarWhatsApp(ADMIN_PHONE, ev ? `📅 Agendado en *${nombreCal}*: ${d.tipo || 'Reunión'} ${d.inicio.replace('T', ' ')} con ${quien}.\nSi no corresponde, bórralo en tu Google Calendar.`
    : `⚠️ No pude crear el evento en el calendario (${d.inicio}). Revisa los logs o usa /agendar.`);
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
    (cal.activo && RX_AGENDA.test(consulta + ' ' + textoCliente) ? await cal.libres(7).then(l => l.length ? `\n🗓️ Libres en tu calendario: ${l.join(' · ')}\n` : '') : '') +
    `\nResponde:  *#${id} tu indicación*` + (out.borrador ? `   o   *#${id} ok*` : '');
  const wamid = await enviarWhatsApp(ADMIN_PHONE, msg);
  if (typeof wamid === 'string') { mensajeAConsulta.set(wamid, id); await db.guardarWamidConsulta(id, wamid); }
  console.log(JSON.stringify({ evento: 'consulta_admin', id, tel, pregunta: consulta }));
}

// Christian responde él mismo (texto literal) y el bot se pausa en ese chat
async function responderManual(tel, texto, avisar) {
  const s = await obtenerSesion(tel);
  if (s.nueva) await guardarSesion(s);
  const ctx = ultimoMensajeCliente(s);
  const ok = await enviarYRegistrar(s, texto);
  if (ok) await registrarEjemplo(s, ctx, texto, 'comando_r');
  if (ok) { s.pausadoHasta = Date.now() + PAUSA_HORAS * HORA; await guardarSesion(s); }
  if (avisar) await enviarWhatsApp(ADMIN_PHONE, ok ? `✅ Enviado a +${tel}. Bot en pausa ${PAUSA_HORAS} h en ese chat (reactiva con /bot ${tel}).` : `⚠️ No se pudo enviar a +${tel}.`);
  return ok;
}

// ---------- Biblioteca de estilo de Christian ----------
function ultimoMensajeCliente(s) {
  for (let i = s.historial.length - 1; i >= 0; i--) if (s.historial[i].role === 'user') return s.historial[i].content;
  return '';
}
async function registrarEjemplo(s, contexto, respuesta, fuente) {
  if (!respuesta || respuesta.length < 8 || /^\[/.test(respuesta)) return;
  const e = { linea: s.linea || 'indefinida', contexto: String(contexto || '').slice(0, 400), respuesta: String(respuesta).slice(0, 800) };
  ejemplos.unshift(e); if (ejemplos.length > MAX_EJEMPLOS) ejemplos.pop();
  await db.guardarEjemplo(e);
  console.log(JSON.stringify({ evento: 'ejemplo_estilo', fuente, linea: e.linea }));
}
const tokens = t => new Set(String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9ñ]{4,}/g) || []);
function bloqueEjemplos(s) {
  if (!ejemplos.length) return '(aún no hay ejemplos)';
  const q = tokens(ultimoMensajeCliente(s));
  const elegidos = ejemplos
    .map((e, i) => { const t = tokens(e.contexto); let n = 0; q.forEach(w => { if (t.has(w)) n++; }); return { e, puntaje: n + (e.linea === s.linea ? 1 : 0) - i * 0.01 }; })
    .sort((a, b) => b.puntaje - a.puntaje).slice(0, 3).map(x => x.e);
  return elegidos.map(e => `- Cliente: "${e.contexto}"\n  Christian respondió: "${e.respuesta}"`).join('\n');
}

// Mensaje enviado por Christian desde la app (coexistencia): se guarda y el bot se pausa en ese chat
let ultimoPausado = null;
async function registrarEcoManual(eco) {
  const tel = eco.to || eco.to_user_id;
  if (!tel || tel === ADMIN_PHONE) return; // chat interno con Christian
  const texto = eco.text?.body || (eco.type ? `[${eco.type} enviado desde la app]` : '');
  if (!tel || !texto) return;
  const s = await obtenerSesion(tel);
  if (s.nueva) await guardarSesion(s);
  if (eco.text?.body) await registrarEjemplo(s, ultimoMensajeCliente(s), texto, 'app');
  s.historial.push({ role: 'assistant', content: texto });
  if (s.historial.length > MAX_HISTORIAL) s.historial = s.historial.slice(-MAX_HISTORIAL);
  await db.guardarMensaje(tel, 'assistant', texto);
  // Lo que Christian responde a mano también entra al embudo de seguimiento
  if (!s.linea) s.linea = detectarLinea(texto) || detectarLinea(ultimoMensajeCliente(s));
  if (s.etapa === 'nuevo') s.etapa = 'perfilando';
  if (!s.proximoSeguimiento && ETAPAS_ACTIVAS.includes(s.etapa)) s.proximoSeguimiento = Date.now() + PRIMER_SEG_MIN * 60000;
  const yaPausado = s.pausadoHasta && s.pausadoHasta > Date.now();
  s.pausadoHasta = Date.now() + PAUSA_HORAS * HORA;
  await guardarSesion(s);
  ultimoPausado = tel;
  if (!yaPausado) await enviarWhatsApp(ADMIN_PHONE, `⏸️ Respondiste desde la app a ${esTelefono(tel) ? '+' + tel : tel}${s.nombre ? ' (' + s.nombre + ')' : ''}: el bot se pausa ${PAUSA_HORAS} h en ese chat.\nPara que el bot continúe ya: */bot ultimo*`);
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
  const ma = t.match(/^\/agendar\s+\+?(\d{8,15}|[A-Z]{2}\.[A-Za-z0-9.]+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?:\s+(\d{2,3}))?\s*([\s\S]*)$/i);
  if (ma) {
    const sx = await obtenerSesion(ma[1]); const quien = sx.nombre ? `${sx.nombre} (+${ma[1]})` : `+${ma[1]}`;
    const tit = `${ma[5].trim() || 'Reunión'} – ${quien}`, ini = `${ma[2]}T${ma[3].padStart(5, '0')}`;
    const ev = await cal.crearEvento({ linea: sx.linea, titulo: tit, inicio: ini, duracionMin: Number(ma[4]) || 60, descripcion: `WhatsApp: https://wa.me/${ma[1]}\nPerfil: ${sx.resumen || '-'}` });
    await registrarCita(sx, ev, tit, ini);
    await enviarWhatsApp(ADMIN_PHONE, ev ? `📅 Evento creado: ${ma[2]} ${ma[3]} con ${quien}.` : (cal.activo ? '⚠️ No pude crear el evento. Revisa los logs.' : '⚠️ El calendario aún no está configurado.'));
    return true;
  }
  if (/^\/status$/i.test(t)) { await enviarStatus(); return true; }
  const muc = t.match(/^\/ultimoscupos(\s+enviar)?(?:\s+(.+))?$/i);
  if (muc) {
    const fecha = (muc[2] || '14 de noviembre').trim();
    const leads = (await db.leadsTodos()).filter(l => l.linea === 'academy' && !['ganado', 'perdido'].includes(l.etapa) && l.tel !== ADMIN_PHONE && Date.now() - Date.parse(l.actualizado) < 30 * DIA);
    if (!muc[1]) {
      await enviarWhatsApp(ADMIN_PHONE, `📣 *Últimos cupos* — vista previa\nDestinatarios: ${leads.length} leads de Academy (no cerrados, activos en 30 días)\nFecha de inicio: sábado ${fecha}\nCosto aprox.: US$ ${(leads.length * 0.07).toFixed(2)}\n\nPara enviar: */ultimoscupos enviar ${fecha}*`);
      return true;
    }
    let ok = 0;
    for (const l of leads) { if (await enviarPlantilla(l.tel, 'ultimos_cupos_academy', l.nombre, [fecha])) { ok++; await db.guardarMensaje(l.tel, 'assistant', `[Plantilla ultimos_cupos_academy · ${fecha}]`); } await new Promise(r => setTimeout(r, 1500)); }
    await enviarWhatsApp(ADMIN_PHONE, `📣 Últimos cupos enviado a ${ok} de ${leads.length} leads.`);
    return true;
  }
  if (/^\/saldo$/i.test(t)) { const r = await saldoIA(); await enviarWhatsApp(ADMIN_PHONE, r.ok ? `🔋 Saldo IA (OpenRouter): US$ ${r.saldo.toFixed(2)} · usado en total: US$ ${r.usado.toFixed(2)}${r.saldo < SALDO_MINIMO ? '\n⚠️ Está bajo: recarga en https://openrouter.ai/settings/credits' : ''}` : `No pude consultar el saldo (${r.error}).`); return true; }
  const mco = t.match(/^\/correo(?:\s+(\d{1,3}))?$/i);
  if (mco) {
    if (!correo.activo) { await enviarWhatsApp(ADMIN_PHONE, 'El correo aún no está configurado (faltan IMAP_USER e IMAP_PASS en Render).'); return true; }
    const r = await revisarCorreos(Number(mco[1]) || 24);
    if (!r.plazos) await enviarWhatsApp(ADMIN_PHONE, `📧 Revisé ${r.revisados} correos nuevos: sin plazos nuevos.`);
    return true;
  }
  if (/^\/vencimientos$/i.test(t)) { await enviarWhatsApp(ADMIN_PHONE, `⏰ *Vencimientos próximos 30 días*\n${await bloqueVencimientos(30)}`); return true; }
  const mag = t.match(/^\/agenda(?:\s+(\d{1,2}))?$/i);
  if (mag) { const n = Number(mag[1]) || 7; await enviarWhatsApp(ADMIN_PHONE, `🗓️ *Agenda próximos ${n} días*\n${await bloqueAgenda(n)}`); return true; }
  if (/^\/(ayuda|help|comandos)$/i.test(t)) { await enviarWhatsApp(ADMIN_PHONE, AYUDA_ADMIN); return true; }
  if (/^\/libres$/i.test(t)) {
    const l = await cal.libres(7, 60, 10);
    await enviarWhatsApp(ADMIN_PHONE, l.length ? '🗓️ Libres próximos 7 días:\n' + l.map(x => '• ' + x).join('\n') : (cal.activo ? 'Sin bloques libres o error de calendario.' : 'El calendario aún no está configurado.'));
    return true;
  }
  const mr = t.match(/^\/r\s+\+?(\d{8,15}|[A-Z]{2}\.[A-Za-z0-9.]+)\s+([\s\S]+)$/i);
  if (mr) { await responderManual(mr[1], mr[2].trim(), true); return true; }
  if (/^\/bot\s+ultimo$/i.test(t)) {
    if (!ultimoPausado) { await enviarWhatsApp(ADMIN_PHONE, 'No hay un chat pausado recientemente.'); return true; }
    const sx = await obtenerSesion(ultimoPausado); sx.pausadoHasta = null; await guardarSesion(sx);
    await enviarWhatsApp(ADMIN_PHONE, `🤖 Bot reactivado para ${sx.nombre || ultimoPausado}. Responderá su próximo mensaje.`); return true;
  }
  const mb = t.match(/^\/bot\s+\+?(\d{8,15}|[A-Z]{2}\.[A-Za-z0-9.]+)$/i);
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
  const ctxCliente = ultimoMensajeCliente(s);
  if (await enviarYRegistrar(s, final)) {
    await registrarEjemplo(s, ctxCliente, final, 'consulta');
    s.pendiente = null; pendientes.delete(id); await db.cerrarConsulta(id);
    s.proximoSeguimiento = Date.now() + PRIMER_SEG_MIN * 60000;
    await guardarSesion(s);
    if (!esOk) {
      const d = { consulta: p.consulta, indicacion, ts: Date.now(), fecha: new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) };
      datosConfirmados.push(d); if (datosConfirmados.length > MAX_DATOS) datosConfirmados.shift();
      await db.guardarDato({ consulta: d.consulta, indicacion: d.indicacion });
    }
    await enviarWhatsApp(ADMIN_PHONE, `✅ #${id} enviado a +${p.tel}:\n"${final}"`);
    if (!esOk && RX_AGENDA.test(p.consulta + ' ' + indicacion)) await intentarAgendar(s, p.consulta, indicacion, final);
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

  const tel = msg.from || msg.from_user_id; // sin teléfono si el cliente usa nombre de usuario (BSUID)
  if (!tel) { console.error('Mensaje sin remitente:', JSON.stringify(msg).slice(0, 300)); return; }
  const s = await obtenerSesion(tel);
  if (!s.nombre && contacto?.profile?.username) s.nombre = contacto.profile.username;
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
      sesiones.delete(tel); await db.borrarLead(tel); await db.cerrarConsultasDe(tel);
      for (const [k, p] of pendientes) if (p.tel === tel) pendientes.delete(k);
      await enviarWhatsApp(tel, '🔄 Sesión reiniciada (modo prueba).');
      return;
    }
    if (/^(#\d+\s|\/)/.test(texto)) {
      let ok = false;
      try { ok = await procesarComandoAdmin(texto); } catch (e) { console.error('Error comando admin:', e.message); }
      if (!ok) await enviarWhatsApp(ADMIN_PHONE, AYUDA_ADMIN);
      return;
    }
    if (/^aprob(ar|ado|o)\b/i.test(texto)) {
      const idr = await db.aprobarUltimaRevision(texto);
      await enviarWhatsApp(ADMIN_PHONE, `✅ Anotado${idr ? ' (revisión #' + idr + ')' : ''}: "${texto}". En tu próxima sesión con Claude dile "aplica los ajustes aprobados" y los implementa.`);
      return;
    }
    // Respuesta sin "#id": 1) si citó (respondió) el mensaje de la consulta; 2) si hay una sola consulta abierta
    if (!process.env.ADMIN_ES_CLIENTE) {
      let idc = msg.context?.id ? (mensajeAConsulta.get(msg.context.id) || await db.consultaPorWamid(msg.context.id)) : null;
      if (!idc) {
        const abiertas = db.activo ? await db.consultasAbiertas() : [...pendientes.keys()].map(id => ({ id }));
        if (abiertas.length === 1) idc = abiertas[0].id;
        else if (abiertas.length > 1) {
          await enviarWhatsApp(ADMIN_PHONE, `Tienes ${abiertas.length} consultas abiertas. Responde citando (deslizando) el mensaje de la consulta, o escribe *#número tu respuesta*.\n` + abiertas.map(a => `#${a.id} +${a.tel || ''} ${a.consulta || ''}`).join('\n').slice(0, 3000));
          return;
        } else {
          await enviarWhatsApp(ADMIN_PHONE, 'No hay consultas pendientes.\n\n' + AYUDA_ADMIN);
          return;
        }
      }
      try { await procesarComandoAdmin(`#${idc} ${texto}`); } catch (e) { console.error('Error respuesta admin:', e.message); }
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
  s.proximoSeguimiento = Date.now() + PRIMER_SEG_MIN * 60000;
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
    const sinSaldo = e.response?.status === 402;
    // El cliente no se queda sin respuesta: acuse breve y Christian decide el resto
    if (!s.acuseIA || Date.now() - s.acuseIA > HORA) {
      s.acuseIA = Date.now();
      await enviarYRegistrar(s, `${(s.historial || []).length <= 1 ? saludoSegunHora().saludo + '. ' : ''}Gracias por escribirnos. Permítame un momento y le respondo.`);
    }
    await consultarAdmin(tel, s, { linea: s.linea, intencion: 'error_ia', pregunta_admin: sinSaldo ? 'Sin saldo de IA (OpenRouter). Recarga créditos o dime qué le respondo.' : 'La IA falló; ¿qué le respondo?' }, texto);
    return;
  }

  if (out.linea && ['servicios', 'academy'].includes(out.linea)) s.linea = out.linea;
  if (out.nombre_cliente && !s.nombre) s.nombre = out.nombre_cliente;

  console.log(JSON.stringify({ evento: 'clasificacion', tel, origen: s.origen, linea: out.linea, intencion: out.intencion, confianza: out.confianza, consultar_admin: !!out.consultar_admin }));

  // "personal" solo aplica a contactos nuevos; un lead con conversación comercial nunca se descarta
  const leadComercial = ['servicios', 'academy'].includes(s.linea) || (s.historial || []).length > 2;
  if (out.linea === 'personal' && leadComercial) {
    console.log(JSON.stringify({ evento: 'personal_ignorado', tel, motivo: 'lead comercial activo' }));
    out.linea = s.linea || 'indefinida';
    if (!out.respuesta) {
      out.respuesta = await redactarConIndicacion(s, ultimoMensajeCliente(s) || 'pregunta del cliente', 'Es una pregunta sobre información interna o fuera de tema. Responde con cortesía que es información interna de la empresa y redirige al valor para el cliente y al siguiente paso. Breve.');
    }
  } else if (out.linea === 'personal') {
    console.log(`Chat personal de ${tel}; el bot no responde ni guarda historial.`);
    sesiones.delete(tel); await db.borrarLead(tel);
    return;
  }

  if (out.respuesta) await enviarYRegistrar(s, out.respuesta);

  // Brochure en PDF solo si lo pide (y mientras su precio esté vigente); la info igual va en el mensaje
  const BROCHURE_HASTA = process.env.BROCHURE_HASTA || '2026-11-14';
  const yaTieneBrochure = (s.historial || []).some(m => /\[Documento: brochure PDF\]/.test(m.content || ''));
  if (out.enviar_brochure && !yaTieneBrochure) {
    const hoyISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    if (hoyISO <= BROCHURE_HASTA) {
      await new Promise(r => setTimeout(r, 3000));
      if (await enviarDocumento(tel, `${URL_PUBLICA}/archivos/brochure-proytech-academy.pdf`, 'Brochure ProyTech Academy - Curso PLC Siemens.pdf', 'Le comparto nuestro brochure con todo el detalle 📄')) {
        s.historial.push({ role: 'assistant', content: '[Documento: brochure PDF]' });
        await db.guardarMensaje(tel, 'assistant', '[Documento: brochure PDF]');
        out.enviar_temario = false; // el brochure ya incluye el temario
      }
    } else await enviarWhatsApp(ADMIN_PHONE, `📄 ${s.nombre || tel} pidió el brochure, pero su precio venció (${BROCHURE_HASTA}). Envíalo tú o pídeme una versión actualizada.`);
  }

  // Temario en PDF (una vez por cliente)
  const yaTieneTemario = (s.historial || []).some(m => /\[Documento: temario PDF\]/.test(m.content || ''));
  if (out.enviar_temario && (s.linea === 'academy' || out.linea === 'academy') && !yaTieneTemario) {
    await new Promise(r => setTimeout(r, 3000));
    if (await enviarDocumento(tel, `${URL_PUBLICA}/archivos/temario-curso-plc-proytech.pdf`, 'Temario Curso PLC Siemens - ProyTech Academy.pdf', 'Le comparto el temario completo del curso 📄')) {
      s.historial.push({ role: 'assistant', content: '[Documento: temario PDF]' });
      await db.guardarMensaje(tel, 'assistant', '[Documento: temario PDF]');
    }
  }

  if (out.etapa) s.etapa = out.etapa;
  // un lead comercial que ya recibió respuesta entra al embudo de seguimiento
  if (s.etapa === 'nuevo' && ['servicios', 'academy'].includes(s.linea)) s.etapa = 'perfilando';
  if (out.resumen_lead) s.resumen = out.resumen_lead;
  if (out.consultar_admin && !s.pendiente) await consultarAdmin(tel, s, out, texto);
  else if (out.consultar_admin && s.pendiente) {
    // consulta abierta: reenviar a Christian la nueva información del cliente
    const wid = await enviarWhatsApp(ADMIN_PHONE, `📝 *Actualización consulta #${s.pendiente}* (+${tel}${s.nombre ? ' ' + s.nombre : ''})\nCliente: "${texto}"\n${out.pregunta_admin ? '👉 ' + out.pregunta_admin + '\n' : ''}Responde: *#${s.pendiente} tu indicación*`);
    if (typeof wid === 'string') mensajeAConsulta.set(wid, s.pendiente);
  }
  if (out.sugerir_llamada && !s.llamadaSugerida) {
    s.llamadaSugerida = true;
    await enviarWhatsApp(ADMIN_PHONE, `📞 *Te sugiero llamar* a +${tel}${s.nombre ? ' (' + s.nombre + ')' : ''}\nMotivo: ${out.motivo_llamada || out.intencion}\nEtapa: ${s.etapa} · ${s.linea || ''}\nPerfil: ${out.resumen_lead || '-'}\nLlámalo por WhatsApp desde el chat del 972${esTelefono(tel) ? ' (o tel:+' + tel + ')' : ''}.`);
  }
  if (out.pedir_video && !s.videoPedido) {
    s.videoPedido = true;
    await enviarWhatsApp(ADMIN_PHONE, `🎥 *Envía el video del laboratorio* a +${tel}${s.nombre ? ' (' + s.nombre + ')' : ''}\nMotivo: ${out.motivo_video || out.intencion}\nEtapa: ${s.etapa}\nPerfil: ${out.resumen_lead || '-'}\nAbrir chat: https://wa.me/${tel}`);
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
async function enviarPlantilla(tel, nombrePlantilla, nombreCliente, extras = []) {
  try {
    await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', ...destino(tel), type: 'template',
      template: { name: nombrePlantilla, language: { code: TEMPLATE_LANG },
        components: [{ type: 'body', parameters: [{ type: 'text', text: (nombreCliente || '').split(' ')[0] || 'estimado(a)' }, ...extras.map(x => ({ type: 'text', text: String(x) }))] }] }
    }, { timeout: 15000, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    console.log(`Plantilla ${nombrePlantilla} enviada a ${tel}`);
    return true;
  } catch (e) { console.error(`Error plantilla a ${tel}:`, JSON.stringify(e.response?.data || e.message)); return false; }
}

// ---------- Embudo de seguimiento (venta persuasiva, Perú) ----------
// Mismo día (ventana gratuita de 24 h): 10 min → 1 h → fin del día. Luego plantillas: día 3 y día 7.
const horaLima = () => Number(new Date().toLocaleString('en-US', { timeZone: 'America/Lima', hour: 'numeric', hour12: false })) % 24;
function proximaHoraLima(h, m = 0) { // próximo instante en Lima a las h:m (UTC-5 fijo)
  const ahora = new Date(); const l = new Date(ahora.getTime() - 5 * HORA);
  let t = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), h + 5, m);
  if (t <= ahora.getTime()) t += DIA;
  return t;
}
function fechaPlantilla(s, i) { // día N tras el último mensaje del cliente, a las 10:00 Lima
  const dias = (DIAS_PLANTILLA[s.linea] || DIAS_PLANTILLA.servicios)[i];
  const base = new Date(s.ultimoCliente + dias * DIA - 5 * HORA);
  return Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 15, 0); // 10:00 Lima = 15:00 UTC
}
const INSTRUCCION_PASO = {
  0: 'Han pasado unos minutos y el cliente no responde. Escribe UN mensaje muy breve (1–2 líneas) preguntando si pudo revisar la información y si desea algún detalle adicional (Academy: temario, horarios, forma de pago; Servicios: alcance, plazos, referencias). Una sola pregunta, cordial, sin presión.',
  1: 'Ha pasado aproximadamente una hora sin respuesta. Escribe UN mensaje persuasivo y breve (2–3 líneas) que aporte un beneficio NUEVO y concreto que aún no mencionaste, e invita a conocer nuestras instalaciones: Academy → visitar el laboratorio y ver los equipos Siemens reales; Servicios → una visita técnica o reunión sin compromiso. Cierra con una pregunta fácil de responder (ej. "¿Le acomoda pasar esta semana?"). No confirmes fechas: si acepta, se coordina después.',
  2: 'Es el cierre del día y el cliente no ha respondido. Escribe UN mensaje breve (3–4 líneas): pregunta con amabilidad si le quedó alguna otra consulta y propone el siguiente paso concreto (Academy: separar su vacante con S/ 200; Servicios: preparar su cotización o coordinar la visita). Estructura: 1) pregunta amable si le quedó alguna consulta; 2) ofrece como ayuda (no como oferta comercial) darle más detalles por una llamada de WhatsApp con uno de nuestros ingenieros o que nos visite en el laboratorio; 3) si le interesa, que puede separar su vacante con S/ 200 con la garantía de reembolso si el curso no inicia (Servicios: preparar su cotización o coordinar una visita técnica). Urgencia SOLO si es real (grupo con fecha de inicio, máximo 2 alumnos por estación). Sin pedir número y sin dar nombres. Divide el texto en DOS mensajes separados por "||": el primero con los puntos 1 y 2 (consulta + llamada o visita); el segundo, corto, con el punto 3 (separar con garantía). Deséale buena tarde/noche según la hora.',
};
const tieneTemario = s => (s.historial || []).some(m => /\[Documento: (temario|brochure) PDF\]/.test(m.content || ''));
async function seguimientoLibre(s, paso) {
  // Academy, paso de 1 h: si aún no recibió el temario, se lo damos como valor nuevo (texto breve + PDF)
  const darTemario = paso === 1 && s.linea === 'academy' && !tieneTemario(s);
  const instr = darTemario
    ? 'Ha pasado aproximadamente una hora sin respuesta y aún no recibió el detalle técnico. Sigue el PROCESO OBLIGATORIO (PASO A): una línea de introducción y los 3 módulos del temario con 1–2 viñetas "• " cada uno (resumidos del CONOCIMIENTO), y cierra preguntando SOLO si desea el brochure: "¿Le comparto nuestro brochure en PDF con todo el detalle del curso?".'
    : INSTRUCCION_PASO[paso];
  const mensajes = [...s.historial, { role: 'user', content: `[Instrucción interna] ${instr} No repitas frases ya dichas en la conversación. Mantén usted/tú según el cliente. Devuelve solo el texto.` }];
  const texto = (await llamarModelo(ESTILO + '\n\nCONOCIMIENTO\n' + CONOCIMIENTO + '\n\nFECHA DE HOY (Lima): ' + hoyLima() + '\n\nDATOS CONFIRMADOS\n' + bloqueDatosConfirmados(), mensajes, 300)).trim();
  if (!texto) return false;
  // En WhatsApp se lee mejor en burbujas cortas: el modelo separa con "||" y se envían con una pausa breve
  const partes = texto.split('||').map(x => x.trim()).filter(Boolean).slice(0, 2);
  let ok = false;
  for (const [k, parte] of partes.entries()) { if (k) await new Promise(r => setTimeout(r, 4000)); ok = (await enviarYRegistrar(s, parte)) || ok; }
  if (false && ok && darTemario) { // el PDF ahora se envía solo si acepta el brochure
    await new Promise(r => setTimeout(r, 3000));
    if (await enviarDocumento(s.tel, `${URL_PUBLICA}/archivos/temario-curso-plc-proytech.pdf`, 'Temario Curso PLC Siemens - ProyTech Academy.pdf', 'Temario completo del curso 📄')) {
      s.historial.push({ role: 'assistant', content: '[Documento: temario PDF]' }); await db.guardarMensaje(s.tel, 'assistant', '[Documento: temario PDF]');
    }
  }
  return ok;
}

async function procesarEmbudo() {
  const ahora = Date.now();
  let candidatos;
  if (db.activo) candidatos = await Promise.all((await db.leadsParaSeguimiento()).map(l => obtenerSesion(l.tel)));
  else candidatos = [...sesiones.values()].filter(s => ETAPAS_ACTIVAS.includes(s.etapa) && !s.pendiente && s.proximoSeguimiento && s.proximoSeguimiento <= ahora);
  const manuales = []; let enviados = 0;
  const h = horaLima();
  for (const s of candidatos) {
    if (s.tel === ADMIN_PHONE && !process.env.SEGUIMIENTO_ADMIN) continue;
    if (s.pausadoHasta && s.pausadoHasta > ahora) continue; // Christian está atendiendo ese chat
    const finVentana = s.ultimoCliente + VENTANA_SEG_H * HORA; // dentro de la ventana gratuita de WhatsApp (24 h)
    try {
      const paso = s.seguimientos || 0;
      if (paso <= 2) {
        if (ahora > finVentana) { s.seguimientos = 3; s.proximoSeguimiento = fechaPlantilla(s, 0); }
        else if (h < 8 || h >= 21) { // de noche no se escribe: se pasa a las 8:30 si sigue la ventana
          const manana = proximaHoraLima(8, 30);
          if (manana < finVentana) s.proximoSeguimiento = manana; else { s.seguimientos = 3; s.proximoSeguimiento = fechaPlantilla(s, 0); }
        } else {
          if (await seguimientoLibre(s, paso)) enviados++;
          s.seguimientos = paso + 1;
          if (paso === 0) s.proximoSeguimiento = Date.now() + 50 * 60000;            // ~1 h desde la respuesta
          else if (paso === 1) {                                                   // fin del día (~19:30) o +3 h
            let t = proximaHoraLima(19, 30); if (t - Date.now() > 12 * HORA || t - Date.now() < 2 * HORA) t = Date.now() + 3 * HORA;
            s.proximoSeguimiento = Math.min(t, finVentana);
          } else s.proximoSeguimiento = fechaPlantilla(s, 0);
        }
      } else if (paso === 3 || paso === 4) {
        if (h < 9 || h >= 20) { s.proximoSeguimiento = proximaHoraLima(9, 30); }
        else {
          const tpl = paso === 3 ? TEMPLATE_D3 : TEMPLATE_D7;
          if (tpl && await enviarPlantilla(s.tel, tpl, s.nombre)) { enviados++; await db.guardarMensaje(s.tel, 'assistant', `[Plantilla ${tpl}]`); }
          else manuales.push(`${esTelefono(s.tel) ? '+' + s.tel : s.tel} ${s.nombre || ''} (${s.linea || '-'}, ${s.etapa}) — recordatorio ${paso === 3 ? '1' : '2 (último)'}`);
          // Lead que no responde a la plantilla: en Perú una llamada suele destrabarlo
          if (paso === 3 && ['interesado', 'pensando', 'objecion', 'listo'].includes(s.etapa)) await enviarWhatsApp(ADMIN_PHONE, `📞 *Llama hoy* a ${esTelefono(s.tel) ? '+' + s.tel : s.tel}${s.nombre ? ' (' + s.nombre + ')' : ''} · ${s.linea || '-'} · ${s.etapa}\nNo responde desde hace ${Math.round((Date.now() - s.ultimoCliente) / DIA)} días. Perfil: ${s.resumen || '-'}\nLlámalo por WhatsApp desde el chat del 972.`);
          s.seguimientos = paso + 1;
          s.proximoSeguimiento = paso === 3 ? fechaPlantilla(s, 1) : null;
        }
      } else s.proximoSeguimiento = null;
      await guardarSesion(s);
    } catch (e) { console.error('Error seguimiento', s.tel, e.message); }
  }
  if (manuales.length) await enviarWhatsApp(ADMIN_PHONE, `⏰ *Recordatorios para enviar a mano*:\n${manuales.join('\n')}`);
  if (candidatos.length) console.log(JSON.stringify({ evento: 'embudo', revisados: candidatos.length, enviados, manuales: manuales.length }));
  return { revisados: candidatos.length, enviados, manuales: manuales.length };
}

async function ejecutarSeguimientos() {
  const r = await procesarEmbudo();
  try { await ejecutarRecordatorios(); } catch (e) { console.error('Error recordatorios citas:', e.message); }
  try { await revisarCorreos(3); } catch (e) { console.error('Error revisión correo:', e.message); }
  try { await revisarSaldoIA(); } catch (e) { console.error('Error saldo IA:', e.message); }
  return r;
}

async function enviarResumenDiario() {
  const leads = db.activo ? await db.listarLeads() : [...sesiones.values()];
  const activos = leads.filter(l => l.tel !== ADMIN_PHONE && ETAPAS_ACTIVAS.includes(l.etapa));
  const abiertas = db.activo ? await db.consultasAbiertas() : [...pendientes.keys()];
  const porEtapa = {}; activos.forEach(l => { porEtapa[l.etapa] = (porEtapa[l.etapa] || 0) + 1; });
  const txt = `📊 *Resumen ProyTech* (${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' })})\n` +
    `Leads activos: ${activos.length} — ${Object.entries(porEtapa).map(([k, v]) => `${k}: ${v}`).join(', ') || '-'}\n` +
    `Consultas sin responder: ${abiertas.length}${abiertas.length ? ' (usa /pendientes)' : ''}\n` +
    (activos.length ? `\nTop:\n${activos.slice(0, 8).map(l => `• +${l.tel} ${l.nombre || ''} · ${l.linea || '-'} · ${l.etapa}`).join('\n')}` : '') +
    (cal.activo ? `\n\n🗓️ *Agenda de hoy y mañana*\n${await bloqueAgenda(2)}\n\n⏰ *Vencimientos próximos 7 días*\n${await bloqueVencimientos(7)}` : '');
  await enviarWhatsApp(ADMIN_PHONE, txt);
  return { activos: activos.length, consultas: abiertas.length };
}

setInterval(() => ejecutarSeguimientos().catch(e => console.error(e)), 30 * 60 * 1000);
setInterval(() => procesarEmbudo().catch(e => console.error(e)), 2 * 60 * 1000);
// Render (plan gratis) duerme tras 15 min sin tráfico: en horario comercial se mantiene despierto para cumplir los seguimientos de 10 min / 1 h
setInterval(() => { const h = horaLima(); if (h >= 7 && h < 22 && process.env.RENDER_EXTERNAL_URL) axios.get(process.env.RENDER_EXTERNAL_URL, { timeout: 15000 }).catch(() => {}); }, 10 * 60 * 1000);

// ---------- Endpoints ----------
app.get('/', (_req, res) => res.send(`ProyTech Bot v3 activo · BD ${db.activo ? 'conectada' : 'en RAM'}`));
// Diagnóstico sin datos sensibles: solo indica si el calendario responde
app.get('/salud/calendario', async (_req, res) => { const l = await cal.libres(7); const ev = await cal.eventos(14); res.json({ activo: cal.activo, bloques_libres: l.length, eventos_14d: ev ? ev.length : null, ultimo_error: cal.ultimoError() }); });
app.get('/salud/ia', async (_req, res) => { const r = await saldoIA(); res.json({ ok: r.ok, saldo_bajo: r.ok ? r.saldo < SALDO_MINIMO : null, error: r.error || null }); });
app.get('/salud/correo', async (_req, res) => { const r = await correo.probar(); res.json({ activo: correo.activo, ...r }); });

require('./bandeja')(app, { db, sesiones, obtenerSesion, guardarSesion, responderManual, INBOX_KEY, PAUSA_HORAS });

function cronAutorizado(req) { return CRON_SECRET && req.query.key === CRON_SECRET; }
app.get('/cron/seguimientos', async (req, res) => {
  if (!cronAutorizado(req)) return res.sendStatus(403);
  res.json(await ejecutarSeguimientos());
});
async function revisionSemanal() {
  const desde = new Date(Date.now() - 7 * DIA).toISOString();
  const [leads, msgs] = await Promise.all([db.leadsTodos(), db.mensajesDesde(desde)]);
  const semana = leads.filter(l => l.tel !== ADMIN_PHONE && Date.parse(l.actualizado) >= Date.parse(desde));
  const cuenta = (arr, k) => arr.reduce((o, x) => { const v = x[k] || '-'; o[v] = (o[v] || 0) + 1; return o; }, {});
  const stats = { leads_semana: semana.length, por_etapa: cuenta(semana, 'etapa'), por_linea: cuenta(semana, 'linea'), por_origen: cuenta(semana, 'origen') };
  const muestra = msgs.filter(m => m.tel !== ADMIN_PHONE).map(m => `[${m.tel.slice(-4)}] ${m.rol === 'user' ? 'Cliente' : 'ProyTech'}: ${m.contenido}`).join('\n').slice(-12000);
  const system = `Eres el estratega comercial de ProyTech Automatización (servicios de automatización industrial y cursos de PLC en Lima).
Analiza la semana y escribe un informe para WhatsApp de máximo 1200 caracteres, en español, sin Markdown (usa "•" para viñetas), con:
1) Resumen en 2 líneas con cifras.
2) Objeciones o dudas más repetidas.
3) Dónde se están perdiendo leads.
4) Tres ajustes concretos y accionables para la secretaria virtual o para la oferta, numerados, para que Christian los apruebe.
No inventes datos que no estén en la información.`;
  const user = `ESTADÍSTICAS: ${JSON.stringify(stats)}\n\nCONVERSACIONES DE LA SEMANA (recortadas):\n${muestra || '(sin conversaciones)'}`;
  const informe = (await llamarModelo(system, [{ role: 'user', content: user }], 700, 1, { interna: true })).trim();
  await db.guardarRevision(informe);
  await enviarWhatsApp(ADMIN_PHONE, `🧠 *Revisión semanal del estratega*\n\n${informe}\n\nResponde con los números de los ajustes que apruebas (por ejemplo "aprobar 1 y 3") y los aplicamos.`);
  console.log(JSON.stringify({ evento: 'revision_semanal', ...stats }));
  return stats;
}

app.get('/cron/semanal', async (req, res) => {
  if (!cronAutorizado(req)) return res.sendStatus(403);
  res.json(await revisionSemanal());
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
        const contacto = contactos.find(c => (msg.from && c.wa_id === msg.from) || (msg.from_user_id && c.user_id === msg.from_user_id)) || contactos[0];
        procesarMensaje(msg, contacto).catch(e => console.error('Error procesando mensaje:', e));
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
// Plantillas de WhatsApp: se crean solas en la cuenta si no existen (quedan en revisión de Meta)
const PLANTILLAS = [
  { name: 'recordatorio_cita', category: 'UTILITY', language: 'es', components: [{ type: 'BODY',
    text: 'Hola {{1}}, le recordamos su {{2}} con ProyTech Automatización programada para el {{3}}. Por favor, confírmenos su asistencia respondiendo a este mensaje.',
    example: { body_text: [['Juan', 'visita técnica', 'jueves 6/11 a las 10:00']] } }] },
  { name: 'ultimos_cupos_academy', category: 'MARKETING', language: 'es', components: [{ type: 'BODY',
    text: 'Hola {{1}}, quedan pocas vacantes para el curso PLC Siemens que inicia el sábado {{2}} en nuestro laboratorio de Surquillo (máximo 2 alumnos por estación). Puede separar la suya con S/ 200, con la garantía de que si el grupo no se abre se le reembolsa el 100 %. ¿Le reservamos un lugar?',
    example: { body_text: [['Juan', '14 de noviembre']] } }, { type: 'FOOTER', text: 'Responda NO si no desea más mensajes' }] },
  { name: 'seguimiento_dia3', category: 'UTILITY', language: 'es', components: [{ type: 'BODY',
    text: 'Hola {{1}}, le escribimos de ProyTech Automatización para saber si pudo revisar la información sobre su consulta. Quedamos atentos para resolver cualquier duda.',
    example: { body_text: [['Juan']] } }] },
  { name: 'seguimiento_dia7', category: 'UTILITY', language: 'es', components: [{ type: 'BODY',
    text: 'Hola {{1}}, retomamos su consulta con ProyTech Automatización. Si aún le interesa, con gusto coordinamos el siguiente paso. Si ya no lo necesita, indíquenos y no volveremos a escribirle.',
    example: { body_text: [['Juan']] } }] },
];
async function estadoPlantillas() {
  const r = await axios.get(`${GRAPH}/${WABA_ID}/message_templates`, { params: { fields: 'name,status,category,rejected_reason', limit: 50 }, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  return r.data.data || [];
}
async function asegurarPlantillas() {
  try {
    const existentes = new Set((await estadoPlantillas()).map(t => t.name));
    for (const t of PLANTILLAS) {
      if (existentes.has(t.name)) continue;
      try {
        await axios.post(`${GRAPH}/${WABA_ID}/message_templates`, { ...t, allow_category_change: true }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
        console.log(`Plantilla ${t.name} enviada a revisión`);
      } catch (e) { console.error(`Error creando plantilla ${t.name}:`, JSON.stringify(e.response?.data || e.message)); }
    }
  } catch (e) { console.error('Error plantillas:', JSON.stringify(e.response?.data || e.message)); }
}
app.get('/salud/plantillas', async (_req, res) => {
  try { res.json((await estadoPlantillas()).map(t => ({ name: t.name, status: t.status, category: t.category, motivo: t.rejected_reason }))); }
  catch (e) { res.json({ error: e.response?.data?.error?.message || e.message }); }
});

app.listen(PORT, async () => {
  setTimeout(() => asegurarPlantillas(), 5000);
  console.log(`ProyTech Bot v3 corriendo en el puerto ${PORT} · BD ${db.activo ? 'Supabase' : 'RAM'}`);
  const datos = await db.cargarDatos();
  datos.forEach(d => datosConfirmados.push({ consulta: d.consulta, indicacion: d.indicacion, ts: Date.parse(d.creado), fecha: new Date(d.creado).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) }));
  if (datos.length) console.log(`Datos confirmados cargados: ${datos.length}`);
  const ej = await db.cargarEjemplos();
  ej.forEach(e => ejemplos.push(e));
  if (ej.length) console.log(`Ejemplos de estilo cargados: ${ej.length}`);
});
