# Design: building and editing dashboards

Status: implemented in 0.2 · Owner: maintainers

## Problem

Lookout can find and explain dashboards but cannot change them. Building a panel still means opening the editor,
finding the right metric and writing PromQL by hand, which is exactly the work an assistant that already
discovers metrics and validates queries can do.

## Goals

1. Create a new dashboard from a description ("a dashboard for checkout: traffic, errors, p95 latency").
2. Edit an existing dashboard: add, change or remove panels, add variables, change the default time range
   ("add a p99 panel", "make the error panel a percentage", "remove the CPU panel").
3. Nothing is saved until the user has seen the change and clicked Apply. Every change can be undone.
4. Works on every Grafana 13 dashboard, whether stored in the classic (v1) or the v2 schema.

Not in scope for now: alert rules, deleting dashboards, moving panels between rows, editing library panels,
saving to Git Sync repositories (Lookout offers a copy instead).

## How it works

```
question ──► model discovers metrics (existing read tools)
         ──► propose_dashboard_change(ops)      read-only: builds the new dashboard JSON in memory,
                                                 runs every query, returns a summary to the model
         ──► chat shows a Proposal card          changes, live panel previews, warnings
user     ──► Apply                               the browser saves with the user's session
         ──► Undo (optional)                     restores the previous version
```

The model never saves anything. `propose_dashboard_change` only reads (the dashboard, the data sources and
the query results) and keeps the proposal in memory. Apply is a button in the chat UI; the model cannot press it,
so text injected through logs or dashboards cannot cause a write by itself.

### The tool

One tool, `propose_dashboard_change`, with a schema-neutral list of operations:

| Operation                               | Arguments                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `add_panel`                             | `panel` (below), optional `row` title to place it in                              |
| `update_panel`                          | `panel_key`, `changes` (any panel fields)                                         |
| `remove_panel`                          | `panel_key`                                                                       |
| `add_variable`                          | `name`, `label`, `datasource_uid`, `query` (e.g. `label_values(metric, service)`) |
| `set_time`                              | `from`, `to`                                                                      |
| `move_panel`                            | `panel_key`, optional `tab`, `row`, `x`, `y`, `width`, `height`                   |
| `add_tab`                               | `title`, `existing_title` (name for the tab that receives the existing panels)    |
| `add_row`                               | `title`, optional `tab`, `collapsed`, `existing_title`                            |
| `rename_container` / `remove_container` | a `tab` or `row` by title (remove only when empty)                                |
| `set_title`                             | `title`                                                                           |

A panel is `{ title, type, datasource_uid, queries: [{ expr, legend }], unit, description, decimals, min, max,
thresholds: [{ value, color }], stack, width, height, content }`. `type` is one of `timeseries`, `stat`, `gauge`,
`bargauge`, `table`, `barchart`, `piechart`, `heatmap`, `logs` or `text` (`content` is the Markdown for a text panel).

Without `dashboard_uid` the tool creates a new dashboard (classic v1 schema, so it works whether or not
dynamic dashboards are enabled), optionally in `folder_uid`.

### Layout

Panels live on a 24-column grid. `add_panel` and `move_panel` take an optional tab, row and position; a panel
placed at `x, y` pushes panels below it down, and gaps close, the same rules Grafana applies when you drag
panels. Without a position a panel fills the last line or starts a new one.

Tabs, rows and free positions exist only in the v2 schema. When a change needs them on a dashboard stored as
classic v1 JSON, Lookout reads Grafana's v2 conversion of it, saves in v2 and says so on the card; Undo restores
the classic version. New dashboards with tabs are created in v2. If dynamic dashboards are turned off
(`dashboardNewLayouts`), these operations are refused with an explanation.

To optimize a dashboard the model needs facts, not screenshots: `get_dashboard` returns every panel's tab, row,
position, size and unit, plus `layout_notes` (lines that do not use all 24 columns, panels without units or
titles, grids with too many panels). After building a proposal the tool returns the same notes for the result
(`layout_check`) so the model can fix a half-empty line before the user sees it. The card shows a map of the
resulting layout with new and moved panels highlighted.

