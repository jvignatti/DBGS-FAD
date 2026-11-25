import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePage, SOURCE_URL } from '../scripts/validate.mjs';

const good = { status: 200, finalUrl: SOURCE_URL, title: 'Debarment List | Buildings and General Services', h1: 'Debarment List' };

test('official page passes', () => {
  assert.deepEqual(validatePage(good), []);
});

test('HTTP 403 fails', () => {
  assert.ok(validatePage({ ...good, status: 403 }).some((e) => e.includes('403')));
});

test('redirect to another URL fails', () => {
  const errs = validatePage({ ...good, finalUrl: 'https://bgs.vermont.gov/purchasing-contracting' });
  assert.ok(errs.some((e) => e.includes('Final URL')));
});

test('CloudFront error page fails even with status 200', () => {
  const errs = validatePage({ ...good, title: 'ERROR: The request could not be satisfied', h1: '403 ERROR' });
  assert.ok(errs.length >= 2);
});

test('missing heading fails', () => {
  assert.ok(validatePage({ ...good, h1: '' }).length === 1);
});
