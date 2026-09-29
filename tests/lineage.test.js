// Measure lineage (lineage/): the extractor traces columns through the model's sourceColumn and Power
// Query to their physical source where every step is certain, classifies the simple measures, leaves
// the rest as AI tasks, and the workbook build merges both — measures inheriting the fields of the
// measures they're built on, calculated columns expanded to their sources. Shapes: FHSQLMonitor
// (Sql.Databases navigation with a loaded parameter and an if … then … else, a DAX function),
// OD reviews (Oracle), SamplePBIP (CSV over a URL, a generated calendar, Table.AddColumn), FCA (Direct Lake).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { eq, has, suite } = require('./harness');
const { loadModels, buildFacts, buildTasks } = require('../lineage/model');
const { classify } = require('../lineage/dax');
const { writeModel } = require('../lineage/extract');
const { buildLineage, usageOf } = require('../lineage/build-excel');
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
      measure('Server Label', "SELECTEDVALUE('Server name'[Server name])"), measure('Big Orders', 'SUMX(FILTER(Orders, [Quantity] > 10), [Quantity])'),
      measure('Latest', 'LatestDate()'), measure('Top Store Sales', 'MAXX(VALUES(Store[Region]), [Total Sales])')]),
  'P.SemanticModel/definition/functions.tmdl': "function LatestDate = () => MAX('Date'[Date])\n\tlineageTag: c\n",
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
  eq(f.columns['Date[Date]'].used, true, 'a column read by a DAX function a measure calls');
});

test('the extractor classifies the simple measures itself, by the rules the AI follows', async () => {
  const f = await facts();
  const by = name => f.measures.find(m => m.name === name).classified || null;
  eq(by('Total Sales'), { fields: [{ field: 'Sales[Sales Amount]', role: 'main', usage: 'SUM' }], measures: [] }, 'SUM');
  eq(by('West Sales'), { fields: [{ field: 'Store[Region]', role: 'helper', usage: 'filter' }], measures: [{ measure: 'Total Sales', as: 'value' }] }, 'CALCULATE with a filter');
  eq(by('Order Count').fields, [{ field: 'Orders', role: 'main', usage: 'COUNTROWS' }], 'COUNTROWS');
  eq(by('Month Label').fields, [{ field: 'Date[Month]', role: 'main', usage: 'SELECTEDVALUE' }], 'SELECTEDVALUE');
  eq(by('Big West'), { fields: [], measures: [{ measure: 'West Sales', as: 'condition' }, { measure: 'Total Sales', as: 'value' }] }, 'IF over a measure');
  eq(['Net Total', 'Big Orders', 'Latest', 'Top Store Sales'].map(by), [null, null, null, null], 'iterators, a function reading the model: for the AI');

  // The shapes, against a small model (names in the model's spelling, whatever the DAX's case).
  const cols = ['Sales[Amount]', 'Sales[Region]', 'Sales[Channel]', 'Sales[ShipDate]', 'Date[Date]'];
  const model = {
    column: (t, c) => cols.find(k => k.toLowerCase() === `${t}[${c}]`.toLowerCase()) || null,
    table: t => ['Sales', 'Date'].find(n => n.toLowerCase() === String(t).toLowerCase()) || null,
    measure: m => ['Total Sales', 'Fmt'].find(n => n.toLowerCase() === String(m).toLowerCase()) || null,
    pureFunction: f => f.toUpperCase() === '_COLOR',
  };
  const h = (field, usage) => ({ field, role: 'helper', usage }), mn = (field, usage) => ({ field, role: 'main', usage });
  const cases = [
    ["sum ( 'sales'[amount] ) // SUM(Sales[Region])", [mn('Sales[Amount]', 'SUM')], []],
    ['CALCULATE([Total Sales], Sales[Region] IN {"West", "East"}, KEEPFILTERS(Sales[Channel] = "Web"), ALL(\'Date\'))',
      [h('Sales[Region]', 'filter'), h('Sales[Channel]', 'keeps filters'), h('Date', 'removes filters')], [{ measure: 'Total Sales', as: 'value' }]],
    ["TOTALYTD(SUM(Sales[Amount]), 'Date'[Date])", [mn('Sales[Amount]', 'SUM'), h('Date[Date]', 'time intelligence')], []],
    ["CALCULATE(SUM(Sales[Amount]), SAMEPERIODLASTYEAR('Date'[Date]), USERELATIONSHIP(Sales[ShipDate], 'Date'[Date]))",
      [mn('Sales[Amount]', 'SUM'), h('Date[Date]', 'time intelligence, relationship'), h('Sales[ShipDate]', 'relationship')], []],
    ['CALCULATE(COUNTROWS(Sales), ALLEXCEPT(Sales, Sales[Region]))', [mn('Sales', 'COUNTROWS'), h('Sales', 'removes filters'), h('Sales[Region]', 'keeps filters')], []],
    ['DIVIDE([Total Sales], CALCULATE([Total Sales], REMOVEFILTERS()))', [], [{ measure: 'Total Sales', as: 'value' }]],
    ['CALCULATE([Total Sales], ALL())', [], [{ measure: 'Total Sales', as: 'value' }]],
    ['FORMAT([Total Sales], [Fmt])', [], [{ measure: 'Total Sales', as: 'value' }, { measure: 'Fmt', as: 'condition' }]],
    ['SELECTEDVALUE(Sales[Region], "All") & " region"', [mn('Sales[Region]', 'SELECTEDVALUE')], []],
    ['-42', [], []],
    ['IF([Total Sales] > 0, [Total Sales], BLANK())', [], [{ measure: 'Total Sales', as: 'value' }]],   // tested and returned: a value
    ['SWITCH(TRUE(), [Fmt] = 1, _color(), ISFILTERED(Sales[Region]), "#fff", BLANK())', [h('Sales[Region]', 'selection')], [{ measure: 'Fmt', as: 'condition' }]],
    ['SWITCH([Fmt], 1, [Total Sales], 2, 0)', [], [{ measure: 'Fmt', as: 'condition' }, { measure: 'Total Sales', as: 'value' }]],
    ['VAR _t = [Total Sales] VAR _txt = FORMAT(_t, [Fmt]) RETURN "Total: " & _txt', [], [{ measure: 'Total Sales', as: 'value' }, { measure: 'Fmt', as: 'condition' }]],
  ];
  for (const [dax, fields, measures] of cases) eq(classify(dax, model), { fields, measures }, dax);
  for (const dax of ['SUMX(Sales, Sales[Amount])', 'IF(SUM(Sales[Amount]) > 0, 1)', 'IF(Sales[Region] = "West", 1)', 'SUM(Sales[Nope])', '[Qty]',
    'CALCULATE([Total Sales], Sales[Region] = [Fmt])', 'CALCULATE([Total Sales], FILTER(Sales, Sales[Amount] > 0))', 'SUM(Sales[Amount]) ^ 2',
    // A variable is evaluated where it's defined: inside CALCULATE's value it doesn't see the filters.
    'VAR _t = [Total Sales] RETURN CALCULATE(_t, Sales[Region] = "West")', 'VAR _unused = [Fmt] RETURN [Total Sales]',
    '_readsTheModel()', 'SWITCH([Fmt], [Total Sales], 1, 0)']) {
    eq(classify(dax, model), null, dax);
  }
});

