// Usage analysis (the Unused tab): references that must count as uses.
// Cases come from real models: RuiRomano/powerbi-agentic-apm-demo (RLS role, relationships,
// measures) and microsoft/Analysis-Services SamplePBIP (calc group, calculated column).
'use strict';
const { loadApp, eq, suite } = require('./harness');
const { App, parseTable, parseRelationships, buildUsageIndex, usageStatus } =
  loadApp(['App', 'parseTable', 'parseRelationships', 'buildUsageIndex', 'usageStatus']);
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

module.exports = tests;
