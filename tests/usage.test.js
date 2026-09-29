// Usage analysis (the Unused tab): references that must count as uses.
// Cases come from real models: RuiRomano/powerbi-agentic-apm-demo (RLS role, relationships,
// measures, KPI), microsoft/Analysis-Services SamplePBIP (calc group, calculated column),
// microsoft/fabric-toolbox's FCA model (dynamic format strings), and Microsoft's calendar docs.
'use strict';
const { loadApp, eq, defined, suite } = require('./harness');
const { App, parseTable, parseRelationships, buildUsageIndex, usageStatus, daxNamesUsed } =
  loadApp(['App', 'parseTable', 'parseRelationships', 'buildUsageIndex', 'usageStatus', 'daxNamesUsed']);
const { tests, test } = suite();

const table = (name, ...body) => parseTable([`table ${name}`, ...body.flat()].join('\n'));
const col = (name) => [`\tcolumn ${name}`, '\t\tdataType: string', '\t\tsourceColumn: x'];
const onPage = (...refs) => [{ name: 'p', displayName: 'P', visuals: [{ type: 'card', fields: refs.map(ref => ({ role: 'Values', ref })) }] }];
function analyze({ tables, relationships = [], roles = [], functions = [], pages = [] }) {
  Object.assign(App.state, { tables, relationships, roles, functions, perspectives: [], pages, reportReferences: new Set() });
  buildUsageIndex();
}
const status = (key, want) => eq(usageStatus(key), want, key);

// ── Unqualified [Column] references ────────────────────────────────────────────────────
test("calc column: bare [Col] marks the host table's columns", () => {
  analyze({
    tables: [table('Sales', col('Quantity'), col("'Unit Price'"),
      ["\tcolumn 'Line Total' = [Quantity] * [Unit Price]", '\t\tdataType: double'],
      ["\tmeasure 'Total Sales' = SUM(Sales[Line Total])"])],
    pages: onPage('Sales.Total Sales'),
  });
  status('Sales.Quantity', 'used');
  status('Sales.Unit Price', 'used');
});

test("RLS filter: bare [Col] marks the guarded table's column (sample role)", () => {
  analyze({
    tables: [table('Store', col('Country'), col('City'))],
    roles: [{ name: 'Store - Canada', tablePermissions: [{ table: 'Store', dax: '[Country] == "Canada"' }] }],
  });
  status('Store.Country', 'used');
  status('Store.City', 'unused');
});

test('measure: bare refs bind to the host table, not a same-named column elsewhere (sample measure)', () => {
  analyze({
    tables: [
      table('Sales', col('ProductKey'), col("'Unit Cost'"),
        ["\tmeasure 'Higher Cost Products Sold' = CALCULATE(DISTINCTCOUNT([ProductKey]), FILTER('Sales', [Unit Cost] > 1))"]),
      table('Product', col('ProductKey'), col("'Unit Cost'")),
    ],
    pages: onPage('Sales.Higher Cost Products Sold'),
  });
  status('Sales.ProductKey', 'used');
  status('Sales.Unit Cost', 'used');
  status('Product.ProductKey', 'unused');
  status('Product.Unit Cost', 'unused');
});

test('measure table: bare refs bind to the table the expression iterates', () => {
  analyze({
    tables: [
      table('_Measures', ["\tmeasure 'Big Orders' = COUNTROWS(FILTER(Sales, [Amount] > 100))"]),
      table('Sales', col('Amount')),
      table('Budget', col('Amount')),
    ],
    pages: onPage('_Measures.Big Orders'),
  });
  status('Sales.Amount', 'used');
  status('Budget.Amount', 'unused');
});

test('unresolvable row context falls back to every table with that column (UDF table param)', () => {
  analyze({
    tables: [table('Sales', col('Amount')), table('Budget', col('Amount')), table('Other', col('Name'))],
    functions: [{ name: 'SumAmount', dax: '(t : table) => SUMX(t, [Amount])' }],
  });
  status('Sales.Amount', 'used');
  status('Budget.Amount', 'used');
  status('Other.Name', 'unused');
});

