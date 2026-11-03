// Google Calendar vía cuenta de servicio (sin dependencias extra)
const axios = require('axios');
const crypto = require('crypto');

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL || '';
const SA_KEY = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
const CAL = {
  principal: process.env.CAL_PRINCIPAL || 'crisgoin001@gmail.com',
  servicios: process.env.CAL_SERVICIOS || '',
  academy: process.env.CAL_ACADEMY || '',
};
const TZ = 'America/Lima';
const HORA_INI = Number(process.env.AGENDA_HORA_INI || 9);
const HORA_FIN = Number(process.env.AGENDA_HORA_FIN || 18);
const activo = !!(SA_EMAIL && SA_KEY && (CAL.servicios || CAL.academy));

let token = null, tokenExp = 0, ultimoErr = null;
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

async function obtenerToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const ahora = Math.floor(Date.now() / 1000);
  const cab = b64({ alg: 'RS256', typ: 'JWT' });
  const cuerpo = b64({ iss: SA_EMAIL, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600 });
  const firma = crypto.createSign('RSA-SHA256').update(`${cab}.${cuerpo}`).sign(SA_KEY).toString('base64url');
  const r = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${cuerpo}.${firma}`,
  }));
  token = r.data.access_token; tokenExp = Date.now() + r.data.expires_in * 1000;
  return token;
}
const api = async (method, url, data) => (await axios({ method, url: 'https://www.googleapis.com/calendar/v3' + url, data, headers: { Authorization: `Bearer ${await obtenerToken()}` } })).data;

function calendarioDe(linea) { return linea === 'academy' ? (CAL.academy || CAL.servicios) : (CAL.servicios || CAL.academy); }

// Lima = UTC-5 sin horario de verano
const limaAUTC = (y, m, d, h, min = 0) => new Date(Date.UTC(y, m - 1, d, h + 5, min));
const partesLima = dt => { const l = new Date(dt.getTime() - 5 * 3600000); return { y: l.getUTCFullYear(), m: l.getUTCMonth() + 1, d: l.getUTCDate(), h: l.getUTCHours(), dow: l.getUTCDay() }; };
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

// Bloques libres (lun-sáb, HORA_INI–HORA_FIN) en los próximos `dias`, mirando los 3 calendarios
async function libres(dias = 7, duracionMin = 60, max = 6) {
  if (!activo) return [];
  try {
    const desde = new Date(), hasta = new Date(Date.now() + dias * 86400000);
    const items = [CAL.principal, CAL.servicios, CAL.academy].filter(Boolean).map(id => ({ id }));
    const fb = await api('post', '/freeBusy', { timeMin: desde.toISOString(), timeMax: hasta.toISOString(), timeZone: TZ, items });
    const ocupado = Object.values(fb.calendars || {}).flatMap(c => (c.busy || []).map(b => [new Date(b.start), new Date(b.end)]));
    const out = [];
    for (let i = 1; i <= dias && out.length < max; i++) {
      const p = partesLima(new Date(Date.now() + i * 86400000));
      if (p.dow === 0) continue;
      const fin = p.dow === 6 ? Math.min(HORA_FIN, 13) : HORA_FIN;
      let porDia = 0;
      for (let h = HORA_INI; h + duracionMin / 60 <= fin && porDia < 2 && out.length < max; h++) {
        const a = limaAUTC(p.y, p.m, p.d, h), b = new Date(a.getTime() + duracionMin * 60000);
        if (ocupado.some(([x, y]) => a < y && b > x)) continue;
        out.push(`${DIAS[p.dow]} ${p.d}/${p.m} ${String(h).padStart(2, '0')}:00`); porDia++; h += 2;
      }
    }
    return out;
  } catch (e) { ultimoErr = e.response?.data?.error?.message || e.response?.data?.error_description || e.message; console.error('Calendar libres:', e.response?.data || e.message); return []; }
}

// inicio: "YYYY-MM-DDTHH:MM" hora Lima
async function crearEvento({ linea, titulo, inicio, duracionMin = 60, descripcion = '', lugar = '' }) {
  if (!activo) return null;
  const [f, hm] = inicio.split('T'); const [y, m, d] = f.split('-').map(Number); const [h, mi] = hm.split(':').map(Number);
  const a = limaAUTC(y, m, d, h, mi), b = new Date(a.getTime() + duracionMin * 60000);
  try {
    return await api('post', `/calendars/${encodeURIComponent(calendarioDe(linea))}/events`, {
      summary: titulo, description: descripcion, location: lugar,
      start: { dateTime: a.toISOString(), timeZone: TZ }, end: { dateTime: b.toISOString(), timeZone: TZ },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 1440 }] },
    });
  } catch (e) { ultimoErr = e.response?.data?.error?.message || e.message; console.error('Calendar crear:', e.response?.data || e.message); return null; }
}

module.exports = { activo, libres, crearEvento, calendarioDe, ultimoError: () => ultimoErr };
