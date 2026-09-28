// Report layer: page visibility and kind, visual IDs / hidden state / titles / textbox text,
// groups, labels, and the export's per-page visual table. Shapes mirror real files — legacy
// report.json from Argel-Tal/MS-Security, comodu20/MyPowerBIProjects and microsoft SamplePBIP;
// PBIR from FHaurum/FHSQLMonitor and RuiRomano/powerbi-agentic-apm-demo.
'use strict';
const { loadApp, eq, has, defined, suite } = require('./harness');
const X = loadApp(['App', 'parseReport', 'parsePbirReport', 'buildMarkdownExport', 'visualLabel', 'hiddenState']);
const { tests, test } = suite();

const lit = v => ({ expr: { Literal: { Value: v } } });
const measureRef = (entity, prop) => ({ expr: { Measure: { Expression: { SourceRef: { Entity: entity } }, Property: prop } } });
const paragraphs = (...runs) => ({ general: [{ properties: { paragraphs: [{ textRuns: runs.map(value => ({ value })) }] } }] });

// ── Legacy report.json ─────────────────────────────────────────────────────────────────
const vc = cfg => ({ config: JSON.stringify(cfg), x: 0, y: 0, z: 0, width: 100, height: 50 });
const legacyText = JSON.stringify({
  config: '{}',
  sections: [
    { name: 'ReportSectionA', displayName: 'Overview', width: 1280, height: 720, config: '{}', visualContainers: [
      vc({ name: 'g1', singleVisualGroup: { displayName: 'Slicers base', groupMode: 0, isHidden: true } }),
      vc({ name: 'v1', parentGroupName: 'g1', singleVisual: { visualType: 'slicer', projections: { Values: [{ queryRef: 'Calendar.Year' }] } } }),
      vc({ name: 'v2', singleVisual: { visualType: 'gauge', display: { mode: 'hidden' },
        vcObjects: { title: [{ properties: { text: lit("'Security Score'") } }] }, projections: { Y: [{ queryRef: 'Sum(Sales.Amount)' }] } } }),
      vc({ name: 'v3', singleVisual: { visualType: 'card',
        vcObjects: { title: [{ properties: { text: measureRef('MeasuresTable', 'Most recent date header') } }] }, projections: { Values: [{ queryRef: 'Sales.Total' }] } } }),
      vc({ name: 'v4', singleVisual: { visualType: 'textbox', objects: paragraphs('MyCompany - ', 'Sales Detail') } }),
      vc({ name: 'v5', singleVisual: { visualType: 'clusteredBarChart', projections: {
        Y: [{ queryRef: 'Sum(Sales.Amount)' }], Category: [{ queryRef: 'Product.Category' }], Tooltips: [{ queryRef: 'Sales.Margin' }] } } }),
    ] },
    { name: 'ReportSectionB', displayName: 'Product Detail', config: '{"type":2}', visualContainers: [] },
    { name: 'ReportSectionC', displayName: 'Tooltip - Issue', config: '{"visibility":1,"type":1}', visualContainers: [] },
    { name: 'ReportSectionD', displayName: 'User Profile - Drill', config: '{"visibility":1}',
      filters: JSON.stringify([{ name: 'f1', howCreated: 5, type: 'Categorical' }]), visualContainers: [] },
  ],
});

test('legacy: group containers are groups, not visuals', () => {
  const [p] = defined(X.parseReport, 'parseReport')(legacyText);
  eq(p.visuals.map(v => v.id), ['v1', 'v2', 'v3', 'v4', 'v5'], 'visual ids');
  eq(p.groups, [{ id: 'g1', name: 'Slicers base', isHidden: true, parentGroup: '' }], 'groups');
  eq(p.visuals[0].parentGroup, 'g1', 'v1 parent group');
});

test('legacy: hidden visual and literal title (quotes stripped)', () => {
  const v2 = X.parseReport(legacyText)[0].visuals[1];
  eq([v2.isHidden, v2.title], [true, 'Security Score'], 'v2');
});

test('legacy: dynamic title and textbox text', () => {
  const [, , v3, v4] = X.parseReport(legacyText)[0].visuals;
  eq([v3.title, v3.titleExpr], ['', 'MeasuresTable[Most recent date header]'], 'v3');
  eq(v4.text, 'MyCompany - Sales Detail', 'v4 text');
});

