// Measure lineage — the extractor's library. Reads a PBIP folder with PBIP Explorer's own parser
// (pbip-explorer.html, unchanged, run in a Node VM the way tests/harness.js runs it), then works out
// what it can about every field the model's measures use:
//   - each column's physical source (connector, server/database, schema, table, column), traced
//     through the model's sourceColumn and the Power Query steps behind it, where every step on the
//     way is one whose effect on column names is certain;
//   - everything else — a column Power Query computes, native SQL, a calculated table — is left
//     as a task for an AI, with the evidence it needs (see INSTRUCTIONS.md);
//   - each measure's DAX and the columns, measures and tables it references, for the AI to classify.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadApp, fileList } = require('../tests/harness');

const APP_FUNCTIONS = ['App', 'processFiles', 'pickProject', 'parseMSteps', 'inlineMParameters', 'extractSqlFromM',
  'splitTopLevel', 'findTopLevelEq', 'stripIdQuotes', 'tableKind', 'tableSource', 'parseDaxReferences', 'daxModelIndex',
  'daxNamesUsed', 'modelParameters', 'isParameterTable', 'unquote', 'normTmdl'];

const MODEL_FILES = /\.(tmdl|bim|json|pbir|pbism|pbip|platform)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pbi', 'StaticResources', 'lineage-output']);

/* The model files under `dir`, as { 'Top/relative/path': text }. Report folders are left out: the
   lineage only needs semantic models, and FHSQLMonitor's report alone is 1,400 files. */
function readProjectFolder(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) throw new Error(`No such folder: ${dir}`);
  const top = fs.statSync(root).isFile() ? path.dirname(root) : root;
  const files = {};
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    if (entries.some(e => e.isFile() && e.name === 'definition.pbir') || /\.Report$/i.test(abs)) return;
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name), `${rel}/${e.name}`); }
      else if (e.isFile() && MODEL_FILES.test(e.name)) files[`${rel}/${e.name}`] = fs.readFileSync(path.join(abs, e.name), 'utf8');
    }
  };
  walk(top, path.basename(top));
  return files;
}

/* Load every semantic model in `files` with PBIP Explorer's parser; one fresh app per model. */
async function loadModels(files) {
  const first = loadApp(APP_FUNCTIONS, { dom: true });
  await first.processFiles(fileList(files));
  const pending = first.App.pendingProjects;
  if (!pending) return first.App.state.tables.length || Object.keys(first.App.state.expressions).length ? [first] : [];
  const apps = [];
  for (let i = 0; i < pending.projects.length; i++) {
    if (!pending.projects[i].model) continue;
    const app = loadApp(APP_FUNCTIONS, { dom: true });
    await app.processFiles(fileList(files));
    await app.pickProject(i);
    apps.push(app);
  }
  return apps;
}

/* ── Reading M ─────────────────────────────────────────────────────────────────────────────── */

