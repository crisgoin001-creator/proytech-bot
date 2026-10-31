// Persistencia en Supabase (REST). Si no hay SUPABASE_URL/SUPABASE_KEY, todo funciona en RAM.
const axios = require('axios');
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const activo = !!(URL && KEY);
const api = activo ? axios.create({
  baseURL: URL.replace(/\/$/, '') + '/rest/v1',
  timeout: 10000,
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
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
    ultimo_cliente: iso(s.ultimoCliente), proximo_seguimiento: iso(s.proximoSeguimiento), actualizado: new Date().toISOString()
  }, { headers: { Prefer: 'resolution=merge-duplicates' } })),
  borrarLead: tel => q(() => api.delete('/leads', { params: { tel: `eq.${tel}` } })),
  cargarMensajes: (tel, n) => q(async () => (await api.get('/mensajes', { params: { tel: `eq.${tel}`, select: 'rol,contenido', order: 'id.desc', limit: n } })).data.reverse().map(m => ({ role: m.rol, content: m.contenido })), []),
  guardarMensaje: (tel, rol, contenido) => q(() => api.post('/mensajes', { tel, rol, contenido })),
  borrarHistorial: tel => q(() => api.delete('/mensajes', { params: { tel: `eq.${tel}` } })),
  crearConsulta: c => q(async () => (await api.post('/consultas', c, { headers: { Prefer: 'return=representation' } })).data[0]),
  cargarConsulta: id => q(async () => (await api.get('/consultas', { params: { id: `eq.${id}`, estado: 'eq.abierta', select: '*' } })).data[0] || null),
  cerrarConsulta: id => q(() => api.patch('/consultas', { estado: 'respondida' }, { params: { id: `eq.${id}` } })),
  consultasAbiertas: () => q(async () => (await api.get('/consultas', { params: { estado: 'eq.abierta', select: 'id,tel,consulta', order: 'id' } })).data, []),
  cargarDatos: () => q(async () => (await api.get('/datos_confirmados', { params: { select: 'consulta,indicacion,creado', order: 'id.desc', limit: 40 } })).data.reverse(), []),
  guardarDato: d => q(() => api.post('/datos_confirmados', d)),
  borrarDatos: () => q(() => api.delete('/datos_confirmados', { params: { id: 'gt.0' } })),
  leadsParaSeguimiento: () => q(async () => (await api.get('/leads', { params: {
    select: '*', proximo_seguimiento: `lte.${new Date().toISOString()}`, etapa: 'in.(perfilando,interesado,pensando,objecion,listo)', pendiente: 'is.null'
  } })).data, []),
  listarLeads: () => q(async () => (await api.get('/leads', { params: { select: 'tel,nombre,linea,etapa,origen,seguimientos,actualizado', etapa: 'not.in.(perdido)', order: 'actualizado.desc', limit: 30 } })).data, [])
};
