#!/usr/bin/env node
// Step 1 of the measure lineage: read a PBIP folder and write, per semantic model,
//   lineage-output/<Model>/model.json      — the facts, and every column source the extractor traced
//   lineage-output/<Model>/tasks/*.json    — what's left for an AI (see lineage/INSTRUCTIONS.md)
// Usage: node lineage/extract.js <PBIP folder> [--out <dir>]
'use strict';
const fs = require('fs');
const path = require('path');
const { readProjectFolder, loadModels, buildFacts, buildTasks } = require('./model');

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
  for (const app of apps) {
    const facts = buildFacts(app, files, args.folder);
    const tasks = buildTasks(facts);
    // Say in model.json which task holds each measure and column, for the workbook's Unresolved sheet.
    const taskOfMeasure = new Map(), taskOfColumn = new Map();
    for (const t of tasks) {
      const id = t.file.replace(/\.json$/, '');
      for (const m of (t.body.measures || [])) taskOfMeasure.set(m.measure, id);
      for (const tb of (t.body.tables || [])) for (const c of tb.columns) taskOfColumn.set(c.column, id);
    }
    for (const m of facts.measures) m.task = taskOfMeasure.get(m.name);
    for (const [k, c] of Object.entries(facts.columns)) if (taskOfColumn.has(k)) c.task = taskOfColumn.get(k);
    // <out>/<project folder>/<model>: many projects call their model Sales or Model.
    const dir = path.join(args.out, safeName(path.basename(path.resolve(args.folder))), safeName(facts.model));
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });
    for (const f of fs.readdirSync(path.join(dir, 'tasks'))) fs.unlinkSync(path.join(dir, 'tasks', f));
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ ...facts, tasks: tasks.map(t => ({ file: t.file, run: t.run })) }, null, 2));
    for (const t of tasks) fs.writeFileSync(path.join(dir, 'tasks', t.file), JSON.stringify(t.body, null, 2));
    const answered = tasks.filter(t => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, 'answers', t.file), 'utf8')).run === t.run; } catch (e) { return false; }
    });

    const cols = Object.values(facts.columns).filter(c => c.used);
    const traced = cols.filter(c => c.lineage && !c.lineage.unresolved);
    const byTrace = traced.reduce((o, c) => ((o[c.lineage.trace] = (o[c.lineage.trace] || 0) + 1), o), {});
    const colTasks = tasks.filter(t => t.body.kind === 'columns'), measTasks = tasks.filter(t => t.body.kind === 'measures');
    const left = colTasks.reduce((n, t) => n + t.body.tables.reduce((k, tb) => k + tb.columns.length, 0), 0);
    const range = list => (list.length ? (list.length === 1 ? list[0].file : `${list[0].file} … ${list[list.length - 1].file}`) : 'none');
    console.log(`${facts.model} (${facts.modelFormat}): ${facts.measures.length} measures use ${cols.length} columns.`);
    console.log(`  Traced to their source: ${traced.length} (${Object.entries(byTrace).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
    console.log(`  Left for the AI: ${left} column${left === 1 ? '' : 's'} → ${range(colTasks)}`);
    console.log(`  Measures to classify: ${facts.measures.length} → ${range(measTasks)}`);
    if (answered.length) console.log(`  Already answered and unchanged: ${answered.length} of ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
    console.log(`  Written to ${dir}${path.sep}`);
    console.log(`  Next: answer the tasks as lineage/INSTRUCTIONS.md describes, then run  node lineage/build-excel.js "${dir}"`);
  }
}

main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
