// Bookmark show/hide: parsing both formats, per-bookmark state, and the export's bookmark matrix.
// Shapes mirror real files: PBIR from FHaurum/FHSQLMonitor (filter-panel pairs toggling group
// state on selected visuals; bookmarks.json folders listing bookmark names); legacy from
// comodu20/MyPowerBIProjects (visuals hidden directly), PiConsulting/Pensadero (nested group
// `children`, suppressActiveSection) and legacy folders holding bookmark objects.
'use strict';
const { loadApp, eq, has, hasNot, defined, suite } = require('./harness');
const X = loadApp(['App', 'parseReport', 'parsePbirReport', 'parseLegacyBookmarks', 'bookmarkState', 'buildMarkdownExport']);
const { tests, test } = suite();

// ── PBIR fixture: FHSQLMonitor's filter-panel pair ──────────────────────────────────────
const def = 'r.Report/definition', root = `${def}/pages`, pos = { x: 0, y: 0, width: 10, height: 10 };
const title = t => ({ title: [{ properties: { text: { expr: { Literal: { Value: `'${t}'` } } } } }] });
const bm = (name, displayName, groups, extra = {}) => ({ name, displayName,
  options: { applyOnlyToTargetVisuals: true, targetVisualNames: ['gOpen', 'gClosed', 'v1', 'v2'], suppressData: true, ...extra },
  explorationState: { activeSection: 'p1', sections: { p1: {
    visualContainers: { v1: { singleVisual: {} }, v2: { singleVisual: {} }, v3: { singleVisual: {} } },
    visualContainerGroups: groups } } } });
const pbirFiles = {
  [`${root}/pages.json`]: { pageOrder: ['p1'] },
  [`${root}/p1/page.json`]: { name: 'p1', displayName: 'Stored procedures', width: 1920, height: 1080 },
  [`${root}/p1/visuals/gOpen/visual.json`]: { name: 'gOpen', position: pos, isHidden: true, visualGroup: { displayName: 'Filter panel opened' } },
  [`${root}/p1/visuals/gClosed/visual.json`]: { name: 'gClosed', position: pos, visualGroup: { displayName: 'Filter panel closed' } },
  [`${root}/p1/visuals/v1/visual.json`]: { name: 'v1', position: pos, parentGroupName: 'gOpen', visual: { visualType: 'slicer', visualContainerObjects: title('Year Slicer') } },
  [`${root}/p1/visuals/v2/visual.json`]: { name: 'v2', position: pos, parentGroupName: 'gClosed', visual: { visualType: 'actionButton', visualContainerObjects: title('Open filter Button') } },
  [`${root}/p1/visuals/v3/visual.json`]: { name: 'v3', position: pos, visual: { visualType: 'tableEx', visualContainerObjects: title('Info Table') } },
  [`${def}/bookmarks/bookmarks.json`]: { items: [{ name: 'f1', displayName: 'Stored procedures', children: ['bmClose', 'bmOpen'] }] },
  [`${def}/bookmarks/bmOpen.bookmark.json`]: bm('bmOpen', 'Filter panel opened', { gOpen: { isHidden: false }, gClosed: { isHidden: true } }),
  [`${def}/bookmarks/bmClose.bookmark.json`]: bm('bmClose', 'Filter panel closed', { gOpen: { isHidden: true }, gClosed: { isHidden: false } }),
};
const toByPath = files => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { text: async () => JSON.stringify(v) }]));

test('PBIR: bookmarks normalised, in bookmarks.json order, with folder', async () => {
  const { bookmarks } = await X.parsePbirReport(toByPath(pbirFiles), root);
  if (!bookmarks) throw new Error('parsePbirReport returned no bookmarks');
  eq(bookmarks.map(b => [b.id, b.name, b.folder, b.page, b.display, b.data]),
    [['bmClose', 'Filter panel closed', 'Stored procedures', 'p1', true, false],
     ['bmOpen', 'Filter panel opened', 'Stored procedures', 'p1', true, false]], 'bookmarks');
  eq(bookmarks[1].targets, ['gOpen', 'gClosed', 'v1', 'v2'], 'targets');
  eq(bookmarks[1].groups, { gOpen: 'shown', gClosed: 'hidden' }, 'group states');
  eq(bookmarks[1].visuals, { v1: 'shown', v2: 'shown', v3: 'shown' }, 'visual states');
});

