// Where a measure is used — the Measures tab's usage panel. Every place that names it, by kind:
// visuals (with the roles it fills), filters (visual, page, report), formatting, bookmarks, DAX,
// field parameters, perspectives — in both report formats. A reference from something nobody uses
// is listed but marked unused; a measure nothing names gets an empty panel. Statuses don't change.
'use strict';
const { loadApp, fileList, eq, has, hasNot, suite } = require('./harness');
const { tests, test } = suite();

const NAMES = ['App', 'processFiles', 'usageStatus', 'renderMeasures'];
const M = (entity, prop) => ({ Measure: { Expression: { SourceRef: { Entity: entity } }, Property: prop } });
const C = (entity, prop) => ({ Column: { Expression: { SourceRef: { Entity: entity } }, Property: prop } });
const lit = v => ({ expr: { Literal: { Value: v } } });
const pos = { x: 0, y: 0, width: 10, height: 10 };

const model = (root) => ({
  [`${root}/definition/model.tmdl`]: 'model Model\n',
  [`${root}/definition/tables/Sales.tmdl`]: ['table Sales',
    '\tmeasure Total = SUM(Sales[Amount])', '\tmeasure Margin = [Total] * 0.2',
    '\tmeasure Old = 1', '\tmeasure Dead = [Old] + 1',
    '\tcolumn Amount', '\t\tdataType: double', '\t\tsourceColumn: Amount'].join('\n'),
  [`${root}/definition/tables/Param.tmdl`]: ['table Param',
    '\tcolumn Param', '\t\tdataType: string', '\t\tsourceColumn: [Value1]',
    '\tpartition Param = calculated', '\t\tmode: import', "\t\tsource = {(\"Total\", NAMEOF('Sales'[Total]), 0)}"].join('\n'),
  [`${root}/definition/perspectives/Main.tmdl`]: 'perspective Main\n\n\tperspectiveTable Sales\n\n\t\tperspectiveMeasure Total\n',
});

const pbir = (title = "'Total card'", bookmark = 'Focus total') => ({
  ...model('P.SemanticModel'),
  'P.Report/definition.pbir': { version: '4.0', datasetReference: { byPath: { path: '../P.SemanticModel' } } },
  'P.Report/definition/report.json': { filterConfig: { filters: [{ name: 'rf', field: M('Sales', 'Total') }] } },
  'P.Report/definition/pages/pages.json': { pageOrder: ['p1'] },
  'P.Report/definition/pages/p1/page.json': { name: 'p1', displayName: 'Overview', filterConfig: { filters: [{ name: 'pf', field: M('Sales', 'Total') }] } },
  'P.Report/definition/pages/p1/visuals/v1/visual.json': { name: 'v1', position: pos,
    filterConfig: { filters: [{ name: 'vf', field: M('Sales', 'Total') }] },
    visual: { visualType: 'card',
      query: { queryState: { Values: { projections: [{ field: M('Sales', 'Total'), queryRef: 'Sales.Total' }] } } },
      objects: { labels: [{ properties: { color: { solid: { color: { expr: M('Sales', 'Total') } } } } }] },
      visualContainerObjects: { title: [{ properties: { text: lit(title) } }] } } },
  'P.Report/definition/pages/p1/visuals/v2/visual.json': { name: 'v2', position: pos, visual: { visualType: 'slicer',
    query: { queryState: { Values: { projections: [{ field: C('Param', 'Param'), queryRef: 'Param.Param' }] } } } } },
  'P.Report/definition/bookmarks/b1.bookmark.json': { name: 'b1', displayName: bookmark, explorationState: { activeSection: 'p1',
    sections: { p1: { visualContainers: { v1: { filters: { byExpr: [{ expression: M('Sales', 'Total') }] } } } } } } },
  'P.Report/definition/bookmarks/bookmarks.json': { items: [{ name: 'b1' }] },
});

const legacy = () => ({
  ...model('P.SemanticModel'),
  'P.Report/definition.pbir': { version: '4.0', datasetReference: { byPath: { path: '../P.SemanticModel' } } },
  'P.Report/report.json': {
    config: JSON.stringify({ bookmarks: [{ name: 'b1', displayName: 'Focus total', explorationState: { activeSection: 's1',
      sections: { s1: { visualContainers: { v1: { filters: { byExpr: [{ expression: M('Sales', 'Total') }] } } } } } } }] }),
    filters: JSON.stringify([{ name: 'rf', expression: M('Sales', 'Total') }]),
    sections: [{ name: 's1', displayName: 'Overview', config: '{}', filters: JSON.stringify([{ name: 'pf', expression: M('Sales', 'Total') }]),
      visualContainers: [
        { ...pos, z: 0, filters: JSON.stringify([{ name: 'vf', expression: M('Sales', 'Total') }]),
          config: JSON.stringify({ name: 'v1', singleVisual: { visualType: 'card',
            projections: { Values: [{ queryRef: 'Sales.Total' }] },
            prototypeQuery: { Version: 2, From: [{ Name: 's', Entity: 'Sales', Type: 0 }],
              Select: [{ Measure: { Expression: { SourceRef: { Source: 's' } }, Property: 'Total' }, Name: 'Sales.Total' }] },
            objects: { labels: [{ properties: { color: { solid: { color: { expr: M('Sales', 'Total') } } } } }] },
            vcObjects: { title: [{ properties: { text: lit("'Total card'") } }] } } }) },
        { ...pos, z: 1, config: JSON.stringify({ name: 'v2', singleVisual: { visualType: 'slicer',
          projections: { Values: [{ queryRef: 'Param.Param' }] } } }) },
      ] }],
  },
});