test('what the extractor leaves becomes tasks: columns with their evidence, measures with their references', async () => {
  const f = await facts();
  const tasks = buildTasks(f, { rules: '2' });
  eq(tasks.map(t => t.file), ['columns-01.json', 'measures-01.json'], 'task files');
  // A task's run is a fingerprint of its content: the same model gives the same runs.
  eq(buildTasks(await facts(), { rules: '2' }).map(t => t.run), tasks.map(t => t.run), 'runs are stable');
  if (tasks[0].run === tasks[1].run || !/^[0-9a-f]{12}$/.test(tasks[0].run)) throw new Error(`runs: ${tasks.map(t => t.run)}`);
  eq(tasks[1].body.rules, '2', 'the rules version the task was made under');
  const cols = tasks[0].body.tables;
  eq(cols.map(t => [t.table, t.columns.map(c => c.column)]), [['Sales', ['Sales[Margin]']], ['Orders', ['Orders[Quantity]']]], 'columns to trace');
  has(cols[0].query, 'Sql.Database("sql01.contoso.com", "SalesDb")');   // the parameter's value filled in
  has(cols[1].query, 'SELECT o.id AS OrderId');
  const ms = tasks[1].body.measures;
  eq(ms.map(m => m.measure), ['Net Total', 'Big Orders', 'Latest', 'Top Store Sales'], 'only the measures the extractor couldn\'t classify');
  eq(ms.find(m => m.measure === 'Top Store Sales').measures, ['Total Sales'], 'a measure\'s references');
  // A bare [Quantity] could be any table's Quantity column: a candidate, apart from what the DAX writes out.
  const big = ms.find(m => m.measure === 'Big Orders');
  eq([big.columns, big.unqualified], [[], ['Orders[Quantity]']], 'bare [Name] references are candidates');
  // A DAX function the measure calls: named on the measure, its code once per task.
  eq(ms.find(m => m.measure === 'Latest').functions, ['LatestDate'], 'the functions a measure calls');
  eq(tasks[1].body.functions, { LatestDate: "() => MAX('Date'[Date])" }, 'the functions\' code');
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
    { measure: 'Month Label', fields: [main('Date[Month]', 'SELECTEDVALUE'), main('Date[Nope]', 'SUM')], measures: [] },   // the extractor's classification wins
    { measure: 'Big Orders', fields: [main('Orders[Quantity]', 'SUMX expression'), { field: 'Orders[Qty]', role: 'helper', usage: 'condition' }], measures: [] },
    { measure: 'Top Store Sales', fields: [{ field: 'Store[Region]', role: 'helper', usage: 'iterates over' }], measures: [{ measure: 'Total Sales', as: 'value' }] },
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
  eq(groups, [[[], ['Margin Total', 'Net Total', 'Total Sales']], [['RETAIL.STORES.REGION_NAME'], ['Top Store Sales', 'West Sales']],
    [['dbo.FactSales.SalesAmt', 'RETAIL.STORES.REGION_NAME'], ['Big West']]], 'one row per main field and set of helpers');
  const issues = b.issues.map(i => `${i[1]}: ${i[0]}`);
  for (const want of ['measure: Latest', 'field: Big Orders → Orders[Qty]', 'answer file: measures-00.json', 'check: Sales[Margin]']) {
    if (!issues.includes(want)) throw new Error(`missing issue "${want}" in ${JSON.stringify(issues)}`);
  }
  if (issues.some(i => /Date\[Nope\]/.test(i))) throw new Error(`an AI answer overrode the extractor's classification: ${JSON.stringify(issues)}`);
  eq(b.lineage.filter(r => r.m.name === 'Month Label').map(r => [r.f.field, r.f.by]), [['Date[Month]', 'extractor']], 'classified by the extractor');
  // A field's usages read the same whatever order an answer gave them.
  eq([usageOf('selection, condition, iterates over'), usageOf('iterates over, condition,selection'), usageOf('MIN, MAX, condition')],
    ['condition, selection, iterates over', 'condition, selection, iterates over', 'condition, MAX, MIN'], 'usages in one order');
  eq(b.lineage.filter(r => r.m.name === 'Top Store Sales').map(r => [r.f.field, r.f.by]),
    [['Sales[Sales Amount]', 'AI'], ['Store[Region]', 'AI']], 'an AI answer, even through a measure the extractor classified');
  has(b.issues.find(i => i[1] === 'check')[2], 'source column "CostAmount" isn\'t in the model\'s queries');
});

