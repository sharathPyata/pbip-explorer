// Model features read the same from TMDL and model.bim (TMSL) — calendars, a measure's dynamic
// format string / KPI / detail rows, inactive relationships — and shown in the Tables tab and the
// export; plus the Overview's source count and the label on Microsoft's M date table.
// Shapes: RuiRomano/powerbi-agentic-apm-demo (the KPI, the inactive Delivery Date relationship),
// sql-bi/DaxTemplate and TabularEditor/SessionArchive (model.bim calendars), Microsoft's docs.
'use strict';
const { loadApp, fileList, eq, has, hasNot, suite } = require('./harness');
const { tests, test } = suite();

const NAMES = ['App', 'processFiles', 'usageStatus', 'buildMarkdownExport', 'renderTableDetail', 'renderOverview', 'detectSource'];

const SALES_M = ['let', '    Source = Sql.Database("sql.contoso.com", "SalesDb"),', '    Sales = Source{[Schema="dbo",Item="Sales"]}[Data]', 'in', '    Sales'];
// Microsoft's recommended Power Query date table (the "Create a date table" example in the docs).
const DATE_M = ['let', '    StartDate = #date(2010, 1, 1),', '    EndDate = #date(2030, 12, 31),',
  '    NumberOfDays = Duration.Days(EndDate - StartDate) + 1,',
  '    DateList = List.Dates(StartDate, NumberOfDays, #duration(1,0,0,0)),',
  '    DateTable = Table.FromList(DateList, Splitter.SplitByNothing(), {"Date"}),',
  '    AddYear = Table.AddColumn(DateTable, "Year", each Date.Year([Date]), Int64.Type)', 'in', '    AddYear'];

const tmdl = {
  'P.SemanticModel/definition/model.tmdl': 'model Model\n\tculture: en-US\n',
  'P.SemanticModel/definition/tables/Sales.tmdl': [
    'table Sales',
    '\tmeasure Margin = SUM(Sales[Amount])',
    '\t\tformatString: $ #,##0',
    '',
    '\t\tformatStringDefinition = IF(SELECTEDVALUE(Sales[Currency]) = "EUR", "€#,0", "$#,0")',
    '',
    '\t\tkpi',
    '\t\t\ttargetExpression = ```',
    '\t\t\t\tSUM(Sales[Target])',
    '\t\t\t\t```',
    '\t\t\tstatusExpression =',
    '\t\t\t\tIF([Margin] > SUM(Sales[Target]), 1, -1)',
    "\tmeasure YTD = TOTALYTD([Margin], 'Fiscal')",
    '\tcolumn Amount', '\t\tdataType: double', '\t\tsourceColumn: Amount',
    '\tcolumn Currency', '\t\tdataType: string', '\t\tsourceColumn: Currency',
    '\tcolumn Target', '\t\tdataType: double', '\t\tsourceColumn: Target',
    "\tcolumn 'Order Date'", '\t\tdataType: dateTime', '\t\tsourceColumn: OrderDate',
    "\tcolumn 'Delivery Date'", '\t\tdataType: dateTime', '\t\tsourceColumn: DeliveryDate',
    '\tpartition Sales = m', '\t\tmode: import', '\t\tsource =', ...SALES_M.map(l => '\t\t\t\t' + l),
  ].join('\n'),
  'P.SemanticModel/definition/tables/Date.tmdl': [
    "table 'Date'",
    '\tcolumn Date', '\t\tdataType: dateTime', '\t\tsourceColumn: Date',
    '\tcolumn Year', '\t\tdataType: int64', '\t\tsourceColumn: Year',
    '\tcolumn IsWorkingDay', '\t\tdataType: boolean', '\t\tsourceColumn: IsWorkingDay',
    '\tcalendar Fiscal',
    '\t\tcalendarColumnGroup = year', '\t\t\tprimaryColumn: Year',
    '\t\tcalendarColumnGroup = date', '\t\t\tprimaryColumn: Date',
    '\t\tcalendarColumnGroup', '\t\t\tcolumn: IsWorkingDay',
    "\tpartition 'Date' = m", '\t\tmode: import', '\t\tsource =', ...DATE_M.map(l => '\t\t\t\t' + l),
  ].join('\n'),
  // An auto date/time table: hidden, and its source group with it.
  'P.SemanticModel/definition/tables/LocalDateTable_1a2b.tmdl': [
    'table LocalDateTable_1a2b', '\tisHidden', '\tshowAsVariationsOnly',
    '\tcolumn Date', '\t\tdataType: dateTime', '\t\tisHidden', '\t\tsourceColumn: [Date]',
    '\tpartition LocalDateTable_1a2b = calculated', '\t\tmode: import', "\t\tsource = Calendar(Date(Year(MIN('Sales'[Order Date])), 1, 1), Date(2030, 12, 31))",
    '\tannotation __PBI_LocalDateTable = true',
  ].join('\n'),
  'P.SemanticModel/definition/relationships.tmdl': [
    'relationship r1', "\tfromColumn: Sales.'Order Date'", "\ttoColumn: 'Date'.Date", '',
    'relationship r2', '\tisActive: false', "\tfromColumn: Sales.'Delivery Date'", "\ttoColumn: 'Date'.Date",
  ].join('\n'),
  'P.Report/definition.pbir': { version: '4.0', datasetReference: { byPath: { path: '../P.SemanticModel' } } },
  'P.Report/definition/pages/pages.json': { pageOrder: ['p1'] },
  'P.Report/definition/pages/p1/page.json': { name: 'p1', displayName: 'Overview', width: 1280, height: 720 },
  'P.Report/definition/pages/p1/visuals/v1/visual.json': { name: 'v1', position: { x: 0, y: 0, width: 200, height: 100 },
    visual: { visualType: 'card', query: { queryState: { Values: { projections: [{ queryRef: 'Sales.YTD' }] } } } } },
};