test('bare [Measure] still resolves to the measure', () => {
  analyze({
    tables: [table('Sales', col('Amount'), ['\tmeasure A = [B] * 2'], ['\tmeasure B = SUM(Sales[Amount])'])],
    pages: onPage('Sales.A'),
  });
  status('Sales.B', 'used');
  status('Sales.Amount', 'used');
});

test('an apostrophe inside a "string" doesn\'t hide a quoted table name', () => {
  analyze({
    tables: [
      table('Budget', ["\tmeasure M = IF(TRUE(), \"It's\", SUMX('Sales Data', [Qty]))"]),
      table("'Sales Data'", col('Qty')),
    ],
    pages: onPage('Budget.M'),
  });
  status('Sales Data.Qty', 'used');
});

test('quoted table name with an escaped apostrophe resolves', () => {
  analyze({
    tables: [table("'Client''s Spend'", col('Amount'), ["\tmeasure Total = SUM('Client''s Spend'[Amount])"])],
    pages: onPage("Client's Spend.Total"),
  });
  status("Client's Spend.Amount", 'used');
});

// ── Quoted names in relationships.tmdl ─────────────────────────────────────────────────
test('relationship key with a quoted name gets its structural mark (sample relationships.tmdl)', () => {
  const rels = parseRelationships([
    'relationship 92b8a424-f739-c57d-a8de-be6b9ea34685',
    '\tisActive: false',
    "\tfromColumn: Sales.'Delivery Date'",
    '\ttoColumn: Calendar.Date',
  ].join('\n'));
  eq([rels[0].fromTable, rels[0].fromColumn, rels[0].toTable, rels[0].toColumn],
    ['Sales', 'Delivery Date', 'Calendar', 'Date'], 'parsed relationship');
  analyze({ tables: [table('Sales', col("'Delivery Date'")), table('Calendar', col('Date'))], relationships: rels });
  status('Sales.Delivery Date', 'structural');
});

test('relationship refs: escaped apostrophe and a dot inside quotes', () => {
  const rels = parseRelationships(['relationship r1', "\tfromColumn: 'Client''s Spend'.'Order Date'", "\ttoColumn: 'Cal.2024'.Date"].join('\n'));
  eq([rels[0].fromTable, rels[0].fromColumn, rels[0].toTable, rels[0].toColumn],
    ["Client's Spend", 'Order Date', 'Cal.2024', 'Date'], 'parsed relationship');
});

test('unquoted relationship refs are unchanged', () => {
  const rels = parseRelationships('relationship r1\n\tfromColumn: Sales.CustomerKey\n\ttoColumn: Customer.CustomerKey');
  eq([rels[0].fromTable, rels[0].fromColumn, rels[0].toTable, rels[0].toColumn],
    ['Sales', 'CustomerKey', 'Customer', 'CustomerKey'], 'parsed relationship');
});

// ── Calculation items ──────────────────────────────────────────────────────────────────
const calcGroup = (...itemLines) => table("'Time Intelligence'",
  ['\tcalculationGroup', '\t\tprecedence: 1', ''], itemLines,
  ["\tcolumn 'Show as'", '\t\tdataType: string', '\t\tsourceColumn: Name']);

test('calc item DAX counts while the calc group is in use', () => {
  analyze({
    tables: [calcGroup('\t\tcalculationItem FYTD =', "\t\t\t\tCALCULATE ( SELECTEDMEASURE (), DATESYTD ( 'Fiscal'[FDate] ) )"),
      table('Fiscal', col('FDate'))],
    pages: onPage('Time Intelligence.Show as'),
  });
  status('Fiscal.FDate', 'used');
});

test("calc item DAX doesn't count when the calc group is unused", () => {
  analyze({
    tables: [calcGroup('\t\tcalculationItem FYTD =', "\t\t\t\tCALCULATE ( SELECTEDMEASURE (), DATESYTD ( 'Fiscal'[FDate] ) )"),
      table('Fiscal', col('FDate'))],
  });
  status('Fiscal.FDate', 'unused');
});

