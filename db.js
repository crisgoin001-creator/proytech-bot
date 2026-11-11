// Persistencia en Supabase (REST). Si no hay SUPABASE_URL/SUPABASE_KEY, todo funciona en RAM.
const axios = require('axios');
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const activo = !!(URL && KEY);
const api = activo ? axios.create({
  baseURL: URL.replace(/\/$/, '') + '/rest/v1',
  timeout: 10000,
  headers: Object.assign({ apikey: KEY, 'Content-Type': 'application/json' }, KEY && KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {})
}) : null;

async function q(fn, def = null) {
  if (!activo) return def;
  try { return await fn(); } catch (e) { console.error('DB error:', JSON.stringify(e.response?.data || e.message)); return def; }
}
const iso = ms => (ms ? new Date(ms).toISOString() : null);

module.exports = {
  activo,
  cargarLead: tel => q(async () => (await api.get('/leads', { params: { tel: `eq.${tel}`, select: '*' } })).data[0] || null),
  guardarLead: s => q(() => api.post('/leads', {
    tel: s.tel, nombre: s.nombre, linea: s.linea, origen: s.origen, etapa: s.etapa, resumen: s.resumen || null,
    pendiente: s.pendiente || null, llamada_sugerida: !!s.llamadaSugerida, seguimientos: s.seguimientos || 0,
    ultimo_cliente: iso(s.ultimoCliente), proximo_seguimiento: iso(s.proximoSeguimiento), pausado_hasta: iso(s.pausadoHasta), actualizado: new Date().toISOString()
  }, { headers: { Prefer: 'resolution=merge-duplicates' } })),
  borrarLead: tel => q(() => api.delete('/leads', { params: { tel: `eq.${tel}` } })),
  cargarMensajes: (tel, n) => q(async () => (await api.get('/mensajes', { params: { tel: `eq.${tel}`, select: 'rol,contenido', order: 'id.desc', limit: n } })).data.reverse().map(m => ({ role: m.rol, content: m.contenido })), []),
  guardarMensaje: (tel, rol, contenido) => q(() => api.post('/mensajes', { tel, rol, contenido })),
  borrarHistorial: tel => q(() => api.delete('/mensajes', { params: { tel: `eq.${tel}` } })),
  crearConsulta: c => q(async () => (await api.post('/consultas', c, { headers: { Prefer: 'return=representation' } })).data[0]),
  cargarConsulta: id => q(async () => (await api.get('/consultas', { params: { id: `eq.${id}`, estado: 'eq.abierta', select: '*' } })).data[0] || null),
  cerrarConsulta: id => q(() => api.patch('/consultas', { estado: 'respondida' }, { params: { id: `eq.${id}` } })),
  guardarWamidConsulta: (id, wamid) => q(() => api.patch('/consultas', { wamid }, { params: { id: `eq.${id}` } })),
  consultaPorWamid: wamid => q(async () => (await api.get('/consultas', { params: { wamid: `eq.${wamid}`, estado: 'eq.abierta', select: 'id' } })).data[0]?.id || null),
  cerrarConsultasDe: tel => q(() => api.patch('/consultas', { estado: 'cerrada' }, { params: { tel: `eq.${tel}`, estado: 'eq.abierta' } })),
  guardarEjemplo: e => q(() => api.post('/ejemplos', e)),
  cargarEjemplos: () => q(async () => (await api.get('/ejemplos', { params: { select: 'linea,contexto,respuesta,creado', order: 'id.desc', limit: 80 } })).data, []),
  mensajesDesde: iso => q(async () => (await api.get('/mensajes', { params: { creado: `gte.${iso}`, select: 'tel,rol,contenido,creado', order: 'id.asc', limit: 500 } })).data, []),
  leadsTodos: () => q(async () => (await api.get('/leads', { params: { select: 'tel,nombre,linea,etapa,origen,resumen,creado,actualizado', order: 'actualizado.desc', limit: 300 } })).data, []),
  guardarRevision: informe => q(async () => (await api.post('/revisiones', { informe }, { headers: { Prefer: 'return=representation' } })).data[0]),
  aprobarUltimaRevision: texto => q(async () => {
    const ult = (await api.get('/revisiones', { params: { select: 'id', order: 'id.desc', limit: 1 } })).data[0];
    if (ult) await api.patch('/revisiones', { aprobado: texto }, { params: { id: `eq.${ult.id}` } });
    return ult?.id || null;
  }),
  consultasAbiertas: () => q(async () => (await api.get('/consultas', { params: { estado: 'eq.abierta', select: 'id,tel,consulta', order: 'id' } })).data, []),
  cargarDatos: () => q(async () => (await api.get('/datos_confirmados', { params: { select: 'consulta,indicacion,creado', order: 'id.desc', limit: 40 } })).data.reverse(), []),
  guardarDato: d => q(() => api.post('/datos_confirmados', d)),
  borrarDatos: () => q(() => api.delete('/datos_confirmados', { params: { id: 'gt.0' } })),
  leadsParaSeguimiento: () => q(async () => (await api.get('/leads', { params: {
    select: '*', proximo_seguimiento: `lte.${new Date().toISOString()}`, etapa: 'in.(perfilando,interesado,pensando,objecion,listo)', pendiente: 'is.null'
  } })).data, []),
  listarChats: () => q(async () => (await api.get('/leads', { params: { select: 'tel,nombre,linea,etapa,origen,resumen,actualizado,pausado_hasta,pendiente', order: 'actualizado.desc', limit: 100 } })).data, []),
  plazoProcesado: id => q(async () => (await api.get('/correos_vistos', { params: { message_id: `eq.${id}`, select: 'message_id' } })).data.length > 0, false),
  marcarCorreo: (id, resumen) => q(() => api.post('/correos_vistos', { message_id: id, resumen }, { headers: { Prefer: 'resolution=ignore-duplicates' } })),
  guardarCita: c => q(() => api.post('/citas', c)),
  citasProximas: horas => q(async () => (await api.get('/citas', { params: { select: '*', inicio: `gte.${new Date().toISOString()}`, order: 'inicio', limit: 50 } })).data
    .filter(c => Date.parse(c.inicio) - Date.now() <= horas * 36e5), []),
  marcarCita: (id, campos) => q(() => api.patch('/citas', campos, { params: { id: `eq.${id}` } })),
  encuestas: () => q(async () => (await api.get('/mensajes', { params: { contenido: 'like.[Encuesta demo]*', select: 'tel,contenido,creado', order: 'id.asc', limit: 2000 } })).data, []),
  listarLeads: () => q(async () => (await api.get('/leads', { params: { select: 'tel,nombre,linea,etapa,origen,seguimientos,actualizado', etapa: 'not.in.(perdido)', order: 'actualizado.desc', limit: 30 } })).data, [])
};