const col = (name, dataType, extra) => ({ name, dataType, sourceColumn: name, ...extra });
const tmsl = {
  'P.SemanticModel/model.bim': { compatibilityLevel: 1702, model: {
    tables: [
      { name: 'Sales',
        measures: [
          { name: 'Margin', expression: 'SUM(Sales[Amount])', formatString: '$ #,##0',
            formatStringDefinition: { expression: 'IF(SELECTEDVALUE(Sales[Currency]) = "EUR", "€#,0", "$#,0")' },
            kpi: { targetExpression: ['SUM(Sales[Target])'], statusExpression: ['IF([Margin] > SUM(Sales[Target]), 1, -1)'] } },
          { name: 'YTD', expression: "TOTALYTD([Margin], 'Fiscal')" },
        ],
        columns: [col('Amount', 'double'), col('Currency', 'string'), col('Target', 'double'), col('Order Date', 'dateTime'), col('Delivery Date', 'dateTime')],
        partitions: [{ name: 'Sales', mode: 'import', source: { type: 'm', expression: SALES_M } }] },
      { name: 'Date',
        columns: [col('Date', 'dateTime'), col('Year', 'int64'), col('IsWorkingDay', 'boolean')],
        calendars: [{ name: 'Fiscal', calendarColumnGroups: [
          { timeUnit: 'year', primaryColumn: 'Year' }, { timeUnit: 'date', primaryColumn: 'Date' }, { columns: ['IsWorkingDay'] }] }],
        partitions: [{ name: 'Date', mode: 'import', source: { type: 'm', expression: DATE_M } }] },
      { name: 'LocalDateTable_1a2b', isHidden: true, showAsVariationsOnly: true,
        columns: [{ name: 'Date', dataType: 'dateTime', isHidden: true, type: 'calculatedTableColumn', sourceColumn: '[Date]' }],
        partitions: [{ name: 'LocalDateTable_1a2b', mode: 'import',
          source: { type: 'calculated', expression: "Calendar(Date(Year(MIN('Sales'[Order Date])), 1, 1), Date(2030, 12, 31))" } }],
        annotations: [{ name: '__PBI_LocalDateTable', value: 'true' }] },
    ],
    relationships: [
      { name: 'r1', fromTable: 'Sales', fromColumn: 'Order Date', toTable: 'Date', toColumn: 'Date' },
      { name: 'r2', isActive: false, fromTable: 'Sales', fromColumn: 'Delivery Date', toTable: 'Date', toColumn: 'Date' },
    ],
  } },
  'P.Report/definition.pbir': tmdl['P.Report/definition.pbir'],
  'P.Report/definition/pages/pages.json': tmdl['P.Report/definition/pages/pages.json'],
  'P.Report/definition/pages/p1/page.json': tmdl['P.Report/definition/pages/p1/page.json'],
  'P.Report/definition/pages/p1/visuals/v1/visual.json': tmdl['P.Report/definition/pages/p1/visuals/v1/visual.json'],
};