test('calc item formatStringDefinition refs count too', () => {
  analyze({
    tables: [calcGroup('\t\tcalculationItem Local = SELECTEDMEASURE()', "\t\t\tformatStringDefinition = SELECTEDVALUE('Currency'[Format])"),
      table('Currency', col('Format'))],
    pages: onPage('Time Intelligence.Show as'),
  });
  status('Currency.Format', 'used');
});

// ── Calendars (calendar-based time intelligence) ───────────────────────────────────────
// As Microsoft's docs write them: categories with a primary and associated columns, and a group
// with no category whose columns are time-related — three tabs deep, like a hierarchy level's.
const dateTable = (calendar) => table("'Date'", col('Date'), col('Year'), col('Month'), col('MonthName'), col('IsWorkingDay'), col('Untagged'),
  [`\tcalendar ${calendar}`, '\t\tlineageTag: def', '',
    '\t\tcalendarColumnGroup = year', '\t\t\tprimaryColumn: Year', '',
    '\t\tcalendarColumnGroup = month', '\t\t\tprimaryColumn: Month', '\t\t\tassociatedColumn: MonthName', '',
    '\t\tcalendarColumnGroup', '\t\t\tcolumn: IsWorkingDay']);
const TAGGED = ['Date.Year', 'Date.Month', 'Date.MonthName', 'Date.IsWorkingDay'];

test("a calendar keeps its columns (structural) until DAX names it; then they're used", () => {
  const t = dateTable("'Fiscal Calendar'");
  eq(t.calendars, [{ name: 'Fiscal Calendar', groups: [
    { unit: 'year', primary: 'Year', associated: [], columns: [] },
    { unit: 'month', primary: 'Month', associated: ['MonthName'], columns: [] },
    { unit: '', primary: '', associated: [], columns: ['IsWorkingDay'] }] }], 'parsed');
  eq(t.hierColumnRefs, [], 'time-related columns are not hierarchy levels');

  analyze({ tables: [t, table('Sales', col('Amount'), ['\tmeasure Total = SUM(Sales[Amount])'])], pages: onPage('Sales.Total') });
  for (const k of TAGGED) status(k, 'structural');
  eq(App.state.usage.byKey['Date.IsWorkingDay'].structural, ["calendar 'Fiscal Calendar'"], 'reason');

  analyze({ tables: [dateTable("'Fiscal Calendar'"), table('Sales', col('Amount'),
    ["\tmeasure YTD = TOTALYTD(SUM(Sales[Amount]), 'Fiscal Calendar')"])], pages: onPage('Sales.YTD') });
  for (const k of TAGGED) status(k, 'used');
  status('Date.Date', 'unused');       // not tagged in the calendar
  status('Date.Untagged', 'unused');
});

test('a calendar named bare or in another case counts; a VAR, string or comment of that name does not', () => {
  const run = (dax) => {
    analyze({ tables: [dateTable('Gregorian'), table('Sales', col('Amount'), [`\tmeasure M = ${dax}`])], pages: onPage('Sales.M') });
    return TAGGED.map(usageStatus);
  };
  const used = TAGGED.map(() => 'used'), kept = TAGGED.map(() => 'structural');
  eq(run('CALCULATE(SUM(Sales[Amount]), DATEADD(gregorian, -1, YEAR))'), used, 'bare, lower case');
  eq(run("CALCULATE(SUM(Sales[Amount]), PARALLELPERIOD('GREGORIAN', -1, YEAR))"), used, 'quoted, upper case');
  eq(run('VAR Gregorian = 2 RETURN SUM(Sales[Amount]) * Gregorian'), kept, 'a VAR of the same name');
  eq(run('IF(SUM(Sales[Amount]) > 0, "Gregorian") -- Gregorian'), kept, 'a string and a comment');
});

test('what DAX names like a table: quoted and bare names, not calls, keywords, VARs, strings, comments or [brackets]', () => {
  const names = defined(daxNamesUsed, 'daxNamesUsed')(
    'VAR d = DATE(2020, 1, 1) RETURN CALCULATE([Sales Amount], \'Sales Data\', Budget, "It\'s", Budget[Amount] > 0) // Fiscal\n/* Gregorian */');
  eq([...names].sort(), ['budget', 'sales data'], 'names');
});

