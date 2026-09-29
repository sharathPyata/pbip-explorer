#!/usr/bin/env node
// Step 1 of the measure lineage: read a PBIP folder and write, per semantic model,
//   lineage-output/<project>/<Model>/model.json      — the facts, every column source the extractor
//                                                      traced and every measure it classified
//   lineage-output/<project>/<Model>/tasks/*.json    — what's left for an AI (see lineage/INSTRUCTIONS.md)
// Answers from an earlier run stay in answers/: a measure or column whose input hasn't changed isn't asked again.
// Usage: node lineage/extract.js <PBIP folder> [--out <dir>]
'use strict';
const fs = require('fs');
const path = require('path');
const { readProjectFolder, loadModels, buildFacts, buildTasks, previousAnswers, rulesVersion } = require('./model');

function parseArgs(argv) {
  const args = { out: 'lineage-output', folder: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (!args.folder) args.folder = argv[i];
  }
  return args;
}
const safeName = s => String(s || 'model').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim() || 'model';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.folder) {
    console.error('Usage: node lineage/extract.js <PBIP folder> [--out <dir>]');
    process.exit(2);
  }
  const files = readProjectFolder(args.folder);
  const apps = await loadModels(files);
  if (!apps.length) {
    console.error(`No semantic model found under ${args.folder} (looked for definition/model.tmdl or model.bim).`);
    process.exit(1);
  }
  const rules = rulesVersion();
  for (const app of apps) {
    const facts = buildFacts(app, files, args.folder);
    // <out>/<project folder>/<model>: many projects call their model Sales or Model.
    const dir = path.join(args.out, safeName(path.basename(path.resolve(args.folder))), safeName(facts.model));
    const tasks = writeModel(facts, dir, { rules });

    const cols = Object.values(facts.columns).filter(c => c.used);
    const traced = cols.filter(c => c.lineage && !c.lineage.unresolved);
    const byTrace = traced.reduce((o, c) => ((o[c.lineage.trace] = (o[c.lineage.trace] || 0) + 1), o), {});
    const colTasks = tasks.filter(t => t.body.kind === 'columns'), measTasks = tasks.filter(t => t.body.kind === 'measures');
    const left = colTasks.reduce((n, t) => n + t.body.tables.reduce((k, tb) => k + tb.columns.length, 0), 0);
    const toClassify = measTasks.reduce((n, t) => n + t.body.measures.length, 0);
    const classified = facts.measures.filter(m => m.classified).length;
    const kept = { measures: Object.keys(tasks.reuse.measures).length, columns: Object.keys(tasks.reuse.columns).length };
    const range = list => (list.length ? (list.length === 1 ? list[0].file : `${list[0].file} … ${list[list.length - 1].file}`) : 'none');
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    console.log(`${facts.model} (${facts.modelFormat}): ${plural(facts.measures.length, 'measure')} use ${plural(cols.length, 'column')}.`);
    console.log(`  Traced to their source: ${traced.length} (${Object.entries(byTrace).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
    console.log(`  Measures classified here: ${classified}`);
    if (kept.measures || kept.columns) console.log(`  Answered before and unchanged: ${plural(kept.measures, 'measure')}, ${plural(kept.columns, 'column')} (kept)`);
    console.log(`  Left for the AI: ${plural(left, 'column')} → ${range(colTasks)}; ${plural(toClassify, 'measure')} → ${range(measTasks)}`);
    console.log(`  Written to ${dir}${path.sep}`);
    console.log(tasks.length ? `  Next: answer the tasks as lineage/INSTRUCTIONS.md describes, then run  node lineage/build-excel.js "${dir}"`
      : `  Nothing left for the AI. Next: node lineage/build-excel.js "${dir}"`);
  }
}

/* Write one model's model.json and tasks/ into `dir`, keeping answers/ — whatever in it still answers
   an unchanged measure or column is reused, and model.json's `reuse` says where. Returns the tasks. */
function writeModel(facts, dir, { rules }) {
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });
  // Before the old tasks go: what's been answered, and exactly what each answer was an answer to.
  const previous = previousAnswers(dir);
  const tasks = buildTasks(facts, { rules, previous, start: previous.max });
  // Say in model.json which task holds each measure and column, for the workbook's Unresolved sheet.
  const taskOfMeasure = new Map(), taskOfColumn = new Map();
  for (const t of tasks) {
    const id = t.file.replace(/\.json$/, '');
    for (const m of (t.body.measures || [])) taskOfMeasure.set(m.measure, id);
    for (const tb of (t.body.tables || [])) for (const c of tb.columns) taskOfColumn.set(c.column, id);
  }
  for (const m of facts.measures) if (taskOfMeasure.has(m.name)) m.task = taskOfMeasure.get(m.name);
  for (const [k, c] of Object.entries(facts.columns)) if (taskOfColumn.has(k)) c.task = taskOfColumn.get(k);
  for (const f of fs.readdirSync(path.join(dir, 'tasks'))) fs.unlinkSync(path.join(dir, 'tasks', f));
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ ...facts, rules, reuse: tasks.reuse, tasks: tasks.map(t => ({ file: t.file, run: t.run })) }, null, 2));
  for (const t of tasks) fs.writeFileSync(path.join(dir, 'tasks', t.file), JSON.stringify(t.body, null, 2));
  return tasks;
}

if (require.main === module) main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { writeModel };