async function load(files) {
  const app = loadApp(NAMES, { dom: true });
  await app.processFiles(fileList(files));
  return app;
}

for (const [format, files] of [['TMDL', tmdl], ['TMSL', tmsl]]) {
  test(`${format}: calendars, measure format string and KPI, inactive relationships`, async () => {
    const app = await load(files);
    const s = app.App.state;
    const byName = Object.fromEntries(s.tables.map(t => [t.name, t]));
    eq(byName.Date.calendars, [{ name: 'Fiscal', groups: [
      { unit: 'year', primary: 'Year', associated: [], columns: [] },
      { unit: 'date', primary: 'Date', associated: [], columns: [] },
      { unit: '', primary: '', associated: [], columns: ['IsWorkingDay'] }] }], 'calendar');
    const margin = byName.Sales.measures.find(m => m.name === 'Margin');
    eq([margin.formatStringDax, margin.kpi], ['IF(SELECTEDVALUE(Sales[Currency]) = "EUR", "€#,0", "$#,0")',
      { target: 'SUM(Sales[Target])', status: 'IF([Margin] > SUM(Sales[Target]), 1, -1)', trend: '' }], 'measure extras');
    eq(s.relationships.map(r => [r.fromColumn, r.isActive]), [['Order Date', true], ['Delivery Date', false]], 'relationships');
    // YTD is on the page and names the calendar; Margin's format string and KPI come with it.
    eq(['Date.Year', 'Date.Date', 'Date.IsWorkingDay', 'Sales.Currency', 'Sales.Target'].map(app.usageStatus),
      ['used', 'used', 'used', 'used', 'used'], 'usage');
  });
}

test('the Tables tab shows calendars and a measure\'s format string and KPI; names are escaped', async () => {
  const files = { ...tmdl };
  files['P.SemanticModel/definition/tables/Date.tmdl'] = files['P.SemanticModel/definition/tables/Date.tmdl']
    .replace('\tcalendar Fiscal', "\tcalendar '<b>Fiscal</b>'");
  const app = await load(files);
  const detail = app.element();
  app.document.getElementById = id => (id === 'tableDetail' ? detail : null);
  app.App.state.activeTable = 'Date';
  app.renderTableDetail();
  has(detail.innerHTML, '&lt;b&gt;Fiscal&lt;/b&gt;');
  hasNot(detail.innerHTML, '<b>Fiscal');
  has(detail.innerHTML, '<td>Year</td><td>Year <span style="color:var(--text-3)">(primary)</span></td>');
  has(detail.innerHTML, '<td>Time-related</td><td>IsWorkingDay</td>');
  has(detail.innerHTML, 'inactive</span>');   // the Delivery Date relationship
  app.App.state.activeTable = 'Sales';
  app.renderTableDetail();
  has(detail.innerHTML, '<div class="measure-extra-label">Format string</div>');
  has(detail.innerHTML, '<div class="measure-extra-label">KPI status</div>');
  has(detail.innerHTML, 'IF([Margin] &gt; SUM(Sales[Target]), 1, -1)');
});

