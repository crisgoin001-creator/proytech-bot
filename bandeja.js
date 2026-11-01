// Bandeja privada: ver conversaciones y responder desde el navegador (celular o PC).
// Acceso: https://proytech-bot.onrender.com/bandeja?key=INBOX_KEY
const express = require('express');

const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fecha = d => d ? new Date(d).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

function pagina(titulo, cuerpo, refrescar) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refrescar ? `<meta http-equiv="refresh" content="${refrescar}">` : ''}<meta name="robots" content="noindex">
<title>${esc(titulo)}</title><style>
:root{--bg:#f4f6f8;--card:#fff;--tx:#1d2733;--mut:#6b7785;--pri:#0b6e4f;--cli:#fff;--bot:#dcf3e8;--bd:#e3e8ee}
@media (prefers-color-scheme:dark){:root{--bg:#11161c;--card:#1a222b;--tx:#e6edf3;--mut:#93a1b0;--pri:#3ccf91;--cli:#1f2a35;--bot:#16392b;--bd:#2a3541}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
header{background:var(--pri);color:#fff;padding:12px 16px;font-weight:600}header a{color:#fff;text-decoration:none}
main{max-width:760px;margin:0 auto;padding:12px 16px}
.item{display:block;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin:8px 0;color:inherit;text-decoration:none}
.fila{display:flex;justify-content:space-between;gap:8px}.mut{color:var(--mut);font-size:13px}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--bd);margin-right:4px}
.msg{max-width:85%;padding:8px 10px;border-radius:10px;margin:6px 0;white-space:pre-wrap;border:1px solid var(--bd)}
.user{background:var(--cli)}.assistant{background:var(--bot);margin-left:auto}
form{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px;margin-top:12px}
textarea{width:100%;min-height:80px;border:1px solid var(--bd);border-radius:8px;padding:8px;background:var(--bg);color:var(--tx);font:inherit}
button{background:var(--pri);color:#fff;border:0;border-radius:8px;padding:9px 14px;font-weight:600;margin-top:8px;cursor:pointer}
.sec{background:transparent;color:var(--pri);border:1px solid var(--pri)}
</style></head><body>${cuerpo}</body></html>`;
}

module.exports = function montarBandeja(app, ctx) {
  const { db, sesiones, obtenerSesion, guardarSesion, responderManual, INBOX_KEY, PAUSA_HORAS } = ctx;
  const ok = req => INBOX_KEY && (req.query.key === INBOX_KEY || req.body?.key === INBOX_KEY);
  const k = encodeURIComponent(INBOX_KEY);
  app.use('/bandeja', express.urlencoded({ extended: false }));

  app.get('/bandeja', async (req, res) => {
    if (!ok(req)) return res.sendStatus(403);
    const chats = db.activo ? await db.listarChats()
      : [...sesiones.values()].map(s => ({ tel: s.tel, nombre: s.nombre, linea: s.linea, etapa: s.etapa, origen: s.origen, resumen: s.resumen, actualizado: s.actualizado, pausado_hasta: s.pausadoHasta, pendiente: s.pendiente }));
    const items = chats.map(c => {
      const pausado = c.pausado_hasta && Date.parse(c.pausado_hasta) > Date.now();
      return `<a class="item" href="/bandeja/chat?tel=${esc(c.tel)}&key=${k}">
        <div class="fila"><strong>${esc(c.nombre || '+' + c.tel)}</strong><span class="mut">${fecha(c.actualizado)}</span></div>
        <div class="mut">+${esc(c.tel)}</div>
        <div><span class="tag">${esc(c.linea || '—')}</span><span class="tag">${esc(c.etapa || '')}</span><span class="tag">${esc(c.origen || '')}</span>${c.pendiente ? '<span class="tag">❓ consulta</span>' : ''}${pausado ? '<span class="tag">✋ tú atiendes</span>' : ''}</div>
        ${c.resumen ? `<div class="mut">${esc(c.resumen)}</div>` : ''}</a>`;
    }).join('');
    res.send(pagina('Bandeja ProyTech', `<header>📥 Bandeja ProyTech · ${chats.length} chats</header><main>${items || '<p class="mut">Aún no hay conversaciones.</p>'}</main>`, 60));
  });

  app.get('/bandeja/chat', async (req, res) => {
    if (!ok(req)) return res.sendStatus(403);
    const tel = String(req.query.tel || '').replace(/\D/g, '');
    const s = await obtenerSesion(tel);
    const msgs = db.activo ? await db.cargarMensajes(tel, 60) : s.historial;
    const pausado = s.pausadoHasta && s.pausadoHasta > Date.now();
    const burbujas = msgs.map(m => `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">${esc(m.content)}</div>`).join('');
    res.send(pagina(`Chat +${tel}`, `<header><a href="/bandeja?key=${k}">← Bandeja</a> · ${esc(s.nombre || '+' + tel)}</header><main>
      <div class="mut">+${esc(tel)} · ${esc(s.linea || '—')} · ${esc(s.etapa)} · origen ${esc(s.origen || '')} ${pausado ? '· ✋ bot en pausa hasta ' + fecha(s.pausadoHasta) : '· 🤖 bot activo'}</div>
      ${burbujas || '<p class="mut">Sin mensajes guardados.</p>'}
      <form method="post" action="/bandeja/responder"><input type="hidden" name="key" value="${esc(INBOX_KEY)}"><input type="hidden" name="tel" value="${esc(tel)}">
        <textarea name="texto" placeholder="Escribe tu respuesta (se envía tal cual y el bot se pausa ${PAUSA_HORAS} h en este chat)" required></textarea>
        <button type="submit">Enviar como ProyTech</button></form>
      <form method="post" action="/bandeja/bot"><input type="hidden" name="key" value="${esc(INBOX_KEY)}"><input type="hidden" name="tel" value="${esc(tel)}">
        <input type="hidden" name="accion" value="${pausado ? 'activar' : 'pausar'}">
        <button class="sec" type="submit">${pausado ? '🤖 Devolver el chat al bot' : '✋ Pausar bot en este chat'}</button></form>
    </main>`));
  });

  app.post('/bandeja/responder', async (req, res) => {
    if (!ok(req)) return res.sendStatus(403);
    const tel = String(req.body.tel || '').replace(/\D/g, '');
    const texto = String(req.body.texto || '').trim();
    if (tel && texto) await responderManual(tel, texto, false);
    res.redirect(`/bandeja/chat?tel=${tel}&key=${k}`);
  });

  app.post('/bandeja/bot', async (req, res) => {
    if (!ok(req)) return res.sendStatus(403);
    const tel = String(req.body.tel || '').replace(/\D/g, '');
    const s = await obtenerSesion(tel);
    s.pausadoHasta = req.body.accion === 'pausar' ? Date.now() + PAUSA_HORAS * 36e5 : null;
    await guardarSesion(s);
    res.redirect(`/bandeja/chat?tel=${tel}&key=${k}`);
  });
};
