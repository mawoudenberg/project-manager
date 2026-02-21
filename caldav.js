'use strict';

/**
 * Minimal CalDAV client + iCalendar parser/generator.
 * Uses only Node.js built-ins — no extra npm packages needed.
 */

const https = require('https');
const http  = require('http');

// ─── HTTP primitive ───────────────────────────────────────────────────────────

function httpRequest({ method, url: href, username, password, extraHeaders = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const u    = new URL(href);
    const mod  = u.protocol === 'https:' ? https : http;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const buf  = Buffer.from(body, 'utf8');

    const options = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method,
      headers: {
        'Authorization':  'Basic ' + auth,
        'Content-Type':   'application/xml; charset=utf-8',
        'Content-Length': buf.length,
        ...extraHeaders,
      },
    };

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (buf.length) req.write(buf);
    req.end();
  });
}

// ─── CalDAV discovery ─────────────────────────────────────────────────────────

/**
 * Given a server host (e.g. "dav.strato.de") and credentials,
 * return the URL of the user's default calendar collection.
 */
async function discoverCalendarUrl({ serverHost, username, password }) {
  const base = `https://${serverHost}`;

  // 1. Try well-known autodiscovery → principal → calendar-home
  try {
    const wellKnown = `${base}/.well-known/caldav`;
    const redir = await httpRequest({ method: 'PROPFIND', url: wellKnown, username, password, body: PROPFIND_PRINCIPAL });
    if (redir.status === 301 || redir.status === 302 || redir.status === 207) {
      const principal = redir.headers.location || wellKnown;
      const home = await getPrincipalHomeUrl(principal, username, password);
      if (home) return await firstCalendarCollection(home, username, password);
    }
  } catch (_) {}

  // 2. Try Strato-style /principals/{user}
  try {
    const principalUrl = `${base}/principals/${encodeURIComponent(username)}/`;
    const home = await getPrincipalHomeUrl(principalUrl, username, password);
    if (home) return await firstCalendarCollection(home, username, password) || home;
  } catch (_) {}

  // 3. Try common Strato CalDAV path patterns
  const candidates = [
    `${base}/caldav/v2/${encodeURIComponent(username)}/calendar/`,
    `${base}/caldav/${encodeURIComponent(username)}/calendar/`,
    `${base}/${encodeURIComponent(username)}/`,
  ];
  for (const url of candidates) {
    try {
      const r = await httpRequest({ method: 'PROPFIND', url, username, password, extraHeaders: { Depth: '0' }, body: PROPFIND_PRINCIPAL });
      if (r.status === 207 || r.status === 200) return url;
    } catch (_) {}
  }

  throw new Error(`Kon geen kalender vinden op ${serverHost}. Controleer de instellingen.`);
}

