// Shared expressions (expressions.tmdl): an expression's M ends where its own properties begin, and
// leaves out TMDL's ``` fence and indent. TMDL writes a multi-line body two tabs in and the
// expression's lineageTag:, queryGroup: and annotations one tab in, so reading on to the next
// unindented line took them in as M; a fenced body kept its ``` lines, which broke the export's
// ```m block. Shapes from RuiRomano/powerbi-agentic-apm-demo (a text parameter feeding Web.Contents),
// microsoft/fabric-toolbox's FCA model (a query), microsoft/Analysis-Services' SamplePBIP (a
// queryGroup; a /// description right after the previous expression's properties) and
// microsoft/finops-toolkit (a function TMDL fences because a line ends in a space).
'use strict';
const { loadApp, fileList, eq, has, hasNot, suite } = require('./harness');
const { tests, test } = suite();

const CSV_LOCATION = '"https://raw.githubusercontent.com/pbi-tools/sales-sample/data/" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]';
const DATABASE_QUERY = ['let', '    database = Sql.Database("contoso.datawarehouse.fabric.microsoft.com", "Usage")', 'in', '    database'];
const JULIAN_DATE = ['(InputDate) =>', 'let', '    StartDate = #date(1899, 12, 30),', '    NumberOfDays = Duration.Days(InputDate - StartDate),',
  '    JulianDay = NumberOfDays + 2415018.5 // 2415019 or 2415018.5 ', 'in', '    JulianDay'];
const ENVIRONMENT = '"TST" meta [IsParameterQuery=true, List={"DEV", "QUAL", "PRD"}, DefaultValue="DEV", Type="Text", IsParameterQueryRequired=true]';
const EXPRESSIONS = [
  `expression CSV_Location = ${CSV_LOCATION}`,
  '\tlineageTag: 39c7bef4-452b-4b29-846c-f788ef1af01f', '',
  '\tannotation PBI_ResultType = Text', '',
  'expression DatabaseQuery =', ...DATABASE_QUERY.map(l => '\t\t' + l),
  '\tlineageTag: 6f9c0e56-0423-41ca-962c-a4da53edf504',
  "\tqueryGroup: 'Raw Data'", '',
  '\tannotation PBI_IncludeFutureArtifacts = False', '',
  'expression ftk_DatetimeToJulianDate = ```', ...JULIAN_DATE.map(l => '\t\t' + l), '\t\t```',
  '\tlineageTag: 4b2bc0fe-5c3d-4275-ad19-3b4ff0b720e9',
  '\tqueryGroup: Functions', '',
  '\tannotation PBI_ResultType = Function', '',
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

test("an expression's M stops at its own properties and leaves out TMDL's fence and indent", () => {
  const { parseExpressions, parseTmslModel } = loadApp(['parseExpressions', 'parseTmslModel']);
  const ex = parseExpressions(EXPRESSIONS);
  eq(Object.entries(ex).map(([name, e]) => [name, e.sourceM, e.description]), [
    ['CSV_Location', CSV_LOCATION, ''],
    ['DatabaseQuery', DATABASE_QUERY.join('\n'), ''],
    ['ftk_DatetimeToJulianDate', JULIAN_DATE.join('\n'), ''],
    ['Environment', ENVIRONMENT, 'Dummy parameter to simulate data from different servers'],
  ], 'expressions');
  // The same M as model.bim holds it.
  const bim = parseTmslModel({ model: { expressions: [
    { name: 'DatabaseQuery', kind: 'm', expression: DATABASE_QUERY },
    { name: 'ftk_DatetimeToJulianDate', kind: 'm', expression: JULIAN_DATE }] } }).expressions;
  eq([bim.DatabaseQuery.sourceM, bim.ftk_DatetimeToJulianDate.sourceM], [ex.DatabaseQuery.sourceM, ex.ftk_DatetimeToJulianDate.sourceM], 'model.bim');
});

test('parameters still feed their connectors; the Sources tab and the export show only the M', async () => {
  const app = loadApp(['App', 'processFiles', 'renderSources', 'buildMarkdownExport', 'esc'], { dom: true });
  await app.processFiles(fileList(project));
  const s = app.App.state;
  eq(s.sources.map(src => [src.type, src.server, src.queries, src.expressions.map(e => e.name)]), [
    ['sql-server', 'contoso.datawarehouse.fabric.microsoft.com / Usage', ['Capacity'], ['DatabaseQuery']],
    ['other', '', [], ['ftk_DatetimeToJulianDate']],
    ['api', 'https://raw.githubusercontent.com/pbi-tools/sales-sample/data/', ['Customer'], []],
  ], 'sources');
  app.renderSources();
  const html = app.App.els.sourcesContent.innerHTML;
  for (const lines of [DATABASE_QUERY, JULIAN_DATE]) has(html, `<pre class="m-code" style="margin:0 12px 10px">${app.esc(lines.join('\n'))}</pre>`);
  const md = app.buildMarkdownExport(s.exportOpts);
  const sources = md.slice(md.indexOf('## Data sources'), md.indexOf('## Tables'));
  has(sources, `**Expression: DatabaseQuery**\n\n\`\`\`m\n${DATABASE_QUERY.join('\n')}\n\`\`\``);
  has(sources, `**Expression: ftk_DatetimeToJulianDate**\n\n\`\`\`m\n${JULIAN_DATE.join('\n')}\n\`\`\``);
  const fences = sources.split('\n').filter(l => l.startsWith('```'));
  eq(fences, fences.map((l, k) => (k % 2 ? '```' : '```m')), 'every ```m block closes once');
  hasNot(html, '```');
  for (const text of [html, sources]) for (const prop of ['lineageTag', 'queryGroup', 'annotation']) hasNot(text, prop);
});

module.exports = tests;