async function load(files) {
  const app = loadApp(NAMES, { dom: true });
  await app.processFiles(fileList(files));
  return app;
}
const bySection = (uses) => {
  const out = {};
  for (const u of uses) (out[u.section] = out[u.section] || []).push([u.page, u.label, u.detail].filter(Boolean).join(' / ') + (u.unused ? ' (unused)' : ''));
  for (const k of Object.keys(out)) out[k].sort();
  return out;
};
const TOTAL = {
  visual: ['Overview / Total card / card · Values'],
  filter: ['Overview / Total card / card · visual filter', 'Overview / page filter', 'report filter'],
  format: ['Overview / Total card / card · formatting'],
  bookmark: ['Overview / Focus total'],
  dax: ['[Margin] / measure in Sales (unused)'],   // nothing shows Margin, so its reference doesn't count
  parameter: ['Param / field parameter'],
  perspective: ['Main'],
};

for (const [format, files] of [['PBIR', pbir()], ['legacy report.json', legacy()]]) {
  test(`${format}: every place a measure is used, by kind`, async () => {
    const app = await load(files);
    const byKey = app.App.state.usage.byKey;
    eq(bySection(byKey['Sales.Total'].uses), TOTAL, 'Sales.Total');
    eq(bySection(byKey['Sales.Old'].uses), { dax: ['[Dead] / measure in Sales (unused)'] }, 'Sales.Old: only an unused measure names it');
    eq(byKey['Sales.Dead'].uses, [], 'Sales.Dead');
    eq(['Sales.Total', 'Sales.Margin', 'Sales.Old', 'Sales.Dead'].map(app.usageStatus), ['used', 'unused', 'unused', 'unused'], 'statuses');
  });
}

test('the Measures tab: a usage summary on each measure, the panel when opened', async () => {
  const app = await load(pbir());
  app.renderMeasures();
  let html = app.App.els.measuresContent.innerHTML;
  has(html, '▸ 1 visual · 3 filters · 1 format setting · 1 bookmark · 1 in DAX · 1 field parameter · 1 perspective</button>');
  has(html, '▸ 1 in DAX</button>');   // Old
  has(html, '▸ no uses</button>');    // Dead (and Margin)
  hasNot(html, 'class="usage-panel"');   // closed by default
  app.App.state.usageOpen.add('Sales.Total');
  app.App.state.usageOpen.add('Sales.Old');
  app.App.state.usageOpen.add('Sales.Dead');
  app.renderMeasures();
  html = app.App.els.measuresContent.innerHTML;
  has(html, '▾ 1 visual · 3 filters');
  has(html, '<div class="usage-sec-title">Visuals <span class="usage-count">1</span></div>');
  has(html, '<a class="usage-page" data-page="0" title="Open this page">Overview</a> · <span class="usage-what">Total card</span> <span class="usage-detail">card · Values</span>');
  has(html, '<li><span class="usage-what">report filter</span></li>');
  has(html, '<span class="usage-what">[Dead]</span> <span class="usage-detail">measure in Sales</span> <span class="usage-pill"');
  has(html, 'Nothing uses this measure');
  const order = ['Visuals', 'Filters', 'Formatting', 'Bookmarks', 'DAX', 'Field parameters', 'Perspectives'].map(t => html.indexOf(`usage-sec-title">${t} `));
  eq(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), true, 'sections in order');
});

test('names from the report render as text in the usage panel', async () => {
  const app = await load(pbir("'<img src=x onerror=alert(1)>'", '<b>B</b>'));
  app.App.state.usageOpen.add('Sales.Total');
  app.renderMeasures();
  const html = app.App.els.measuresContent.innerHTML;
  hasNot(html, '<img src=x');
  hasNot(html, '<b>B</b>');
  has(html, '&lt;img src=x onerror=alert(1)&gt;');
  has(html, '&lt;b&gt;B&lt;/b&gt;');
});

module.exports = tests;
