'use strict';
if (typeof window.api === 'undefined') {
  window.__WEB_MODE__ = true;

  async function _fetch(url, opts = {}) {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  window.api = {
    dbQuery:        (p)    => _fetch('/api/query', { method: 'POST', body: p }),
    configGet:      ()     => Promise.resolve(JSON.parse(localStorage.getItem('pm-config') || 'null')),
    configSet:      (cfg)  => {
      const prev = JSON.parse(localStorage.getItem('pm-config') || '{}');
      localStorage.setItem('pm-config', JSON.stringify({ ...prev, ...cfg }));
      return Promise.resolve({ ok: true });
    },
    openFolder:     ()     => Promise.resolve(null),
    refresh:        ()     => Promise.resolve({ ok: true }),
    apiFetch:       (o)    => _fetch(o.url, { method: o.method, body: o.body, headers: o.headers }),
    exportPdf:      (html) => {
      const w = window.open('', '_blank');
      w.document.write(html); w.document.close();
      setTimeout(() => { w.focus(); w.print(); }, 400);
      return Promise.resolve({ ok: true });
    },
    // In browser mode PDF bytes can't be generated via Electron IPC — return null
    // so the API-mode path in exportQuotePdf gracefully shows an error toast.
    generatePdf:    ()     => Promise.resolve(null),
    getLogoDataUrl: ()     => _fetch('/api/logo').then(d => d.url),
    onUpdateAvailable: ()  => {},
    openUrl:        (url)  => { window.open(url, '_blank'); return Promise.resolve(); },
    openPath:       ()     => Promise.resolve(), // not available in browser
    downloadUrl:    (url)  => { window.open(url, '_blank'); return Promise.resolve(); },
    onDbChanged:    ()     => {},   // api polling in app.js covers this
  };
}
