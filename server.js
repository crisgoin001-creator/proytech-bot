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
async function enviarWhatsApp(to, body) {
  try {
    const r = await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
      { timeout: 15000, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    console.log(`Respuesta enviada exitosamente a ${to}: ${JSON.stringify(body)}`);
    return r.data?.messages?.[0]?.id || true;
  } catch (e) {
    console.error(`Error enviando a ${to}:`, JSON.stringify(e.response?.data || e.message));
    return false;
  }
}

const AYUDA_ADMIN = 'Comandos:\n• /status — resumen del negocio\n• /agenda [días] — eventos agendados\n• /vencimientos — plazos próximos 30 días\n• /correo [horas] — revisar correo ahora\n• /libres — horarios disponibles\n• /agendar 51XXXXXXXXX AAAA-MM-DD HH:MM [min] título\n• /pendientes · /leads · /datos\n• /r 51XXXXXXXXX texto · /bot 51XXXXXXXXX';

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
    try { r = extraerJSON('{' + await llamarModelo(system, [{ role: 'user', content: user }, { role: 'assistant', content: '{' }], 400)); } catch (e) { console.error('Plazos LLM:', e.message); continue; }
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
    (cal.activo ? `\n\n⏰ *Vencimientos próximos 14 días*\n${await bloqueVencimientos(14)}` : '');
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
      ? `${saludoSegunHora()}${s.nombre ? ' ' + s.nombre.split(' ')[0] : ''}, le recordamos su ${que} con ProyTech programada para el ${cuando}. ¿Nos confirma su disponibilidad?`
      : `${saludoSegunHora()}, le recordamos que su ${que} con ProyTech es hoy a las ${cuando.slice(-5)}. Cualquier novedad, nos avisa por aquí.`;
    let ok = false;
    if ((Date.now() - s.ultimoCliente) / HORA < 23.5) ok = await enviarYRegistrar(s, texto);
    else if (process.env.TEMPLATE_RECORDATORIO) ok = await enviarPlantilla(c.tel, process.env.TEMPLATE_RECORDATORIO, s.nombre);
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
async function registrarEcoManual(eco) {
  const tel = eco.to;
  if (tel === ADMIN_PHONE) return; // chat interno con Christian
  const texto = eco.text?.body || (eco.type ? `[${eco.type} enviado desde la app]` : '');
  if (!tel || !texto) return;
  const s = await obtenerSesion(tel);
  if (s.nueva) await guardarSesion(s);
  if (eco.text?.body) await registrarEjemplo(s, ultimoMensajeCliente(s), texto, 'app');
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
  const ma = t.match(/^\/agendar\s+\+?(\d{8,15})\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?:\s+(\d{2,3}))?\s*([\s\S]*)$/i);
  if (ma) {
    const sx = await obtenerSesion(ma[1]); const quien = sx.nombre ? `${sx.nombre} (+${ma[1]})` : `+${ma[1]}`;
    const tit = `${ma[5].trim() || 'Reunión'} – ${quien}`, ini = `${ma[2]}T${ma[3].padStart(5, '0')}`;
    const ev = await cal.crearEvento({ linea: sx.linea, titulo: tit, inicio: ini, duracionMin: Number(ma[4]) || 60, descripcion: `WhatsApp: https://wa.me/${ma[1]}\nPerfil: ${sx.resumen || '-'}` });
    await registrarCita(sx, ev, tit, ini);
    await enviarWhatsApp(ADMIN_PHONE, ev ? `📅 Evento creado: ${ma[2]} ${ma[3]} con ${quien}.` : (cal.activo ? '⚠️ No pude crear el evento. Revisa los logs.' : '⚠️ El calendario aún no está configurado.'));
    return true;
  }
  if (/^\/status$/i.test(t)) { await enviarStatus(); return true; }
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
  const ctxCliente = ultimoMensajeCliente(s);
  if (await enviarYRegistrar(s, final)) {
    await registrarEjemplo(s, ctxCliente, final, 'consulta');
    s.pendiente = null; pendientes.delete(id); await db.cerrarConsulta(id);
    s.proximoSeguimiento = Date.now() + SEGUIMIENTO_HORAS * HORA;
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
    const wid = await enviarWhatsApp(ADMIN_PHONE, `📝 *Actualización consulta #${s.pendiente}* (+${tel}${s.nombre ? ' ' + s.nombre : ''})\nCliente: "${texto}"\n${out.pregunta_admin ? '👉 ' + out.pregunta_admin + '\n' : ''}Responde: *#${s.pendiente} tu indicación*`);
    if (typeof wid === 'string') mensajeAConsulta.set(wid, s.pendiente);
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
  try { await ejecutarRecordatorios(); } catch (e) { console.error('Error recordatorios citas:', e.message); }
  try { await revisarCorreos(3); } catch (e) { console.error('Error revisión correo:', e.message); }
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
    (activos.length ? `\nTop:\n${activos.slice(0, 8).map(l => `• +${l.tel} ${l.nombre || ''} · ${l.linea || '-'} · ${l.etapa}`).join('\n')}` : '') +
    (cal.activo ? `\n\n🗓️ *Agenda de hoy y mañana*\n${await bloqueAgenda(2)}\n\n⏰ *Vencimientos próximos 7 días*\n${await bloqueVencimientos(7)}` : '');
  await enviarWhatsApp(ADMIN_PHONE, txt);
  return { activos: activos.length, consultas: abiertas.length };
}

setInterval(() => ejecutarSeguimientos().catch(e => console.error(e)), 30 * 60 * 1000);

// ---------- Endpoints ----------
app.get('/', (_req, res) => res.send(`ProyTech Bot v3 activo · BD ${db.activo ? 'conectada' : 'en RAM'}`));
// Diagnóstico sin datos sensibles: solo indica si el calendario responde
app.get('/salud/calendario', async (_req, res) => { const l = await cal.libres(7); const ev = await cal.eventos(14); res.json({ activo: cal.activo, bloques_libres: l.length, eventos_14d: ev ? ev.length : null, ultimo_error: cal.ultimoError() }); });
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
  const informe = (await llamarModelo(system, [{ role: 'user', content: user }], 700)).trim();
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
  datos.forEach(d => datosConfirmados.push({ consulta: d.consulta, indicacion: d.indicacion, ts: Date.parse(d.creado), fecha: new Date(d.creado).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) }));
  if (datos.length) console.log(`Datos confirmados cargados: ${datos.length}`);
  const ej = await db.cargarEjemplos();
  ej.forEach(e => ejemplos.push(e));
  if (ej.length) console.log(`Ejemplos de estilo cargados: ${ej.length}`);
});
