// Report-only projects: a live-connected ("thin") report whose semantic model lives in the Power BI
// service, or a report dropped without its model folder. Everything the report holds still loads —
// pages, visuals, bookmarks, report-level measures — plus the list of model fields it depends on.
// Shapes mirror real files: the byConnection string of microsoft/fabric-cicd's ByConnection.Report
// sample (and the older version-1 form with pbiModelDatabaseName), and the legacy report-level
// measures (config.modelExtensions) of maleek004/WWI-in-Fabric.
'use strict';
const { loadApp, fileList, eq, has, hasNot, defined, suite } = require('./harness');
const { tests, test } = suite();

const NAMES = ['App', 'processFiles', 'pickProject', 'buildMarkdownExport', 'reportFieldsUsed', 'usageStatus',
  'renderOverview', 'renderSources', 'renderTables', 'renderRelationships', 'renderMeasures', 'renderUnused', 'updateCounts'];
const pos = { x: 0, y: 0, width: 10, height: 10 };
const col = (entity, prop) => ({ Column: { Expression: { SourceRef: { Entity: entity } }, Property: prop } });

const thinPbir = {
  'ws/Cost.Report/definition.pbir': { version: '4.0', datasetReference: { byConnection: { connectionString:
    'Data Source=powerbi://api.powerbi.com/v1.0/myorg/Finance%20Workspace;initial catalog=Cost Model;access mode=readonly;integrated security=ClaimsToken;semanticmodelid=11111111-2222-3333-4444-555555555555' } } },
  'ws/Cost.Report/definition/pages/pages.json': { pageOrder: ['p1'] },
  'ws/Cost.Report/definition/pages/p1/page.json': { name: 'p1', displayName: 'Summary', width: 1280, height: 720,
    filterConfig: { filters: [{ name: 'f1', field: col('Calendar', 'Year') }] } },
  'ws/Cost.Report/definition/pages/p1/visuals/v1/visual.json': { name: 'v1', position: pos, visual: { visualType: 'card',
    query: { queryState: { Values: { projections: [{ queryRef: 'Costs.Total Cost' }] } } } } },
  'ws/Cost.Report/definition/pages/p1/visuals/v2/visual.json': { name: 'v2', position: pos, visual: { visualType: 'clusteredBarChart',
    query: { queryState: { Y: { projections: [{ queryRef: 'Costs.Margin %' }] }, Category: { projections: [{ queryRef: 'Product.Category' }] } } } } },
  'ws/Cost.Report/definition/reportExtensions.json': { name: 'extension', entities: [{ name: 'Costs',
    measures: [{ name: 'Margin %', dataType: 'Double', expression: "DIVIDE([Total Cost], SUM('Costs'[Revenue]))" }] }] },
};

const thinLegacy = {
  'r/WWI_sales_report.Report/definition.pbir': { version: '4.0', datasetReference: { byConnection: {
    connectionString: 'Data Source="powerbi://api.powerbi.com/v1.0/myorg/WWI";initial catalog=WWI_sales;integrated security=ClaimsToken',
    pbiServiceModelId: null, pbiModelVirtualServerName: 'sobe_wowvirtualserver', pbiModelDatabaseName: 'aaaa-bbbb',
    connectionType: 'pbiServiceXmlaStyleLive', name: 'EntityDataSource' } } },
  'r/WWI_sales_report.Report/report.json': {
    config: JSON.stringify({ modelExtensions: [{ name: 'extension', entities: [{ name: 'Dim_Stock_Item', extends: 'Dim_Stock_Item',
      measures: [{ name: 'AvgExpectedDeliveryDays', dataType: 3, expression: 'AVERAGE(Dim_Stock_Item[Lead Time Days]) ',
        formatInformation: { formatString: 'G' } }] }] }] }),
    sections: [{ name: 's1', displayName: 'Sales', width: 1280, height: 720, config: '{}', visualContainers: [
      { x: 0, y: 0, z: 0, width: 10, height: 10,
        config: JSON.stringify({ name: 'v1', singleVisual: { visualType: 'card', projections: { Values: [{ queryRef: 'Dim_Stock_Item.AvgExpectedDeliveryDays' }] } } }) },
    ] }],
  },
};

async function load(files) {
  const app = loadApp(NAMES, { dom: true });
  await app.processFiles(fileList(files));
  return app;
}

