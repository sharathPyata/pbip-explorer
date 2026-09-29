// Measure lineage (lineage/): the extractor traces columns through the model's sourceColumn and Power
// Query to their physical source where every step is certain, leaves the rest as AI tasks, and the
// workbook build merges both — measures inheriting the fields of the measures they're built on,
// calculated columns expanded to their sources. Shapes: FHSQLMonitor (Sql.Databases navigation with
// a loaded parameter and an if … then … else), OD reviews (Oracle), SamplePBIP (CSV over a URL, a
// generated calendar, Table.AddColumn), FCA (Direct Lake).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { eq, has, suite } = require('./harness');
const { loadModels, buildFacts, buildTasks } = require('../lineage/model');
const { buildLineage } = require('../lineage/build-excel');
const { writeXlsx, colLetter } = require('../lineage/xlsx');
const { tests, test } = suite();

const tbl = (name, columns, source, extra = []) => [`table '${name}'`, ...extra,
  ...columns.flatMap(([c, src, dax]) => (dax ? [`\tcolumn '${c}' = ${dax}`, '\t\tdataType: double']
    : [`\tcolumn '${c}'`, '\t\tdataType: string', `\t\tsourceColumn: ${src || c}`])),
  ...source].join('\n');
const mPartition = (name, lines) => [`\tpartition '${name}' = m`, '\t\tmode: import', '\t\tsource =', ...lines.map(l => '\t\t\t\t' + l)];
const measure = (name, dax) => `\tmeasure '${name}' = ${dax}`;

const files = {
  'P.SemanticModel/definition/model.tmdl': 'model Model\n\tculture: en-US\n',
  'P.SemanticModel/definition/expressions.tmdl': [
    'expression Server = "sql01.contoso.com" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]',
    '\tlineageTag: a', '',
    'expression Lake =', '\t\tlet', '\t\t    database = Sql.Database("lake.datawarehouse.fabric.microsoft.com", "LakeDb")', '\t\tin', '\t\t    database',
    '\tlineageTag: b', ''].join('\n'),
  'P.SemanticModel/definition/tables/Server name.tmdl': tbl('Server name', [['Server name']],
    ["\tpartition 'Server name' = m", '\t\tmode: import', '\t\tsource = "localhost" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]']),
  'P.SemanticModel/definition/tables/Date.tmdl': tbl('Date', [['Date'], ['Month']], mPartition('Date', ['let',
    '    dbList = Sql.Databases(#"Server name"),', '    db = dbList{[Name = "FHSQLMonitor"]}[Data],',
    '    table = db{[Schema = "FHSM", Item = "Date"]}[Data],', '    emptyDataset = Table.FirstN(table, 0),',
    '    datasetToUse = if (1 = 1) then table else emptyDataset,',
    '    selectColumns = Table.SelectColumns(datasetToUse, {"Date", "MonthName"}),',
    '    renameColumns = Table.RenameColumns(selectColumns, {{"MonthName", "Month"}})', 'in', '    renameColumns'])),
  'P.SemanticModel/definition/tables/Sales.tmdl': tbl('Sales', [['Sales Amount', 'SalesAmt'], ['Cost'], ['Margin'], ['Net', '', "Sales[Sales Amount] - Sales[Cost]"]],
    mPartition('Sales', ['let', '    Source = Sql.Database(Server, "SalesDb"),', '    dbo_FactSales = Source{[Schema="dbo",Item="FactSales"]}[Data],',
      '    #"Added Margin" = Table.AddColumn(dbo_FactSales, "Margin", each [SalesAmt] - [Cost])', 'in', '    #"Added Margin"']),
    [measure('Total Sales', 'SUM(Sales[Sales Amount])'), measure('West Sales', 'CALCULATE([Total Sales], Store[Region] = "West")'),
      measure('Big West', 'IF([West Sales] > 100, [Total Sales])'), measure('Net Total', 'SUMX(Sales, Sales[Net])'),
      measure('Margin Total', 'SUM(Sales[Margin])'), measure('Orders Qty', 'SUM(Orders[Quantity])'), measure('Order Count', 'COUNTROWS(Orders)'),
      measure('Lake Total', "SUM('Lakehouse Sales'[Amount])"), measure('Month Label', "SELECTEDVALUE('Date'[Month])"),
      measure('Category Count', 'DISTINCTCOUNT(Products[Category])'), measure('Days', 'COUNTROWS(Calendar)'), measure('First Day', 'MIN(Calendar[Date])'),
      measure('Server Label', "SELECTEDVALUE('Server name'[Server name])")]),
  'P.SemanticModel/definition/tables/Store.tmdl': tbl('Store', [['Region', 'REGION_NAME']], mPartition('Store', ['let',
    '    Source = Oracle.Database("""ora01:1521/SVC""", [HierarchicalNavigation=true]),', '    RETAIL = Source{[Schema="RETAIL"]}[Data],',
    '    STORES = RETAIL{[Name="STORES"]}[Data]', 'in', '    STORES'])),
  'P.SemanticModel/definition/tables/Products.tmdl': tbl('Products', [['Category']], mPartition('Products', ['let',
    '    Source = Csv.Document(Web.Contents("https://files.contoso.com/data/", [RelativePath = "products.csv"]), [Delimiter=","]),',
    '    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),',
    '    #"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers", {{"Category", type text}})', 'in', '    #"Changed Type"'])),
  'P.SemanticModel/definition/tables/Orders.tmdl': tbl('Orders', [['Quantity']], mPartition('Orders', ['let',
    '    Source = Sql.Database("sql01.contoso.com", "SalesDb", [Query="SELECT o.id AS OrderId, o.qty AS Quantity FROM dbo.Orders o"])', 'in', '    Source'])),
  'P.SemanticModel/definition/tables/Calendar.tmdl': tbl('Calendar', [['Date']], mPartition('Calendar', ['let',
    '    Source = List.Dates(#date(2020, 1, 1), 366, #duration(1, 0, 0, 0)),',
    '    AsTable = Table.FromList(Source, Splitter.SplitByNothing(), {"Date"})', 'in', '    AsTable'])),
  'P.SemanticModel/definition/tables/Lakehouse Sales.tmdl': tbl('Lakehouse Sales', [['Amount', 'amount_usd']],
    ["\tpartition 'Lakehouse Sales' = entity", '\t\tmode: directLake', '\t\tsource', '\t\t\tentityName: fact_sales', '\t\t\tschemaName: gold', '\t\t\texpressionSource: Lake']),
};

