// The Sources tab's Parameters list: every Power Query parameter (text, number, date/time, logical,
// null) with its type, value, suggested values, /// description and what uses it — tables that name
// it, or reach it through shared queries or other tables' queries. A [field] of the same name, a
// string, a comment or a step of the same name isn't a use. Shapes from RuiRomano's demo
// (CSV_Location, Environment), SamplePBIP (RangeStart, Randomizer, the RAW-* queries), FHSQLMonitor
// (Data load list) and finops-toolkit (a logical parameter).
'use strict';
const { loadApp, fileList, eq, has, hasNot, suite } = require('./harness');
const { tests, test } = suite();

const table = (name, m, extra = []) => [`table '${name.replace(/'/g, "''")}'`, ...extra, '\tcolumn Id', '\t\tdataType: int64', '\t\tsourceColumn: Id',
  '\tpartition P = m', '\t\tmode: import', '\t\tsource =', ...m.map(l => '\t\t\t\t' + l)].join('\n');
const model = (expressions, tables) => ({
  'P.SemanticModel/definition/model.tmdl': 'model Model\n\tculture: en-US\n',
  'P.SemanticModel/definition/expressions.tmdl': expressions.join('\n'),
  ...Object.fromEntries(tables.map(([name, m, extra], i) => [`P.SemanticModel/definition/tables/T${i}.tmdl`, table(name, m, extra)])),
});
async function load(files) {
  const app = loadApp(['App', 'processFiles', 'renderSources', 'modelParameters', 'buildMarkdownExport', 'applyExportPreset', 'renderTableDetail'], { dom: true });
  await app.processFiles(fileList(files));
  return app;
}

const project = model([
  '/// Where the CSV files are',
  'expression CSV_Location = "https://raw.githubusercontent.com/pbi-tools/sales-sample/data/" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]',
  '\tlineageTag: 39c7bef4-452b-4b29-846c-f788ef1af01f', '',
  'expression Environment = "DEV" meta [IsParameterQuery=true, List={"DEV", "QUAL", "PRD"}, DefaultValue="DEV", Type="Text", IsParameterQueryRequired=true]',
  'expression RangeStart = #datetime(2020, 1, 1, 0, 0, 0) meta [IsParameterQuery=true, Type="DateTime", IsParameterQueryRequired=true]',
  'expression Randomizer = 0.6 meta [IsParameterQuery=true, Type="Number", IsParameterQueryRequired=true]',
  "expression 'Data load list' = null meta [IsParameterQuery=true, Type=\"Text\", IsParameterQueryRequired=false]",
  "expression 'Remove Duplicate Resource IDs' = false meta [IsParameterQuery=true, List={false, true}, DefaultValue=false, Type=\"Logical\", IsParameterQueryRequired=true]",
  'expression RAW-Sales =', '\t\tlet',
  '\t\t    Source = Csv.Document(Web.Contents(CSV_Location, [RelativePath = "RAW-Sales.csv"])),',
  '\t\t    Scaled = Table.TransformColumns(Source, {{"Qty", each _ * Randomizer}})', '\t\tin', '\t\t    Scaled',
], [
  ['Customer', ['let', '    // RangeStart is not used here',
    '    Source = Csv.Document(Web.Contents(CSV_Location, [RelativePath = "RAW-Customer.csv"])),',
    '    Added = Table.AddColumn(Source, "Environment", each [Randomizer] * 2)', 'in', '    Added']],
  ['Sales', ['let', '    Source = #"RAW-Sales",', '    Filtered = Table.SelectRows(Source, each [OrderDate] >= RangeStart),',
    '    WithEnv = Table.AddColumn(Filtered, "Env", each Environment)', 'in', '    WithEnv']],
  ['Summary', ['let', '    Source = Table.Group(Sales, {"Env"}, {{"Rows", each Table.RowCount(_)}})', 'in', '    Source']],
  ['Shadow', ['let', '    Environment = "local",', '    Result = #table({"Env"}, {{Environment}})', 'in', '    Result']],
  ['Staging', ['let', '    Source = #"Data load list"', 'in', '    Source'], ['\tisHidden']],
]);