test('extracting again asks only what changed; earlier answers still count for the rest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-'));
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const answer = (file, body) => fs.writeFileSync(path.join(dir, 'answers', file), JSON.stringify({ task: file.replace(/\.json$/, ''), run: read(`tasks/${file}`).run, ...body }));
  let tasks = writeModel(await facts(), dir, { rules: '2' });
  eq(tasks.map(t => t.file), ['columns-01.json', 'measures-01.json'], 'the first extraction');
  answer('columns-01.json', { columns: answers['columns-01.json'].columns });
  const earlier = answers['measures-01.json'].measures;
  answer('measures-01.json', { measures: [...['Net Total', 'Top Store Sales'].map(n => earlier.find(m => m.measure === n)),   // not Latest
    { measure: 'Big Orders', fields: [main('Orders[Quantity]', 'SUMX expression'), { field: 'Orders[Quantity]', role: 'helper', usage: 'condition' }], measures: [] }] });

  // Top Store Sales changes; nothing else does.
  const changed = await facts();
  changed.measures.find(m => m.name === 'Top Store Sales').dax = 'MAXX(VALUES(Store[Region]), [Margin Total])';
  tasks = writeModel(changed, dir, { rules: '2' });
  eq(tasks.map(t => [t.file, t.body.measures.map(m => m.measure)]), [['measures-02.json', ['Latest', 'Top Store Sales']]], 'the changed and the unanswered, numbered after the answered');
  eq(fs.readdirSync(path.join(dir, 'tasks')).sort(), ['measures-02.json'], 'the old tasks are gone');
  eq(read('answers/measures-01.task.json').run, read('answers/measures-01.json').run, 'a copy of the task each answer answered');
  eq(read('model.json').reuse, { measures: { 'Net Total': 'measures-01.json', 'Big Orders': 'measures-01.json' },
    columns: { 'Sales[Margin]': 'columns-01.json', 'Orders[Quantity]': 'columns-01.json' } }, 'where the kept answers are');

  // The workbook takes the kept answers, and the new one for Top Store Sales rather than the kept file's.
  answer('measures-02.json', { measures: [
    { measure: 'Latest', fields: [main('Date[Date]', 'MAX')], measures: [] },
    { measure: 'Top Store Sales', fields: [{ field: 'Store[Region]', role: 'helper', usage: 'iterates over' }], measures: [{ measure: 'Margin Total', as: 'value' }] }] });
  const b = buildLineage(dir);
  eq(b.issues.filter(i => i[1] !== 'check'), [], 'nothing missing or ignored');
  eq([...new Set(b.lineage.filter(r => r.m.name === 'Top Store Sales' && r.f.role === 'main').map(r => r.f.field))], ['Sales[Margin]'], 'the new answer');
  eq(b.lineage.filter(r => r.m.name === 'Net Total').map(r => r.s.column), ['Cost', 'SalesAmt'], 'a kept answer');

  // Nothing changed: nothing to ask. A new rules version: everything the extractor didn't do, again.
  eq(writeModel(changed, dir, { rules: '2' }).length, 0, 'nothing left for the AI');
  tasks = writeModel(changed, dir, { rules: '3' });
  eq(tasks.map(t => t.file), ['columns-02.json', 'measures-03.json'], 'a new rules version');
  eq(tasks[1].body.measures.length, 4, 'every measure the extractor didn\'t classify');
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
