#!/usr/bin/env node
// Step 3 of the measure lineage: merge what the extractor traced and classified (model.json) with the
// AI's answers (answers/*.json, earlier extractions' included for what hasn't changed since) and write
// <Model>-lineage.xlsx with three sheets:
//   Lineage          one row per measure × field × physical source
//   By source field  measures grouped by the main source field and the helper fields they use
//   Unresolved       what couldn't be traced, answers missing or not matching the model, checks
// Usage: node lineage/build-excel.js <lineage-output/<project>/<Model> folder>
'use strict';
const fs = require('fs');
const path = require('path');
const { writeXlsx } = require('./xlsx');

/* Everything the workbook needs, from the folder the extractor wrote and the AI filled in. */
function buildLineage(dir) {
  const facts = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
  const issues = [];   // [item, kind, reason, where]
  const answersDir = path.join(dir, 'answers');
  const columnAnswers = new Map(), measureAnswers = new Map();
  // Each task carries a fingerprint of its content; an answer counts only for the task version it
  // answered. An earlier extraction's answer still counts for the items the extractor didn't ask
  // again because their input is unchanged (model.json's reuse).
  const taskRuns = new Map((facts.tasks || []).map(t => [t.file, t.run]));
  const reuse = facts.reuse || { measures: {}, columns: {} };
  const reused = new Set([...Object.values(reuse.measures), ...Object.values(reuse.columns)]);
  const files = (fs.existsSync(answersDir) ? fs.readdirSync(answersDir) : []).filter(f => /^(columns|measures)-\d+\.json$/.test(f)).sort();
  for (const f of files) {
    let a;
    try { a = JSON.parse(fs.readFileSync(path.join(answersDir, f), 'utf8')); }
    catch (e) { issues.push([f, 'answer file', `not valid JSON: ${e.message}`, `answers/${f}`]); continue; }
    let take = () => true;
    if (taskRuns.has(f)) {
      if (a.run !== taskRuns.get(f)) { issues.push([f, 'answer file', 'answers an earlier version of its task (the run differs) — ignored', `answers/${f}`]); continue; }
    } else if (reused.has(f)) {
      take = (kind, name) => reuse[kind][name] === f;
    } else {
      // Answered an earlier extraction whose items were all asked again or dropped: nothing to say.
      // Without that copy of its task, it never matched a task.
      if (!fs.existsSync(path.join(answersDir, f.replace(/\.json$/, '.task.json')))) issues.push([f, 'answer file', 'answers a task this extraction doesn\'t have — ignored', `answers/${f}`]);
      continue;
    }
    for (const c of (a.columns || [])) if (take('columns', c.column)) columnAnswers.set(c.column, { ...c, file: f });
    for (const m of (a.measures || [])) if (take('measures', m.measure)) measureAnswers.set(m.measure, { ...m, file: f, by: 'AI' });
  }
  // The measures the extractor classified itself.
  for (const m of facts.measures) if (m.classified) measureAnswers.set(m.name, { measure: m.name, ...m.classified, by: 'extractor' });

  // Everything the queries say, for checking that an AI-named source appears in them.
  const evidence = [...Object.values(facts.tables).map(t => [t.query, t.dax, t.partition].join('\n')), ...Object.values(facts.queries)].join('\n').toLowerCase();
  const appears = name => !name || evidence.includes(String(name).toLowerCase());

  /* A field's physical sources: [{ connector, system, schema, table, column, trace, note, by, through, check }] */
  const memo = new Map();
  const sourcesOf = (field, seen = []) => {
    if (memo.has(field)) return memo.get(field);
    if (seen.includes(field)) return [{ unresolved: `derived in a loop (${[...seen, field].join(' → ')})` }];
    let out;
    const col = facts.columns[field];
    if (!col && facts.tables[field]) {                       // a table itself — COUNTROWS(Sales)
      const l = facts.tables[field].lineage;
      if (l && !l.unresolved) out = l.sources.map(s => ({ ...s, column: '(rows)', trace: l.trace, note: l.note, by: 'extractor' }));
      else {
        // When the table's own query couldn't be followed (FHSQLMonitor's Object expands a record),
        // its columns may have been traced — by the extractor or the AI. If they all come from one
        // object, so do the table's rows.
        const objects = new Map();
        for (const [key, c] of Object.entries(facts.columns)) {
          if (c.table !== field || c.calculated) continue;
          for (const s of sourcesOf(key, [...seen, field])) {
            if (s.unresolved || s.through) continue;
            objects.set(JSON.stringify([s.connector, s.system, s.schema, s.table]), s);
          }
        }
        if (objects.size === 1) {
          const s = [...objects.values()][0];
          out = [{ connector: s.connector, system: s.system, schema: s.schema, table: s.table, column: '(rows)', trace: 'exact', note: 'the table\'s columns all come from here', by: s.by }];
        } else out = [{ unresolved: l ? l.unresolved : 'the table isn\'t traced' }];
      }
    } else if (!col) {
      out = [{ unresolved: 'not a column the extractor found in the measures\' DAX' }];
    } else {
      let l = col.lineage;
      if (l && l.unresolved) {
        const a = columnAnswers.get(field);
        if (a) l = { sources: a.sources || [], derivedFrom: a.derivedFrom || [], trace: a.trace, note: a.note, by: 'AI' };
      }
      if (!l || l.unresolved) out = [{ unresolved: l ? l.unresolved : 'no lineage' }];
      else {
        out = [];
        for (const s of (l.sources || [])) {
          // Typed-in, generated and parameter values name no real table to look for.
          const check = l.by === 'AI' && l.trace !== 'assumed' && !['typed-in', 'generated', 'parameter'].includes(s.connector)
            ? [appears(s.table) ? '' : `source table "${s.table}" isn't in the model's queries`, appears(s.column) ? '' : `source column "${s.column}" isn't in the model's queries`].filter(Boolean).join('; ') : '';
          out.push({ ...s, trace: l.trace, note: l.note, by: l.by, check });
        }
        for (const from of (l.derivedFrom || [])) {
          for (const s of sourcesOf(from, [...seen, field])) out.push({ ...s, trace: s.unresolved ? s.trace : 'derived', through: [from, ...(s.through || [])] });
        }
        if (!out.length) out = [{ unresolved: l.by === 'AI' ? 'the answer names no source' : 'no source' }];
        if (l.trace === 'derived' && col.calculated) out.forEach(s => { s.note = [`calculated column ${field}`, s.note].filter(Boolean).join('; '); });
      }
    }
    memo.set(field, out);
    return out;
  };

  /* A measure's fields, its own and those of the measures it's built on. */
  const fieldMemo = new Map();
  const fieldsOf = (name, seen = []) => {
    if (fieldMemo.has(name)) return fieldMemo.get(name);
    if (seen.includes(name)) return [];
    const a = measureAnswers.get(name);
    if (!a) return [];
    // `by`: who classified the field — the extractor only if it classified every measure on the way.
    const out = (a.fields || []).map(f => ({ field: f.field, role: f.role === 'main' ? 'main' : 'helper', usage: f.usage || '', via: [], by: a.by }));
    for (const r of (a.measures || [])) {
      for (const f of fieldsOf(r.measure, [...seen, name])) {
        const asCondition = r.as === 'condition';
        out.push({ field: f.field, role: asCondition ? 'helper' : f.role, usage: asCondition ? `condition (through [${r.measure}])` : f.usage,
          via: [r.measure, ...f.via], by: a.by === 'AI' || f.by === 'AI' ? 'AI' : 'extractor' });
      }
    }
    const seenKey = new Set();
    const dedup = out.filter(f => { const k = `${f.field}|${f.role}|${f.via.join('>')}`; if (seenKey.has(k)) return false; seenKey.add(k); return true; });
    fieldMemo.set(name, dedup);
    return dedup;
  };

  // Check the answers against the model.
  const known = new Set([...Object.keys(facts.columns), ...Object.keys(facts.tables)]);
  const measureNames = new Set(facts.measures.map(m => m.name));
  for (const m of facts.measures) {
    if (measureAnswers.has(m.name)) continue;
    const where = m.task ? `tasks/${m.task}.json` : reuse.measures[m.name] ? `answers/${reuse.measures[m.name]} (missing it — extract again)` : 'tasks/measures-NN.json';
    issues.push([m.name, 'measure', 'no answer classifies this measure', where]);
  }
  for (const [name, a] of measureAnswers) {
    if (!measureNames.has(name)) issues.push([name, 'measure', 'answered, but the model has no measure of that name', `answers/${a.file}`]);
    for (const f of (a.fields || [])) if (!known.has(f.field)) issues.push([`${name} → ${f.field}`, 'field', 'not a column or table the extractor found for the measures', `answers/${a.file}`]);
    for (const r of (a.measures || [])) if (!measureNames.has(r.measure)) issues.push([`${name} → [${r.measure}]`, 'measure', 'refers to a measure the model doesn\'t have', `answers/${a.file}`]);
  }
  for (const [key, c] of Object.entries(facts.columns)) {
    if (c.used && c.lineage && c.lineage.unresolved && !columnAnswers.has(key)) issues.push([key, 'column', `not traced: ${c.lineage.unresolved}`, `tasks/${c.task || 'columns-NN'}.json`]);
  }

  // Lineage rows.
  const lineage = [];
  const measures = [...facts.measures].sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name));
  for (const m of measures) {
    const fields = fieldsOf(m.name);
    if (!fields.length && measureAnswers.has(m.name)) lineage.push({ m, f: { field: '', role: 'none', usage: 'uses no column', via: [], by: measureAnswers.get(m.name).by }, s: {} });
    for (const f of fields) for (const s of sourcesOf(f.field)) lineage.push({ m, f, s });
  }
  lineage.sort((x, y) => x.m.table.localeCompare(y.m.table) || x.m.name.localeCompare(y.m.name)
    || (x.f.role === y.f.role ? 0 : x.f.role === 'main' ? -1 : 1) || x.f.field.localeCompare(y.f.field));
  // Every field left untraced, once, with how many measures use it.
  const untraced = new Map();
  for (const r of lineage) {
    if (!r.s.unresolved) continue;
    const k = `${r.f.field}\u0000${r.s.unresolved}`;
    untraced.set(k, [...(untraced.get(k) || []), r.m.name]);
  }
  for (const [k, ms] of untraced) {
    const [field, reason] = k.split('\u0000');
    if (!issues.some(i => i[0] === field && i[1] === 'column')) issues.push([field, 'not traced', reason, `used by ${new Set(ms).size} measure${new Set(ms).size === 1 ? '' : 's'}`]);
  }
  const checked = new Set();
  for (const r of lineage) {
    if (!r.s.check || checked.has(`${r.f.field}|${r.s.check}`)) continue;
    checked.add(`${r.f.field}|${r.s.check}`);
    issues.push([`${r.f.field}`, 'check', r.s.check, `used by ${r.m.name}${lineage.filter(x => x.f.field === r.f.field && x.m !== r.m).length ? ' and others' : ''}`]);
  }

  // By source field: one row per main source field and set of helper fields.
  const fq = s => (s.unresolved ? '' : [s.schema, s.table, s.column].filter(Boolean).map(p => (/\./.test(p) ? `[${p}]` : p)).join('.'));
  const label = (f, s) => (s.unresolved ? `(not traced) ${f.field}` : s.column);
  const groups = new Map();
  for (const m of measures) {
    const rows = lineage.filter(r => r.m === m && r.f.role !== 'none');
    const mains = rows.filter(r => r.f.role === 'main'), helpers = rows.filter(r => r.f.role === 'helper');
    const helperSet = [...new Map(helpers.map(r => [fq(r.s) || r.f.field, r])).values()].sort((a, b) => (fq(a.s) || a.f.field).localeCompare(fq(b.s) || b.f.field));
    const mainList = mains.length ? [...new Map(mains.map(r => [fq(r.s) || r.f.field, r])).values()] : [null];
    for (const main of mainList) {
      const key = `${main ? fq(main.s) || main.f.field : '(none)'}\u0000${helperSet.map(h => fq(h.s) || h.f.field).join('\u0001')}`;
      if (!groups.has(key)) groups.set(key, { main, helpers: helperSet, measures: [] });
      groups.get(key).measures.push(m.name);
    }
  }
  const bySource = [...groups.values()].sort((a, b) => (a.main ? fq(a.main.s) || a.main.f.field : '~').localeCompare(b.main ? fq(b.main.s) || b.main.f.field : '~'));

  const byAI = [...measureAnswers.values()].filter(a => a.by === 'AI' && measureNames.has(a.measure)).length;
  return { facts, lineage, bySource, issues, label, fq,
    answered: { columns: columnAnswers.size, measures: byAI, classified: facts.measures.filter(m => m.classified).length } };
}