test('the parameters: type, value and suggested values, description, and the tables and queries that use them', async () => {
  const app = await load(project);
  const s = app.App.state;
  eq(app.modelParameters(s.expressions, s.tables).map(p => [p.name, p.type, p.value, p.list, p.tables, p.queries, p.description]), [
    ['CSV_Location', 'Text', '"https://raw.githubusercontent.com/pbi-tools/sales-sample/data/"', '', ['Customer', 'Sales', 'Summary'], ['RAW-Sales'], 'Where the CSV files are'],
    ['Environment', 'Text', '"DEV"', '{"DEV", "QUAL", "PRD"}', ['Sales', 'Summary'], [], ''],
    ['RangeStart', 'DateTime', '#datetime(2020, 1, 1, 0, 0, 0)', '', ['Sales', 'Summary'], [], ''],
    ['Randomizer', 'Number', '0.6', '', ['Sales', 'Summary'], ['RAW-Sales'], ''],
    ['Data load list', 'Text', 'null', '', ['Staging'], [], ''],
    ['Remove Duplicate Resource IDs', 'Logical', 'false', '{false, true}', [], [], ''],
  ], 'parameters');

  app.renderSources();
  const html = app.App.els.sourcesContent.innerHTML;
  has(html, '<div class="section-title">Parameters <span');
  const row = name => { const at = html.indexOf(`<td style="font-weight:600">${name}`); return at < 0 ? '' : html.slice(at, html.indexOf('</tr>', at)); };
  has(row('CSV_Location'), 'Where the CSV files are');
  has(row('CSV_Location'), '<span class="data-type string">Text</span>');
  has(row('CSV_Location'), '<td style="overflow-wrap:anywhere">https://raw.githubusercontent.com/pbi-tools/sales-sample/data/</td>');
  for (const t of ['Customer', 'Sales', 'Summary']) has(row('CSV_Location'), `<span class="chip" data-table="${t}">${t}</span>`);
  has(row('CSV_Location'), '<span class="flag">queries: RAW-Sales</span>');
  has(row('Environment'), 'one of: DEV, QUAL, PRD');
  has(row('RangeStart'), '<span class="data-type dateTime">DateTime</span>');
  has(row('RangeStart'), '>2020-01-01</td>');
  has(row('Data load list'), '<span class="flag">null</span>');
  has(row('Data load list'), '<span class="flag">+1 hidden</span>');   // Staging is hidden
  hasNot(row('Data load list'), 'data-table="Staging"');
  has(row('Remove Duplicate Resource IDs'), 'one of: false, true');
  has(row('Remove Duplicate Resource IDs'), '<span class="flag">not used</span>');

  s.showHidden = true;
  app.renderSources();
  has(app.App.els.sourcesContent.innerHTML, '<span class="chip" data-table="Staging">Staging</span>');
});

test('the export: a Parameters section after Data sources, its own toggle, and a count in the summary', async () => {
  const app = await load(project);
  const o = app.App.state.exportOpts;
  const md = app.buildMarkdownExport(o);
  has(md, '| Parameters | 6 |');
  eq(md.slice(md.indexOf('## Parameters'), md.indexOf('## Tables')).split('\n'), [
    '## Parameters', '', '_Power Query parameters: inputs to the queries rather than data sources._', '',
    '### CSV_Location', '', 'Where the CSV files are', '',
    '- **Type:** Text', '- **Value:** `https://raw.githubusercontent.com/pbi-tools/sales-sample/data/`',
    '- **Tables (3):** Customer, Sales, Summary', '- **Queries (1):** RAW-Sales', '',
    '### Environment', '', '- **Type:** Text', '- **Value:** `DEV`', '- **Suggested values:** DEV, QUAL, PRD', '- **Tables (2):** Sales, Summary', '',
    '### RangeStart', '', '- **Type:** DateTime', '- **Value:** `2020-01-01`', '- **Tables (2):** Sales, Summary', '',
    '### Randomizer', '', '- **Type:** Number', '- **Value:** `0.6`', '- **Tables (2):** Sales, Summary', '- **Queries (1):** RAW-Sales', '',
    '### Data load list', '', '- **Type:** Text', '- **Value:** `null`', '- **Tables:** 1 hidden', '',
    '### Remove Duplicate Resource IDs', '', '- **Type:** Logical', '- **Value:** `false`', '- **Suggested values:** false, true', '- **Used by:** none', '', '',
  ], 'section');
  if (!(md.indexOf('## Data sources') < md.indexOf('## Parameters'))) throw new Error('Parameters should follow Data sources');
  has(app.buildMarkdownExport({ ...o, includeHidden: true }), '### Data load list\n\n- **Type:** Text\n- **Value:** `null`\n- **Tables (1):** Staging\n');
  const off = app.buildMarkdownExport({ ...o, parameters: false });
  hasNot(off, '## Parameters');
  has(off, '| Parameters | 6 |');
  const presets = ['schema', 'measures', 'everything'].map(name => { app.applyExportPreset(name); return o.parameters; });
  eq(presets, [false, false, true], 'schema, measures, everything presets');
});

// FHSQLMonitor: its server, database and schema are parameters with Enable load — tables whose
// query is the parameter — and every data table reads Sql.Databases(#"Server name").
const SERVER = '"localhost" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]';
const DATABASE = '"FHSQLMonitor" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]';
const readTable = item => ['let', '    dbList = Sql.Databases(#"Server name"),', '    db = dbList{[Name = #"Database name"]}[Data],',
  `    table = db{[Schema = "FHSM", Item = "${item}"]}[Data]`, 'in', '    table'];
const DATA_LOAD = ['let', '    Source = Table.FromRows({{"Waits", "Yes"}}, {"Service", "DataLoad"})', 'in', '    Source'];
const WAITS = ['let', '    load = Table.First(Table.SelectRows(#"Data load", each [Service] = "Waits")),',
  '    dbList = Sql.Databases(#"Server name"),', '    db = dbList{[Name = #"Database name"]}[Data],',
  '    table = db{[Schema = "FHSM", Item = "Waits"]}[Data]', 'in', '    table'];
