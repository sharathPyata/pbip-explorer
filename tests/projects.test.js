// Finding projects in a dropped folder: models and reports are recognised by their definition
// files, not their folder names, and each report is paired with the model its definition.pbir
// names. Layouts mirror real repos: microsoft/finops-toolkit (five reports sharing one
// Shared.Dataset model), Fabric Git exports with bare "SemanticModel" folders, and Power BI's own
// side-by-side projects.
'use strict';
const { loadApp, fileList, eq, has, defined, suite } = require('./harness');
const { tests, test } = suite();

const NAMES = ['App', 'processFiles', 'discoverProjects', 'pickProject', 'usageStatus', 'buildMarkdownExport'];

const model = (root, table, cols) => ({
  [`${root}/definition.pbism`]: { version: '4.0' },
  [`${root}/definition/model.tmdl`]: 'model Model\n\tculture: en-US\n',
  [`${root}/definition/tables/${table}.tmdl`]: [`table ${table}`,
    ...cols.flatMap(c => [`\tcolumn ${c}`, '\t\tdataType: string', `\t\tsourceColumn: ${c}`])].join('\n'),
});
const report = (root, datasetReference, fieldRef) => ({
  [`${root}/definition.pbir`]: { version: '4.0', datasetReference },
  [`${root}/definition/pages/pages.json`]: { pageOrder: ['p1'] },
  [`${root}/definition/pages/p1/page.json`]: { name: 'p1', displayName: 'Page', width: 100, height: 100 },
  [`${root}/definition/pages/p1/visuals/v1/visual.json`]: { name: 'v1', position: { x: 0, y: 0, width: 1, height: 1 },
    visual: { visualType: 'card', query: { queryState: { Values: { projections: [{ queryRef: fieldRef }] } } } } },
});
const byPath = (path) => ({ byPath: { path } });
const asByPath = (files) => Object.fromEntries(fileList(files).map(f => [f.webkitRelativePath, f]));

async function load(files) {
  const app = loadApp(NAMES, { dom: true });
  await app.processFiles(fileList(files));
  return app;
}

test('a model folder named X.Dataset loads (finops-toolkit layout)', async () => {
  const app = await load({ ...model('kql/Shared.Dataset', 'Costs', ['Amount']), ...report('kql/CostSummary.Report', byPath('../Shared.Dataset'), 'Costs.Amount') });
  eq(app.toasts, ['Loaded 1 tables, 0 measures, 0 relationships'], 'toasts');
  eq([app.App.state.projectName, app.App.state.modelFormat, app.App.state.pages.length], ['Shared', 'TMDL', 1], 'project');
  eq(app.usageStatus('Costs.Amount'), 'used', 'usage');
});

test('model and report folders with no suffix at all (Fabric Git style)', async () => {
  const app = await load({ ...model('src/SemanticModel', 'Sales', ['Amount']), ...report('src/Report', byPath('../SemanticModel'), 'Sales.Amount') });
  eq(app.toasts, ['Loaded 1 tables, 0 measures, 0 relationships'], 'toasts');
  eq(app.usageStatus('Sales.Amount'), 'used', 'usage');
});

test('a report is paired with the model its definition.pbir names, not the first one found', async () => {
  const app = loadApp(NAMES, { dom: true });
  const projects = await defined(app.discoverProjects, 'discoverProjects')(asByPath({
    ...model('P/A.SemanticModel', 'TA', ['x']), ...model('P/B.SemanticModel', 'TB', ['y']),
    ...report('P/R.Report', byPath('../B.SemanticModel'), 'TB.y'),
  }));
  eq(projects.map(p => [p.reports.map(r => r.name), p.model && p.model.name]), [[['R'], 'B'], [[], 'A']], 'projects');
});

test('the byPath link matches the model folder case-insensitively (Windows paths)', async () => {
  const app = loadApp(NAMES, { dom: true });
  const projects = await app.discoverProjects(asByPath({ ...model('P/Sales.SemanticModel', 'T', ['c']), ...report('P/Sales.Report', byPath('../sales.semanticmodel'), 'T.c') }));
  eq(projects.map(p => p.model && p.model.root), ['P/Sales.SemanticModel'], 'paired');
});

test('more than one project: nothing loads until one is picked from the list', async () => {
  const app = await load({ ...model('P/A.SemanticModel', 'TA', ['x']), ...model('P/B.SemanticModel', 'TB', ['y']),
    ...report('P/R.Report', byPath('../B.SemanticModel'), 'TB.y') });
  eq(app.toasts, [], 'no load yet');
  const pending = app.App.pendingProjects;
  eq(pending && pending.projects.length, 2, 'choices');
  const html = app.App.els.projectPicker.innerHTML;
  has(html, 'R'); has(html, 'A');
  await defined(app.pickProject, 'pickProject')(1);                       // the model-only project A
  eq(app.App.state.tables.map(t => t.name), ['TA'], 'loaded A');
  eq(app.App.pendingProjects, null, 'choice consumed');
});

test('several reports on one model: "all reports" is offered first and combines their usage', async () => {
  const files = { ...model('kql/Shared.Dataset', 'Costs', ['Amount', 'Region', 'Unused']),
    ...report('kql/X.Report', byPath('../Shared.Dataset'), 'Costs.Amount'),
    ...report('kql/Y.Report', byPath('../Shared.Dataset'), 'Costs.Region') };
  const app = await load(files);
  eq(app.App.pendingProjects.projects.map(p => p.reports.map(r => r.name)), [['X', 'Y'], ['X'], ['Y']], 'choices');
  await app.pickProject(0);
  const s = app.App.state;
  eq(s.pages.map(p => [p.name, p.displayName, p.pageId]), [['X/p1', 'X · Page', 'p1'], ['Y/p1', 'Y · Page', 'p1']], 'pages');
  eq(['Costs.Amount', 'Costs.Region', 'Costs.Unused'].map(app.usageStatus), ['used', 'used', 'unused'], 'usage across reports');
  has(app.buildMarkdownExport({ pages: true }), 'Page ID: `p1`');   // the real ID, not the prefixed one

  const one = await load(files);
  await one.pickProject(1);                                               // just X
  eq(['Costs.Amount', 'Costs.Region'].map(one.usageStatus), ['used', 'unused'], 'usage for X alone');
});

test('a report the .pbip opens is listed before the others', async () => {
  const app = loadApp(NAMES, { dom: true });
  const projects = await app.discoverProjects(asByPath({
    ...model('P/A.SemanticModel', 'TA', ['x']), ...report('P/A.Report', byPath('../A.SemanticModel'), 'TA.x'),
    ...model('P/Z.SemanticModel', 'TZ', ['z']), ...report('P/Z.Report', byPath('../Z.SemanticModel'), 'TZ.z'),
    'P/Z.pbip': { version: '1.0', artifacts: [{ report: { path: 'Z.Report' } }] },
  }));
  eq(projects.map(p => [p.reports[0].name, p.reports[0].pbip]), [['Z', 'Z.pbip'], ['A', '']], 'order');
});

test('a folder with no model or report says what it expected', async () => {
  const app = await load({ 'stuff/readme.txt': 'hello' });
  eq(app.toasts.length, 1, 'one toast');
  has(app.toasts[0], 'No Power BI project found');
});

module.exports = tests;