// ── Names in another case: DAX matches them case-insensitively ─────────────────────────
test("DAX names match in any case (sample calc item: 'Time intelligence'[Show as])", () => {
  analyze({
    tables: [
      table('Sales', col('Amount'), col('Region'), ["\tmeasure 'Total Sales' = SUM(sales[amount])"], ['\tmeasure Report = [total sales] * 2'],
        ['\tcolumn Flag = IF([region] = "W", 1, 0)', '\t\tdataType: int64'],
        ["\tmeasure Shown = SELECTEDVALUE('Time intelligence'[show AS])"]),
      table("'Time Intelligence'", col("'Show as'")),
    ],
    pages: onPage('Sales.Report', 'Sales.Flag', 'Sales.Shown'),
  });
  status('Sales.Total Sales', 'used');
  status('Sales.Amount', 'used');
  status('Sales.Region', 'used');
  status('Time Intelligence.Show as', 'used');
});

test('a report binding in another case still counts (a rename that only changed case)', () => {
  analyze({ tables: [table('Sales', col('Amount'), col('Spare'))], pages: onPage('sales.AMOUNT') });
  status('Sales.Amount', 'used');
  status('Sales.Spare', 'unused');
});

// ── A measure's other DAX: dynamic format string, KPI, detail rows ────────────────────
// FCA's formatStringDefinition (a multi-line SWITCH on the currency column, four tabs deep) and the
// demo's KPI (a fenced target, multi-line status and trend) — the columns only they name.
const kpiSales = () => table('Sales', col('Amount'), col('Currency'), col('Target'), col('Prior'), col('OrderId'), col('Spare'), [
  '\tmeasure Total = SUM(Sales[Amount])',
  '\t\tlineageTag: 1',
  '',
  '\t\tformatStringDefinition =',
  '\t\t\t\tSWITCH( MAX(Sales[Currency]),',
  '\t\t\t\t"USD", "\\$#,0.00",',
  '\t\t\t\t"#,0.00")',
  '',
  '\t\tdetailRowsDefinition = SELECTCOLUMNS(Sales, "Order", Sales[OrderId])',
  '',
  '\t\tkpi',
  '\t\t\ttargetExpression = ```',
  '\t\t\t\tSUM(Sales[Target])',
  '\t\t\t\t```',
  '\t\t\tstatusExpression =',
  '\t\t\t\tVAR x = [Total]',
  '\t\t\t\tRETURN IF(x > 0, 1, -1)',
  '\t\t\ttrendExpression =',
  '\t\t\t\tIF([Total] > SUM(Sales[Prior]), 1, -1)',
  '',
  '\t\tannotation PBI_FormatHint = {"isCustom":true}',
  '',
  '\tmeasure Margin =',
  '\t\t\tSUM(Sales[Amount])',
  '\t\tkpi',
  '\t\t\ttargetExpression = 100',
]);

test("a measure's format string, KPI and detail rows are read, and count while the measure is used", () => {
  eq(kpiSales().measures.map(m => [m.name, m.dax, m.formatStringDax, m.detailRowsDax, m.kpi]), [
    ['Total', 'SUM(Sales[Amount])', 'SWITCH( MAX(Sales[Currency]),\n"USD", "\\$#,0.00",\n"#,0.00")',
      'SELECTCOLUMNS(Sales, "Order", Sales[OrderId])',
      { target: 'SUM(Sales[Target])', status: 'VAR x = [Total]\nRETURN IF(x > 0, 1, -1)', trend: 'IF([Total] > SUM(Sales[Prior]), 1, -1)' }],
    ['Margin', 'SUM(Sales[Amount])', '', '', { target: '100', status: '', trend: '' }],   // a KPI right after the DAX ends it
  ], 'parsed');
  analyze({ tables: [kpiSales()], pages: onPage('Sales.Total') });
  for (const c of ['Amount', 'Currency', 'Target', 'Prior', 'OrderId']) status(`Sales.${c}`, 'used');
  status('Sales.Spare', 'unused');
  analyze({ tables: [kpiSales()], pages: onPage('Sales.Margin') });   // Total unused: its extras count for nothing
  status('Sales.Currency', 'unused');
});

module.exports = tests;
