// HTML escaping. A PBIP is someone else's files, and this page promises that dropping one in is
// safe, so file text that reaches the page through innerHTML — element content or an attribute
// value — must come out inert, and attribute values must survive intact. The fixtures are hostile
// on purpose: a crafted model.bim can put any string where Power BI would only ever write a word
// or a number.
'use strict';
const { loadApp, eq, has, hasNot, defined, suite } = require('./harness');
const X = loadApp(['App', 'esc', 'highlightSql', 'parseTmslModel', 'renderTables', 'visualRowHtml'], { dom: true });
const { tests, test } = suite();

test("esc() escapes & < > \" ' — safe in element text and in either kind of quoted attribute", () => {
  eq(defined(X.esc, 'esc')(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f', 'esc');
  eq([X.esc(null), X.esc(undefined), X.esc(42)], ['', '', '42'], 'non-strings');
});

test('highlightSql still colours strings, comments and keywords, with the quotes escaped', () => {
  const html = defined(X.highlightSql, 'highlightSql')(`SELECT "OrderId", 'it''s' FROM "DB"."ORDERS" -- open "ones"`);
  has(html, '<span style="color:#0033b3;font-weight:600">SELECT</span>');
  has(html, '<span style="color:#22863a">&#39;it&#39;</span>');
  has(html, '&quot;OrderId&quot;');
  has(html, '<span style="color:#6a737d;font-style:italic">-- open &quot;ones&quot;</span>');
});

// A crafted model.bim: every one of these strings lands somewhere in the Tables view.
const bim = { model: { tables: [
  { name: 'Orders" onmouseover="alert(1)',
    columns: [{ name: 'OrderId', dataType: 'int64', sourceColumn: 'OrderId' }],
    partitions: [{ name: 'p', mode: '<img src=x onerror=alert(1)>', source: { type: 'm', expression: [
      'let',
      '    Source = Value.NativeQuery(Snowflake.Databases("acme.snowflakecomputing.com"){[Name="DB"]}[Data], "SELECT ""OrderId"" FROM ""DB"".""ORDERS"" WHERE STATUS = \'open\'")',
      'in',
      '    Source',
    ] } }] },
  { name: 'Time Intelligence',
    calculationGroup: { precedence: '<b>9</b>', calculationItems: [{ name: 'YTD', expression: 'SELECTEDMEASURE()', ordinal: '<i>2</i>' }] },
    columns: [{ name: 'Name', dataType: 'string', sourceColumn: 'Name' }],
    partitions: [{ name: 'cg', mode: 'import', source: { type: 'calculationGroup' } }] },
] } };

/* Render the Tables view with `name` selected; returns the table list's and the detail pane's HTML. */
function renderTable(name) {
  const { tables } = defined(X.parseTmslModel, 'parseTmslModel')(bim);
  const detail = X.element();
  X.document.getElementById = id => (id === 'tableDetail' ? detail : null);
  Object.assign(X.App.state, { tables, relationships: [], expressions: {}, sources: [], usage: { byKey: {} }, activeTable: name, showHidden: true });
  defined(X.renderTables, 'renderTables')();
  return { list: X.App.els.tablesContent.innerHTML, detail: detail.innerHTML };
}

test('the SQL "Copy" button carries the whole query, quotes included (Snowflake native query)', () => {
  has(renderTable('Orders" onmouseover="alert(1)').detail,
    'data-copy-sql="SELECT &quot;OrderId&quot; FROM &quot;DB&quot;.&quot;ORDERS&quot; WHERE STATUS = &#39;open&#39;"');
});

test("a table name can't break out of its attributes", () => {
  const { list } = renderTable('Orders" onmouseover="alert(1)');
  has(list, 'data-name="Orders&quot; onmouseover=&quot;alert(1)"');
  hasNot(list, '" onmouseover=');   // a raw quote before it = the attribute was closed and a new one opened
});

test('TMSL mode, precedence and ordinal render as text, not markup', () => {
  const orders = renderTable('Orders" onmouseover="alert(1)').detail;
  hasNot(orders, '<img src=x');
  has(orders, '&lt;img src=x onerror=alert(1)&gt;');
  const cg = renderTable('Time Intelligence').detail;
  hasNot(cg, '<b>9</b>');
  has(cg, '&lt;b&gt;9&lt;/b&gt;');
  hasNot(cg, '<i>2</i>');
  has(cg, '&lt;i&gt;2&lt;/i&gt;');
});

test("a visual's tabOrder can't break out of its tooltip attribute", () => {
  const html = defined(X.visualRowHtml, 'visualRowHtml')({ id: 'v1', type: 'card', fields: [], x: 0, y: 0, z: 0, width: 1, height: 1,
    tabOrder: '" onmouseover="alert(1)', parentGroup: '', isHidden: false, title: 'T', titleExpr: '', text: '' }, new Map(), '');
  hasNot(html, '" onmouseover=');
});

module.exports = tests;
