# Measure lineage — instructions for the AI

You're completing a measure-lineage workbook for a Power BI semantic model. A script has already
read the model and done everything that can be done exactly. You answer the task files it left:
judgment calls about Power Query, SQL and DAX. A second script then builds the Excel workbook
from its facts and your answers.

Work only from what the task files contain. Never invent a table, column, server or schema name.
When the evidence doesn't settle something, say so in the answer (see `trace` below) rather than guess.

Rules version: 2. Each task records the version it was made under; when a rule below changes, the
version goes up and the next extraction asks every item again.

## The three steps

1. **Extract** (already run, or run it):

   ```bash
   node lineage/extract.js "<PBIP folder>"
   ```

   It writes `lineage-output/<project>/<Model>/`:
   - `model.json`: the model's facts, every column source the script traced itself and every measure
     it classified itself. Don't edit it.
   - `tasks/columns-NN.json`: columns the script couldn't trace to their source.
   - `tasks/measures-NN.json`: measures the script couldn't classify. It does the simple ones itself,
     by the rules below: one-column aggregations, `COUNTROWS`, `CALCULATE` with constant filters, and
     `IF` / `SWITCH` that test measures.
   - `answers/`: where your answers go. Answers from an earlier extraction stay there, and a measure or
     column whose input hasn't changed isn't asked again. New tasks are numbered after the answered ones.
     The `*.task.json` files there are the script's copies of the tasks those answers answered: leave them.

2. **Answer every task file.** For each `tasks/<name>.json`, write `answers/<name>.json`, following
   the two sections below. The files are independent: do them in any order. With many of them, give
   each to a separate subagent together with this file.
   - Every answer file starts with the task's `task` and `run` values, copied exactly.
   - Each task file has its own `run`, a fingerprint of its content. An answer whose `run` differs from its task's is ignored as stale.

3. **Build the workbook:**

   ```bash
   node lineage/build-excel.js lineage-output/<project>/<Model>
   ```

   It writes `<Model>-lineage.xlsx` and lists problems it found: missing answers, fields that aren't
   in the model, and source names that don't appear in the model's queries. Fix your answers and run
   it again until only genuinely untraceable items remain.

## columns-NN.json: trace each column to its physical source

The task lists tables. Each table gives its evidence and the columns to trace:

| Key | What it holds |
|---|---|
| `query` | The table's Power Query (M), with text parameter values already filled in. |
| `queries` | The shared queries and other tables' queries it reads, by name. |
| `dax` | A calculated table's DAX. |
| `partition` | A legacy query partition, e.g. `SELECT * FROM [Casos]`. |
| `detected` | The source PBIP Explorer detected for the table. |
| `columns` | For each column: its model name `column`, the query column behind it `sourceColumn`, and `stoppedAt`, where the script stopped following it. Pick up from there. |

The **physical source** is where the value is read from outside the model:
- **Database, lakehouse or warehouse column:** `connector` (e.g. `sql-server`, `oracle`, `snowflake`), `system` (`server / database`), `schema`, `table` and `column`.
- **File column:** `system` is the folder or URL, `table` is the file name (add ` › Sheet` for Excel), and `column` is the header text.

Write one entry per column:

```json
{
  "task": "columns-01",
  "run": "<copied from the task>",
  "columns": [
    {
      "column": "Sales[Quantity]",
      "sources": [
        { "connector": "file", "system": "https://raw.githubusercontent.com/pbi-tools/sales-sample/data/",
          "schema": "", "table": "RAW-Sales.csv", "column": "Quantity" }
      ],
      "derivedFrom": [],
      "trace": "derived",
      "note": "NewQuantity = Quantity randomized by the Randomizer parameter (Table.AddColumn), then renamed back to Quantity"
    }
  ]
}
```

Rules:
- **`trace`** is one of:
  - `exact`: read as is, with the same name. This includes a column read by name from a whole table, whether navigated to (`{[Schema="FHSM", Item="Object"]}`) or selected with `SELECT *` from one table: both return the table's columns under their own names.
  - `renamed`: read as is, but the source uses a different name.
  - `derived`: computed from other columns, including every `derivedFrom` answer.
  - `assumed`: a reasonable reading the evidence doesn't prove, such as `SELECT *` over a join where you can't tell which table has the column.
  - `unresolved`: you can't tell. Leave `sources` empty and give the reason in `note`.