test('a live-connected PBIR report loads instead of being rejected', async () => {
  const app = await load(thinPbir);
  const s = app.App.state;
  eq(app.toasts, ['Loaded report Cost: 1 page, 2 visuals — live connection to Cost Model in Finance Workspace'], 'toasts');
  eq([s.reportOnly, s.projectName, s.tables.length, s.pages.length], [true, 'Cost', 0, 1], 'state');
  eq([s.connection.kind, s.connection.workspace, s.connection.model, s.connection.id],
    ['byConnection', 'Finance Workspace', 'Cost Model', '11111111-2222-3333-4444-555555555555'], 'connection');
  eq(s.reportMeasures.map(m => [m.table, m.name]), [['Costs', 'Margin %']], 'report measures');
});

test('fields the report uses: visuals, filters and report-measure DAX — its own measures excluded', async () => {
  const app = await load(thinPbir);
  eq(defined(app.reportFieldsUsed, 'reportFieldsUsed')().map(f => [f.table, f.field, f.visuals, f.other, [...f.measures]]), [
    ['Calendar', 'Year', 0, true, []],
    ['Costs', 'Revenue', 0, false, ['Margin %']],
    ['Costs', 'Total Cost', 1, false, []],
    ['Product', 'Category', 1, false, []],
  ], 'fields');
});

test('a stale queryRef: Fields used lists the bound field, not the stale name; with the model, the name still counts', async () => {
  const measure = (prop) => ({ Measure: { Expression: { SourceRef: { Entity: 'fca' } }, Property: prop } });
  const files = { ...thinPbir };
  files['ws/Cost.Report/definition/pages/p1/visuals/v1/visual.json'] = { name: 'v1', position: pos, visual: { visualType: 'card',
    query: { queryState: { Values: { projections: [{ field: measure('#TotalCost'), queryRef: 'fca.$TCO', nativeQueryRef: '$TCO' }] } } } } };
  const app = await load(files);
  const fields = app.reportFieldsUsed().map(f => [`${f.table}.${f.field}`, f.visuals]);
  has(JSON.stringify(fields), '["fca.#TotalCost",1]');
  hasNot(JSON.stringify(fields), '$TCO');

  // Paired with a model that still has the old measure too: marking it used is the safe side.
  files['ws/Cost.Report/definition.pbir'] = { version: '4.0', datasetReference: { byPath: { path: '../Cost.SemanticModel' } } };
  files['ws/Cost.SemanticModel/definition/model.tmdl'] = 'model Model\n';
  files['ws/Cost.SemanticModel/definition/tables/fca.tmdl'] = 'table fca\n\tmeasure \'#TotalCost\' = 1\n\tmeasure \'$TCO\' = 2\n\tmeasure Spare = 3\n';
  const paired = await load(files);
  eq(['fca.#TotalCost', 'fca.$TCO', 'fca.Spare'].map(paired.usageStatus), ['used', 'used', 'unused'], 'usage');
});

test('legacy thin report: modelExtensions measures, version-1 connection (pbiModelDatabaseName)', async () => {
  const app = await load(thinLegacy);
  const s = app.App.state;
  eq([s.connection.workspace, s.connection.model, s.connection.id], ['WWI', 'WWI_sales', 'aaaa-bbbb'], 'connection');
  eq(s.reportMeasures.map(m => [m.table, m.name, m.dax, m.formatString]),
    [['Dim_Stock_Item', 'AvgExpectedDeliveryDays', 'AVERAGE(Dim_Stock_Item[Lead Time Days])', 'G']], 'report measures');
  eq(app.reportFieldsUsed().map(f => `${f.table}.${f.field}`), ['Dim_Stock_Item.Lead Time Days'], 'fields');
});

test('a report dropped without its model folder loads, saying where the model was expected', async () => {
  const files = {};
  for (const [k, v] of Object.entries(thinPbir)) files[k.replace('ws/Cost.Report', 'Sales.Report')] = v;
  files['Sales.Report/definition.pbir'] = { version: '4.0', datasetReference: { byPath: { path: '../Sales.SemanticModel' } } };
  const app = await load(files);
  eq(app.toasts, ["Loaded report Sales: 1 page, 2 visuals — its semantic model (../Sales.SemanticModel) isn't in this folder"], 'toasts');
  eq([app.App.state.reportOnly, app.App.state.connection.kind], [true, 'byPath'], 'state');
});

test('the picker labels a report-only choice with its connection', async () => {
  const files = { ...thinPbir,
    'm/Other.SemanticModel/definition/model.tmdl': 'model Model\n',
    'm/Other.SemanticModel/definition/tables/T.tmdl': 'table T\n\tcolumn c\n\t\tdataType: string\n\t\tsourceColumn: c' };
  const app = await load(files);
  eq(app.App.pendingProjects.projects.map(p => [p.reports.map(r => r.name), p.model && p.model.name]), [[['Cost'], null], [[], 'Other']], 'choices');
  has(app.App.els.projectPicker.innerHTML, 'report only — live connection to Cost Model in Finance Workspace');
  await app.pickProject(0);
  eq(app.App.state.reportOnly, true, 'loaded the report');
});

