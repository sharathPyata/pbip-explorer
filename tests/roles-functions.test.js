// Security roles, DAX functions and perspectives — shown, not only counted: roles in the Tables tab
// under each table they filter, functions in the Measures tab, all three in the Overview, the
// export and the header search. Shapes from RuiRomano/powerbi-agentic-apm-demo (roles, an indented
// function with a /// description and a lineageTag, a perspective) and FHaurum/FHSQLMonitor (fenced
// functions).
'use strict';
const { loadApp, fileList, eq, has, hasNot, suite } = require('./harness');
const { tests, test } = suite();

const NAMES = ['App', 'processFiles', 'parseFunctions', 'parseTmslModel', 'renderTableDetail', 'renderMeasures',
  'renderOverview', 'buildMarkdownExport', 'applyExportPreset', 'runGlobalSearch'];

const col = (name) => [`\tcolumn ${name}`, '\t\tdataType: string', `\t\tsourceColumn: ${name}`];
const project = ({ role = 'West', fnDescription = 'amount - sales amount', perspective = 'Sales' } = {}) => ({
  'P.SemanticModel/definition/model.tmdl': 'model Model\n\tculture: en-US\n',
  'P.SemanticModel/definition/tables/Sales.tmdl': ['table Sales', ...col('Amount'), ...col('Region'),
    '\tmeasure Total = AddTax(SUM(Sales[Amount]))'].join('\n'),
  'P.SemanticModel/definition/tables/Store.tmdl': ['table Store', ...col('Country'), ...col('City')].join('\n'),
  'P.SemanticModel/definition/tables/Budget.tmdl': ['table Budget', ...col('Target')].join('\n'),
  [`P.SemanticModel/definition/roles/${role}.tmdl`]: [`role '${role.replace(/'/g, "''")}'`, '\tmodelPermission: read', '',
    '\ttablePermission Sales = [Region] == "West"', '',
    '\ttablePermission Store =', '\t\t\tVAR c = "US"', '\t\t\tRETURN [Country] = c', '',
    '\tannotation PBI_Id = 5587cca136da46789bfeb4c2de02c98e'].join('\n'),
  'P.SemanticModel/definition/roles/Admin.tmdl': 'role Admin\n\tmodelPermission: administrator\n',
  'P.SemanticModel/definition/functions.tmdl': [
    `/// ${fnDescription}`, '/// Returns:', '/// double: The amount with tax as double',
    'function AddTax =', '\t\t(', '\t\t    amount : double', '\t\t) =>', '\t\tamount * 1.1',
    '\tlineageTag: 11d34bb8-904c-4380-b905-551fde304afb', '',
    'function _toggle = ```', '\t\t(side : string) =>', '\t\tIF(side = "Left", 1, 19)', '\t\t```',
    '\tlineageTag: 7baffed2-8ee9-4e5c-9945-9396c0c90345', ''].join('\n'),
  'P.SemanticModel/definition/perspectives/Sales.tmdl': [`perspective '${perspective.replace(/'/g, "''")}'`, '',
    '\tperspectiveTable Sales', '', '\t\tperspectiveMeasure Total', '', '\t\tperspectiveColumn Region', ''].join('\n'),
  'P.Report/definition.pbir': { version: '4.0', datasetReference: { byPath: { path: '../P.SemanticModel' } } },
  'P.Report/definition/pages/pages.json': { pageOrder: ['p1'] },
  'P.Report/definition/pages/p1/page.json': { name: 'p1', displayName: 'Page', width: 100, height: 100 },
  'P.Report/definition/pages/p1/visuals/v1/visual.json': { name: 'v1', position: { x: 0, y: 0, width: 1, height: 1 },
    visual: { visualType: 'card', query: { queryState: { Values: { projections: [{ queryRef: 'Sales.Total' }] } } } } },
});

async function load(files) {
  const app = loadApp(NAMES, { dom: true });
  await app.processFiles(fileList(files));
  return app;
}
function tableDetail(app, name) {
  const detail = app.element();
  app.document.getElementById = id => (id === 'tableDetail' ? detail : null);
  app.App.state.activeTable = name;
  app.renderTableDetail();
  return detail.innerHTML;
}

test("a function's indented body stops at its lineageTag; its /// block is its description (demo's AddTax)", async () => {
  const app = await load(project());
  eq(app.App.state.functions.map(f => [f.name, f.dax, f.description]), [
    ['AddTax', '(\n    amount : double\n) =>\namount * 1.1', 'amount - sales amount\nReturns:\ndouble: The amount with tax as double'],
    ['_toggle', '(side : string) =>\nIF(side = "Left", 1, 19)', ''],
  ], 'functions');
  const { functions } = app.parseTmslModel({ model: { functions: [{ name: 'F', expression: ['() =>', '1'], description: 'One.' }] } });
  eq(functions, [{ name: 'F', dax: '() =>\n1', description: 'One.' }], 'model.bim');
});

