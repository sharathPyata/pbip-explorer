// Shared expressions (expressions.tmdl): an expression's M ends where its own properties begin. TMDL
// writes a multi-line body two tabs in and the expression's lineageTag:, queryGroup: and annotations
// one tab in, so reading on to the next unindented line took them in as M. Shapes from
// RuiRomano/powerbi-agentic-apm-demo (a text parameter feeding Web.Contents), microsoft/fabric-toolbox's
// FCA model (a query) and microsoft/Analysis-Services' SamplePBIP (a queryGroup; a /// description
// right after the previous expression's properties).
'use strict';
const { loadApp, fileList, eq, has, hasNot, suite } = require('./harness');
const { tests, test } = suite();

const CSV_LOCATION = '"https://raw.githubusercontent.com/pbi-tools/sales-sample/data/" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]';
const DATABASE_QUERY = ['\t\tlet', '\t\t    database = Sql.Database("contoso.datawarehouse.fabric.microsoft.com", "Usage")', '\t\tin', '\t\t    database'];
const ENVIRONMENT = '"TST" meta [IsParameterQuery=true, List={"DEV", "QUAL", "PRD"}, DefaultValue="DEV", Type="Text", IsParameterQueryRequired=true]';
const EXPRESSIONS = [
  `expression CSV_Location = ${CSV_LOCATION}`,
  '\tlineageTag: 39c7bef4-452b-4b29-846c-f788ef1af01f', '',
  '\tannotation PBI_ResultType = Text', '',
  'expression DatabaseQuery =', ...DATABASE_QUERY,
  '\tlineageTag: 6f9c0e56-0423-41ca-962c-a4da53edf504',
  "\tqueryGroup: 'Raw Data'", '',
  '\tannotation PBI_IncludeFutureArtifacts = False', '',
  '/// Dummy parameter to simulate data from different servers',
  `expression Environment = ${ENVIRONMENT}`,
  '\tlineageTag: 64edd943-1a90-4438-b62f-bb95a9da1510', '',
  '\tannotation PBI_ResultType = Text', '', '',
].join('\n');

const m = (name, lines) => [`table ${name}`, '\tcolumn Id', '\t\tdataType: int64', '\t\tsourceColumn: Id',
  `\tpartition ${name} = m`, '\t\tmode: import', '\t\tsource =', ...lines.map(l => '\t\t\t\t' + l)].join('\n');
const project = {
  'P.SemanticModel/definition/model.tmdl': 'model Model\n\tculture: en-US\n',
  'P.SemanticModel/definition/expressions.tmdl': EXPRESSIONS,
  'P.SemanticModel/definition/tables/Customer.tmdl': m('Customer', ['let',
    '    Source = Csv.Document(Web.Contents(CSV_Location, [RelativePath = "RAW-Customer.csv"]),[Delimiter=",", Encoding=65001])',
    'in', '    Source']),
  'P.SemanticModel/definition/tables/Capacity.tmdl': m('Capacity', ['let', '    Source = DatabaseQuery,',
    '    Capacity = Source{[Schema="dbo",Item="Capacity"]}[Data]', 'in', '    Capacity']),
};

test("an expression's M stops at its own lineageTag, queryGroup and annotations", () => {
  const { parseExpressions } = loadApp(['parseExpressions']);
  const ex = parseExpressions(EXPRESSIONS);
  eq(Object.entries(ex).map(([name, e]) => [name, e.sourceM, e.description]), [
    ['CSV_Location', CSV_LOCATION, ''],
    ['DatabaseQuery', DATABASE_QUERY.join('\n'), ''],
    ['Environment', ENVIRONMENT, 'Dummy parameter to simulate data from different servers'],
  ], 'expressions');
});

test('parameters still feed their connectors; the Sources tab and the export show only the M', async () => {
  const app = loadApp(['App', 'processFiles', 'renderSources', 'buildMarkdownExport', 'esc'], { dom: true });
  await app.processFiles(fileList(project));
  const s = app.App.state;
  eq(s.sources.map(src => [src.type, src.server, src.queries, src.expressions.map(e => e.name)]), [
    ['sql-server', 'contoso.datawarehouse.fabric.microsoft.com / Usage', ['Capacity'], ['DatabaseQuery']],
    ['api', 'https://raw.githubusercontent.com/pbi-tools/sales-sample/data/', ['Customer'], []],
  ], 'sources');
  app.renderSources();
  const html = app.App.els.sourcesContent.innerHTML;
  has(html, `<pre class="m-code" style="margin:0 12px 10px">${app.esc(DATABASE_QUERY.join('\n'))}</pre>`);
  const md = app.buildMarkdownExport(s.exportOpts);
  const sources = md.slice(md.indexOf('## Data sources'), md.indexOf('## Tables'));
  has(sources, '**Expression: DatabaseQuery**\n\n```m\nlet\n');
  has(sources, '\t\t    database\n```');   // the block closes right after the M
  for (const text of [html, sources]) for (const prop of ['lineageTag', 'queryGroup', 'annotation']) hasNot(text, prop);
});

module.exports = tests;