let factsCache = null;
async function facts() {
  if (!factsCache) {
    const [app] = await loadModels(files);
    factsCache = buildFacts(app, files, 'P');
  }
  return JSON.parse(JSON.stringify(factsCache));
}
const src = (connector, system, schema, table, column) => ({ connector, system, schema, table, column });
const lineageOf = (f, key) => { const l = f.columns[key].lineage; return l.unresolved ? { unresolved: l.unresolved } : { sources: l.sources, trace: l.trace }; };

test('the extractor traces columns through the model, Power Query navigation, renames and files', async () => {
  const f = await facts();
  eq(lineageOf(f, 'Date[Month]'), { sources: [src('sql-server', 'localhost / FHSQLMonitor', 'FHSM', 'Date', 'MonthName')], trace: 'renamed' }, 'Sql.Databases, a loaded parameter, if … then … else, a rename');
  eq(lineageOf(f, 'Sales[Sales Amount]'), { sources: [src('sql-server', 'sql01.contoso.com / SalesDb', 'dbo', 'FactSales', 'SalesAmt')], trace: 'renamed' }, 'a rename in the model (sourceColumn)');
  has(f.columns['Sales[Sales Amount]'].lineage.note, 'renamed SalesAmt → Sales Amount in the model');
  eq(lineageOf(f, 'Store[Region]'), { sources: [src('oracle', 'ora01:1521/SVC', 'RETAIL', 'STORES', 'REGION_NAME')], trace: 'renamed' }, 'Oracle: Schema, then Name');
  eq(lineageOf(f, 'Products[Category]'), { sources: [src('file', 'https://files.contoso.com/data/', '', 'products.csv', 'Category')], trace: 'exact' }, 'a CSV over a URL, headers promoted');
  eq(lineageOf(f, 'Calendar[Date]'), { sources: [src('generated', '', '', 'Calendar (rows generated in Power Query)', 'Date')], trace: 'derived' }, 'rows the query generates');
  eq(lineageOf(f, 'Lakehouse Sales[Amount]'), { sources: [src('sql-server', 'lake.datawarehouse.fabric.microsoft.com / LakeDb', 'gold', 'fact_sales', 'amount_usd')], trace: 'renamed' }, 'Direct Lake');
  eq(lineageOf(f, 'Server name[Server name]').sources, [src('parameter', '', '', 'Server name (parameter)', 'Server name')], 'a loaded parameter');
  eq(f.columns['Sales[Net]'].lineage.derivedFrom, ['Sales[Cost]', 'Sales[Sales Amount]'], 'a calculated column');
  eq(lineageOf(f, 'Sales[Margin]'), { unresolved: 'computed in Power Query (Table.AddColumn "Margin")' }, 'Table.AddColumn is for the AI');
  eq(lineageOf(f, 'Orders[Quantity]'), { unresolved: 'a native SQL query' }, 'native SQL is for the AI');
  eq(f.tables.Orders.lineage.unresolved, 'a native SQL query', 'COUNTROWS(Orders): the table itself');
});

