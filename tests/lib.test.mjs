import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForSearch, filterRecords, etToUtc, pdfFilename, formatEt, lastExpectedRun, stalenessLevel } from '../site/lib.js';

const Z = (s) => new Date(s);
const recs = [
  { name: 'Valley Floor’s, Inc.', expiration_term: '10/16/2028' },
  { name: "Delair's Carpet Barn", expiration_term: '03/31/2027' },
  { name: 'Two Sisters Mill & Mercantile LLC', expiration_term: '12/26/2026' },
];

test('search: straight apostrophe finds curly, case-insensitive, display text untouched', () => {
  const out = filterRecords(recs, "valley FLOOR'S");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Valley Floor’s, Inc.');
});

test('search: curly apostrophe finds straight; empty query returns all in order', () => {
  assert.equal(filterRecords(recs, 'Delair’s').length, 1);
  assert.deepEqual(filterRecords(recs, '   '), recs);
});

test('search: accents and whitespace normalized; no match returns empty', () => {
  assert.equal(normalizeForSearch('  Café   Co '), 'cafe co');
  assert.deepEqual(filterRecords(recs, 'zzz'), []);
});

test('etToUtc handles EST and EDT around the Nov 2026 switch', () => {
  assert.equal(etToUtc(2026, 10, 30, 7, 0).toISOString(), '2026-10-30T11:00:00.000Z'); // EDT
  assert.equal(etToUtc(2026, 11, 2, 7, 0).toISOString(), '2026-11-02T12:00:00.000Z'); // EST
  assert.equal(etToUtc(2027, 3, 15, 7, 0).toISOString(), '2027-03-15T11:00:00.000Z'); // EDT again
});

test('pdfFilename uses retrieval time in ET, 24h', () => {
  assert.equal(pdfFilename(Z('2026-11-25T12:05:00Z')), 'Vermont_BGS_Debarment_2026-11-25_0705.pdf');
  assert.equal(pdfFilename(Z('2027-03-15T11:00:00Z')), 'Vermont_BGS_Debarment_2027-03-15_0700.pdf');
  assert.equal(pdfFilename(Z('2026-11-25T23:30:00Z')), 'Vermont_BGS_Debarment_2026-11-25_1830.pdf');
});

test('formatEt is human readable with zone', () => {
  assert.equal(formatEt(Z('2026-11-25T12:05:00Z')), 'Nov 25, 2026, 7:05 AM EST');
});

test('lastExpectedRun skips weekends', () => {
  // Sunday 2026-11-22 noon ET -> Friday 2026-11-20 07:00 ET
  assert.equal(lastExpectedRun(Z('2026-11-22T17:00:00Z')).toISOString(), '2026-11-20T12:00:00.000Z');
  // Monday 06:59 ET -> still Friday
  assert.equal(lastExpectedRun(Z('2026-11-23T11:59:00Z')).toISOString(), '2026-11-20T12:00:00.000Z');
  // Monday 07:00 ET exactly -> Monday
  assert.equal(lastExpectedRun(Z('2026-11-23T12:00:00Z')).toISOString(), '2026-11-23T12:00:00.000Z');
});

const friSuccess = Z('2026-11-20T12:02:00Z'); // Fri 07:02 ET
test('staleness: weekend + Monday within grace is ok', () => {
  assert.equal(stalenessLevel(friSuccess, Z('2026-11-22T17:00:00Z')), 'ok');
  assert.equal(stalenessLevel(friSuccess, Z('2026-11-23T14:00:00Z')), 'ok'); // Mon 09:00 ET
});
test('staleness: Monday run missed beyond 3h grace is stale', () => {
  assert.equal(stalenessLevel(friSuccess, Z('2026-11-23T15:30:00Z')), 'stale'); // Mon 10:30 ET
});
test('staleness: two missed runs is critical', () => {
  assert.equal(stalenessLevel(friSuccess, Z('2026-11-24T16:00:00Z')), 'critical'); // Tue 11:00 ET
});
test('staleness: manual mid-day success counts; no success is none', () => {
  assert.equal(stalenessLevel(Z('2026-11-24T19:00:00Z'), Z('2026-11-25T11:00:00Z')), 'ok');
  assert.equal(stalenessLevel(null, Z('2026-11-25T11:00:00Z')), 'none');
});
