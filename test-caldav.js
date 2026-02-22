'use strict';

/**
 * CalDAV end-to-end test script.
 * Usage: node test-caldav.js <host> <username> <password>
 * Example: node test-caldav.js caldav.icloud.com naam@icloud.com <app-wachtwoord>
 */

const { discoverCalendarUrl, fetchEvents, putEvent, deleteEvent, generateICS } = require('./caldav');

const [,, serverHost, username, password] = process.argv;
if (!serverHost || !username || !password) {
  console.error('Usage: node test-caldav.js <host> <username> <password>');
  process.exit(1);
}

const TEST_UID = `caldav-test-${Date.now()}@test`;
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';

async function run() {
  let calendarUrl;
  let initialCount = 0;
  let allPassed = true;

  function result(label, ok, detail = '') {
    console.log(`${ok ? PASS : FAIL}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) allPassed = false;
  }

  // ── Step 1: Discover calendar URL ────────────────────────────────────────────
  try {
    calendarUrl = await discoverCalendarUrl({ serverHost, username, password });
    result('Discover calendar URL', true, calendarUrl);
  } catch (e) {
    result('Discover calendar URL', false, e.message);
    process.exit(1);
  }

  // ── Step 2: Fetch events (baseline count) ────────────────────────────────────
  try {
    const events = await fetchEvents({ calendarUrl, username, password });
    initialCount = events.length;
    result('Fetch events (baseline)', true, `${initialCount} event(s)`);
  } catch (e) {
    result('Fetch events (baseline)', false, e.message);
  }

  // ── Step 3: Push a test event ─────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const icsContent = generateICS({
    uid:   TEST_UID,
    title: 'CalDAV test – delete me',
    date:  today,
  });

  try {
    const { status } = await putEvent({ calendarUrl, username, password, uid: TEST_UID, icsContent });
    result('Push test event (PUT)', true, `HTTP ${status}`);
  } catch (e) {
    result('Push test event (PUT)', false, e.message);
    // If push fails we can't verify or clean up — exit early
    process.exit(1);
  }

  // ── Step 4: Fetch events again and verify test event is present ───────────────
  let testEventFound = false;
  try {
    const events = await fetchEvents({ calendarUrl, username, password });
    testEventFound = events.some(ev => (ev.href || '').includes(encodeURIComponent(TEST_UID)) || (ev.ics || '').includes(TEST_UID));
    result(
      'Verify test event present',
      testEventFound,
      `${events.length} event(s) total${testEventFound ? '' : ' — test event not found'}`,
    );
  } catch (e) {
    result('Verify test event present', false, e.message);
  }

  // ── Step 5: Delete the test event ────────────────────────────────────────────
  try {
    const { status } = await deleteEvent({ calendarUrl, username, password, uid: TEST_UID });
    const ok = status === 200 || status === 204 || status === 404;
    result('Delete test event (DELETE)', ok, `HTTP ${status}`);
  } catch (e) {
    result('Delete test event (DELETE)', false, e.message);
  }

  console.log(`\nOverall: ${allPassed ? PASS + '  all steps passed' : FAIL + '  some steps failed'}`);
  process.exit(allPassed ? 0 : 1);
}

run().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
