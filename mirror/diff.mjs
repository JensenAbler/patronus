// Usage: node diff.mjs reports.jsonl <baselineLabel> <label> [label...]
// Compares the latest report for each label against the baseline, field by field.
import { readFileSync } from 'node:fs';
const [file, base, ...labels] = process.argv.slice(2);
const latest = {};
for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line); latest[r.label] = r; }
const flat = (o, p = '', out = {}) => { if (o && typeof o === 'object' && !Array.isArray(o)) { for (const [k, v] of Object.entries(o)) flat(v, p ? p + '.' + k : k, out); } else out[p] = JSON.stringify(o); return out; };
const view = (r) => flat({ probe: { ...r.probe, token: undefined }, headers: r.page?.headers, headerOrder: r.page?.order?.join(','), httpVersion: r.page?.httpVersion });
const volatile = /token|canvasHash|misc\.historyLength|misc\.referrer|headers\.(x-|cf-|cache|connection)|\.ip$|screen\.screen[XY]/;
if (!latest[base]) { console.error('No baseline report labeled', base, '- labels seen:', Object.keys(latest).join(', ')); process.exit(1); }
const b = view(latest[base]);
for (const label of labels) {
  const r = latest[label]; if (!r) { console.log(`\n## ${label}: no report`); continue; }
  const v = view(r); const keys = [...new Set([...Object.keys(b), ...Object.keys(v)])].filter((k) => !volatile.test(k)).sort();
  const diffs = keys.filter((k) => b[k] !== v[k]);
  console.log(`\n## ${label} vs ${base}: ${diffs.length} differences`);
  for (const k of diffs) console.log(`- ${k}\n    ${base}: ${b[k] ?? '(missing)'}\n    ${label}: ${v[k] ?? '(missing)'}`);
}
