// Staff-facing page. Reads static files published with this site only.
// All extracted text is inserted with textContent (never innerHTML).
import { filterRecords, formatEt, stalenessLevel } from './lib.js';

const OFFICIAL = 'https://bgs.vermont.gov/purchasing-contracting/debarment';
const $ = (id) => document.getElementById(id);

async function getJson(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function showBanner(level, text) {
  const b = $('banner');
  b.className = `banner banner-${level}`;
  b.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = { ok: 'Up to date. ', info: 'Note: ', stale: 'Warning: ', critical: 'Do not rely on this copy. ' }[level] || '';
  const a = document.createElement('a');
  a.href = OFFICIAL;
  a.rel = 'noopener noreferrer';
  a.textContent = 'official BGS page';
  b.append(strong, text, ' ', ...(level === 'ok' ? [] : ['Check the ', a, '.']));
  b.hidden = false;
}

function renderRows(records, total) {
  const tbody = $('rows');
  tbody.replaceChildren(...records.map((r) => {
    const tr = document.createElement('tr');
    for (const v of [r.name, r.expiration_term]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    return tr;
  }));
  $('result-count').textContent = total === 0 ? '' : `Showing ${records.length} of ${total}.`;
}

function enableDownload(id, filename) {
  const a = $('download');
  a.href = `snapshots/${encodeURIComponent(id)}/debarment.pdf`;
  a.download = filename;
  a.removeAttribute('aria-disabled');
  a.textContent = `Download PDF (${filename})`;
}

async function main() {
  let status;
  try {
    status = await getJson('status.json', { cache: 'no-store' });
  } catch {
    $('last-success').textContent = $('last-attempt').textContent = 'Unavailable';
    showBanner('critical', 'The retrieval status could not be loaded.');
    return;
  }

  const att = status.last_attempt || {};
  $('last-attempt').textContent = att.at_utc
    ? `${formatEt(new Date(att.at_utc))} (${att.result === 'success' ? 'succeeded' : 'failed'})`
    : 'None recorded';

  if (!status.current_snapshot) {
    $('last-success').textContent = 'None';
    showBanner('critical', 'No verified snapshot is available yet.');
    return;
  }

  const base = `snapshots/${encodeURIComponent(status.current_snapshot)}/`;
  let meta, data;
  try {
    [meta, data] = await Promise.all([getJson(base + 'metadata.json'), getJson(base + 'debarment.json')]);
    if (meta.snapshot_id !== status.current_snapshot || data.snapshot_id !== status.current_snapshot) throw new Error('mismatch');
  } catch {
    $('last-success').textContent = 'Unavailable';
    showBanner('critical', 'The snapshot files could not be loaded or do not match each other.');
    return;
  }

  const retrieved = new Date(meta.retrieved_at_utc);
  $('last-success').textContent = formatEt(retrieved);
  $('count-total').textContent = String(data.records.length);
  enableDownload(meta.snapshot_id, meta.pdf_download_name);

  const level = stalenessLevel(new Date(status.last_success_utc || meta.retrieved_at_utc), new Date());
  if (att.result === 'failure') {
    showBanner(level === 'ok' ? 'stale' : 'critical',
      `The most recent retrieval attempt (${formatEt(new Date(att.at_utc))}) failed. The list below is from the last successful retrieval (${formatEt(retrieved)}).`);
  } else if (level === 'stale') {
    showBanner('stale', `A scheduled update appears to have been missed. This list was retrieved ${formatEt(retrieved)}.`);
  } else if (level === 'critical') {
    showBanner('critical', `This list is more than one scheduled update out of date (retrieved ${formatEt(retrieved)}).`);
  } else {
    showBanner('ok', `List retrieved ${formatEt(retrieved)} from the official BGS page.`);
  }

  const records = data.records;
  $('empty-notice').hidden = records.length !== 0;
  renderRows(records, records.length);
  const q = $('q');
  q.disabled = false;
  q.addEventListener('input', () => renderRows(filterRecords(records, q.value), records.length));
}

main();