test('legacy: page hidden and kind from section config (never guessed from filters)', () => {
  eq(X.parseReport(legacyText).map(p => [p.name, p.hidden, p.kind]), [
    ['ReportSectionA', false, ''], ['ReportSectionB', false, 'Drillthrough'],
    ['ReportSectionC', true, 'Tooltip'], ['ReportSectionD', true, ''],
  ], 'pages');
});

test('textbox with dynamic values and conditional cases (RuiRomano narrative textbox shape)', () => {
  const dyn = { propertyIdentifier: { objectName: 'values', propertyName: 'expr' }, selector: { id: 'V1' } };
  const text = JSON.stringify({ config: '{}', sections: [{ name: 's', displayName: 'S', config: '{}', visualContainers: [
    vc({ name: 't', singleVisual: { visualType: 'textbox', objects: { general: [{ properties: { paragraphs: [
      { textRuns: [{ cases: [{ pattern: {}, textRuns: [{ value: 'At ' }, { value: dyn }, { value: ', sales grew' }] }] }] },
      { textRuns: [{ value: 'Total: ' }, { value: dyn }] },
    ] } }] } } }),
  ] }] });
  eq(X.parseReport(text)[0].visuals[0].text, 'At …, sales grew / Total: …', 'text');
});

// ── PBIR (per-file) ────────────────────────────────────────────────────────────────────
const root = 'r.Report/definition/pages';
const pos = { x: 0, y: 0, z: 0, width: 100, height: 50 };
const pbirFiles = {
  [`${root}/pages.json`]: { pageOrder: ['p1', 'p2'] },
  // pageBinding alone doesn't make a drillthrough page (RuiRomano's visible "Sales" page carries one)
  [`${root}/p1/page.json`]: { name: 'p1', displayName: 'Sales', width: 1280, height: 720, pageBinding: { name: 'Pod6', type: 'Drillthrough', parameters: [] } },
  [`${root}/p1/visuals/grp/visual.json`]: { name: 'grp', position: pos, isHidden: true, visualGroup: { displayName: 'Filter panel opened', groupMode: 'ScaleMode' } },
  [`${root}/p1/visuals/a/visual.json`]: { name: 'a', position: pos, parentGroupName: 'grp', visual: { visualType: 'slicer',
    query: { queryState: { Values: { projections: [{ queryRef: 'Calendar.Year', nativeQueryRef: 'Year' }] } } },
    visualContainerObjects: { title: [{ properties: { text: lit("'Year Slicer'") } }] } } },
  [`${root}/p1/visuals/b/visual.json`]: { name: 'b', position: pos, isHidden: true, visual: { visualType: 'clusteredBarChart',
    query: { queryState: { Y: { projections: [{ queryRef: 'Sum(Sales.Amount)', nativeQueryRef: 'Sum of Amount' }] },
      Category: { projections: [{ queryRef: 'Product.Category', nativeQueryRef: 'Category' }] } } } } },
  [`${root}/p1/visuals/c/visual.json`]: { name: 'c', position: pos, visual: { visualType: 'textbox', objects: paragraphs('MyCompany - Cost Analysis') } },
  [`${root}/p1/visuals/d/visual.json`]: { name: 'd', position: pos, visual: { visualType: 'pivotTable',
    query: { queryState: { Rows: { projections: [{ queryRef: 'Product.Category' }] } } },
    visualContainerObjects: { title: [{ properties: { text: lit("'Margin | by ''Category'''") } }] } } },
  [`${root}/p2/page.json`]: { name: 'p2', displayName: 'Sales Detail', visibility: 'HiddenInViewMode', type: 'Drillthrough' },
};
const byPath = Object.fromEntries(Object.entries(pbirFiles).map(([k, v]) => [k, { text: async () => JSON.stringify(v) }]));

test('PBIR: page hidden and kind (type only, not pageBinding)', async () => {
  const { pages } = await X.parsePbirReport(byPath, root);
  eq(pages.map(p => [p.name, p.hidden, p.kind]), [['p1', false, ''], ['p2', true, 'Drillthrough']], 'pages');
});