async function getPrincipalHomeUrl(principalUrl, username, password) {
  const res = await httpRequest({
    method: 'PROPFIND', url: principalUrl, username, password,
    extraHeaders: { Depth: '0' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`,
  });
  const href = xmlText(res.body, 'href');
  if (!href) return null;
  const u = new URL(principalUrl);
  return href.startsWith('http') ? href : `${u.protocol}//${u.host}${href}`;
}

async function firstCalendarCollection(homeUrl, username, password) {
  const res = await httpRequest({
    method: 'PROPFIND', url: homeUrl, username, password,
    extraHeaders: { Depth: '1' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:resourcetype/><D:displayname/></D:prop>
</D:propfind>`,
  });

  // Find first href that is a calendar collection (not the home itself)
  const hrefRe = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/gi;
  const calendarRe = /calendar(?!-home)/i;
  const responses = res.body.split(/<[^:>]*:?response[^>]*>/i).slice(1);

  for (const block of responses) {
    const hm = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i.exec(block);
    if (!hm) continue;
    const href = hm[1].trim();
    // Skip the home collection itself
    const homeU = new URL(homeUrl);
    if (href === homeU.pathname || href === homeUrl) continue;
    // Must contain calendar resource type OR look like a calendar path
    if (block.includes('calendar') || calendarRe.test(href)) {
      const u = new URL(homeUrl);
      return href.startsWith('http') ? href : `${u.protocol}//${u.host}${href}`;
    }
  }
  return homeUrl; // fall back to home
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;

// ─── Fetch events (CalDAV REPORT) ─────────────────────────────────────────────

async function fetchEvents({ calendarUrl, username, password, monthsBack = 1, monthsAhead = 6 }) {
  const now   = new Date();
  const start = new Date(now); start.setMonth(start.getMonth() - monthsBack);
  const end   = new Date(now); end.setMonth(end.getMonth() + monthsAhead);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${toStamp(start)}" end="${toStamp(end)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const res = await httpRequest({
    method: 'REPORT', url: calendarUrl, username, password,
    extraHeaders: { Depth: '1', Prefer: 'return-minimal' },
    body,
  });

  if (res.status !== 207) throw new Error(`CalDAV REPORT mislukt: HTTP ${res.status}`);
  return parseMultiStatus(res.body);
}

// ─── Push event (CalDAV PUT) ──────────────────────────────────────────────────

async function putEvent({ calendarUrl, username, password, uid, icsContent }) {
  const url = calendarUrl.replace(/\/$/, '') + '/' + uid + '.ics';
  const res = await httpRequest({
    method: 'PUT', url, username, password,
    extraHeaders: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Length': Buffer.byteLength(icsContent, 'utf8') },
    body: icsContent,
  });
  return { status: res.status, etag: res.headers.etag || '' };
}

// ─── Delete event (CalDAV DELETE) ─────────────────────────────────────────────

async function deleteEvent({ calendarUrl, username, password, uid }) {
  const url = calendarUrl.replace(/\/$/, '') + '/' + uid + '.ics';
  const res = await httpRequest({ method: 'DELETE', url, username, password, body: '' });
  return { status: res.status };
}

// ─── iCalendar parser ─────────────────────────────────────────────────────────

function parseMultiStatus(xml) {
  const results = [];
  // Split XML into per-response blocks
  const re = /<[^:>]*:?response[^>]*>([\s\S]*?)<\/[^:>]*:?response>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const calMatch = /<[^:>]*:?calendar-data[^>]*>([\s\S]*?)<\/[^:>]*:?calendar-data>/i.exec(block);
    if (!calMatch) continue;
    const hrefMatch = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i.exec(block);
    const etagMatch = /<[^:>]*:?getetag[^>]*>"?([^<"]*)"?<\/[^:>]*:?getetag>/i.exec(block);
    results.push({
      href: hrefMatch?.[1]?.trim() || '',
      etag: etagMatch?.[1]?.trim() || '',
      ics:  calMatch[1],
    });
  }
  return results;
}

/**
 * Parse iCalendar text into an array of VEVENT property objects.
 */
function parseICS(icsText) {
  // Unfold continuation lines
  const text = icsText.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  const events = [];
  const veventRe = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
  let m;
  while ((m = veventRe.exec(text)) !== null) {
    const ev = {};
    const lineRe = /^([A-Z][A-Z0-9\-]*(?:;[^\n:]+)?):(.*)$/gm;
    let lm;
    while ((lm = lineRe.exec(m[1])) !== null) {
      const rawKey = lm[1];
      const baseKey = rawKey.split(';')[0];
      const val = lm[2]
        .replace(/\\n/g, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\');
      ev[baseKey] = val;
      // Also store params (e.g. DTSTART;VALUE=DATE)
      ev['_params_' + baseKey] = rawKey.includes(';') ? rawKey.split(';').slice(1).join(';') : '';
    }
    if (ev.UID) events.push(ev);
  }
  return events;
}

/**
 * Extract a date string (YYYY-MM-DD) from a DTSTART iCalendar value.
 */
function parseDTSTART(val) {
  if (!val) return null;
  // DATE format: YYYYMMDD
  if (/^\d{8}$/.test(val)) {
    return `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}`;
  }
  // DateTime format: YYYYMMDDTHHmmss[Z]
  if (val.length >= 15 && val[8] === 'T') {
    return `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}`;
  }
  return null;
}

// ─── iCalendar generator ──────────────────────────────────────────────────────

/**
 * Generate iCalendar (.ics) content for a single all-day task event.
 */
function generateICS({ uid, title, description, date, status }) {
  const stamp   = toStamp(new Date());
  const dateVal = (date || toDate(new Date())).replace(/-/g, '');
  const dateEnd = incDate(date || toDate(new Date())).replace(/-/g, '');
  const icalStatus = status === 'done' ? 'CANCELLED' : 'CONFIRMED';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vonk & Vorm Project Manager//NL',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dateVal}`,
    `DTEND;VALUE=DATE:${dateEnd}`,
    `SUMMARY:${escICS(title)}`,
    description ? `DESCRIPTION:${escICS(description)}` : null,
    `STATUS:${icalStatus}`,
    `LAST-MODIFIED:${stamp}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  return lines.join('\r\n') + '\r\n';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toStamp(date) {
  return date.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

function toDate(date) {
  return date.toISOString().slice(0, 10);
}

function incDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function escICS(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g,  '\\;')
    .replace(/,/g,  '\\,')
    .replace(/\n/g, '\\n');
}

function xmlText(xml, tag) {
  const re = new RegExp(`<[^:>]*:?${tag}[^>]*>([^<]*)<\\/[^:>]*:?${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

module.exports = {
  discoverCalendarUrl,
  fetchEvents,
  putEvent,
  deleteEvent,
  parseICS,
  parseDTSTART,
  generateICS,
};
