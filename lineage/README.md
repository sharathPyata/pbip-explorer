# Measure lineage

This builds an Excel workbook that traces every measure in a Power BI model back to the physical
source fields it's built from. Renames along the way are seen through: in the model (`sourceColumn`),
in Power Query steps and in SQL aliases. It works from a PBIP folder, using PBIP Explorer's own
parser (`pbip-explorer.html`, unchanged). It needs Node and nothing to install.

## Running it

1. **Extract.** A script reads the model and traces every column it can trace exactly:

   ```bash
   node lineage/extract.js "C:\path\to\MyProject"
   ```

   It writes `lineage-output/MyProject/<Model>/`, holding `model.json` and `tasks/*.json`: the
   columns it couldn't trace, and the measures to classify.

2. **Answer the tasks.** An AI answers each task file, following
   [INSTRUCTIONS.md](INSTRUCTIONS.md), into `answers/`. In VS Code with Claude Code, ask:

   > Follow lineage/INSTRUCTIONS.md for lineage-output/MyProject/<Model>

3. **Build the workbook:**

   ```bash
   node lineage/build-excel.js "lineage-output/MyProject/<Model>"
   ```

   It writes `<Model>-lineage.xlsx` next to `model.json`, and prints anything left unresolved.

## The workbook

| Sheet | One row per | Columns |
|---|---|---|
| **Lineage** | measure × field × source | measure, main or helper and how it's used, model field, the measures or calculated columns it came through, connector, system, schema, table, source column, how it was traced (exact / renamed / derived / assumed / unresolved), note, traced by (extractor or AI), check |
| **By source field** | main source field + set of helper fields | source field, helper fields, the measures built on them, and where each lives (`schema.table.field`) |
| **Unresolved** | issue | columns nobody could trace, measures without an answer, answers naming fields the model doesn't have, AI-named sources not found in the model's queries |

## What the extractor traces without the AI

It traces a column when every Power Query step between the model and the source is one whose effect
on column names is certain:
- **Navigation to a database object:** `{[Schema="dbo", Item="Sales"]}`, Snowflake's `Kind` levels, Oracle's `Schema` then `Name`.
- **Files:** CSV and Excel files, read locally or from a URL.
- **Direct Lake tables:** traced through their entity and schema.
- **Renaming steps:** renames, duplicated columns, promoted headers.
- **Steps that keep every column's name:** row filters, type changes, sorting, value replacements.
- **References to other queries**, including loaded parameters.

It hands everything else to the AI: columns computed with `Table.AddColumn`, native SQL, expanded
and joined columns, custom functions, and calculated tables.