- **A column computed in Power Query or SQL** (`Table.AddColumn`, a `CASE`, arithmetic): give one `sources` entry for each source column it's computed from, set `trace` to `derived`, and say in `note` how it's computed.
- **Native SQL:** follow the column through the select list's aliases, then the `FROM`/`JOIN` aliases, to `schema.table.column`. Leave `schema` empty if the SQL doesn't name one. Through a CTE or subquery, give the base table's column.
- **Expanded or joined columns** (`Table.ExpandTableColumn`, `Table.NestedJoin`, `Table.ExpandRecordColumn`): follow the join to the query it reads, and trace the column there.
- **A column of a calculated table (DAX):**
  - If its values come from model columns, put those in `derivedFrom` as `Table[Column]`, exactly as the model names them, and leave `sources` empty. The build traces them further.
  - If its values are typed into the DAX (`DATATABLE`, `{…}`, `GENERATESERIES`): `sources: [{ "connector": "typed-in", "system": "", "schema": "", "table": "<table> (values typed into DAX)", "column": "<column>" }]`, with `trace` set to `exact`.
- **Values the query generates or types in** (a date list, Enter Data): connector `generated` or `typed-in`, with table `"<table> (rows generated in Power Query)"` or `"<table> (rows typed into the query)"`. A column computed from the generated values (a month name from the date list) names the generated column as its `column`, with `trace` set to `derived`.
- **A constant written into a query step** (`Table.AddColumn(t, "Flag", each "Yes")`): connector `typed-in`, table `"<table> (value typed into the query)"`, with `trace` set to `exact`, like values typed into DAX. The value is what's typed.
- **`note`:** always say briefly how you got there. The person reading the workbook checks it.

## measures-NN.json: classify each measure's fields

Each measure has:

| Key | What it holds |
|---|---|
| `dax` | The measure's DAX. |
| `columns` | The `Table[Column]` references the DAX writes out. |
| `unqualified` | Columns matching a bare `[Name]` the DAX writes without a table. Only candidates: see the rules. |
| `measures` | The other measures it uses. |
| `tables` | The tables it names. |
| `functions` | The DAX user-defined functions it calls, directly or through each other. Their code is in the task's top-level `functions`, by name. |

The principle:
- A **main** field is a column whose values make up the measure's result.
- A **helper** field is a column the measure uses only to filter it or to decide something.

Write one entry per measure:

```json
{
  "task": "measures-01",
  "run": "<copied from the task>",
  "measures": [
    {
      "measure": "West Sales LY",
      "fields": [
        { "field": "Sales[Amount]", "role": "main", "usage": "SUM" },
        { "field": "Store[Region]", "role": "helper", "usage": "filter" },
        { "field": "Date[Date]", "role": "helper", "usage": "time intelligence" }
      ],
      "measures": [ { "measure": "Total Cost", "as": "value" } ],
      "note": ""
    }
  ]
}
```

Main fields:

