// Files in data/ — committed back to the repo after every run so the bot remembers what it checked.
//   seen.json     every business already checked (so it's never checked or sent twice)
//   leads.csv     every lead ever found (GitHub shows it as a table)
//   last-run.json stats from the most recent run
//   run-leads.txt the latest run's leads as plain text (open it on GitHub and tap "Copy raw file")

import fs from 'node:fs';
import path from 'node:path';

export function loadState(dir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
    if (state && typeof state.places === 'object' && state.places) return state;
  } catch {
    // first run, or the file was deleted to start over
  }
  return { version: 1, places: {} };
}

export function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'seen.json');
  // One business per line keeps the file readable and the git history small.
  const lines = Object.entries(state.places).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  const text = `{\n "version": 1,\n "places": {\n${lines.join(',\n')}\n }\n}\n`;
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

const CSV_COLUMNS = [
  'found_on', 'name', 'category', 'phone', 'whatsapp', 'email', 'address', 'google_rating', 'google_reviews',
  'google_maps', 'social_pages', 'notes', 'city', 'osm_link',
];

function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Stop spreadsheet apps from treating a business name like "=HYPERLINK(...)" as a formula.
  // Phone numbers like "+92 300…" still pass through unchanged.
  if (/^(=|@|\t|\r|[+-](?!\d))/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function appendLead(dir, lead) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'leads.csv');
  const header = fs.existsSync(file) ? '' : `${CSV_COLUMNS.join(',')}\n`;
  const row = [
    csvCell(lead.foundOn),
    csvCell(lead.name),
    csvCell(lead.categoryLabel),
    csvCell(lead.phone),
    csvCell(lead.whatsapp),
    csvCell(lead.email),
    csvCell(lead.address),
    csvCell(lead.rating),
    csvCell(lead.reviews),
    csvCell(lead.mapsUrl),
    csvCell((lead.socials || []).join(' ')),
    csvCell((lead.notes || []).join(' | ')),
    csvCell(lead.city),
    csvCell(lead.osmUrl),
  ].join(',');
  fs.appendFileSync(file, `${header}${row}\n`);
}

export function writeLastRun(dir, summary) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last-run.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

export function writeRunLeads(dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-leads.txt'), `${text}\n`);
}
