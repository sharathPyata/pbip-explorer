// End to end: a small project through processFiles(), the same path a dropped folder takes.
// One fixture per model format (TMDL folder / TMSL model.bim) and report format (PBIR / legacy
// report.json), all describing the same model, so both pairs must land in the same state.
'use strict';
const { loadApp, fileList, eq, suite } = require('./harness');
const { tests, test } = suite();

const NAMES = ['App', 'processFiles', 'usageStatus'];

// Shared by both fixtures: a parameterised SQL source, a measure over a column, an RLS rule on
// another column, one visual using the measure, one bookmark that hides it.
const SALES_M = ['let', '    Source = Sql.Database(Server, "SalesDb"),', '    Sales = Source{[Schema="dbo",Item="Sales"]}[Data]', 'in', '    Sales'];
const SERVER_PARAM = '"sql.contoso.com" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]';

const tmdlPbir = {
  'P.SemanticModel/definition/model.tmdl': 'model Model\n\tculture: en-US\n',
  'P.SemanticModel/definition/expressions.tmdl': `expression Server = ${SERVER_PARAM}\n`,
  'P.SemanticModel/definition/tables/Sales.tmdl': [
    'table Sales',
    '\tmeasure Total = SUM(Sales[Amount])',
    '\t\tformatString: #,##0',
    '\tcolumn Amount', '\t\tdataType: double', '\t\tsourceColumn: Amount',
    '\tcolumn Region', '\t\tdataType: string', '\t\tsourceColumn: Region',
    '\tpartition Sales = m', '\t\tmode: import', '\t\tsource =', ...SALES_M.map(l => '\t\t\t\t' + l),
  ].join('\r\n'),   // CRLF, as Power BI Desktop on Windows saves it
  'P.SemanticModel/definition/roles/West.tmdl': 'role West\n\tmodelPermission: read\n\n\ttablePermission Sales = [Region] == "West"\n',
  'P.Report/definition.pbir': { version: '4.0', datasetReference: { byPath: { path: '../P.SemanticModel' } } },
  'P.Report/definition/pages/pages.json': { pageOrder: ['p1'] },
  'P.Report/definition/pages/p1/page.json': { name: 'p1', displayName: 'Overview', width: 1280, height: 720 },
  'P.Report/definition/pages/p1/visuals/v1/visual.json': { name: 'v1', position: { x: 0, y: 0, width: 200, height: 100 },
    visual: { visualType: 'card', query: { queryState: { Values: { projections: [{ queryRef: 'Sales.Total', nativeQueryRef: 'Total' }] } } } } },
  'P.Report/definition/bookmarks/b1.bookmark.json': { name: 'b1', displayName: 'Hide card', options: { suppressData: true },
    explorationState: { activeSection: 'p1', sections: { p1: { visualContainers: { v1: { singleVisual: { display: { mode: 'hidden' } } } } } } } },
};

const tmslLegacy = {
  'P.SemanticModel/model.bim': { compatibilityLevel: 1601, model: {
    expressions: [{ name: 'Server', kind: 'm', expression: SERVER_PARAM }],
    tables: [{
      name: 'Sales',
      columns: [
        { name: 'Amount', dataType: 'double', sourceColumn: 'Amount' },
        { name: 'Region', dataType: 'string', sourceColumn: 'Region' },
        { name: 'RowNumber-2662979B', dataType: 'int64', isHidden: true, type: 'rowNumber' },   // TOM's implicit column
      ],
      measures: [{ name: 'Total', expression: 'SUM(Sales[Amount])', formatString: '#,##0' }],
      partitions: [{ name: 'Sales', mode: 'import', source: { type: 'm', expression: SALES_M } }],
    }],
    roles: [{ name: 'West', modelPermission: 'read', tablePermissions: [{ name: 'Sales', filterExpression: '[Region] == "West"' }] }],
  } },
  'P.Report/report.json': {
    config: JSON.stringify({ bookmarks: [{ name: 'b1', displayName: 'Hide card', options: { suppressData: true },
      explorationState: { activeSection: 'p1', sections: { p1: { visualContainers: { v1: { singleVisual: { display: { mode: 'hidden' } } } } } } } }] }),
    sections: [{ name: 'p1', displayName: 'Overview', width: 1280, height: 720, config: '{}', visualContainers: [
      { x: 0, y: 0, z: 0, width: 200, height: 100,
        config: JSON.stringify({ name: 'v1', singleVisual: { visualType: 'card', projections: { Values: [{ queryRef: 'Sales.Total' }] } } }) },
    ] }],
  },
};

async function load(files) {
  const app = loadApp(NAMES, { dom: true });
  await app.processFiles(fileList(files));
  return app;
}

function expectSameModel(app, format) {
  const s = app.App.state;
  eq(app.toasts, ['Loaded 1 tables, 1 measures, 0 relationships'], 'toasts');
  eq([s.projectName, s.modelFormat], ['P', format], 'project');
  eq(s.tables.map(t => [t.name, t.columns.map(c => c.name), t.measures.map(m => m.name)]),
    [['Sales', ['Amount', 'Region'], ['Total']]], 'tables');
  // The parameter is inlined into the connector and isn't a source of its own.
  eq(s.sources.map(src => [src.type, src.server, src.queries]), [['sql-server', 'sql.contoso.com / SalesDb', ['Sales']]], 'sources');
  eq(['Sales.Total', 'Sales.Amount', 'Sales.Region'].map(app.usageStatus), ['used', 'used', 'used'], 'usage (visual, measure DAX, RLS)');
  eq(s.pages.map(p => [p.name, p.visuals.map(v => [v.id, v.type])]), [['p1', [['v1', 'card']]]], 'pages');
  eq(s.bookmarks.map(b => [b.id, b.page, b.visuals]), [['b1', 'p1', { v1: 'hidden' }]], 'bookmarks');
}

test('TMDL model + PBIR report load end to end (CRLF table file)', async () => {
  expectSameModel(await load(tmdlPbir), 'TMDL');
});

test('TMSL model.bim + legacy report.json load to the same state', async () => {
  expectSameModel(await load(tmslLegacy), 'TMSL');
});

module.exports = tests;