| Where the column appears | `usage` |
|---|---|
| Argument of `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `COUNTBLANK`, `DISTINCTCOUNT`, `DISTINCTCOUNTNOBLANK`, `MEDIAN`, `PERCENTILE.INC` / `.EXC` | the function name |
| Inside the expression argument of an iterator: `SUMX`, `AVERAGEX`, `MINX`, `MAXX`, `COUNTX`, `PRODUCTX`, `CONCATENATEX`, `RANKX` | e.g. `SUMX expression` |
| `COUNTROWS(T)` | `COUNTROWS`, with the table name `"T"` as the field |
| Returned as the measure's value by `SELECTEDVALUE`, `VALUES`, `FIRSTNONBLANK`, `LASTNONBLANK` | the function name |

Helper fields:

| Where the column appears | `usage` |
|---|---|
| Compared in a filter argument of `CALCULATE` / `CALCULATETABLE` (`=`, `IN`, `&&` / `||`, `CONTAINSSTRING`), or `TREATAS` | `filter` |
| `KEEPFILTERS` | `keeps filters` |
| `ALL`, `ALLEXCEPT`, `REMOVEFILTERS`, `ALLSELECTED`, `ALLNOBLANKROW` | `removes filters` |
| Tested in `FILTER` (even a `FILTER` that is a `CALCULATE` filter argument), `IF`, `SWITCH`, `IFERROR` | `condition` |
| Date column of time intelligence: `DATESYTD`, `DATESMTD`, `TOTALYTD`, `SAMEPERIODLASTYEAR`, `DATEADD`, `PARALLELPERIOD`, `DATESBETWEEN`, `DATESINPERIOD`, and calendar-based time intelligence | `time intelligence` |
| `USERELATIONSHIP`, `CROSSFILTER` | `relationship` |
| `SELECTEDVALUE`, `VALUES`, `HASONEVALUE`, `ISFILTERED`, `ISINSCOPE` used to test or pick something | `selection` |
| `RELATED`, `LOOKUPVALUE` when not the value itself | `lookup` |
| A column in the table argument of an iterator, i.e. the rows it iterates over (`AVERAGEX(VALUES(Calendar[Month]), …)`) | `iterates over` |
| The order-by argument of `CONCATENATEX`, `TOPN`, `RANKX`, `WINDOW` | `sort order` |

**Main or helper, when it's not obvious.** Judge by what the measure returns:
- **An aggregate used only to decide something is a helper, not main.** That covers a count, MIN or MAX that's only tested, used as a filter bound, or used to pick a format or how many lines to print. Use usage `condition`, `filter` for a bound, or both when it's both. A `SELECTEDVALUE` that only supplies a bound stays `selection`. "Show filters Headers"-style measures, whose counts only decide line breaks, have no main field.
- **Counting the rows that pass a test** (`COUNTX(FILTER(T, T[IsDamaged]), 1)`, `COUNTROWS(FILTER(T, …))`, `COUNTX(T, IF(T[IsDamaged], 1))`): the table is main (`COUNTX` or `COUNTROWS`), and the columns tested are helpers (`condition`).
- **Counting a column's values** (`COUNTROWS(VALUES(T[C]))`, `COUNTROWS(FILTER(VALUES(T[C]), …))`) counts that column, not the table: the column is the field. In "Show filters Headers"-style measures it's a helper, with `condition` and `iterates over` (and `selection` for an `ISFILTERED` test).
- **A main column the measure also checks** (`IF(ISBLANK(SUM(T[Amount])), …)`) doesn't get a second, helper entry. List it again only when it's filtered separately, as in `CALCULATE(SUM(T[Amount]), T[Amount] > 100)`, tested for selection (`ISFILTERED(T[Amount])`: `selection`), iterated over or sorted by (`CONCATENATEX(VALUES(T[C]), T[C], ", ", T[C])`: `iterates over, sort order`).

Rules:
- **A column used both ways** gets two entries, one per role.
- **Tables as fields:** list a table as a field only for row counting (`COUNTROWS(T)`, `COUNTX(T, …)`: main) and for `ALL(T)` / `REMOVEFILTERS(T)` / `ALLSELECTED(T)` (helper, `removes filters`), wherever those appear: as a `CALCULATE` filter, or as the table an iterator runs over. A table an iterator merely runs over (`SUMX('Disk size', …)`, `FILTER('Date', …)`) isn't a field, and nor is `ISFILTERED(T)`; the columns used inside are.
- **A bare `[Name]`** (the task's `unqualified`) is matched to every column of that name, so each is only a candidate:
  - Keep the column the DAX reads: the one in the table the iterator or `FILTER` runs over (`[Qty]` inside `SUMX(Sales, …)` is `Sales[Qty]`). Drop the other candidates.
  - When `[Name]` is an alias the DAX defines (`SELECTCOLUMNS`, `ADDCOLUMNS`, a table variable's column), list the column it's defined from, and none of the candidates.
- **DAX functions** (the task's `functions`): what a called function reads counts as the measure's. Classify its columns and measures as if the function's body were written into the measure, with its parameters replaced by the arguments passed.
- **A column used several ways within one role** gets one entry, with its usages comma-separated (`"time intelligence, iterates over"`). Their order doesn't matter: the build puts them in a fixed order.
- **Commented-out DAX** (`//`, `--`, `/* … */`) uses nothing. Ignore any reference inside a comment.
- **Other measures:** list every measure the DAX uses in `measures`, with `as` set to:
  - `value` when its result is part of this measure's result: arithmetic, text joined with `&`, `DIVIDE`, `CALCULATE([M], …)`, or returned by an `IF`/`SWITCH` branch. Its fields carry over with their roles.
  - `condition` when it's only tested (`IF([M] > 0, …)`, `FILTER(T, [M] > 5)`), only sets a filter value (`'X'[Date] = [Latest date]`), or only supplies a format (`FORMAT(x, [Date format string])`). Its fields carry over as helpers.

  Wrapping it in `CALCULATE` doesn't change which: `CALCULATE([Latest date], REMOVEFILTERS(T))` used only as a filter value is a `condition`.

  Don't copy another measure's fields into `fields` yourself; the build does that.
- **Field names:**
  - Take `field` values from the task's `columns`, `unqualified` and `tables`, and from the functions' code.
  - If the DAX uses a column the list missed, add it as `Table[Column]`, spelled exactly as the model names the table and column.
  - A column written without its table (`[Qty]` inside `SUMX(Sales, …)`) belongs to the table the iterator runs over.
- **A measure that uses no column** (a constant, only other measures, or `REMOVEFILTERS()`, `ALL()` or `ALLSELECTED()` with no argument) gets `"fields": []`.
- **Every measure in the task gets exactly one entry**, named exactly as in the task.
- **`note`:** use it only for something a reader should know, such as a calculation group or field parameter changing what the measure does.
