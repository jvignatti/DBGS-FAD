// Pure helpers shared by the browser page (app.js) and Node scripts/tests.
// No DOM, no network.

export const TZ = 'America/New_York';
const RUN_HOUR_ET = 7; // schedule: 07:00 America/New_York, Monday-Friday
const GRACE_MS = 3 * 60 * 60 * 1000; // allowance for GitHub schedule delays

// ---- Search (local only; never sent anywhere) ----
export function normalizeForSearch(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2019\u2018\u02bc`\u00b4]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function filterRecords(records, query) {
  const q = normalizeForSearch(query);
  if (!q) return records;
  return records.filter((r) => normalizeForSearch(r.name).includes(q));
}

// ---- Eastern-time helpers (DST-aware via Intl) ----
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function etParts(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, weekday: p.weekday };
}

function offsetMs(date) {
  const p = etParts(date);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(date.getTime() / 1000) * 1000;
}

export function etToUtc(y, m, d, hh, mm) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall - offsetMs(new Date(wall));
  t = wall - offsetMs(new Date(t)); // re-evaluate at the candidate instant (DST edges)
  return new Date(t);
}

const pad = (n) => String(n).padStart(2, '0');

export function pdfFilename(retrievedAt) {
  const p = etParts(retrievedAt);
  return `Vermont_BGS_Debarment_${p.y}-${pad(p.m)}-${pad(p.d)}_${pad(p.hh)}${pad(p.mm)}.pdf`;
}

const humanFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
export function formatEt(date) {
  // "Nov 25, 2026, 7:05 AM EST" (normalize the narrow no-break space some engines emit)
  return humanFmt.format(date).replace(/[\u00a0\u202f]/g, ' ');
}

// ---- Staleness (decision D5) ----
// Most recent scheduled run (weekday 07:00 ET) at or before `at`.
export function lastExpectedRun(at) {
  let { y, m, d } = etParts(at);
  for (let i = 0; i < 10; i++) {
    const cand = etToUtc(y, m, d, RUN_HOUR_ET, 0);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun .. 6 Sat
    if (dow !== 0 && dow !== 6 && cand.getTime() <= at.getTime()) return cand;
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    y = prev.getUTCFullYear(); m = prev.getUTCMonth() + 1; d = prev.getUTCDate();
  }
  throw new Error('lastExpectedRun: no weekday found');
}

// 'none' = never succeeded; 'ok'; 'stale' = one expected run missed (beyond grace);
// 'critical' = two or more missed.
export function stalenessLevel(lastSuccess, now) {
  if (!lastSuccess) return 'none';
  let run = lastExpectedRun(new Date(now.getTime() - GRACE_MS));
  let missed = 0;
  while (run.getTime() > lastSuccess.getTime() && missed < 2) {
    missed++;
    run = lastExpectedRun(new Date(run.getTime() - 1));
  }
  return missed === 0 ? 'ok' : missed === 1 ? 'stale' : 'critical';
}