test('state per bookmark: shown / hidden / via group / untouched (FHSQLMonitor pair)', async () => {
  const S = defined(X.bookmarkState, 'bookmarkState');
  const { pages: [p], bookmarks: [close, open] } = await X.parsePbirReport(toByPath(pbirFiles), root);
  const groupsById = new Map(p.groups.map(g => [g.id, g]));
  const row = (it, isGroup) => [S(open, it, isGroup, groupsById), S(close, it, isGroup, groupsById)];
  const g = id => p.groups.find(x => x.id === id), v = id => p.visuals.find(x => x.id === id);
  eq(row(g('gOpen'), true), ['shown', 'hidden'], 'gOpen');
  eq(row(g('gClosed'), true), ['hidden', 'shown'], 'gClosed');
  eq(row(v('v1'), false), ['shown', 'via group'], 'v1 in gOpen');
  eq(row(v('v2'), false), ['via group', 'shown'], 'v2 in gClosed');
  eq(row(v('v3'), false), ['', ''], 'v3 not targeted');
});

test('state: display not captured, or outside "selected visuals", means untouched', () => {
  const S = defined(X.bookmarkState, 'bookmarkState');
  const groupsById = new Map();
  const v = { id: 'v1', parentGroup: '', isHidden: false };
  eq(S({ display: false, targets: null, visuals: { v1: 'hidden' }, groups: {} }, v, false, groupsById), '', 'suppressDisplay');
  eq(S({ display: true, targets: ['other'], visuals: { v1: 'hidden' }, groups: {} }, v, false, groupsById), '', 'not a target');
  eq(S({ display: true, targets: null, visuals: {}, groups: {} }, v, false, groupsById), '', 'not captured (added later)');
  eq(S({ display: true, targets: null, visuals: { v1: 'hidden' }, groups: {} }, v, false, groupsById), 'hidden', 'hidden');
});

test('state: shown by the bookmark but inside a group that stays hidden reads "via group"', () => {
  const groupsById = new Map([['g', { id: 'g', parentGroup: '', isHidden: true }]]);
  const v = { id: 'v1', parentGroup: 'g', isHidden: false };
  eq(defined(X.bookmarkState, 'bookmarkState')({ display: true, targets: null, visuals: { v1: 'shown' }, groups: {} }, v, false, groupsById), 'via group', 'state');
});

// ── Legacy fixture: comodu20 / Pensadero ──────────────────────────────────────────────
const vc = cfg => ({ config: JSON.stringify(cfg), x: 0, y: 0, z: 0, width: 10, height: 10 });
const legacyBm = (name, displayName, sec, options = { targetVisualNames: [], suppressData: true }) =>
  ({ name, displayName, options, explorationState: { activeSection: 'ReportSectionA', sections: { ReportSectionA: sec } } });
const legacyText = JSON.stringify({
  config: JSON.stringify({ bookmarks: [
    { displayName: 'Panels', name: 'fold1', children: [
      legacyBm('bmShow', 'Show filter pane', { visualContainers: { s1: { singleVisual: {} }, c1: { singleVisual: {} } }, visualContainerGroups: { g1: { isHidden: false } } }),
      legacyBm('bmHide', 'Hide filter pane', { visualContainers: { s1: { singleVisual: { display: { mode: 'hidden' } } }, c1: { singleVisual: {} } }, visualContainerGroups: { g1: { isHidden: true } } }),
    ] },
    legacyBm('bmNested', 'Casos Confirmados', { visualContainers: {}, visualContainerGroups: { g1: { isHidden: false, children: { g2: { isHidden: true } } } } },
      { targetVisualNames: [], suppressData: true, suppressActiveSection: true, applyOnlyToTargetVisuals: false }),
    legacyBm('bmGone', 'Deleted page bookmark', { visualContainers: {} }),
  ] }),
  sections: [{ name: 'ReportSectionA', displayName: 'Reviews', width: 1280, height: 720, config: '{}', visualContainers: [
    vc({ name: 'g1', singleVisualGroup: { displayName: 'Slicers base', isHidden: true } }),
    vc({ name: 'g2', parentGroupName: 'g1', singleVisualGroup: { displayName: 'Search' } }),
    vc({ name: 's1', parentGroupName: 'g1', singleVisual: { visualType: 'slicer', vcObjects: { title: [{ properties: { text: { expr: { Literal: { Value: "'Review status'" } } } } }] } } }),
    vc({ name: 'c1', singleVisual: { visualType: 'card', projections: { Values: [{ queryRef: 'Sales.Total' }] } } }),
  ] }],
});

