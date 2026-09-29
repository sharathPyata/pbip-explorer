# Measure lineage — instructions for the AI

You're completing a measure-lineage workbook for a Power BI semantic model. A script has already
read the model and done everything that can be done exactly. You answer the task files it left:
judgment calls about Power Query, SQL and DAX. A second script then builds the Excel workbook
from its facts and your answers.

Work only from what the task files contain. Never invent a table, column, server or schema name.
When the evidence doesn't settle something, say so in the answer (see `trace` below) rather than guess.

## The three steps

1. **Extract** (already run, or run it):

   ```bash
   node lineage/extract.js "<PBIP folder>"
   ```

   It writes `lineage-output/<project>/<Model>/`:
   - `model.json`: the model's facts and every column source the script traced itself. Don't edit it.
   - `tasks/columns-NN.json`: columns the script couldn't trace to their source.
   - `tasks/measures-NN.json`: measures whose fields need classifying.
   - `answers/`: empty, and where your answers go.

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
- **Values the query generates or types in** (a date list, Enter Data): connector `generated` or `typed-in`, with table `"<table> (rows generated in Power Query)"` or `"<table> (rows typed into the query)"`.
- **A constant written into a query step** (`Table.AddColumn(t, "Flag", each "Yes")`): connector `typed-in`, with `trace` set to `exact`, like values typed into DAX. The value is what's typed.
- **`note`:** always say briefly how you got there. The person reading the workbook checks it.

## measures-NN.json: classify each measure's fields

Each measure has:

| Key | What it holds |
|---|---|
| `dax` | The measure's DAX. |
| `columns` | The `Table[Column]` references the parser found. |
| `measures` | The other measures it uses. |
| `tables` | The tables it names. |

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
| Filter argument of `CALCULATE` / `CALCULATETABLE`, or `TREATAS` | `filter` |
| `KEEPFILTERS` | `keeps filters` |
| `ALL`, `ALLEXCEPT`, `REMOVEFILTERS`, `ALLSELECTED`, `ALLNOBLANKROW` | `removes filters` |
| Condition in `FILTER`, `IF`, `SWITCH`, `IFERROR`, `&&` / `||` tests | `condition` |
| Date column of time intelligence: `DATESYTD`, `DATESMTD`, `TOTALYTD`, `SAMEPERIODLASTYEAR`, `DATEADD`, `PARALLELPERIOD`, `DATESBETWEEN`, `DATESINPERIOD`, and calendar-based time intelligence | `time intelligence` |
| `USERELATIONSHIP`, `CROSSFILTER` | `relationship` |
| `SELECTEDVALUE`, `VALUES`, `HASONEVALUE`, `ISFILTERED`, `ISINSCOPE` used to test or pick something | `selection` |
| `RELATED`, `LOOKUPVALUE` when not the value itself | `lookup` |
| A column in the table argument of an iterator, i.e. the rows it iterates over (`AVERAGEX(VALUES(Calendar[Month]), …)`) | `iterates over` |
| The order-by argument of `CONCATENATEX`, `TOPN`, `RANKX`, `WINDOW` | `sort order` |

**Main or helper, when it's not obvious.** Judge by what the measure returns:
- **An aggregate used only to decide something is a helper, not main.** That covers a count, MIN or MAX that's only tested, used as a filter bound, or used to pick a format or how many lines to print. Use usage `condition`, or `filter` for a bound. "Show filters Headers"-style measures, whose counts only decide line breaks, have no main field.
- **Counting the rows that pass a test** (`COUNTX(FILTER(T, T[IsDamaged]), 1)`, `COUNTROWS(FILTER(T, …))`): the table is main (`COUNTX` or `COUNTROWS`), and the columns tested are helpers (`condition`).
- **A main column the measure also checks** (`IF(ISBLANK(SUM(T[Amount])), …)`) doesn't get a second, helper entry. List it again only when it's filtered separately, as in `CALCULATE(SUM(T[Amount]), T[Amount] > 100)`.

Rules:
- **A column used both ways** gets two entries, one per role.
- **Tables as fields:** list a table as a field only for row counting (`COUNTROWS(T)`, `COUNTX(T, …)`: main) and for `ALL(T)` / `REMOVEFILTERS(T)` (helper, `removes filters`). A table an iterator merely runs over (`SUMX('Disk size', …)`, `FILTER('Date', …)`) isn't a field; the columns used inside are.
- **A bare `[Name]` that isn't a model column**, such as a `SELECTCOLUMNS` / `ADDCOLUMNS` alias, is traced to the column it's defined from. Drop any task `columns` entry that the DAX only matches through such an alias.
- **A column used several ways within one role** gets one entry, with its usages comma-separated in the order they appear (`"time intelligence, iterates over"`).
- **Commented-out DAX** (`//`, `--`, `/* … */`) uses nothing. Ignore any reference inside a comment.
- **Other measures:** list every measure the DAX uses in `measures`, with `as` set to:
  - `value` when its result is part of this measure's result: arithmetic, `DIVIDE`, `CALCULATE([M], …)`, or returned by an `IF`/`SWITCH` branch. Its fields carry over with their roles.
  - `condition` when it's only tested (`IF([M] > 0, …)`, `FILTER(T, [M] > 5)`), only sets a filter value (`'X'[Date] = [Latest date]`), or only supplies a format (`FORMAT(x, [Date format string])`). Its fields carry over as helpers.

  Don't copy another measure's fields into `fields` yourself; the build does that.
- **Field names:**
  - Take `field` values from the task's `columns` and `tables`.
  - If the DAX uses a column the list missed, add it as `Table[Column]`, spelled exactly as the model names the table and column.
  - A column written without its table (`[Qty]` inside `SUMX(Sales, …)`) belongs to the table the iterator runs over.
- **A measure that uses no column** (a constant, only other measures, or `REMOVEFILTERS()` with no argument) gets `"fields": []`.
- **Every measure in the task gets exactly one entry**, named exactly as in the task.
- **`note`:** use it only for something a reader should know, such as a calculation group or field parameter changing what the measure does.