### Variables

`add_variable` creates query variables (`label_values(...)`), custom variables (`a, b` or `Text : value`), data
source variables (panels then use `datasource_uid: "${name}"`, and checks run against the data source the
variable selects) and text boxes.

### Schema adapters

Grafana 13 stores a dashboard as classic v1 JSON or as v2 (`status.conversion.storedVersion`). Lookout reads and
writes each dashboard in its stored version, so nothing is lost in conversion:

- **v1:** `/apis/dashboard.grafana.app/v1beta1/…`; panels with `gridPos` and `targets`, variables in
  `templating.list`. Panels inside collapsed rows are found and edited in place. New panels go below the last panel.
- **v2:** `/apis/dashboard.grafana.app/v2/…`; `elements` plus a layout tree. New panels go into the named row or
  tab, otherwise into the last grid in the layout (`GridLayout` or `AutoGridLayout`).

Panel keys are the ones `get_dashboard` returns (`panel-<id>` for v1-stored dashboards, element names for v2).

### Validation (before the user sees the proposal)

- The data source exists and the user can query it.
- Every Prometheus and Loki query runs over the last hour. Dashboard variables are replaced with their current
  value, or with `.*` when the current value is "All" or multiple values. Queries that fail are rejected and
  the error goes back to the model; queries that return no data become a warning on the card.
- Tempo queries (TraceQL) are run too. Other data sources are accepted but marked "not checked".
- A query that compares a label with `=` to a variable that allows several values or "All" is rejected: Grafana
  turns several values into a regex, so `=` would match nothing. The model is told to use `=~` or make the
  variable single-select.
- Tables built from several queries get merge and organize transformations (one row per label set, named columns
  with their own units). A trace search put in a `traces` panel becomes a table, since that panel shows one
  trace.
- The `dto` endpoint says whether the user can save the dashboard.

### Where a change is saved

| Dashboard                                                       | Apply does                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Normal, user can save                                           | Saves in place                                                        |
| Provisioned from files, Terraform or another tool (`managedBy`) | Saves a copy (an in-place save would be overwritten)                  |
| Managed by Git Sync                                             | Saves a copy; changing the repo needs a pull request                  |
| User cannot save                                                | Saves a copy in the same folder (Grafana enforces folder permissions) |
| New dashboard                                                   | Creates it                                                            |

Saves use the `resourceVersion` read when the proposal was built. If the dashboard changed since, Grafana
returns 409 and the card says "This dashboard changed since the proposal; ask again". Every save writes a version
message (`Lookout: <summary>`) so the change shows in the dashboard's version history.

### The proposal card

- Title: "New dashboard: X", "Change to X" or "Copy of X", marked "Not saved".
- One line per change: `+ Add panel "p95 latency" (time series)`, `~ "Error rate": unit, query`, `− Remove "CPU"`.
- Up to four live previews of added or changed panels, rendered with the real panel type.
- Warnings: no data, query not checked, will save a copy and why.
- Buttons: Apply (or Create / Save copy), Discard, View JSON. After Apply: Open dashboard and Undo.
- If the user is looking at the dashboard that changed, it reloads after Apply and after Undo.

A newer proposal in the same conversation replaces older ones that were not applied.

## Security

- Proposals are built and saved with the user's session; Grafana's permissions decide what can be saved.
- The model can only propose. Apply and Undo are user actions in the UI.
- The card shows every change, including text panel content, before anything is saved. Grafana sanitises text
  panel HTML as usual.
- No links, data links or custom HTML options are accepted from the model.
- Results stay bounded: at most 80 operations per proposal, 40 query checks and 4 previews.

## Testing

- Unit tests for both adapters (add/update/remove/variables, rows, keys), variable substitution and the save
  target rules, with mocked Grafana responses.
- Manual end-to-end on the quickstart stack: create a dashboard, edit a provisioned dashboard (copy), edit a copy
  in place, a conflict, undo.