test('legacy: folders flattened, nested group states flattened, page per bookmark', () => {
  const list = defined(X.parseLegacyBookmarks, 'parseLegacyBookmarks')(legacyText);
  eq(list.map(b => [b.id, b.name, b.folder, b.page]), [
    ['bmShow', 'Show filter pane', 'Panels', 'ReportSectionA'], ['bmHide', 'Hide filter pane', 'Panels', 'ReportSectionA'],
    ['bmNested', 'Casos Confirmados', '', 'ReportSectionA'], ['bmGone', 'Deleted page bookmark', '', 'ReportSectionA'],
  ], 'bookmarks');
  eq(list[1].visuals, { s1: 'hidden', c1: 'shown' }, 'bmHide visuals');
  eq(list[2].groups, { g1: 'shown', g2: 'hidden' }, 'nested group states');
  eq([list[2].targets, list[2].display, list[2].data], [null, true, false], 'bmNested scope');
});

// ── Export ────────────────────────────────────────────────────────────────────────────
const exportPages = (pages, bookmarks) => {
  Object.assign(X.App.state, { projectName: 'T', tables: [], sources: [], relationships: [], modelAnnotations: {}, pages, bookmarks });
  return defined(X.buildMarkdownExport, 'buildMarkdownExport')({ pages: true });
};

test('export: bookmark table + visibility matrix (FHSQLMonitor pair)', async () => {
  const { pages, bookmarks } = await X.parsePbirReport(toByPath(pbirFiles), root);
  const md = exportPages(pages, bookmarks || []);
  has(md, '#### Bookmarks');
  has(md, '| Bookmark | ID | Folder | Applies to | Captures |');
  has(md, '| Filter panel opened | `bmOpen` | Stored procedures | 4 selected visuals | display |');
  has(md, '| Visual ID | Type | Title | Group | Default | Filter panel closed | Filter panel opened |');
  has(md, '| `gOpen` | group | Filter panel opened |  | hidden | hidden | shown |');
  has(md, '| `gClosed` | group | Filter panel closed |  | shown | shown | hidden |');
  has(md, '| `v1` | slicer | Year Slicer | Filter panel opened | via group | via group | shown |');
  has(md, '| `v2` | actionButton | Open filter Button | Filter panel closed | shown | shown | via group |');
  has(md, '| `v3` | tableEx | Info Table |  |  | — |');        // still in the page's visual table…
  hasNot(md, '| `v3` | tableEx | Info Table |  | shown |');     // …but untouched, so counted, not in the matrix
  has(md, "_1 other visual isn't changed by any bookmark on this page._");
});

test('export: more than 6 bookmarks on a page switches to a list per bookmark', async () => {
  const files = { ...pbirFiles };
  delete files[`${def}/bookmarks/bookmarks.json`];
  for (let i = 1; i <= 7; i++) files[`${def}/bookmarks/b${i}.bookmark.json`] = bm(`b${i}`, `Chart ${i}`, {}, { applyOnlyToTargetVisuals: false });
  const { pages, bookmarks } = await X.parsePbirReport(toByPath(files), root);
  const md = exportPages(pages, bookmarks || []);
  hasNot(md, '| Default |');
  // v1 sits in gOpen, hidden by default and untouched by these bookmarks, so it stays hidden.
  // v3 is shown by default and by every bookmark: nothing changes it, so it isn't listed.
  has(md, '- **Chart 1** `b1` — shows: Open filter Button (`v2`); hidden via group: Year Slicer (`v1`)');
  has(md, "_1 other visual isn't changed by any bookmark on this page._");
});

test('export: a visual captured as shown by every bookmark, and shown by default, is not listed', async () => {
  const files = { ...pbirFiles };
  for (const k of ['bmOpen', 'bmClose']) {      // both bookmarks now target v3 too — same state as its default
    const b = JSON.parse(JSON.stringify(files[`${def}/bookmarks/${k}.bookmark.json`]));
    b.options.targetVisualNames.push('v3');
    files[`${def}/bookmarks/${k}.bookmark.json`] = b;
  }
  const { pages, bookmarks } = await X.parsePbirReport(toByPath(files), root);
  const md = exportPages(pages, bookmarks);
  hasNot(md, '| `v3` | tableEx | Info Table |  | shown |');
  has(md, "_1 other visual isn't changed by any bookmark on this page._");
});

test('export: legacy bookmarks, and ones whose page no longer exists', () => {
  const pages = X.parseReport(legacyText);
  const bookmarks = defined(X.parseLegacyBookmarks, 'parseLegacyBookmarks')(legacyText);
  bookmarks[3].page = 'ReportSectionGone';
  const md = exportPages(pages, bookmarks);
  has(md, '| Hide filter pane | `bmHide` | Panels | all visuals | display |');
  has(md, '| `s1` | slicer | Review status | Slicers base | via group | shown | hidden | — |');
  has(md, '### Bookmarks without a matching page');
  has(md, '| Deleted page bookmark | `bmGone` |');
});

module.exports = tests;