test('the export: calendars, a measure\'s extra DAX, and whether each relationship is active', async () => {
  const md = (await load(tmdl)).buildMarkdownExport({ tables: true, measures: true, relationships: true });
  has(md, '- **Calendar Fiscal:** Year: Year; Date: Date; Time-related: IsWorkingDay');
  has(md, '_KPI target:_\n```dax\nSUM(Sales[Target])\n```');
  has(md, '_Format string:_\n```dax\nIF(SELECTEDVALUE(Sales[Currency]) = "EUR", "€#,0", "$#,0")\n```');
  has(md, '| From | To | Cross-filter | Active |');
  has(md, '| Sales[Delivery Date] | Date[Date] | single | no |');
  has(md, '| Sales[Order Date] | Date[Date] | single | yes |');
});

test('the Overview counts the sources the Sources tab shows — not the hidden auto date tables', async () => {
  const app = await load(tmdl);
  const s = app.App.state;
  eq(s.sources.length, 3, 'all sources, auto date tables included');
  app.renderOverview();
  const tile = app.App.els.overviewContent.innerHTML.match(/Data Sources<\/div>\s*<div class="tile-value">(\d+)</);
  eq([tile && tile[1], app.App.els.cSources.textContent], ['2', '2'], 'Overview tile, Sources badge');
  has(app.buildMarkdownExport({ summary: true }), '| Data sources | 2 |');
  has(app.buildMarkdownExport({ summary: true, includeHidden: true }), '| Data sources | 3 |');
});

test("Microsoft's List.Dates date table is Computed, not Inline Data", () => {
  const { detectSource } = loadApp(['detectSource']);
  const kind = m => { const r = detectSource(m.join('\n'), {}, []); return r.type === 'other' ? r.key : r.type; };
  eq(kind(DATE_M), 'computed', 'List.Dates + Table.FromList');
  eq(kind(['let', '    Source = Table.FromList({"North", "South"}, Splitter.SplitByNothing(), {"Region"})', 'in', '    Source']), 'inline', 'a typed-in list');
  eq(kind(['let', '    Source = Sql.Database("db", "x"),', '    D = List.Dates(#date(2020,1,1), 10, #duration(1,0,0,0)),',
    '    T = Table.FromList(D, Splitter.SplitByNothing())', 'in', '    T']), 'sql-server', 'a generated list next to a connector');
});

test("a table or shared query named in a string, a comment, a [field] or a dotted name isn't where the data comes from", () => {
  const { detectSource } = loadApp(['detectSource']);
  const sql = ['let', '    Source = Sql.Database("sql.contoso.com", "SalesDb")', 'in', '    Source'].join('\n');
  const tables = ['Sales', 'Date', 'Umsätze'].map(name => ({ name, partitionSource: sql }));
  const expressions = { Staging: { sourceM: 'Sql.Database("staging.contoso.com", "Stage")' } };
  const kind = m => { const r = detectSource(m.join('\n'), expressions, tables); return r.type === 'other' ? r.key : `${r.type} via ${r.viaTable || r.viaExpression}`; };
  // RuiRomano's About table: rows typed into a #table, one of them naming the project file.
  eq(kind(['let', '    Source = #table({"Key", "Value"}, {{"Description", "Sales.pbip"}, {"Loaded from", "Staging"}})', 'in', '    Source']), 'computed', 'strings');
  eq(kind(['let', '    // was: Source = Sales', '    Source = #table({"Year"}, {{Date.Year(DateTime.LocalNow())}}),',
    '    Added = Table.AddColumn(Source, "Total", each [Sales] + 1)', 'in', '    Added']), 'computed', 'a comment, Date.Year and a [field]');
  eq(kind(['let', '    Source = #"Sales Archive"', 'in', '    Source']), 'unknown', 'another quoted name');
  // Real references still count: bare, quoted, in another script, and a shared query.
  eq(kind(['let', '    Source = Sales,', '    Kept = Table.SelectRows(Source, each [Amount] > 0)', 'in', '    Kept']), 'sql-server via Sales', 'bare');
  eq(kind(['let', '    Source = #"Date"', 'in', '    Source']), 'sql-server via Date', 'quoted');
  eq(kind(['let', '    Source = Umsätze', 'in', '    Source']), 'sql-server via Umsätze', 'a name in another script');
  eq(kind(['let', '    Source = Staging', 'in', '    Source']), 'sql-server via Staging', 'a shared query');
});

module.exports = tests;