test('the Tables tab shows the roles that filter a table, with their DAX', async () => {
  const app = await load(project());
  const store = tableDetail(app, 'Store');
  has(store, 'filtered by 1 security role');
  has(store, 'Row-level security');
  has(store, '<div class="measure-name">West</div>');
  has(store, 'VAR c = &quot;US&quot;\nRETURN [Country] = c');
  has(tableDetail(app, 'Sales'), '[Region] == &quot;West&quot;');
  has(tableDetail(app, 'Sales'), 'in perspective Sales');
  hasNot(tableDetail(app, 'Budget'), 'Row-level security');   // no role filters it; Admin filters nothing
});

test('the Measures tab lists the DAX functions after the measures, under the same filter', async () => {
  const app = await load(project());
  app.renderMeasures();
  let html = app.App.els.measuresContent.innerHTML;
  has(html, '1 of 1 · 2 of 2 functions');
  has(html, '<span class="table-name">DAX functions</span>');
  has(html, 'amount - sales amount\nReturns:');
  has(html, 'IF(side = &quot;Left&quot;, 1, 19)');
  app.App.state.measureFilter = 'addtax';   // the function, and the measure that calls it
  app.renderMeasures();
  html = app.App.els.measuresContent.innerHTML;
  has(html, '1 of 1 · 1 of 2 functions');
  hasNot(html, '_toggle');
});

test('the Overview lists roles (with what they filter), perspectives and functions', async () => {
  const app = await load(project());
  app.renderOverview();
  const html = app.App.els.overviewContent.innerHTML;
  has(html, '<strong>Security roles (2):</strong> West <span style="color:var(--text-3)">(filters Sales, Store)</span>, Admin</span>');
  has(html, '<strong>Perspectives (1):</strong> Sales <span style="color:var(--text-3)">(2 fields)</span>');
  has(html, '<strong>DAX functions (2):</strong> AddTax, _toggle — listed in the Measures tab');
});

test('the export: counts in the summary, then functions, roles and perspectives — each with its own toggle', async () => {
  const app = await load(project());
  const o = app.App.state.exportOpts;
  const md = app.buildMarkdownExport(o);
  for (const row of ['| Security roles | 2 |', '| DAX functions | 2 |', '| Perspectives | 1 |']) has(md, row);
  has(md, '## DAX functions\n\n_User-defined functions, callable from any DAX in the model._\n\n### AddTax\n\namount - sales amount\nReturns:\ndouble: The amount with tax as double\n\n```dax\n(\n    amount : double\n) =>\namount * 1.1\n```');
  has(md, '### West\n\n- **Permission:** read\n\n**Filters Sales:**\n```dax\n[Region] == "West"\n```');
  has(md, '### Admin\n\n- **Permission:** administrator\n\n_No row filters._');
  has(md, '## Perspectives\n\n### Sales\n\n- **Sales:** columns: Region; measures: Total');
  const off = app.buildMarkdownExport({ ...o, functions: false, roles: false, perspectives: false });
  for (const h of ['## DAX functions', '## Security roles', '## Perspectives']) hasNot(off, h);
  app.applyExportPreset('schema');
  eq([o.roles, o.perspectives, o.functions], [true, true, false], 'schema preset');
  app.applyExportPreset('measures');
  eq([o.roles, o.perspectives, o.functions], [false, false, true], 'measures preset');
});

test('the header search finds functions (by name or in their DAX) and roles', async () => {
  const app = await load(project());
  app.App.state.searchTerm = 'west';
  app.runGlobalSearch();
  has(app.App.els.searchPanel.innerHTML, 'data-action="table" data-name="Sales"');
  has(app.App.els.searchPanel.innerHTML, 'filters Sales');
  app.App.state.searchTerm = 'side';
  app.runGlobalSearch();
  has(app.App.els.searchPanel.innerHTML, 'data-action="function" data-name="_toggle"');
  has(app.App.els.searchPanel.innerHTML, 'function · in DAX');
});

test('role, function and perspective names from the files render as text', async () => {
  const app = await load(project({ role: '<img src=x onerror=alert(1)>', fnDescription: '<script>x</script>', perspective: '<b>P</b>' }));
  app.renderMeasures();
  app.renderOverview();
  app.App.state.searchTerm = 'img';
  app.runGlobalSearch();
  const views = { tables: tableDetail(app, 'Sales'), measures: app.App.els.measuresContent.innerHTML,
    overview: app.App.els.overviewContent.innerHTML, search: app.App.els.searchPanel.innerHTML };
  for (const [view, html] of Object.entries(views)) {
    for (const bad of ['<img src=x', '<script>', '<b>P</b>']) if (html.includes(bad)) throw new Error(`${view}: unescaped ${bad}`);
  }
  has(views.tables, '&lt;img src=x onerror=alert(1)&gt;');
  has(views.measures, '&lt;script&gt;x&lt;/script&gt;');
  has(views.overview, '&lt;b&gt;P&lt;/b&gt;');
});

module.exports = tests;