test('what the extractor leaves becomes tasks: columns with their evidence, measures with their references', async () => {
  const f = await facts();
  const tasks = buildTasks(f);
  eq(tasks.map(t => t.file), ['columns-01.json', 'measures-01.json'], 'task files');
  // A task's run is a fingerprint of its content: the same model gives the same runs.
  eq(buildTasks(await facts()).map(t => t.run), tasks.map(t => t.run), 'runs are stable');
  if (tasks[0].run === tasks[1].run || !/^[0-9a-f]{12}$/.test(tasks[0].run)) throw new Error(`runs: ${tasks.map(t => t.run)}`);
  const cols = tasks[0].body.tables;
  eq(cols.map(t => [t.table, t.columns.map(c => c.column)]), [['Sales', ['Sales[Margin]']], ['Orders', ['Orders[Quantity]']]], 'columns to trace');
  has(cols[0].query, 'Sql.Database("sql01.contoso.com", "SalesDb")');   // the parameter's value filled in
  has(cols[1].query, 'SELECT o.id AS OrderId');
  const west = tasks[1].body.measures.find(m => m.measure === 'West Sales');
  eq([west.columns, west.measures], [['Store[Region]'], ['Total Sales']], 'a measure\'s references');
});

/* A model.json and answers in a temporary folder, as extract.js and the AI would leave them. */
async function built(answers) {
  const f = await facts();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-'));
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ ...f, tasks: [{ file: 'columns-01.json', run: 'R1' }, { file: 'measures-01.json', run: 'R1' }] }));
  fs.mkdirSync(path.join(dir, 'answers'));
  for (const [name, body] of Object.entries(answers)) fs.writeFileSync(path.join(dir, 'answers', name), JSON.stringify(body));
  return buildLineage(dir);
}
const main = (field, usage) => ({ field, role: 'main', usage });
const answers = {
  'columns-01.json': { task: 'columns-01', run: 'R1', columns: [
    { column: 'Sales[Margin]', sources: [src('sql-server', 'sql01.contoso.com / SalesDb', 'dbo', 'FactSales', 'SalesAmt'), src('sql-server', 'sql01.contoso.com / SalesDb', 'dbo', 'FactSales', 'CostAmount')], derivedFrom: [], trace: 'derived', note: 'SalesAmt - Cost' },
    { column: 'Orders[Quantity]', sources: [src('sql-server', 'sql01.contoso.com / SalesDb', 'dbo', 'Orders', 'qty')], derivedFrom: [], trace: 'renamed', note: 'o.qty AS Quantity' }] },
  'measures-01.json': { task: 'measures-01', run: 'R1', measures: [
    { measure: 'Total Sales', fields: [main('Sales[Sales Amount]', 'SUM')], measures: [] },
    { measure: 'West Sales', fields: [{ field: 'Store[Region]', role: 'helper', usage: 'filter' }], measures: [{ measure: 'Total Sales', as: 'value' }] },
    { measure: 'Big West', fields: [], measures: [{ measure: 'West Sales', as: 'condition' }, { measure: 'Total Sales', as: 'value' }] },
    { measure: 'Net Total', fields: [main('Sales[Net]', 'SUMX expression')], measures: [] },
    { measure: 'Margin Total', fields: [main('Sales[Margin]', 'SUM')], measures: [] },
    { measure: 'Orders Qty', fields: [main('Orders[Quantity]', 'SUM')], measures: [] },
    { measure: 'Order Count', fields: [main('Orders', 'COUNTROWS')], measures: [] },
    { measure: 'Lake Total', fields: [main('Lakehouse Sales[Amount]', 'SUM')], measures: [] },
    { measure: 'Month Label', fields: [main('Date[Month]', 'SELECTEDVALUE'), main('Date[Nope]', 'SUM')], measures: [] },
    { measure: 'Category Count', fields: [main('Products[Category]', 'DISTINCTCOUNT')], measures: [] },
    { measure: 'First Day', fields: [main('Calendar[Date]', 'MIN')], measures: [] },
    { measure: 'Server Label', fields: [main('Server name[Server name]', 'SELECTEDVALUE')], measures: [] }] },
  'measures-00.json': { task: 'measures-00', run: 'OLD', measures: [{ measure: 'Days', fields: [main('Calendar', 'COUNTROWS')], measures: [] }] },
};