test('PBIR: groups split out; ids, hidden, parent group', async () => {
  const [p1] = (await X.parsePbirReport(byPath, root)).pages;
  eq(p1.groups, [{ id: 'grp', name: 'Filter panel opened', isHidden: true, parentGroup: '' }], 'groups');
  const byId = Object.fromEntries(p1.visuals.map(v => [v.id, v]));
  eq(Object.keys(byId).sort(), ['a', 'b', 'c', 'd'], 'visual ids');
  eq([byId.a.parentGroup, byId.a.isHidden, byId.b.isHidden], ['grp', false, true], 'flags');
});

test('PBIR: literal title (escaped quote), textbox text', async () => {
  const [p1] = (await X.parsePbirReport(byPath, root)).pages;
  const byId = Object.fromEntries(p1.visuals.map(v => [v.id, v]));
  eq([byId.a.title, byId.c.text, byId.d.title], ['Year Slicer', 'MyCompany - Cost Analysis', "Margin | by 'Category'"], 'titles');
});

// ── Labels & hidden state ──────────────────────────────────────────────────────────────
test('label precedence: title > dynamic title > text > auto', () => {
  const L = defined(X.visualLabel, 'visualLabel');
  const f = [{ role: 'Y', ref: 'Sum(Sales.Amount)', name: 'Sum of Amount' }, { role: 'Category', ref: 'Product.Category' }];
  eq(L({ title: 'T', titleExpr: 'M[x]', text: 'txt', fields: f }), { text: 'T', kind: 'title' }, 'title');
  eq(L({ title: '', titleExpr: 'M[x]', text: 'txt', fields: f }), { text: 'M[x]', kind: 'dynamic' }, 'dynamic');
  eq(L({ title: '', titleExpr: '', text: 'txt', fields: f }), { text: 'txt', kind: 'text' }, 'text');
  eq(L({ title: '', titleExpr: '', text: '', fields: f }), { text: 'Sum of Amount by Category', kind: 'auto' }, 'auto');
});

test('auto label: legacy refs, tooltips ignored, category-only visuals', () => {
  const [v1, , , , v5] = X.parseReport(legacyText)[0].visuals;
  eq(X.visualLabel(v5), { text: 'Amount by Category', kind: 'auto' }, 'bar chart');
  eq(X.visualLabel({ ...v1, title: '' }), { text: 'Year', kind: 'auto' }, 'slicer');
});

test('hidden state: own vs via an enclosing group', () => {
  const [p] = X.parseReport(legacyText);
  const H = defined(X.hiddenState, 'hiddenState');
  const groups = new Map(p.groups.map(g => [g.id, g]));
  eq([H(p.visuals[0], groups), H(p.visuals[1], groups), H(p.visuals[2], groups)], ['via group', 'yes', ''], 'states');
});

// ── Export ─────────────────────────────────────────────────────────────────────────────
const exportPages = (pages) => {
  Object.assign(X.App.state, { projectName: 'T', tables: [], sources: [], relationships: [], pages, bookmarks: [], modelAnnotations: {} });
  return defined(X.buildMarkdownExport, 'buildMarkdownExport')({ pages: true });
};

test('export: page flags, page id, one row per visual and group', async () => {
  const md = exportPages((await X.parsePbirReport(byPath, root)).pages);
  has(md, '### Sales _(1280×720)_');
  has(md, 'Page ID: `p1`');
  has(md, '### Sales Detail · hidden · drillthrough');
  has(md, 'Page ID: `p2`');
  has(md, '| Visual ID | Type | Title | Hidden | Group | Fields |');
  has(md, '| `grp` | group | Filter panel opened | yes |  | 1 member |');
  has(md, '| `a` | slicer | Year Slicer | via group | Filter panel opened | Calendar.Year |');
  has(md, '| `b` | clusteredBarChart | Sum of Amount by Category _(auto)_ | yes |  | Sum(Sales.Amount), Product.Category |');
  has(md, '| `c` | textbox | "MyCompany - Cost Analysis" _(text)_ |  |  | — |');
  has(md, "| `d` | pivotTable | Margin \\| by 'Category' |  |  | Product.Category |");
});

test('export: dynamic title row (legacy)', () => {
  const md = exportPages(X.parseReport(legacyText));
  has(md, '| `v3` | card | MeasuresTable[Most recent date header] _(dynamic)_ |  |  | Sales.Total |');
  has(md, '### User Profile - Drill · hidden');
});

module.exports = tests;