function sheets(b) {
  const { lineage, bySource, issues, label, fq } = b;
  // Names for a list of fields: a whole table reads "Database file (rows)", and a name that two of
  // the fields share (FHSQLMonitor's many Date columns) gets its table in front.
  const names = list => {
    const base = list.map(x => (x.s.unresolved ? label(x.f, x.s) : x.s.column === '(rows)' ? `${x.s.table} (rows)` : x.s.column));
    return base.map((n, i) => (base.indexOf(n) !== base.lastIndexOf(n) && !list[i].s.unresolved ? `${list[i].s.table}.${n}` : n));
  };
  return [
    { name: 'Lineage', columns: [
      { header: 'Measure', width: 34 }, { header: 'Measure table', width: 18 }, { header: 'Display folder', width: 18 },
      { header: 'Role', width: 8 }, { header: 'How it\'s used', width: 22 }, { header: 'Model field', width: 32 },
      { header: 'Through', width: 28, wrap: true }, { header: 'Connector', width: 12 }, { header: 'Source system', width: 30 },
      { header: 'Source schema', width: 14 }, { header: 'Source table', width: 28 }, { header: 'Source column', width: 24 },
      { header: 'Trace', width: 11 }, { header: 'Note', width: 50, wrap: true }, { header: 'Classified by', width: 12 }, { header: 'Traced by', width: 10 },
      { header: 'Check', width: 40, wrap: true }],
      rows: lineage.map(({ m, f, s }) => [m.name, m.table, m.folder, f.role, f.usage, f.field,
        [...f.via.map(v => `[${v}]`), ...(s.through || [])].join(' → '), s.connector || '', s.system || '', s.schema || '', s.table || '',
        s.unresolved ? '' : s.column, s.unresolved ? 'unresolved' : s.trace || '', s.unresolved ? s.unresolved : s.note || '', f.by || '', s.unresolved ? '' : s.by || '', s.check || '']) },
    { name: 'By source field', columns: [
      { header: 'Source field', width: 26, wrap: true }, { header: 'Helper fields', width: 30, wrap: true }, { header: 'Measures', width: 40, wrap: true },
      { header: 'Source field location (schema.table.field)', width: 44, wrap: true }, { header: 'Helper fields location (schema.table.field)', width: 50, wrap: true }],
      rows: bySource.map(g => [g.main ? names([g.main])[0] : '(no main field)', names(g.helpers).join('\n'),
        [...new Set(g.measures)].join('\n'), g.main ? fq(g.main.s) || '(not traced)' : '', g.helpers.map(h => fq(h.s) || `(not traced) ${h.f.field}`).join('\n')]) },
    { name: 'Unresolved', columns: [{ header: 'Item', width: 40 }, { header: 'Kind', width: 12 }, { header: 'Reason', width: 70, wrap: true }, { header: 'Where', width: 28 }],
      rows: issues },
  ];
}

function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(path.join(dir, 'model.json'))) {
    console.error('Usage: node lineage/build-excel.js <folder holding model.json, e.g. lineage-output/<project>/<Model>>');
    process.exit(2);
  }
  const b = buildLineage(dir);
  const file = path.join(dir, `${b.facts.model.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')}-lineage.xlsx`);
  fs.writeFileSync(file, writeXlsx(sheets(b)));
  const unresolved = b.lineage.filter(r => r.s.unresolved).length;
  console.log(`${b.facts.model}: ${b.facts.measures.length} measures, ${b.answered.classified} classified by the extractor; AI answers for ${b.answered.measures} measures and ${b.answered.columns} columns.`);
  console.log(`  Lineage: ${b.lineage.length} rows (${unresolved} not traced) · By source field: ${b.bySource.length} rows · Unresolved: ${b.issues.length}`);
  for (const i of b.issues.slice(0, 15)) console.log(`  ! ${i[1]} ${i[0]}: ${i[2]}`);
  if (b.issues.length > 15) console.log(`  … ${b.issues.length - 15} more on the Unresolved sheet`);
  console.log(`  Written: ${file}`);
}

if (require.main === module) main();
module.exports = { buildLineage, sheets };
