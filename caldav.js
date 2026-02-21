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
 * Given a server host and credentials, return the URL of the user's calendar collection.
 * Tries multiple strategies so it works with Strato, iCloud, Google, etc.
 */
async function discoverCalendarUrl({ serverHost, username, password }) {
  const base   = `https://${serverHost}`;
  const encUser = encodeURIComponent(username); // info%40vonkenvorm.com
  const log = [];

  // ── Strategy 1: direct known URL patterns (Strato SabreDAV) ──────────────
  // Try BOTH literal @ and encoded @ because Strato accepts either.
  const directCandidates = [
    `${base}/caldav/v2/${username}/calendar/`,
    `${base}/caldav/v2/${encUser}/calendar/`,
    `${base}/caldav/v2/${username}/`,
    `${base}/calendars/${username}/`,
    `${base}/calendars/${encUser}/`,
  ];

  for (const url of directCandidates) {
    try {
      const r = await httpRequest({
        method: 'PROPFIND', url, username, password,
        extraHeaders: { Depth: '0' },
        body: PROPFIND_RESOURCETYPE,
      });
      console.log(`[CalDAV] PROPFIND ${url} → ${r.status}`);
      if (r.status === 207) return url;
      if (r.status === 401) throw new Error('Authenticatie mislukt (401). Controleer gebruikersnaam en wachtwoord.');
    } catch (e) {
      if (e.message.includes('401')) throw e;
      log.push(`${url}: ${e.message}`);
    }
  }

  // ── Strategy 2: well-known with redirect following ────────────────────────
  try {
    let url = `${base}/.well-known/caldav`;
    for (let hop = 0; hop < 5; hop++) {
      const r = await httpRequest({
        method: 'PROPFIND', url, username, password,
        extraHeaders: { Depth: '0' },
        body: PROPFIND_RESOURCETYPE,
      });
      console.log(`[CalDAV] well-known hop ${hop}: ${url} → ${r.status}`);
      if (r.status === 207) { url = await resolveToCalendar(url, r.body, username, password); return url; }
      if (r.status === 301 || r.status === 302 || r.status === 308) {
        const loc = r.headers.location;
        if (!loc) break;
        url = loc.startsWith('http') ? loc : new URL(loc, base).href;
      } else { break; }
    }
  } catch (e) { log.push(`well-known: ${e.message}`); }

  // ── Strategy 3: principal discovery ──────────────────────────────────────
  const principalCandidates = [
    `${base}/principals/${username}/`,
    `${base}/principals/${encUser}/`,
    `${base}/principals/users/${username}/`,
    `${base}/principals/users/${encUser}/`,
  ];

  for (const pUrl of principalCandidates) {
    try {
      const calHome = await getCalendarHomeFromPrincipal(pUrl, username, password, base);
      if (calHome) {
        console.log(`[CalDAV] calendar-home-set: ${calHome}`);
        return calHome;
      }
    } catch (e) { log.push(`${pUrl}: ${e.message}`); }
  }

  throw new Error(
    `Kon geen kalender vinden op ${serverHost}.\n` +
    `Open DevTools (Ctrl+Shift+I) voor details.\n` +
    log.slice(0, 3).join('\n')
  );
}

/**
 * PROPFIND a principal URL and extract the calendar-home-set href.
 * Bug fix: extract href from INSIDE <calendar-home-set>, not the first href overall.
 */
async function getCalendarHomeFromPrincipal(principalUrl, username, password, base) {
  const res = await httpRequest({
    method: 'PROPFIND', url: principalUrl, username, password,
    extraHeaders: { Depth: '0' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`,
  });
  console.log(`[CalDAV] principal ${principalUrl} → ${res.status}`);
  if (res.status !== 207) return null;

  // Extract href specifically from inside <calendar-home-set> — not the first href in the doc
  const calHomeBlock = /<[^:>]*:?calendar-home-set[^>]*>([\s\S]*?)<\/[^:>]*:?calendar-home-set>/i.exec(res.body);
  if (!calHomeBlock) return null;
  const href = xmlText(calHomeBlock[1], 'href');
  if (!href) return null;

  const u = new URL(base);
  return href.startsWith('http') ? href : `${u.protocol}//${u.host}${href}`;
}

/**
 * When we got a 207 from a non-collection URL, resolve it to the actual calendar.
 */
async function resolveToCalendar(url, body, username, password) {
  // If the response contains a calendar-home-set, follow it
  const calHomeBlock = /<[^:>]*:?calendar-home-set[^>]*>([\s\S]*?)<\/[^:>]*:?calendar-home-set>/i.exec(body);
  if (calHomeBlock) {
    const href = xmlText(calHomeBlock[1], 'href');
    if (href) {
      const u = new URL(url);
      const homeUrl = href.startsWith('http') ? href : `${u.protocol}//${u.host}${href}`;
      return await firstCalendarCollection(homeUrl, username, password) || homeUrl;
    }
  }
  return url;
}

async function firstCalendarCollection(homeUrl, username, password) {
  const res = await httpRequest({
    method: 'PROPFIND', url: homeUrl, username, password,
    extraHeaders: { Depth: '1' },
    body: PROPFIND_RESOURCETYPE,
  });
  if (res.status !== 207) return homeUrl;

  // Split into response blocks; find first one with calendar resourcetype that isn't the home itself
  const blocks = res.body.split(/<[^:>]*:?response[^>]*>/i).slice(1);
  const homeU = new URL(homeUrl);

  for (const block of blocks) {
    if (!block.includes('calendar')) continue;  // fast skip
    const hm = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i.exec(block);
    if (!hm) continue;
    const href = hm[1].trim();
    if (href === homeU.pathname || href === homeUrl) continue; // skip home itself
    const absUrl = href.startsWith('http') ? href : `${homeU.protocol}//${homeU.host}${href}`;
    console.log(`[CalDAV] Found calendar collection: ${absUrl}`);
    return absUrl;
  }
  return homeUrl;
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;

const PROPFIND_RESOURCETYPE = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:displayname/></D:prop></D:propfind>`;

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
    extraHeaders: { Depth: '1' },
    body,
  });

  console.log(`[CalDAV] REPORT ${calendarUrl} → ${res.status}`);
  if (res.status === 207) return parseMultiStatus(res.body);

  // Some servers need the calendar URL without trailing slash, or need different depth
  if (res.status === 400 || res.status === 403 || res.status === 501) {
    // Fall back: fetch all events without time-range filter
    const bodyAll = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>
</C:calendar-query>`;
    const res2 = await httpRequest({
      method: 'REPORT', url: calendarUrl, username, password,
      extraHeaders: { Depth: '1' }, body: bodyAll,
    });
    console.log(`[CalDAV] REPORT (no time-range) → ${res2.status}`);
    if (res2.status === 207) return parseMultiStatus(res2.body);
  }

  throw new Error(`CalDAV REPORT mislukt: HTTP ${res.status}. URL: ${calendarUrl}`);
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