test('the workbook: measures inherit the fields of measures they use, calculated columns expand to sources', async () => {
  const b = await built(answers);
  const rows = name => b.lineage.filter(r => r.m.name === name).map(r => [r.f.role, r.f.usage, r.f.field, r.f.via.join('>'), r.s.unresolved ? 'unresolved' : `${r.s.schema}.${r.s.table}.${r.s.column}`]);
  eq(rows('West Sales'), [['main', 'SUM', 'Sales[Sales Amount]', 'Total Sales', 'dbo.FactSales.SalesAmt'], ['helper', 'filter', 'Store[Region]', '', 'RETAIL.STORES.REGION_NAME']], 'West Sales');
  eq(rows('Big West'), [['main', 'SUM', 'Sales[Sales Amount]', 'Total Sales', 'dbo.FactSales.SalesAmt'],
    ['helper', 'condition (through [West Sales])', 'Sales[Sales Amount]', 'West Sales>Total Sales', 'dbo.FactSales.SalesAmt'],
    ['helper', 'condition (through [West Sales])', 'Store[Region]', 'West Sales', 'RETAIL.STORES.REGION_NAME']], 'a measure used as a condition gives helpers');
  eq(b.lineage.filter(r => r.m.name === 'Net Total').map(r => [r.s.column, r.s.trace, (r.s.through || []).join('>')]),
    [['Cost', 'derived', 'Sales[Cost]'], ['SalesAmt', 'derived', 'Sales[Sales Amount]']], 'a calculated column, expanded');
  // Orders' own query is native SQL, but its column Quantity was traced (by the AI) to dbo.Orders.
  eq(rows('Order Count'), [['main', 'COUNTROWS', 'Orders', '', 'dbo.Orders.(rows)']], 'a table, through its traced columns');
  eq(rows('Orders Qty'), [['main', 'SUM', 'Orders[Quantity]', '', 'dbo.Orders.qty']], 'a column the AI traced');
});

test('the workbook: grouped by source field; missing, unknown, stale and unchecked answers are listed', async () => {
  const b = await built(answers);
  // SalesAmt is the main source of Total Sales, of Net Total (through the calculated column Net) and
  // of Margin Total (through the AI-traced Margin); West Sales and Big West add helpers.
  const groups = b.bySource.filter(g => g.main && b.fq(g.main.s) === 'dbo.FactSales.SalesAmt')
    .map(g => [g.helpers.map(h => b.fq(h.s)), g.measures]).sort((x, y) => x[0].length - y[0].length);
  eq(groups, [[[], ['Margin Total', 'Net Total', 'Total Sales']], [['RETAIL.STORES.REGION_NAME'], ['West Sales']],
    [['dbo.FactSales.SalesAmt', 'RETAIL.STORES.REGION_NAME'], ['Big West']]], 'one row per main field and set of helpers');
  const issues = b.issues.map(i => `${i[1]}: ${i[0]}`);
  for (const want of ['measure: Days', 'field: Month Label → Date[Nope]', 'answer file: measures-00.json', 'check: Sales[Margin]']) {
    if (!issues.includes(want)) throw new Error(`missing issue "${want}" in ${JSON.stringify(issues)}`);
  }
  has(b.issues.find(i => i[1] === 'check')[2], 'source column "CostAmount" isn\'t in the model\'s queries');
});

/* The parts of a zip, read back through its central directory and inflated. */
function unzip(buf) {
  const zlib = require('zlib');
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const parts = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10), packed = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + packed);
    parts[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    at += 46 + nameLen + extra + comment;
  }
  return parts;
}

test('the .xlsx writer: a deflated zip of the workbook parts, sheets named and filtered', () => {
  eq([0, 25, 26, 701, 702].map(colLetter), ['A', 'Z', 'AA', 'ZZ', 'AAA'], 'column letters');
  const buf = writeXlsx([{ name: 'Lineage', columns: [{ header: 'Measure' }, { header: 'Note', wrap: true }], rows: [['Total <Sales>', 'a\nb']] }]);
  eq(buf.slice(0, 4).toString('hex'), '504b0304', 'zip signature');
  const parts = unzip(buf);
  eq(Object.keys(parts), ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'], 'parts');
  has(parts['xl/workbook.xml'], '<sheet name="Lineage"');
  for (const s of ['<autoFilter ref="A1:B2"/>', 'Total &lt;Sales&gt;', '<t xml:space="preserve">a\nb</t>', 'state="frozen"']) has(parts['xl/worksheets/sheet1.xml'], s);
});

module.exports = tests;