/* The index of the bracket closing the one at `open` — ( [ { nest; strings ("" escapes),
   #"quoted names" and comments are skipped. */
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && !(text[i] === '"' && text[i + 1] !== '"')) i += text[i] === '"' ? 2 : 1; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
/* An M text literal's value, or null: "a ""quoted"" word" → a "quoted" word. */
function mString(text) {
  const m = String(text || '').trim().match(/^"((?:[^"]|"")*)"$/);
  return m ? m[1].replace(/""/g, '"') : null;
}
/* A reference to a step or query — #"Removed Columns" or Source — or null. */
function mReference(expr, app) {
  const t = expr.trim();
  if (/^#"(?:[^"]|"")*"$/.test(t) || /^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) return app.stripIdQuotes(t);
  return null;
}
/* A call — Table.RenameColumns(x, …) or #table(…) — as { fn, args, rest }, or null. */
function mCall(expr, app) {
  const t = expr.trim();
  const m = t.match(/^(#?[A-Za-z_][A-Za-z0-9_.]*)\s*\(/);
  if (!m) return null;
  const open = m[0].length - 1, close = closeOf(t, open);
  if (close < 0) return null;
  return { fn: m[1], args: app.splitTopLevel(t.slice(open + 1, close), ','), rest: t.slice(close + 1).trim() };
}
/* A record navigation — base{[Schema="dbo", Item="Sales"]}[Data] — as { base, fields }, or null. */
function mNavigation(expr, app) {
  const m = expr.trim().match(/^([\s\S]*?)\{\s*\[((?:[^\]"]|"(?:[^"]|"")*")*)\]\s*\}\s*\[\s*Data\s*\]\s*$/);
  if (!m || !m[1].trim()) return null;
  const fields = {};
  for (const part of app.splitTopLevel(m[2], ',')) {
    const eq = app.findTopLevelEq(part);
    if (eq <= 0) return null;
    const value = mString(part.slice(eq + 1));
    if (value === null) return null;        // a name worked out at refresh time — can't be read here
    fields[part.slice(0, eq).trim()] = value;
  }
  return { base: m[1], fields };
}
/* `if c then a else b` at the top level, as { then, else }, or null. */
function mIf(expr) {
  const t = expr.trim();
  if (!/^if\b/.test(t)) return null;
  const at = {}; let depth = 0;
  for (let i = 2; i < t.length; i++) {
    const c = t[i];
    if (c === '"') { i++; while (i < t.length && !(t[i] === '"' && t[i + 1] !== '"')) i += t[i] === '"' ? 2 : 1; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && /[a-z]/.test(c) && !/[A-Za-z0-9_.]/.test(t[i - 1] || '')) {
      for (const kw of ['if', 'then', 'else']) {
        if (t.startsWith(kw, i) && !/[A-Za-z0-9_.]/.test(t[i + kw.length] || '')) {
          if (kw === 'if') return null;     // a nested if at the top level — leave it to the AI
          if (!(kw in at)) at[kw] = i;
        }
      }
    }
  }
  if (at.then === undefined || at.else === undefined) return null;
  return { then: t.slice(at.then + 4, at.else), else: t.slice(at.else + 4) };
}

// Steps that keep every column's name: they filter, sort, retype or reshape rows, or change values.
const KEEPS_NAMES = new Set(['Table.SelectColumns', 'Table.RemoveColumns', 'Table.TransformColumnTypes', 'Table.SelectRows',
  'Table.Sort', 'Table.Distinct', 'Table.Buffer', 'Table.ReorderColumns', 'Table.FirstN', 'Table.LastN', 'Table.Skip',
  'Table.RemoveFirstN', 'Table.RemoveLastN', 'Table.RemoveRowsWithErrors', 'Table.SelectRowsWithErrors', 'Table.ReplaceValue',
  'Table.ReplaceErrorValues', 'Table.TransformColumns', 'Table.FillDown', 'Table.FillUp', 'Table.RemoveMatchingRows',
  'Table.Range', 'Table.AlternateRows', 'Table.ReverseRows', 'Table.MaxN', 'Table.MinN', 'Table.StopFolding',
  'Table.RemoveRows', 'Table.Repeat']);
// …of those, the ones that change a column's values, worth a note when the traced column is one of them.
const CHANGES_VALUES = new Set(['Table.TransformColumns', 'Table.ReplaceValue', 'Table.ReplaceErrorValues', 'Table.FillDown', 'Table.FillUp']);
// Steps that make rows out of values typed into the query.
const TYPED_IN = new Set(['#table', 'Table.FromRows', 'Table.FromRecords', 'Table.FromList', 'Table.FromColumns']);

/* The connector at the root of a navigation, and what the navigation above it named. */
const CONNECTORS = {
  'Sql.Database': 'sql-server', 'Sql.Databases': 'sql-server', 'Oracle.Database': 'oracle', 'Snowflake.Databases': 'snowflake',
  'PostgreSQL.Database': 'postgresql', 'MySQL.Database': 'mysql', 'AnalysisServices.Database': 'analysis-services',
  'AnalysisServices.Databases': 'analysis-services', 'Odbc.DataSource': 'odbc', 'OleDb.DataSource': 'oledb',
  'AzureStorage.DataLake': 'data-lake', 'Lakehouse.Contents': 'lakehouse', 'Fabric.Warehouse': 'warehouse',
  'Databricks.Catalogs': 'databricks', 'GoogleBigQuery.Database': 'bigquery', 'AmazonRedshift.Database': 'redshift',
  'Teradata.Database': 'teradata', 'DB2.Database': 'db2', 'Sybase.Database': 'sybase', 'Access.Database': 'access',
};

/* ── Tracing ───────────────────────────────────────────────────────────────────────────────── */

/* Everything the tracer looks names up in: the model's queries by name (shared expressions, and
   Power Query tables, which other queries can reference by the table's name) with their M
   already carrying the text parameters' values. */
function traceContext(app) {
  const s = app.App.state;
  const queries = new Map();
  for (const [name, e] of Object.entries(s.expressions || {})) queries.set(name, e.sourceM || '');
  for (const t of s.tables) if (app.tableKind(t) === 'm' && !queries.has(t.name)) queries.set(t.name, t.partitionSource || '');
  const inlined = new Map(), parsed = new Map();
  const code = name => {
    if (!inlined.has(name)) inlined.set(name, app.inlineMParameters(queries.get(name), s.expressions, s.tables));
    return inlined.get(name);
  };
  const steps = name => {
    if (!parsed.has(name)) {
      const p = app.parseMSteps(code(name));
      parsed.set(name, p ? { steps: new Map(p.steps.map(st => [st.name, st.expr])), start: p.result } : { steps: new Map(), start: code(name) });
    }
    return parsed.get(name);
  };
  return { app, queries, code, steps };
}

/* Where a navigation's root came from: { connector, system, database, schema } — or a file. */
function describeRoot(ctx, query, expr, depth = 0) {
  const { app } = ctx;
  const found = { connector: '', system: '', database: '', schema: '' };
  const q = ctx.steps(query);
  for (let guard = 0; guard < 50 && expr; guard++) {
    const ref = mReference(expr, app);
    if (ref !== null) {
      if (q.steps.has(ref)) { expr = q.steps.get(ref); continue; }
      if (ctx.queries.has(ref) && ref !== query && depth < 5) {
        const up = describeRoot(ctx, ref, ctx.steps(ref).start, depth + 1);
        return { ...up, database: found.database || up.database, schema: found.schema || up.schema };
      }
      return found;
    }
    const nav = mNavigation(expr, app);
    if (nav) {
      const f = nav.fields;
      if (f.Kind === 'Database' || (f.Name && !f.Kind && !f.Schema && !found.database)) found.database = found.database || f.Name;
      else if (f.Kind === 'Schema' || (f.Schema && !f.Item && !f.Name)) found.schema = found.schema || f.Name || f.Schema;
      expr = nav.base;
      continue;
    }
    const call = mCall(expr, app);
    if (!call) return found;
    if (CONNECTORS[call.fn]) {
      // Oracle's connector is often written Oracle.Database("""host:port/service""") — quotes inside.
      const [server, database] = call.args.map(a => (mString(a) || '').replace(/^"(.*)"$/, '$1'));
      return { ...found, connector: CONNECTORS[call.fn], system: server || '', database: found.database || database || '' };
    }
    const file = fileOf(call, app);
    if (file) return { ...found, connector: 'file', system: file.folder, file: file.name };
    return { ...found, connector: call.fn };
  }
  return found;
}
/* A file a connector call reads: Csv.Document / Excel.Workbook / Json.Document over
   File.Contents("C:\…\x.csv") or Web.Contents("https://…/", [RelativePath = "x.csv"]). */
function fileOf(call, app) {
  if (!/^(Csv\.Document|Excel\.Workbook|Json\.Document|Xml\.Tables|Parquet\.Document)$/.test(call.fn) || !call.args.length) return null;
  const inner = mCall(call.args[0], app);
  if (!inner || !/^(File\.Contents|Web\.Contents)$/.test(inner.fn)) return null;
  let where = mString(inner.args[0]);
  if (where === null) return null;
  const rel = inner.args[1] && (inner.args[1].match(/RelativePath\s*=\s*("(?:[^"]|"")*")/) || [])[1];
  if (rel) where = where.replace(/\/?$/, '/') + mString(rel);
  const cut = Math.max(where.lastIndexOf('/'), where.lastIndexOf('\\'));
  return { folder: where.slice(0, cut + 1), name: where.slice(cut + 1) };
}

/* Trace `column` (null for the table itself) from the output of query `query` back to the source
   object it's read from. Returns { sources:[…], trace, note } when every step on the way is
   certain, else { unresolved: reason }. */
function traceQuery(ctx, query, column, seen = []) {
  if (seen.includes(query) || seen.length > 8) return { unresolved: `the query refers back to itself (${[...seen, query].join(' → ')})` };
  const q = ctx.steps(query);
  const notes = [];
  let renamed = false;
  // Steps are looked up innermost first: a step can be a `let … in …` of its own (FHSQLMonitor's are).
  const walk = (expr, col, scopes = [q.steps]) => {
    const { app } = ctx;
    const stepNamed = name => { for (const sc of scopes) if (sc.has(name)) return sc.get(name); return undefined; };
    for (let guard = 0; guard < 300; guard++) {
      expr = String(expr || '').trim();
      if (!expr) return { unresolved: 'an empty step' };
      // A query's result is a step's name as written after `in`, quotes already off: Added Custom.
      const ref = stepNamed(expr) !== undefined || ctx.queries.has(expr) ? expr : mReference(expr, app);
      if (ref !== null) {
        if (stepNamed(ref) !== undefined) { expr = stepNamed(ref); continue; }
        if (ctx.queries.has(ref)) {
          const up = traceQuery(ctx, ref, col, [...seen, query]);
          if (up.unresolved) return up;
          return { ...up, via: [ref, ...(up.via || [])] };
        }
        return { unresolved: `"${ref}" isn't a step or a query of this model` };
      }
      if (/^let\b/.test(expr)) {
        const inner = app.parseMSteps(expr);
        if (!inner) return { unresolved: 'a let … in … that could not be read' };
        scopes = [new Map(inner.steps.map(st => [st.name, st.expr])), ...scopes];
        expr = inner.result;
        continue;
      }
      const branch = mIf(expr);
      if (branch) {
        const a = walk(branch.then, col, scopes), b = walk(branch.else, col, scopes);
        if (a.unresolved) return a;
        if (b.unresolved) return b;
        if (JSON.stringify(a.sources) !== JSON.stringify(b.sources)) return { unresolved: 'an if … then … else picks between different sources' };
        return a;
      }
      const nav = mNavigation(expr, app);
      if (nav) {
        const f = nav.fields;
        const root = describeRoot(ctx, query, nav.base);
        const object = f.Item || ((f.Kind === 'Table' || f.Kind === 'View' || f.Kind === 'Sheet') && f.Name) || (root.schema && !f.Kind && f.Name);
        if (!object) return { unresolved: 'the navigation stops above a table (a database or schema)' };
        const table = root.file ? `${root.file} › ${object}` : object;
        return { sources: [{ connector: root.connector, system: [root.system, root.database].filter(Boolean).join(' / '), schema: f.Schema || root.schema || '', table, column: col }] };
      }
      const call = mCall(expr, app);
      if (!call) return { unresolved: `a step that isn't a table function call: ${expr.replace(/\s+/g, ' ').slice(0, 80)}` };
      if (call.rest) return { unresolved: `${call.fn}(…)${call.rest.slice(0, 20)} — a call followed by more` };
      const fn = call.fn;
      if (KEEPS_NAMES.has(fn)) {
        if (col && CHANGES_VALUES.has(fn) && call.args.slice(1).some(a => a.includes(`"${col}"`))) notes.push(`values changed by ${fn}`);
        expr = call.args[0];
        continue;
      }
      if (fn === 'Table.RenameColumns') {
        const pairs = namePairs(call.args[1], app);
        if (!pairs) return { unresolved: 'Table.RenameColumns with names worked out at refresh time' };
        const hit = col && pairs.find(([, to]) => to === col);
        if (hit) { notes.push(`renamed ${hit[0]} → ${col}`); renamed = true; col = hit[0]; }
        expr = call.args[0];
        continue;
      }
      if (fn === 'Table.DuplicateColumn') {
        const from = mString(call.args[1]), to = mString(call.args[2]);
        if (from === null || to === null) return { unresolved: 'Table.DuplicateColumn with names worked out at refresh time' };
        if (col === to) { notes.push(`copied from ${from}`); renamed = true; col = from; }
        expr = call.args[0];
        continue;
      }
      if (fn === 'Table.AddColumn' || fn === 'Table.AddIndexColumn') {
        const made = mString(call.args[1]);
        if (made === null) return { unresolved: `${fn} with a name worked out at refresh time` };
        if (col === made) return { unresolved: `computed in Power Query (${fn} "${made}")`, computed: true };
        expr = call.args[0];
        continue;
      }
      if (fn === 'Table.PromoteHeaders') { expr = call.args[0]; continue; }
      if (TYPED_IN.has(fn)) {
        // Rows typed in (Enter Data's compressed JSON, or a literal list) vs rows the query generates
        // (Table.FromList(List.Dates(…)) — SamplePBIP's calendar): only the first has no source to find.
        // These rows start with names like Column1; the name that means something is the one the
        // query gives the column, so report that and leave out the renames in between.
        const rows = fn === '#table' ? call.args[1] : call.args[0];
        const typed = /^\s*Json\.Document\s*\(\s*Binary\.Decompress/.test(rows || '') || isLiteralList(rows);
        if (typed) return { plain: true, sources: [{ connector: 'typed-in', system: '', schema: '', table: `${query} (rows typed into the query)`, column }], trace: 'exact', note: '' };
        const gen = (String(rows || '').match(/\b(List\.[A-Za-z]+)\s*\(/) || [])[1];
        return { plain: true, sources: [{ connector: 'generated', system: '', schema: '', table: `${query} (rows generated in Power Query)`, column }], trace: 'derived', note: gen ? `rows made by ${gen}` : 'rows made by the query' };
      }
      const file = fileOf(call, app);
      if (file && fn === 'Csv.Document') return { sources: [{ connector: 'file', system: file.folder, schema: '', table: file.name, column: col }] };
      if (fn === 'Value.NativeQuery' || (CONNECTORS[fn] && /\bQuery\s*=/.test(call.args.slice(2).join(',')))) return { unresolved: 'a native SQL query', sql: true };
      return { unresolved: `a step calling ${fn}` };
    }
    return { unresolved: 'too many steps' };
  };
  const out = walk(q.start, column);
  if (out.unresolved) return out;
  if (out.plain) { const { plain, ...rest } = out; return rest; }
  // Notes read from the model back to the source: this query's steps, then the queries it reads.
  const trace = out.trace === 'derived' ? 'derived' : renamed || out.trace === 'renamed' ? 'renamed' : 'exact';
  return { ...out, trace, note: [...new Set([...notes, out.note].filter(Boolean))].join('; ') };
}
/* A list written out in full — {"North", "South"}, {{1, "a"}, {2, "b"}} — rather than computed. */
function isLiteralList(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{') || closeOf(t, 0) !== t.length - 1) return false;
  // Only text, numbers, null / true / false and #date(…)-style values; any other name is computed.
  const bare = t.replace(/"(?:[^"]|"")*"/g, '""').replace(/#(?:date|datetime|datetimezone|time|duration)\s*\(/g, '(');
  return (bare.match(/[A-Za-z_][A-Za-z0-9_.]*/g) || []).every(w => w === 'null' || w === 'true' || w === 'false');
}
/* {{"old", "new"}, …} → [[old, new], …], or null when it isn't a literal list of text pairs. */
function namePairs(text, app) {
  const t = String(text || '').trim();
  if (!t.startsWith('{') || closeOf(t, 0) !== t.length - 1) return null;
  const pairs = [];
  for (const item of app.splitTopLevel(t.slice(1, -1), ',')) {
    const it = item.trim();
    if (!it.startsWith('{') || closeOf(it, 0) !== it.length - 1) return null;
    const [from, to] = app.splitTopLevel(it.slice(1, -1), ',').map(mString);
    if (from === null || to === null || from === undefined || to === undefined) return null;
    pairs.push([from, to]);
  }
  return pairs;
}

/* Direct Lake tables have no M: the table's partition names a lakehouse or warehouse table
   (entityName, schemaName) read through a shared expression (expressionSource). model.bim keeps
   them in JSON; TMDL in the partition's `source` block, which the explorer doesn't keep. */
function directLakeEntities(files) {
  const out = new Map();
  for (const [p, text] of Object.entries(files)) {
    if (/\/tables\/[^/]+\.tmdl$/i.test(p)) {
      const t = text.replace(/\r\n?/g, '\n');
      const name = (t.match(/^table\s+(.+?)\s*$/m) || [])[1];
      const part = t.match(/^\tpartition\s+.+?=\s*entity\s*$([\s\S]*?)(?=^\t[a-z]|$(?![\s\S]))/m);
      if (!name || !part) continue;
      const prop = k => (part[1].match(new RegExp(`^\\t\\t\\t${k}:\\s*(.+?)\\s*$`, 'm')) || [])[1] || '';
      out.set(unquoteName(name), { entity: prop('entityName'), schema: prop('schemaName'), expressionSource: unquoteName(prop('expressionSource')) });
    } else if (/model\.bim$/i.test(p)) {
      let bim; try { bim = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { continue; }
      for (const t of ((bim.model || {}).tables || [])) {
        const src = ((t.partitions || [])[0] || {}).source || {};
        if (src.type === 'entity' || src.entityName) out.set(t.name, { entity: src.entityName || '', schema: src.schemaName || '', expressionSource: src.expressionSource || '' });
      }
    }
  }
  return out;
}
function unquoteName(s) { s = String(s || '').trim(); return /^'.*'$/.test(s) ? s.slice(1, -1).replace(/''/g, "'") : s; }

/* ── The model's facts ─────────────────────────────────────────────────────────────────────── */

/* Everything the tasks and the workbook need about one model, from the loaded app. */
function buildFacts(app, files, folder) {
  const s = app.App.state;
  const ctx = traceContext(app);
  const ix = app.daxModelIndex();
  const entities = directLakeEntities(files);
  const byKey = new Map();          // "Table.Name" (the explorer's key) → { table, name, kind }
  const tableByLower = new Map(s.tables.map(t => [t.name.toLowerCase(), t]));
  for (const t of s.tables) {
    for (const c of t.columns) byKey.set(`${t.name}.${c.name}`, { table: t.name, name: c.name, kind: 'column', c });
    for (const m of t.measures) byKey.set(`${t.name}.${m.name}`, { table: t.name, name: m.name, kind: 'measure' });
  }
  // Blank DAX comments before looking for references: a line commented out uses nothing
  // (SamplePBIP's Value Normalized keeps an old version of itself in comments).
  const uncommented = dax => String(dax || '').replace(/"(?:[^"]|"")*"|\/\/[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\//g, m => (m[0] === '"' ? m : m.replace(/[^\n]/g, ' ')));
  const refsOf = (daxText, home) => {
    const dax = uncommented(daxText);
    const r = app.parseDaxReferences(dax, home, ix);
    const cols = [...r.columns].map(k => byKey.get(k)).filter(Boolean).map(e => `${e.table}[${e.name}]`);
    const meas = [...r.measures].map(k => byKey.get(k)).filter(Boolean).map(e => e.name);
    const tables = [...app.daxNamesUsed(dax)].map(n => tableByLower.get(n)).filter(Boolean).map(t => t.name);
    return { columns: [...new Set(cols)].sort(), measures: [...new Set(meas)].sort(), tables: [...new Set(tables)].sort() };
  };

  const measures = [];
  for (const t of s.tables) {
    for (const m of t.measures) {
      measures.push({ name: m.name, table: t.name, folder: m.displayFolder || '', dax: m.dax || '', ...refsOf(m.dax, t.name) });
    }
  }

  // Columns the measures reach — directly, or through calculated columns — and the tables they name.
  const columns = {};
  const queue = measures.flatMap(m => m.columns);
  const tablesNamed = new Set(measures.flatMap(m => m.tables));
  while (queue.length) {
    const key = queue.shift();
    if (columns[key]) continue;
    const [, table, name] = key.match(/^(.*)\[(.*)\]$/);
    const t = s.tables.find(x => x.name === table), c = t && t.columns.find(x => x.name === name);
    if (!c) continue;
    const kind = app.tableKind(t);
    const entry = { table, column: name, sourceColumn: c.sourceColumn || '', tableKind: kind };
    if (c.calcDax) {
      const r = refsOf(c.calcDax, table);
      Object.assign(entry, { calculated: c.calcDax, derivedFrom: r.columns });
      entry.lineage = { derivedFrom: r.columns, trace: 'derived', note: 'calculated column', by: 'extractor' };
      queue.push(...r.columns);
    } else {
      entry.lineage = traceColumn(ctx, t, c, entities);
    }
    entry.used = true;
    columns[key] = entry;
  }
  // Every other column too, unused by the measures: a calculated table an AI traces may be built on
  // one (derivedFrom), and the workbook can follow it only if it's traced. No tasks are made for these.
  for (const t of s.tables) {
    for (const c of t.columns) {
      const key = `${t.name}[${c.name}]`;
      if (columns[key]) continue;
      const entry = { table: t.name, column: c.name, sourceColumn: c.sourceColumn || '', tableKind: app.tableKind(t), used: false };
      entry.lineage = c.calcDax ? { derivedFrom: refsOf(c.calcDax, t.name).columns, trace: 'derived', note: 'calculated column', by: 'extractor' }
        : traceColumn(ctx, t, c, entities);
      if (c.calcDax) entry.calculated = c.calcDax;
      columns[key] = entry;
    }
  }

  // Tables named in the DAX: where the table itself comes from (COUNTROWS(Sales) counts its rows).
  const tables = {};
  for (const t of s.tables) {
    const kind = app.tableKind(t);
    const src = app.tableSource(t, s.expressions, s.tables);
    const entry = { table: t.name, kind, hidden: !!t.isHidden, detected: src ? `${src.name}${src.server && src.server !== src.name ? ` (${src.server})` : ''}` : '' };
    if (kind === 'm') entry.query = ctx.code(t.name);
    else if (kind === 'calculated' || kind === 'calc-group') entry.dax = t.partitionSource || '';
    else if (t.partitionSource) entry.partition = t.partitionSource;   // e.g. a legacy `SELECT * FROM [Casos]` query partition
    if (entities.has(t.name)) entry.directLake = entities.get(t.name);
    if (tablesNamed.has(t.name)) entry.lineage = traceColumn(ctx, t, null, entities);
    tables[t.name] = entry;
  }

  const html = process.env.PBIP_HTML || path.join(__dirname, '..', 'pbip-explorer.html');
  return {
    format: 'pbip-lineage/1',
    model: s.projectName,
    modelFormat: s.modelFormat,
    folder: path.resolve(folder),
    generated: new Date().toISOString(),
    explorer: `${path.basename(html)} sha1:${crypto.createHash('sha1').update(fs.readFileSync(html)).digest('hex').slice(0, 12)}`,
    parameters: app.modelParameters(s.expressions, s.tables).map(p => ({ name: p.name, type: p.type, value: p.value, loaded: p.loaded })),
    queries: Object.fromEntries([...ctx.queries.keys()].filter(n => n in (s.expressions || {})).map(n => [n, ctx.code(n)])),
    tables, columns, measures,
  };
}

/* One column's physical source, as far as the extractor can be sure of it. */
function traceColumn(ctx, t, c, entities) {
  const { app } = ctx;
  const kind = app.tableKind(t);
  const colName = c ? (c.sourceColumn || c.name) : null;
  const done = r => (r.unresolved ? { unresolved: r.unresolved, computed: !!r.computed, sql: !!r.sql, by: 'extractor' }
    : { sources: r.sources, trace: c && c.sourceColumn && c.sourceColumn !== c.name ? 'renamed' : r.trace,
      note: [c && c.sourceColumn && c.sourceColumn !== c.name ? `renamed ${c.sourceColumn} → ${c.name} in the model` : '', r.note, r.via && r.via.length ? `through ${r.via.join(' → ')}` : '']
        .filter(Boolean).join('; '), by: 'extractor' });
  if (entities.has(t.name)) {
    const e = entities.get(t.name);
    // FCA's partitions don't name their expressionSource; its model has just the one to read through.
    const shared = [...ctx.queries.keys()].filter(n => n in (app.App.state.expressions || {}));
    const via = e.expressionSource || (shared.length === 1 ? shared[0] : '');
    const root = via && ctx.queries.has(via) ? describeRoot(ctx, via, ctx.steps(via).start) : {};
    return done({ sources: [{ connector: root.connector || 'direct-lake', system: [root.system, root.database].filter(Boolean).join(' / '), schema: e.schema, table: e.entity || t.name, column: colName }], trace: 'exact', note: 'Direct Lake' });
  }
  // A parameter loaded as a table (FHSQLMonitor's Server name): its one value is typed in.
  if (app.isParameterTable(t)) {
    const value = String(t.partitionSource || '').trim().match(/^("(?:[^"]|"")*"|[^\s]+)/);
    return done({ sources: [{ connector: 'parameter', system: '', schema: '', table: `${t.name} (parameter)`, column: colName }], trace: 'exact', note: value ? `value ${value[1]}` : '' });
  }
  if (kind === 'm') return done(traceQuery(ctx, t.name, colName));
  if (kind === 'calculated') return { unresolved: 'a column of a calculated table (DAX)', calculatedTable: true, by: 'extractor' };
  if (t.partitionSource) return { unresolved: `a ${t.partitionKind || 'non-Power Query'} partition: ${String(t.partitionSource).trim().split('\n')[0].slice(0, 80)}`, by: 'extractor' };
  return { unresolved: `a table of kind ${kind}`, by: 'extractor' };
}

/* ── Tasks for the AI ──────────────────────────────────────────────────────────────────────── */

/* Split the work the extractor couldn't finish into files an AI can take one at a time:
   columns-NN.json (columns to trace, grouped by table with the evidence once per table) and
   measures-NN.json (measures to classify). Each stays under `budget` characters. */
function buildTasks(facts, { budget = 30000, perMeasureTask = 40 } = {}) {
  const tasks = [];
  const open = Object.entries(facts.columns).filter(([, c]) => c.used && c.lineage && c.lineage.unresolved);
  const byTable = new Map();
  for (const [key, c] of open) (byTable.get(c.table) || byTable.set(c.table, []).get(c.table)).push([key, c]);
  // The queries a query reads (shared ones, and other tables' queries), three levels deep: the
  // column's physical source is usually at the end of that chain.
  const allQueries = { ...Object.fromEntries(Object.values(facts.tables).filter(t => t.query).map(t => [t.table, t.query])), ...facts.queries };
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const readBy = (code, skip, depth = 0, acc = {}) => {
    if (depth > 2) return acc;
    for (const q of Object.keys(allQueries)) {
      if (q === skip || q in acc) continue;
      if (new RegExp(`#"${esc(q)}"|(?<![\\w.#"])${esc(q)}(?![\\w."])`).test(code)) { acc[q] = allQueries[q]; readBy(allQueries[q], skip, depth + 1, acc); }
    }
    return acc;
  };
  const tableEvidence = name => {
    const t = facts.tables[name] || {};
    const ev = { table: name, kind: t.kind, detected: t.detected };
    if (t.query) {
      ev.query = t.query;
      const used = readBy(t.query, name);
      if (Object.keys(used).length) ev.queries = used;
    }
    if (t.dax) ev.dax = t.dax;
    if (t.partition) ev.partition = t.partition;
    return ev;
  };
  let current = null;
  const flush = () => { if (current && current.tables.length) tasks.push(current); current = null; };
  for (const [table, cols] of byTable) {
    const ev = tableEvidence(table);
    ev.columns = cols.map(([key, c]) => ({ column: key, sourceColumn: c.sourceColumn, stoppedAt: c.lineage.unresolved }));
    const size = JSON.stringify(ev).length;
    if (!current || (current.size + size > budget && current.tables.length)) { flush(); current = { kind: 'columns', tables: [], size: 0 }; }
    current.tables.push(ev);
    current.size += size;
  }
  flush();
  let batch = null;
  for (const m of facts.measures) {
    const item = { measure: m.name, table: m.table, dax: m.dax, columns: m.columns, measures: m.measures, tables: m.tables };
    const size = JSON.stringify(item).length;
    if (!batch || batch.measures.length >= perMeasureTask || (batch.size + size > budget && batch.measures.length)) {
      if (batch) tasks.push(batch);
      batch = { kind: 'measures', measures: [], size: 0 };
    }
    batch.measures.push(item);
    batch.size += size;
  }
  if (batch) tasks.push(batch);
  let nc = 0, nm = 0;
  return tasks.map(t => {
    const file = t.kind === 'columns' ? `columns-${String(++nc).padStart(2, '0')}.json` : `measures-${String(++nm).padStart(2, '0')}.json`;
    const { size, ...rest } = t;
    const body = { task: file.replace(/\.json$/, ''), model: facts.model, instructions: 'lineage/INSTRUCTIONS.md', ...rest };
    // The task's fingerprint: an answer stays good for as long as the task it answers is unchanged,
    // so extracting again leaves every answer whose measures or queries didn't change.
    const run = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
    return { file, run, body: { ...body, run } };
  });
}

module.exports = { readProjectFolder, loadModels, buildFacts, buildTasks, traceContext, traceQuery, describeRoot, mIf, mNavigation, mCall, namePairs, directLakeEntities };
