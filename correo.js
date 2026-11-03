// Lectura del correo de la empresa (IMAP, solo lectura) para detectar plazos y compromisos
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const HOST = process.env.IMAP_HOST || 'mail.proytechautomation.com';
const USER = process.env.IMAP_USER || '';
const PASS = process.env.IMAP_PASS || '';
const activo = !!(USER && PASS);
const BUZONES = (process.env.IMAP_BUZONES || 'INBOX,INBOX.Sent').split(',').map(s => s.trim());
const RUIDO = /no-?reply|newsletter|marketing|mailer-daemon|notifications?@|news@|promo|webinar/i;

// Devuelve correos recibidos/enviados desde `desde` (Date): [{id, buzon, de, para, asunto, fecha, texto}]
async function correosDesde(desde, max = 25) {
  if (!activo) return [];
  const cli = new ImapFlow({ host: HOST, port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
  const out = [];
  try {
    await cli.connect();
    for (const buzon of BUZONES) {
      const lock = await cli.getMailboxLock(buzon);
      try {
        const uids = (await cli.search({ since: desde }, { uid: true })) || [];
        for (const uid of uids.slice(-max)) {
          const m = await cli.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!m?.source) continue;
          const de = m.envelope?.from?.[0]?.address || '';
          if (RUIDO.test(de) || RUIDO.test(m.envelope?.subject || '')) continue;
          const p = await simpleParser(m.source);
          if (p.date && p.date < desde) continue;
          const texto = (p.text || '').split(/\n\s*(De|From):\s/)[0].slice(0, 3500); // solo el último mensaje del hilo
          out.push({ id: p.messageId || `${buzon}:${uid}`, buzon, de, para: (m.envelope?.to || []).map(t => t.address).join(', '), asunto: p.subject || '', fecha: p.date, texto });
        }
      } finally { lock.release(); }
    }
  } catch (e) { console.error('IMAP:', e.message); }
  finally { try { await cli.logout(); } catch (_) {} }
  return out;
}

// Diagnóstico: solo conecta y cuenta (sin contenido)
async function probar() {
  if (!activo) return { ok: false, error: 'sin credenciales' };
  const cli = new ImapFlow({ host: HOST, port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
  try { await cli.connect(); const st = await cli.status('INBOX', { messages: true }); return { ok: true, mensajes_inbox: st.messages }; }
  catch (e) { return { ok: false, error: e.authenticationFailed ? 'usuario o contraseña incorrectos' : e.message }; }
  finally { try { await cli.logout(); } catch (_) {} }
}

module.exports = { activo, correosDesde, probar };