/* Render every tab of a loaded report-only project; returns each tab's HTML by name. */
function renderTabs(app) {
  const html = {};
  for (const [tab, fn, el] of [['overview', 'renderOverview', 'overviewContent'], ['sources', 'renderSources', 'sourcesContent'],
    ['tables', 'renderTables', 'tablesContent'], ['relationships', 'renderRelationships', 'relationshipsContent'],
    ['measures', 'renderMeasures', 'measuresContent'], ['unused', 'renderUnused', 'unusedContent']]) {
    defined(app[fn], fn)();
    html[tab] = app.App.els[el].innerHTML;
  }
  return html;
}

test('the tabs: Overview shows the connection, model tabs say where the model is, Unused becomes Fields used', async () => {
  const app = await load(thinPbir);
  const unusedTab = { firstChild: { nodeValue: 'Unused ' } };
  app.document.querySelector = sel => (sel === '.nav-tab[data-view="unused"]' ? unusedTab : null);
  defined(app.updateCounts, 'updateCounts')();
  eq([unusedTab.firstChild.nodeValue, app.App.els.cMeasures.textContent, app.App.els.cUnused.textContent], ['Fields used ', '1', '4'], 'nav');

  const html = renderTabs(app);
  has(html.overview, '<strong>Workspace:</strong> Finance Workspace');
  has(html.overview, '<strong>Semantic model ID:</strong> 11111111-2222-3333-4444-555555555555');
  for (const tab of ['sources', 'tables', 'relationships']) has(html[tab], 'live-connected to <strong>Cost Model</strong> in <strong>Finance Workspace</strong>');
  has(html.measures, 'Report-level measures: defined in this report');
  has(html.measures, 'Margin %');
  has(html.unused, '<strong>4</strong> of 4 fields');
  has(html.unused, 'Revenue<span class="reason">— report measure [Margin %]</span>');
  has(html.unused, 'Year<span class="reason">— filters, bookmarks or other settings</span>');
  has(html.unused, 'Category<span class="reason">— 1 visual</span>');
});

test('a report-only project whose connection and fields are hostile renders them as text', async () => {
  const files = { ...thinPbir };
  files['ws/Cost.Report/definition.pbir'] = { version: '4.0', datasetReference: { byConnection: { connectionString:
    'Data Source=powerbi://api.powerbi.com/v1.0/myorg/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E;initial catalog=<b>M</b>;semanticmodelid=<i>id</i>' } } };
  files['ws/Cost.Report/definition/pages/p1/visuals/v1/visual.json'] = { name: 'v1', position: pos, visual: { visualType: 'card',
    query: { queryState: { Values: { projections: [{ queryRef: 'Costs.<script>x</script>' }] } } } } };
  files['ws/Cost.Report/definition/reportExtensions.json'] = { name: 'extension', entities: [{ name: 'Costs',
    measures: [{ name: '<u>m</u>', expression: '1' }] }] };
  const app = await load(files);
  const html = renderTabs(app);
  for (const [tab, h] of Object.entries(html)) {
    for (const bad of ['<img src=x', '<b>M</b>', '<i>id</i>', '<script>', '<u>m</u>']) {
      if (h.includes(bad)) throw new Error(`${tab}: unescaped ${bad}`);
    }
  }
  has(html.overview, '&lt;img src=x onerror=alert(1)&gt;');
  has(html.unused, '&lt;script&gt;x&lt;/script&gt;');
  has(html.measures, '&lt;u&gt;m&lt;/u&gt;');
});

test('export of a report-only project: connection, report measures, fields used — no model sections', async () => {
  const app = await load(thinPbir);
  const md = app.buildMarkdownExport({ summary: true, sources: true, tables: true, measures: true, calcGroups: true, relationships: true, pages: true, unused: true, includeM: true });
  has(md, 'Live connection to **Cost Model** in **Finance Workspace**');
  has(md, '## Report-level measures');
  has(md, "DIVIDE([Total Cost], SUM('Costs'[Revenue]))");
  has(md, '## Fields this report uses');
  has(md, '| Calendar | Year | 0 | filters, bookmarks or other settings |');
  has(md, '| Costs | Revenue | 0 | report measure [Margin %] |');
  has(md, '## Report pages');
  hasNot(md, '## Tables');
  hasNot(md, '## Unused');
});

module.exports = tests;