const loadedTmdl = {
  'P.SemanticModel/definition/model.tmdl': 'model Model\n\tculture: en-US\n',
  'P.SemanticModel/definition/tables/Server name.tmdl': ['/// The SQL Server instance to read', "table 'Server name'",
    "\tcolumn 'Server name'", '\t\tdataType: string', "\t\tsourceColumn: Server name", "\tpartition 'Server name' = m", '\t\tmode: import', `\t\tsource = ${SERVER}`].join('\n'),
  'P.SemanticModel/definition/tables/Database name.tmdl': ["table 'Database name'",
    "\tcolumn 'Database name'", '\t\tdataType: string', "\t\tsourceColumn: Database name", "\tpartition 'Database name' = m", '\t\tmode: import', `\t\tsource = ${DATABASE}`].join('\n'),
  'P.SemanticModel/definition/tables/Date.tmdl': table('Date', readTable('Date')),
  'P.SemanticModel/definition/tables/Data load.tmdl': table('Data load', DATA_LOAD),
  'P.SemanticModel/definition/tables/Waits.tmdl': table('Waits', WAITS),
};
const bimTable = (name, expression, description) => ({ name, ...(description ? { description } : {}),
  columns: [{ name: 'Id', dataType: 'int64', sourceColumn: 'Id' }], partitions: [{ name, mode: 'import', source: { type: 'm', expression } }] });
const loadedTmsl = { 'P.SemanticModel/model.bim': { compatibilityLevel: 1601, model: { tables: [
  bimTable('Server name', SERVER, 'The SQL Server instance to read'), bimTable('Database name', DATABASE),
  bimTable('Date', readTable('Date')), bimTable('Data load', DATA_LOAD), bimTable('Waits', WAITS)] } } };

for (const [format, files] of [['TMDL', loadedTmdl], ['TMSL', loadedTmsl]]) {
  test(`${format}: a parameter loaded as a table feeds connectors, has a card of its own, and is listed`, async () => {
    const app = await load(files);
    const s = app.App.state;
    eq(s.sources.map(src => [src.name, src.type, [...src.queries].sort()]), [
      ['Inline Data', 'other', ['Data load']],
      ['Loaded Parameters', 'other', ['Database name', 'Server name']],
      ['localhost', 'sql-server', ['Date', 'Waits']],   // Waits reads Data load's rows too, but its data is SQL's
    ], 'sources');
    eq(app.modelParameters(s.expressions, s.tables).map(p => [p.name, p.loaded, p.type, p.value, p.tables, p.description]), [
      ['Database name', true, 'Text', '"FHSQLMonitor"', ['Date', 'Waits'], ''],
      ['Server name', true, 'Text', '"localhost"', ['Date', 'Waits'], 'The SQL Server instance to read'],
    ], 'parameters');
    app.renderSources();
    has(app.App.els.sourcesContent.innerHTML, '<td style="font-weight:600">Server name<div class="flag" style="font-weight:400;margin-top:3px">loaded as a table</div>');
    has(app.buildMarkdownExport(s.exportOpts), '### Server name\n\nThe SQL Server instance to read\n\n- **Type:** Text\n- **Loaded as a table:** yes (Enable load)\n- **Value:** `localhost`\n- **Tables (2):** Date, Waits\n');
    const detail = app.element();
    app.document.getElementById = id => (id === 'tableDetail' ? detail : null);
    s.activeTable = 'Server name';
    app.renderTableDetail();
    has(detail.innerHTML, '<span class="source-type-badge other">other</span> <span style="font-family:var(--mono);color:var(--text-2)">Loaded Parameters</span>');
  });
}

test("names, values and descriptions render as text; past 12 tables a parameter's chips fold away", async () => {
  const tables = Array.from({ length: 14 }, (_, i) => [`T${String(i + 1).padStart(2, '0')}`, ['let', '    Source = Sql.Database(#"<b>Server</b>", "db")', 'in', '    Source']]);
  const app = await load(model([
    '/// <script>alert(1)</script>',
    "expression '<b>Server</b>' = \"<img src=x onerror=alert(1)>\" meta [IsParameterQuery=true, List={\"<i>a</i>\"}, Type=\"Text\", IsParameterQueryRequired=true]",
  ], tables));
  app.renderSources();
  const html = app.App.els.sourcesContent.innerHTML.slice(app.App.els.sourcesContent.innerHTML.indexOf('>Parameters <'));
  for (const bad of ['<b>Server', '<img src=x', '<script>', '<i>a']) hasNot(html, bad);
  for (const good of ['&lt;b&gt;Server&lt;/b&gt;', '&lt;img src=x onerror=alert(1)&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;', 'one of: &lt;i&gt;a&lt;/i&gt;']) has(html, good);
  const [before, after] = html.split('<details');
  eq([(before.match(/class="chip"/g) || []).length, (after.match(/class="chip"/g) || []).length], [12, 2], 'chips shown, folded');
  has(after, 'and 2 more tables</summary>');
});

module.exports = tests;
