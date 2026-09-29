# PBIP Explorer

A self-contained HTML **viewer, explorer, and analyzer** for **Power BI Project (PBIP)** folders. Drop a PBIP folder into the browser and the tool parses TMDL, reads DAX, explores M code, draws relationships, and flags unused fields — all locally, no upload.

**No network calls. No uploads. No backend.** Open the HTML file, drop your folder, and inspect.

🔗 **[Try it live](https://sharathpyata.github.io/pbip-explorer/)** — no install needed. Your PBIP never leaves your browser.

---

## Screenshots

<table>
<tr>
<td width="50%" align="center">
<b>Drag-and-drop home</b><br>
<img src="screenshots/DefaultHome.png" alt="Empty state — drop a PBIP folder">
</td>
<td width="50%" align="center">
<b>Overview</b><br>
<img src="screenshots/Overview.png" alt="Overview tab — tiles, model metadata, sources">
</td>
</tr>
<tr>
<td width="50%" align="center">
<b>Sources</b><br>
<img src="screenshots/Sources.png" alt="Sources tab — grouped by host">
</td>
<td width="50%" align="center">
<b>Tables</b><br>
<img src="screenshots/Tables.png" alt="Tables tab — master-detail browser, grouped by source">
</td>
</tr>
<tr>
<td width="50%" align="center">
<b>Measures</b><br>
<img src="screenshots/Measures.png" alt="Measures tab — searchable DAX">
</td>
<td width="50%" align="center">
<b>Relationships</b><br>
<img src="screenshots/Relationships.png" alt="Relationships tab — force-directed graph">
</td>
</tr>
<tr>
<td width="50%" align="center">
<b>Pages</b><br>
<img src="screenshots/Pages.png" alt="Pages tab — visuals + field/measure search">
</td>
<td width="50%" align="center">
<b>Unused</b><br>
<img src="screenshots/Unused.png" alt="Unused tab — columns and measures with no references">
</td>
</tr>
<tr>
<td align="center" colspan="2">
<b>Notes</b><br>
<img src="screenshots/Notes.png" alt="Notes tab — self-documenting reference" width="50%">
</td>
</tr>
</table>

*(Screenshots use Microsoft's public AdventureWorks PBIP sample.)*

---

## Quick start

1. Open `pbip-explorer.html` in a modern browser (Chrome / Edge 113+, Firefox 113+, or Safari 16.4+).
2. **Drag** a PBIP folder into the page, or click **Pick a folder** and select one.
3. Click through the tabs at the top.

The file can be opened directly from disk — no web server required.

---

## What's a PBIP folder?

In Power BI Desktop, **File → Save As → Power BI Project (folder)** saves the report as a directory tree:

```
My report/
├── My report.SemanticModel/
│   └── definition/
│       ├── model.tmdl
│       ├── expressions.tmdl
│       ├── relationships.tmdl
│       └── tables/
│           └── *.tmdl
└── My report.Report/
    └── report.json
```

PBIP Explorer reads **both** semantic-model formats. TMDL (`.SemanticModel/definition/*.tmdl`, a folder of text files) and TMSL (`.SemanticModel/model.bim`, a single JSON file) are auto-detected — TMDL is still a Power BI Desktop preview option, so plenty of projects are saved as TMSL, and both load identically. Both report formats are auto-detected: the legacy single `.Report/report.json` and the newer **PBIR** per-file format (`.Report/definition/pages/[pageName]/visuals/[visualName]/visual.json`) introduced in 2026.

You can drop a folder holding **several projects**. Models and reports are found by their files rather than their folder names, so `X.Dataset` (older projects, still used by e.g. microsoft/finops-toolkit) and suffix-less folders from Fabric Git work too. Each report is paired with the model its `definition.pbir` names: a folder (`byPath`), or for a live connection (`byConnection`, which Fabric Git writes even when the model is in the same export) the model here whose name matches the connection's. One project opens straight away; with several you pick which, and a model shared by several reports can open with **all of them** — their pages side by side, and a field counts as used if any report uses it.

A report whose model isn't there — live-connected to a model in the Power BI service, or dropped without its model folder — opens **on its own**: pages, visuals, bookmarks and report-level measures, with the model tabs saying where the model is, and **Fields used** in place of Unused: every model field the report depends on, which is what the model's owner must keep.

---

## Views

| Tab | What it shows |
|---|---|
| **Overview** | Big-number tiles, model metadata (PBI version, time-intelligence settings), security roles (and the tables each filters), perspectives, DAX functions, table-kind breakdown, data-source summary |
| **Sources** | Grouped data sources (Snowflake, SQL Server, Dataverse, SharePoint, Excel, OData, Web…). Multiple expressions hitting the same host collapse into one card, each listing its shared expressions and the tables that pull from it. Below the cards, the model's Power Query parameters (including those loaded as tables): type, value and suggested values, description, and the tables that use each one — directly or through other queries |
| **Tables** | Master/detail browser. Left rail lists tables; right pane shows columns, measures grouped by display folder, calculation items, hierarchies, calendars, the security roles that filter the table (with their DAX) and the perspectives that include it, relationships, partition M code, inline data, extracted SQL, and annotations |
| **Measures** | Flat searchable list of all DAX measures, grouped by table and display folder, with full DAX — then the model's DAX user-defined functions, with their descriptions |
| **Relationships** | Force-directed graph. Pan, zoom, drag, hover-to-highlight; arrow markers; dashed lines for bidirectional cross-filter, dotted for inactive relationships |
| **Pages** | Master/detail like Tables. "📑 All Pages" shows the stacked list of every page; selecting a specific page shows just that page's visuals. Hidden, drillthrough and tooltip pages are marked; each visual shows its title (or its textbox text, or an auto label from its fields), whether it's hidden — itself or through its group — and its group; hover for its ID. On a page with bookmarks, pick one to preview what it shows or hides. A search box at the top filters by field or measure name (e.g. `Sales.Amount`, `Profit`) and highlights matches inline |
| **Unused** | Columns and measures with no references in visuals, filters, DAX, or M code. Toggle to also show "structural-only" items (referenced only by relationships / sortBy / hierarchies). For a report opened without its model it becomes **Fields used**: each model field the report needs, and what uses it (visuals, filters and bookmarks, report-level measures) |
| **Notes** | Self-documenting reference describing exactly what the parser supports. Open even without loading a folder to read it |
| **Export** | Generates a single Markdown document of the whole model — paste it into an AI chat as context, share it, or copy all measures at once. Section toggles + presets (Everything / Measures only / Schema only / AI prompt), with copy-to-clipboard and download-`.md` buttons. Parameters (value, suggested values, and the tables and queries that use each), security roles (each table filter's DAX), DAX functions and perspectives get sections of their own. Report pages list page IDs, hidden / drillthrough / tooltip flags, and a row per visual and group with its ID, title, hidden state and group — the IDs bookmark files use. Each page with bookmarks also gets a matrix of what every bookmark shows or hides (shown / hidden / via group / — for untouched) |

---

## What's parsed

| Layer | Detail |
|---|---|
| **TMSL** (`model.bim`) | The same object tree as TMDL, in JSON — tables, columns, measures, partitions, hierarchies, calculation groups, relationships, shared expressions, roles, perspectives, data sources and functions. Converted to identical internal state, so every tab behaves the same. The implicit TOM `RowNumber` column is skipped, and `string \| string[]` text properties are joined. |
| **TMDL** | Model annotations, tables, columns (data types, format strings, sort-by, lineage tags), measures (DAX, single-line / triple-backtick / indented, plus a dynamic format string, KPI target / status / trend and detail rows), calculated columns, hierarchies, calendars (calendar-based time intelligence: each category's primary and associated columns, and time-related columns), calculation groups (with precedence and items), partitions (Power Query M / calculated / calculation-group), table relationships (active or not) |
| **M (Power Query)** | Connector patterns, inline data (`Table.FromRecords`, `Table.FromRows`, base64+deflate-compressed inline data), generated tables such as Microsoft's `List.Dates` date table (shown as Computed, not inline data), SQL extracted from native queries, all M string escape sequences (`#(lf)`, `#(cr)`, `#(2605)`, etc.) |
| **Report JSON** | Pages, visuals, field bindings (structured `Column` / `Measure` / `Hierarchy` / `HierarchyLevel` refs, and `queryRef` — a stale `queryRef`, left behind when a measure is renamed or moved, gives way to the field actually bound), visual positions and z-order, filter references, conditional formatting refs. Page visibility and kind (drillthrough / tooltip); visual IDs, hidden state, titles (constant or measure-driven), textbox text; visual groups and membership — in both the legacy and PBIR formats |
| **Report extras** | `report.json` report-level filters, `reportExtensions.json` report-level measures (name, DAX, table), `bookmarks/*.bookmark.json` captured filter state and per-bookmark show/hide (visuals and groups, respecting "selected visuals" and "Display"); in legacy reports, bookmarks from `report.json`'s `config.bookmarks` and report-level measures from its `config.modelExtensions`. `definition.pbir`'s live connection: workspace, model and semantic model ID |
| **Security & curation** | `roles/*.tmdl` RLS roles (`modelPermission`, `tablePermission` filter DAX), `perspectives/*.tmdl` membership — both shown, and both count toward usage |
| **DAX functions** | `functions.tmdl` user-defined functions and their `///` descriptions — listed in the Measures tab and the export; the body's column/measure references count as usage |
| **Declared sources** | `dataSources.tmdl` explicit provider data sources, with host/database pulled from the connection string |

---

## Data sources detected

| Connector | M pattern |
|---|---|
| SQL Server | `Sql.Database` |
| Oracle | `Oracle.Database` |
| Snowflake | `Snowflake.Databases` |
| Dataverse | `CommonDataService.Database` / `Cds.Contents` / `Dataverse.*` |
| SharePoint | `SharePoint.Files` / `SharePoint.Tables` / `SharePoint.Lists` |
| Excel | `Excel.Workbook(File.Contents(...))` |
| Web / API | `Web.Contents` / `Json.Document` / `OData.Feed` |
| Analysis Services / Power BI model | `AnalysisServices.Databases` / `PowerBI.Datasets` — a live connection to another semantic model |
| Inline | `Table.FromRecords` / `Table.FromRows` (incl. base64+deflate compressed) |
| Computed | `#table` / `Table.FromValue` / `List.Numbers` — no external source at all |

Multiple expressions pointing to the same host collapse into one source card.

---

## Unused-detection

The **Unused** tab classifies each column / measure into:

- **Used** — referenced by a visual binding, filter, DAX expression, or M code of a used table; by a **row-level-security filter**; by a **report-level measure**; by a **bookmark's** captured state; by a **calculation item** (expression or format string) of a calculation group in use; by a used measure's **dynamic format string, KPI or detail-rows** DAX; by a **calendar** that a used DAX expression names (`TOTALYTD([Sales], 'Fiscal')` uses every column the calendar tags); or by a **DAX user-defined function** body
- **Structural only** — referenced only by relationships, `sortByColumn`, hierarchy levels, a **calendar** nothing names, or **perspective membership** (usually safe to keep)
- **Unused** — no references anywhere

Detection is regex-based and errs on the safe side: if a column name appears in an unrelated string literal, it'll be counted as used. A column referenced without its table — `[Qty] * [Price]` in a calculated column, `[Country] = "Canada"` in an RLS filter — is matched to the expression's own table or a table it names, and to every column of that name when neither has it. Names match in any case, as DAX matches them: `'Time intelligence'[Show as]` is the table `'Time Intelligence'`.

---

## Privacy & security

- **Local-only.** All parsing happens in your browser via the File API. No requests are made to any server.
- **No telemetry.** No analytics, no ping, nothing phones home.
- **No external dependencies.** Everything is embedded inline — D3.js (for the relationships graph), both webfonts (base64 WOFF2), all CSS, all JS. Nothing is fetched from a CDN or from Google Fonts, so the page loads and renders identically on an air-gapped machine.
- **Open directly from disk.** No web server required; double-click works.

This means you can drop a PBIP that contains internal SQL, schema names, or sensitive data into the page without worrying about anything leaving your machine.

---

## Browser requirements

- A modern Chromium-based browser (Chrome / Edge 113+), Firefox 113+, or Safari 16.4+
- The compressed-inline-data decoder uses the `DecompressionStream` API, which requires the versions above. Everything else works in slightly older browsers
- Folder drop & picker rely on `webkitGetAsEntry()` and `<input type="file" webkitdirectory>` — supported in all modern browsers

---

## Known limitations

- **`cultures/*.tmdl` (Q&A linguistic schema) is deliberately not counted as usage.** Power BI auto-generates a synonym entity for every table and every column, so treating the linguistic schema as a reference would mark the entire model "used" and render the Unused tab meaningless. This is an intentional exclusion, not a gap.
- **Translations and cultures** are present in TMDL but not surfaced.
- **GroupRef (binning) and RoleRef (RLS)** are not specifically handled.
- **Object-level security** (a role's `metadataPermission` / `columnPermission`) isn't read, and a role's members aren't shown — only its model permission and row filters.

---

## Tips

- The **Notes** tab is accessible without loading a folder — read it to see the parser's full feature list.
- In **Tables**, related-table chips at the bottom of a table's detail jump to that table without losing your sidebar scroll position.
- In **Pages → All Pages**, click any page name to drill into just that page's view. The search box at the top works in both All Pages and single-page views.
- The relationships graph supports **drag** (reposition a node), **scroll** (zoom), **hover** (highlight), and the **Fit** button (reset zoom).
- Hidden tables (auto-date tables, `isHidden` flags) are filtered out by default to match Power BI Desktop's Fields pane. Toggle **Show N hidden** in the header to see them.

---

## Tests

The parsers, usage analysis and export have a test suite that needs nothing but Node — no `npm install` (tested with Node 20):

```bash
node tests/run.js
```

It loads the app's own `<script>` from `pbip-explorer.html` into Node and runs every `tests/*.test.js`: the Unused-tab reference rules, report pages / visuals / bookmarks in both report formats, and a small project loaded end to end in both model formats. Fixtures mirror real PBIP files.

To check that a new test really fails without a fix, point the runner at an older copy of the page:

```bash
git show HEAD~1:pbip-explorer.html > /tmp/before.html && node tests/run.js /tmp/before.html
```

---

## Credits & licences

PBIP Explorer itself is MIT-licensed (see [LICENSE](LICENSE)). Three third-party assets are bundled inline:

| Asset | Used for | Licence |
|---|---|---|
| [D3](https://d3js.org/) v7 | Relationships force-directed graph | ISC |
| [Source Sans 3](https://github.com/adobe-fonts/source-sans) | UI typeface | [SIL OFL 1.1](https://scripts.sil.org/OFL) |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | Code / DAX / M typeface | [SIL OFL 1.1](https://scripts.sil.org/OFL) |

The fonts remain under the OFL; their copyright notices travel with the `@font-face` block at the top of the file's `<style>` element.

---

## Sharing

This is a single static HTML file. Email it, drop it on Slack, copy it to a USB stick — it works the same everywhere. The folder you drop in stays on your machine.
