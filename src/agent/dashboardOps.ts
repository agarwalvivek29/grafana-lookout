// Pure dashboard editing: apply schema-neutral operations to a classic (v1) or v2 dashboard spec.
// No network here, so every rule is unit-testable. See docs/design/dashboard-editing.md.

export type Json = Record<string, any>;

export const PANEL_TYPES = [
  'timeseries',
  'stat',
  'gauge',
  'bargauge',
  'table',
  'barchart',
  'piechart',
  'heatmap',
  'logs',
  'text',
  'nodeGraph',
  'traces',
] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

export interface PanelQuery {
  expr: string;
  legend?: string;
  /** Column name in a table panel. */
  name?: string;
  /** Unit of this query's column in a table panel. */
  unit?: string;
}

/** Panel fields the model may set. Anything else (links, raw options, custom HTML) is never accepted. */
export interface PanelSpec {
  title?: string;
  type?: PanelType;
  description?: string;
  datasource_uid?: string;
  queries?: PanelQuery[];
  unit?: string;
  decimals?: number;
  min?: number;
  max?: number;
  thresholds?: Array<{ value: number; color: string }>;
  stack?: boolean;
  width?: number;
  height?: number;
  content?: string;
  /** How thresholds are drawn on time series: line, dashed, area, line+area or off. */
  threshold_style?: string;
}

/** Where a panel goes in a v2 layout: a tab and/or row by title, and an optional grid position. */
export interface Placement {
  tab?: string;
  row?: string;
  x?: number;
  y?: number;
}

export type VariableKind = 'query' | 'custom' | 'datasource' | 'textbox';

export type Operation =
  | ({ op: 'add_panel'; panel: PanelSpec } & Placement)
  | { op: 'update_panel'; panel_key: string; changes: PanelSpec }
  | { op: 'remove_panel'; panel_key: string }
  | ({ op: 'move_panel'; panel_key: string; width?: number; height?: number } & Placement)
  | { op: 'add_tab'; title: string; existing_title?: string }
  | { op: 'add_row'; title: string; tab?: string; collapsed?: boolean; existing_title?: string }
  | { op: 'rename_container'; tab?: string; row?: string; title: string }
  | { op: 'remove_container'; tab?: string; row?: string }
  | {
      op: 'add_variable';
      name: string;
      label?: string;
      kind?: VariableKind;
      datasource_uid?: string;
      query?: string;
      ds_type?: string;
      regex?: string;
      multi?: boolean;
      include_all?: boolean;
      hide?: boolean;
    }
  | { op: 'set_time'; from: string; to: string }
  | { op: 'set_title'; title: string };

/** Operations that need the v2 layout (tabs, rows, positions). */
export const LAYOUT_OPS = ['move_panel', 'add_tab', 'add_row', 'rename_container', 'remove_container'];

export function needsV2Layout(ops: Operation[]): boolean {
  return ops.some(
    (o) =>
      LAYOUT_OPS.includes(o.op) ||
      (o.op === 'add_panel' && (o.tab !== undefined || o.x !== undefined || o.y !== undefined))
  );
}

export interface ChangeLine {
  kind: 'add' | 'update' | 'remove' | 'other';
  text: string;
  detail?: string;
}

/** What a preview or a validation run needs to know about one panel after the change. */
export interface PanelView {
  key: string;
  title: string;
  type: string;
  queries: Array<{ dsUid: string; dsType: string; expr: string; legend?: string }>;
  fieldConfig: Json;
  options: Json;
}

export interface ApplyResult {
  spec: Json;
  changes: ChangeLine[];
  /** Panels added or changed, for previews and query checks. */
  touched: PanelView[];
}

/** Data source uid → type, resolved by the caller before applying. */
export type DsTypes = Record<string, string>;

export const MAX_OPERATIONS = 80;
const GRID_COLUMNS = 24;

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+(-[a-z]+)*)$/i;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export class OpError extends Error {}

function defaultSize(type: PanelType | string | undefined): { w: number; h: number } {
  switch (type) {
    case 'stat':
    case 'gauge':
      return { w: 6, h: 5 };
    case 'logs':
    case 'table':
      return { w: 24, h: 10 };
    case 'text':
      return { w: 24, h: 4 };
    case 'nodeGraph':
      return { w: 12, h: 16 };
    case 'traces':
      return { w: 24, h: 10 };
    default:
      return { w: 12, h: 8 };
  }
}

const clampW = (w: unknown, dflt: number) => Math.max(2, Math.min(GRID_COLUMNS, Math.round(Number(w) || dflt)));
const clampH = (h: unknown, dflt: number) => Math.max(2, Math.min(40, Math.round(Number(h) || dflt)));

/**
 * Several instant queries in a table panel show as separate tables unless merged: merge them into one row per
 * label set, hide the time column, and name each value column after the query's legend.
 */
export function tableTransforms(type: string, queries: PanelQuery[] | undefined): Array<{ id: string; options: Json }> {
  if (type !== 'table' || !queries || queries.length < 2) {
    return [];
  }
  const renameByName: Record<string, string> = {};
  queries.forEach((q, i) => {
    const name = columnName(q);
    if (name) {
      renameByName[`Value #${refId(i)}`] = name;
    }
  });
  return [
    { id: 'merge', options: {} },
    { id: 'organize', options: { excludeByName: { Time: true }, renameByName } },
  ];
}

const columnName = (q: PanelQuery) => q.name ?? (q.legend && !q.legend.includes('{{') ? q.legend : undefined);

/** Per-column units for a table built from several queries (Grafana field overrides by column name). */
export function tableOverrides(type: string, queries: PanelQuery[] | undefined): Json[] {
  if (type !== 'table' || !queries || queries.length < 2) {
    return [];
  }
  return queries
    .map((q, i) => ({ q, col: columnName(q) ?? `Value #${refId(i)}` }))
    .filter(({ q }) => q.unit)
    .map(({ q, col }) => ({ matcher: { id: 'byName', options: col }, properties: [{ id: 'unit', value: q.unit }] }));
}

const v2Transforms = (list: Array<{ id: string; options: Json }>) =>
  list.map((x) => ({ kind: 'Transformation', group: x.id, spec: { options: x.options } }));

/** A "traces" panel shows one trace; a TraceQL search ({...}) belongs in a table. */
function fixTraceSearch(p: PanelSpec) {
  if (p.type === 'traces' && p.queries?.some((q) => q.expr.trim().startsWith('{'))) {
    p.type = 'table';
  }
}

function checkPanelSpec(p: PanelSpec, isNew: boolean) {
  fixTraceSearch(p);
  if (isNew && !p.title) {
    throw new OpError('add_panel needs panel.title');
  }
  if (p.type !== undefined && !PANEL_TYPES.includes(p.type)) {
    throw new OpError(`Unsupported panel type "${p.type}". Use one of: ${PANEL_TYPES.join(', ')}`);
  }
  const type = p.type ?? 'timeseries';
  if (isNew && type !== 'text' && (!p.datasource_uid || !p.queries?.length)) {
    throw new OpError(`Panel "${p.title}" needs datasource_uid and at least one query`);
  }
  if (p.queries && p.queries.length > 6) {
    throw new OpError(`Panel "${p.title ?? ''}" has more than 6 queries`);
  }
  for (const t of p.thresholds ?? []) {
    if (!COLOR.test(String(t.color)) || !isFinite(Number(t.value))) {
      throw new OpError(`Invalid threshold ${JSON.stringify(t)}: use a number and a colour name or hex`);
    }
  }
}

/** Field config defaults built from a panel spec, merged over what the panel already has. */
function mergeFieldDefaults(existing: Json | undefined, p: PanelSpec): Json {
  const d: Json = clone(existing ?? {});
  if (p.unit !== undefined) {
    d.unit = p.unit;
  }
  for (const k of ['decimals', 'min', 'max'] as const) {
    if (p[k] !== undefined) {
      d[k] = p[k];
    }
  }
  if (p.thresholds) {
    d.thresholds = {
      mode: 'absolute',
      steps: [
        { color: 'green', value: null },
        ...p.thresholds.map((t) => ({ color: t.color, value: Number(t.value) })),
      ],
    };
  }
  if (p.threshold_style !== undefined) {
    const mode = THRESHOLD_STYLES[p.threshold_style] ?? 'line';
    d.custom = { ...(d.custom ?? {}), thresholdsStyle: { mode } };
  }
  if (p.stack !== undefined) {
    d.custom = { ...(d.custom ?? {}), stacking: { mode: p.stack ? 'normal' : 'none', group: 'A' } };
  }
  return d;
}

const THRESHOLD_STYLES: Record<string, string> = {
  line: 'line',
  dashed: 'dashed',
  area: 'area',
  'line+area': 'line+area',
  'dashed+area': 'dashed+area',
  off: 'off',
};

function defaultOptions(type: string, content?: string): Json {
  switch (type) {
    case 'text':
      return { mode: 'markdown', content: content ?? '' };
    case 'timeseries':
      return { legend: { showLegend: true, displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } };
    case 'stat':
    case 'gauge':
    case 'bargauge':
    case 'piechart':
      return { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } };
    case 'logs':
      return { showTime: true, wrapLogMessage: true, sortOrder: 'Descending' };
    default:
      return {};
  }
}

/** Query fields for one data source type (shared by v1 targets and v2 query specs). */
function querySpec(dsType: string, panelType: string, q: PanelQuery): Json {
  if (dsType === 'tempo') {
    return { query: q.expr, queryType: 'traceql', limit: 20, tableType: 'traces' };
  }
  const spec: Json = { expr: q.expr };
  if (q.legend) {
    spec.legendFormat = q.legend;
  }
  if (dsType === 'prometheus' && panelType === 'table') {
    Object.assign(spec, { format: 'table', instant: true, range: false });
  }
  if (dsType === 'loki') {
    spec.queryType = 'range';
  }
  return spec;
}

const refId = (i: number) => String.fromCharCode(65 + i);

function dsTypeOf(ds: DsTypes, uid: string): string {
  const t = ds[uid];
  if (!t) {
    throw new OpError(`Unknown data source uid "${uid}". Use list_datasources.`);
  }
  return t;
}

function describePanel(p: PanelSpec): string {
  const q = p.queries
    ?.map((x) => (x.name || x.unit ? `${x.expr}   [column "${x.name ?? ''}"${x.unit ? `, ${x.unit}` : ''}]` : x.expr))
    .join('\n');
  return q ?? p.content ?? '';
}

function updateSummary(c: PanelSpec): string[] {
  const names: string[] = [];
  const label: Record<string, string> = {
    title: 'title',
    type: 'type',
    description: 'description',
    datasource_uid: 'data source',
    queries: 'query',
    unit: 'unit',
    decimals: 'decimals',
    min: 'min',
    max: 'max',
    thresholds: 'thresholds',
    stack: 'stacking',
    width: 'size',
    height: 'size',
    content: 'text',
    threshold_style: 'thresholds',
  };
  for (const k of Object.keys(c) as Array<keyof PanelSpec>) {
    if (c[k] !== undefined && label[k] && !names.includes(label[k])) {
      names.push(label[k]);
    }
  }
  return names;
}

// ---------------------------------------------------------------- classic (v1) dashboards

/** Every panel in a classic dashboard, including panels inside collapsed rows. */
function v1AllPanels(spec: Json): Json[] {
  const out: Json[] = [];
  for (const p of spec.panels ?? []) {
    out.push(p);
    if (p.type === 'row') {
      out.push(...(p.panels ?? []));
    }
  }
  return out;
}

function v1Find(spec: Json, key: string): { list: Json[]; index: number } | null {
  const id = Number(String(key).replace(/^panel-/, ''));
  const top: Json[] = spec.panels ?? [];
  for (let i = 0; i < top.length; i++) {
    if (top[i].id === id && top[i].type !== 'row') {
      return { list: top, index: i };
    }
    if (top[i].type === 'row') {
      const inner: Json[] = top[i].panels ?? [];
      const j = inner.findIndex((p) => p.id === id);
      if (j >= 0) {
        return { list: inner, index: j };
      }
    }
  }
  return null;
}

function v1Targets(ds: DsTypes, uid: string, panelType: string, queries: PanelQuery[]): Json[] {
  const type = dsTypeOf(ds, uid);
  return queries.map((q, i) => ({ refId: refId(i), datasource: { type, uid }, ...querySpec(type, panelType, q) }));
}

function v1View(p: Json): PanelView {
  return {
    key: `panel-${p.id}`,
    title: p.title ?? '',
    type: p.type,
    queries: (p.targets ?? [])
      .filter((t: Json) => !t.hide)
      .map((t: Json) => ({
        dsUid: t.datasource?.uid ?? p.datasource?.uid,
        dsType: t.datasource?.type ?? p.datasource?.type,
        expr: String(t.expr ?? t.query ?? ''),
        legend: t.legendFormat,
      }))
      .filter((q: Json) => q.expr),
    fieldConfig: p.fieldConfig ?? { defaults: {}, overrides: [] },
    options: p.options ?? {},
  };
}

function v1Bottom(spec: Json): number {
  let bottom = 0;
  for (const p of v1AllPanels(spec)) {
    const g = p.gridPos ?? {};
    bottom = Math.max(bottom, (g.y ?? 0) + (g.h ?? 0));
  }
  return bottom;
}

function v1Variables(spec: Json): Json[] {
  return spec.templating?.list ?? [];
}

export function applyV1(original: Json, ops: Operation[], ds: DsTypes): ApplyResult {
  const spec = clone(original);
  spec.panels = spec.panels ?? [];
  const changes: ChangeLine[] = [];
  const touched = new Set<number>();
  let nextId = Math.max(0, ...v1AllPanels(spec).map((p) => Number(p.id) || 0)) + 1;
  // New panels flow left to right below everything that is already there.
  let cursor = { x: 0, y: v1Bottom(spec), rowH: 0 };

  for (const o of ops) {
    if (o.op === 'add_panel') {
      checkPanelSpec(o.panel, true);
      const p = o.panel;
      const type = p.type ?? 'timeseries';
      const size = defaultSize(type);
      const w = clampW(p.width, size.w);
      const h = clampH(p.height, size.h);
      if (cursor.x + w > GRID_COLUMNS) {
        cursor = { x: 0, y: cursor.y + cursor.rowH, rowH: 0 };
      }
      const panel: Json = {
        id: nextId++,
        type,
        title: p.title,
        description: p.description ?? '',
        gridPos: { x: cursor.x, y: cursor.y, w, h },
        fieldConfig: { defaults: mergeFieldDefaults({}, p), overrides: [] },
        options: defaultOptions(type, p.content),
      };
      if (type !== 'text') {
        panel.datasource = { type: dsTypeOf(ds, p.datasource_uid!), uid: p.datasource_uid };
        panel.targets = v1Targets(ds, p.datasource_uid!, type, p.queries!);
        const tx = tableTransforms(type, p.queries);
        if (tx.length) {
          panel.transformations = tx;
          panel.fieldConfig.overrides = tableOverrides(type, p.queries);
        }
      }
      cursor = { x: cursor.x + w, y: cursor.y, rowH: Math.max(cursor.rowH, h) };
      // A row title is only honoured for an existing collapsed row; otherwise the panel goes at the bottom.
      const row = o.row ? spec.panels.find((r: Json) => r.type === 'row' && r.collapsed && r.title === o.row) : null;
      (row ? (row.panels = row.panels ?? []) : spec.panels).push(panel);
      touched.add(panel.id);
      changes.push({ kind: 'add', text: `Add panel "${p.title}" (${type})`, detail: describePanel(p) });
    } else if (o.op === 'update_panel') {
      checkPanelSpec(o.changes, false);
      const found = v1Find(spec, o.panel_key);
      if (!found) {
        throw new OpError(`panel_key "${o.panel_key}" does not exist on this dashboard`);
      }
      const panel = found.list[found.index];
      const c = o.changes;
      const oldTitle = panel.title;
      const before = describePanel({ queries: v1View(panel).queries.map((q) => ({ expr: q.expr })) });
      if (c.title !== undefined) {
        panel.title = c.title;
      }
      if (c.description !== undefined) {
        panel.description = c.description;
      }
      if (c.type !== undefined && c.type !== panel.type) {
        panel.type = c.type;
        panel.options = defaultOptions(c.type, c.content ?? panel.options?.content);
      }
      if (c.content !== undefined) {
        panel.options = { ...(panel.options ?? {}), mode: 'markdown', content: c.content };
      }
      const dsUid = c.datasource_uid ?? panel.datasource?.uid ?? panel.targets?.[0]?.datasource?.uid;
      if (c.queries) {
        if (!dsUid) {
          throw new OpError(`Panel "${panel.title}" has no data source; set datasource_uid`);
        }
        panel.targets = v1Targets(ds, dsUid, panel.type, c.queries);
        const tx = tableTransforms(panel.type, c.queries);
        if (tx.length) {
          panel.transformations = tx;
          panel.fieldConfig = {
            ...(panel.fieldConfig ?? { defaults: {} }),
            overrides: tableOverrides(panel.type, c.queries),
          };
        }
        panel.datasource = { type: dsTypeOf(ds, dsUid), uid: dsUid };
      } else if (c.datasource_uid) {
        const type = dsTypeOf(ds, c.datasource_uid);
        panel.datasource = { type, uid: c.datasource_uid };
        for (const t of panel.targets ?? []) {
          t.datasource = { type, uid: c.datasource_uid };
        }
      }
      panel.fieldConfig = {
        ...(panel.fieldConfig ?? {}),
        defaults: mergeFieldDefaults(panel.fieldConfig?.defaults, c),
        overrides: panel.fieldConfig?.overrides ?? [],
      };
      if (c.width !== undefined || c.height !== undefined) {
        const g = panel.gridPos ?? { x: 0, y: 0, w: 12, h: 8 };
        panel.gridPos = { ...g, w: clampW(c.width, g.w), h: clampH(c.height, g.h) };
      }
      touched.add(panel.id);
      changes.push({
        kind: 'update',
        text: `Change "${oldTitle}": ${updateSummary(c).join(', ')}${c.title && c.title !== oldTitle ? ` (now "${c.title}")` : ''}`,
        detail: c.queries ? `${before}\n→ ${describePanel(c)}` : undefined,
      });
    } else if (o.op === 'remove_panel') {
      const found = v1Find(spec, o.panel_key);
      if (!found) {
        throw new OpError(`panel_key "${o.panel_key}" does not exist on this dashboard`);
      }
      const [removed] = found.list.splice(found.index, 1);
      touched.delete(removed.id);
      changes.push({ kind: 'remove', text: `Remove panel "${removed.title}"` });
    } else if (LAYOUT_OPS.includes(o.op)) {
      throw new OpError(`${o.op} needs the v2 dashboard layout`);
    } else {
      applyCommon(spec, o, changes, 'v1', ds);
    }
  }
  const views = v1AllPanels(spec)
    .filter((p) => touched.has(p.id))
    .map(v1View);
  return { spec, changes, touched: views };
}

// ---------------------------------------------------------------- v2 dashboards

interface GridTarget {
  kind: 'GridLayout' | 'AutoGridLayout';
  spec: Json;
}

const isGrid = (l: Json) => l?.kind === 'GridLayout' || l?.kind === 'AutoGridLayout';
const children = (l: Json): Json[] => l?.spec?.tabs ?? l?.spec?.rows ?? [];
const sameTitle = (a: unknown, b: unknown) =>
  String(a ?? '')
    .trim()
    .toLowerCase() ===
  String(b ?? '')
    .trim()
    .toLowerCase();

function titles(items: Json[]): string {
  return items.map((i) => `"${i.spec?.title ?? ''}"`).join(', ') || 'none';
}

/** Find a tab (top-level TabsLayout) by title. */
function findTab(layout: Json, tab: string): Json {
  if (layout?.kind !== 'TabsLayout') {
    throw new OpError(`This dashboard has no tabs; add one with add_tab first`);
  }
  const t = children(layout).find((x) => sameTitle(x.spec?.title, tab));
  if (!t) {
    throw new OpError(`No tab "${tab}". Tabs: ${titles(children(layout))}`);
  }
  return t;
}

/** The layout a tab/row reference points at (the tab's layout, or the whole dashboard). */
function scopeLayout(root: Json, tab?: string): Json {
  return tab ? findTab(root, tab).spec.layout : root;
}

/**
 * The grid a panel goes into. With a row (and optionally a tab) it is that row's grid. Without one it is the
 * last grid in the scope, so a dashboard keeps filling from the bottom as before.
 */
export function v2TargetGrid(layout: Json, row?: string, tab?: string): GridTarget | null {
  const scope = scopeLayout(layout, tab);
  if (row) {
    let found: Json | null = null;
    const walk = (l: Json) => {
      for (const item of children(l)) {
        if (!found && item.kind === 'RowsLayoutRow' && sameTitle(item.spec?.title, row)) {
          found = item;
        }
        walk(item.spec?.layout);
      }
    };
    walk(scope);
    // Older callers passed a tab title as "row"; accept that too.
    if (!found && scope?.kind === 'TabsLayout') {
      found = children(scope).find((t) => sameTitle(t.spec?.title, row)) ?? null;
    }
    if (!found) {
      throw new OpError(`No row "${row}"${tab ? ` in tab "${tab}"` : ''}`);
    }
    return v2TargetGrid((found as Json).spec.layout);
  }
  let last: GridTarget | null = null;
  const walk = (l: Json) => {
    if (!l) {
      return;
    }
    if (isGrid(l)) {
      l.spec = l.spec ?? {};
      l.spec.items = l.spec.items ?? [];
      last = l as GridTarget;
      return;
    }
    for (const item of children(l)) {
      walk(item?.spec?.layout);
    }
  };
  walk(scope);
  return last;
}

function v2Items(layout: Json): Json[] {
  const out: Json[] = [];
  const walk = (l: Json) => {
    if (!l) {
      return;
    }
    if (isGrid(l)) {
      out.push(...(l.spec?.items ?? []));
      return;
    }
    for (const item of children(l)) {
      walk(item?.spec?.layout);
    }
  };
  walk(layout);
  return out;
}

/** Remove a panel from whichever grid holds it; returns the removed layout item. */
function v2RemoveItem(layout: Json, key: string): Json | null {
  let removed: Json | null = null;
  const walk = (l: Json) => {
    if (!l) {
      return;
    }
    if (isGrid(l)) {
      const items: Json[] = l.spec?.items ?? [];
      const i = items.findIndex((it) => it.spec?.element?.name === key);
      if (i >= 0) {
        removed = items.splice(i, 1)[0];
      }
      return;
    }
    for (const item of children(l)) {
      walk(item?.spec?.layout);
    }
  };
  walk(layout);
  return removed;
}

const overlaps = (a: Json, b: Json) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Make a grid valid after a change: nothing overlaps (items under a placed panel move down) and nothing floats
 * (every item moves up as far as it can), the same rules Grafana's grid applies when you drag panels.
 * The item with key `first` wins when two want the same place.
 */
export function normalizeGrid(items: Json[], first?: string) {
  const grid = items.filter((it) => it.kind === 'GridLayoutItem');
  const order = [...grid].sort((a, b) => {
    const pa = a.spec.element?.name === first ? -1 : 0;
    const pb = b.spec.element?.name === first ? -1 : 0;
    return a.spec.y - b.spec.y || pa - pb || a.spec.x - b.spec.x;
  });
  const placed: Json[] = [];
  for (const it of order) {
    const s = it.spec;
    s.x = Math.max(0, Math.min(GRID_COLUMNS - s.width, s.x));
    // Fall up as far as possible, then down past anything in the way.
    s.y = 0;
    let moved = true;
    while (moved) {
      moved = false;
      for (const p of placed) {
        if (overlaps(s, p.spec)) {
          s.y = p.spec.y + p.spec.height;
          moved = true;
        }
      }
    }
    placed.push(it);
  }
  // Keep the items in reading order so the saved JSON matches what users see.
  items.sort((a, b) => (a.spec?.y ?? 0) - (b.spec?.y ?? 0) || (a.spec?.x ?? 0) - (b.spec?.x ?? 0));
}

/** Fallback placement: fill the last line if there is room, otherwise start a new line. */
function nextSlot(items: Json[], w: number): { x: number; y: number } {
  const grid = items.filter((it) => it.kind === 'GridLayoutItem');
  if (!grid.length) {
    return { x: 0, y: 0 };
  }
  const bottom = Math.max(...grid.map((it) => it.spec.y + it.spec.height));
  const lastLine = grid.filter((it) => it.spec.y + it.spec.height === bottom);
  const lineY = Math.min(...lastLine.map((it) => it.spec.y));
  const lineEnd = Math.max(...grid.filter((it) => it.spec.y === lineY).map((it) => it.spec.x + it.spec.width));
  return lineEnd + w <= GRID_COLUMNS ? { x: lineEnd, y: lineY } : { x: 0, y: bottom };
}

function placeInGrid(grid: GridTarget, key: string, w: number, h: number, at: { x?: number; y?: number }) {
  const ref = { kind: 'ElementReference', name: key };
  if (grid.kind === 'AutoGridLayout') {
    grid.spec.items.push({ kind: 'AutoGridLayoutItem', spec: { element: ref } });
    return;
  }
  const slot = at.x === undefined && at.y === undefined ? nextSlot(grid.spec.items, w) : null;
  grid.spec.items.push({
    kind: 'GridLayoutItem',
    spec: {
      x: slot ? slot.x : Math.round(Number(at.x ?? 0)),
      // Without a y the panel goes to the bottom; normalizeGrid pulls it up into any gap.
      y: slot ? slot.y : Math.round(Number(at.y ?? 10000)),
      width: w,
      height: h,
      element: ref,
    },
  });
  normalizeGrid(grid.spec.items, key);
}

/** The grid that holds this layout item (by element name, since the item may have been removed). */
function findGridOf(layout: Json, item: Json | null): GridTarget | null {
  const key = item?.spec?.element?.name;
  if (!key) {
    return null;
  }
  let hit: GridTarget | null = null;
  const walk = (l: Json) => {
    if (!l || hit) {
      return;
    }
    if (isGrid(l)) {
      if ((l.spec?.items ?? []).some((it: Json) => it.spec?.element?.name === key)) {
        hit = l as GridTarget;
      }
      return;
    }
    for (const c of children(l)) {
      walk(c.spec?.layout);
    }
  };
  walk(layout);
  return hit;
}

const emptyGrid = () => ({ kind: 'GridLayout', spec: { items: [] as Json[] } });

/** Turn a layout object into a container of the given kind in place, keeping existing content as the first child. */
function wrapInPlace(l: Json, kind: 'TabsLayout' | 'RowsLayout', firstTitle: string) {
  const inner = { kind: l.kind, spec: l.spec };
  const hasContent = v2Items(inner).length > 0 || children(inner).length > 0;
  const childKind = kind === 'TabsLayout' ? 'TabsLayoutTab' : 'RowsLayoutRow';
  const first = {
    kind: childKind,
    spec: { title: firstTitle, layout: inner, ...(kind === 'RowsLayout' ? { collapse: false } : {}) },
  };
  l.kind = kind;
  l.spec = { [kind === 'TabsLayout' ? 'tabs' : 'rows']: hasContent ? [first] : [] };
}

/** Find the tab or row a rename/remove refers to, with its parent list. */
function findContainer(root: Json, tab?: string, row?: string): { list: Json[]; index: number; item: Json } {
  if (row) {
    const scope = scopeLayout(root, tab);
    let hit: { list: Json[]; index: number; item: Json } | null = null;
    const walk = (l: Json) => {
      const list = children(l);
      list.forEach((item, index) => {
        if (!hit && item.kind === 'RowsLayoutRow' && sameTitle(item.spec?.title, row)) {
          hit = { list, index, item };
        }
        walk(item.spec?.layout);
      });
    };
    walk(scope);
    if (!hit) {
      throw new OpError(`No row "${row}"${tab ? ` in tab "${tab}"` : ''}`);
    }
    return hit;
  }
  if (tab) {
    const t = findTab(root, tab);
    const list = children(root);
    return { list, index: list.indexOf(t), item: t };
  }
  throw new OpError('Name the tab or row');
}

function v2Queries(ds: DsTypes, uid: string, panelType: string, queries: PanelQuery[]): Json[] {
  const type = dsTypeOf(ds, uid);
  return queries.map((q, i) => ({
    kind: 'PanelQuery',
    spec: {
      refId: refId(i),
      hidden: false,
      query: {
        kind: 'DataQuery',
        group: type,
        version: 'v0',
        datasource: { name: uid },
        spec: querySpec(type, panelType, q),
      },
    },
  }));
}

function v2View(key: string, el: Json): PanelView {
  const s = el.spec ?? {};
  return {
    key,
    title: s.title ?? '',
    type: s.vizConfig?.group ?? '',
    queries: (s.data?.spec?.queries ?? [])
      .filter((q: Json) => !q.spec?.hidden)
      .map((q: Json) => {
        const dq = q.spec?.query ?? {};
        return {
          dsUid: dq.datasource?.name ?? '',
          dsType: dq.group ?? '',
          expr: String(dq.spec?.expr ?? dq.spec?.query ?? ''),
          legend: dq.spec?.legendFormat,
        };
      })
      .filter((q: Json) => q.expr),
    fieldConfig: s.vizConfig?.spec?.fieldConfig ?? { defaults: {}, overrides: [] },
    options: s.vizConfig?.spec?.options ?? {},
  };
}

function v2Variables(spec: Json): Json[] {
  return spec.variables ?? [];
}

export function applyV2(original: Json, ops: Operation[], ds: DsTypes): ApplyResult {
  const spec = clone(original);
  spec.elements = spec.elements ?? {};
  spec.layout = spec.layout ?? { kind: 'GridLayout', spec: { items: [] } };
  const changes: ChangeLine[] = [];
  const touched = new Set<string>();
  let nextId =
    Math.max(
      0,
      ...Object.values<Json>(spec.elements).map((e) => Number(e.spec?.id) || 0),
      ...Object.keys(spec.elements).map((k) => Number(k.replace(/^panel-/, '')) || 0)
    ) + 1;

  for (const o of ops) {
    if (o.op === 'add_panel') {
      checkPanelSpec(o.panel, true);
      const p = o.panel;
      const type = p.type ?? 'timeseries';
      const id = nextId++;
      const key = `panel-${id}`;
      const el: Json = {
        kind: 'Panel',
        spec: {
          id,
          title: p.title,
          description: p.description ?? '',
          links: [],
          data: {
            kind: 'QueryGroup',
            spec: {
              queries: type === 'text' ? [] : v2Queries(ds, p.datasource_uid!, type, p.queries!),
              transformations: v2Transforms(tableTransforms(type, p.queries)),
              queryOptions: {},
            },
          },
          vizConfig: {
            kind: 'VizConfig',
            group: type,
            version: '',
            spec: {
              options: defaultOptions(type, p.content),
              fieldConfig: { defaults: mergeFieldDefaults({}, p), overrides: tableOverrides(type, p.queries) },
            },
          },
        },
      };
      const grid = v2TargetGrid(spec.layout, o.row, o.tab);
      if (!grid) {
        throw new OpError('This dashboard layout has no grid to add a panel to');
      }
      const size = defaultSize(type);
      placeInGrid(grid, key, clampW(p.width, size.w), clampH(p.height, size.h), o);
      spec.elements[key] = el;
      touched.add(key);
      const where = [o.tab && `tab "${o.tab}"`, o.row && `row "${o.row}"`].filter(Boolean).join(', ');
      changes.push({
        kind: 'add',
        text: `Add panel "${p.title}" (${type})${where ? ` in ${where}` : ''}`,
        detail: describePanel(p),
      });
    } else if (o.op === 'update_panel') {
      checkPanelSpec(o.changes, false);
      const el = spec.elements[o.panel_key];
      if (!el || el.kind !== 'Panel') {
        throw new OpError(`panel_key "${o.panel_key}" does not exist on this dashboard`);
      }
      const s = el.spec;
      const c = o.changes;
      const oldTitle = s.title;
      const before = describePanel({ queries: v2View(o.panel_key, el).queries.map((q) => ({ expr: q.expr })) });
      if (c.title !== undefined) {
        s.title = c.title;
      }
      if (c.description !== undefined) {
        s.description = c.description;
      }
      s.vizConfig = s.vizConfig ?? { kind: 'VizConfig', group: 'timeseries', version: '', spec: {} };
      if (c.type !== undefined && c.type !== s.vizConfig.group) {
        s.vizConfig.group = c.type;
        s.vizConfig.spec.options = defaultOptions(c.type, c.content ?? s.vizConfig.spec.options?.content);
      }
      if (c.content !== undefined) {
        s.vizConfig.spec.options = { ...(s.vizConfig.spec.options ?? {}), mode: 'markdown', content: c.content };
      }
      const current = s.data?.spec?.queries ?? [];
      const dsUid = c.datasource_uid ?? current[0]?.spec?.query?.datasource?.name;
      if (c.queries) {
        if (!dsUid) {
          throw new OpError(`Panel "${s.title}" has no data source; set datasource_uid`);
        }
        s.data = s.data ?? { kind: 'QueryGroup', spec: { transformations: [], queryOptions: {} } };
        s.data.spec.queries = v2Queries(ds, dsUid, s.vizConfig.group, c.queries);
        const tx = tableTransforms(s.vizConfig.group, c.queries);
        if (tx.length) {
          s.data.spec.transformations = v2Transforms(tx);
          s.vizConfig.spec.fieldConfig = {
            ...(s.vizConfig.spec.fieldConfig ?? { defaults: {} }),
            overrides: tableOverrides(s.vizConfig.group, c.queries),
          };
        }
      } else if (c.datasource_uid) {
        const type = dsTypeOf(ds, c.datasource_uid);
        for (const q of current) {
          q.spec.query.datasource = { name: c.datasource_uid };
          q.spec.query.group = type;
        }
      }
      const fc = s.vizConfig.spec.fieldConfig ?? { defaults: {}, overrides: [] };
      s.vizConfig.spec.fieldConfig = { ...fc, defaults: mergeFieldDefaults(fc.defaults, c) };
      if (c.width !== undefined || c.height !== undefined) {
        const item = v2Items(spec.layout).find((it) => it.spec?.element?.name === o.panel_key);
        if (item?.kind === 'GridLayoutItem') {
          item.spec.width = clampW(c.width, item.spec.width);
          item.spec.height = clampH(c.height, item.spec.height);
          const grid = findGridOf(spec.layout, item);
          if (grid) {
            normalizeGrid(grid.spec.items, o.panel_key);
          }
        }
      }
      touched.add(o.panel_key);
      changes.push({
        kind: 'update',
        text: `Change "${oldTitle}": ${updateSummary(c).join(', ')}${c.title && c.title !== oldTitle ? ` (now "${c.title}")` : ''}`,
        detail: c.queries ? `${before}\n→ ${describePanel(c)}` : undefined,
      });
    } else if (o.op === 'move_panel') {
      const el = spec.elements[o.panel_key];
      if (!el) {
        throw new OpError(`panel_key "${o.panel_key}" does not exist on this dashboard`);
      }
      const ownGrid = findGridOf(spec.layout, { spec: { element: { name: o.panel_key } } });
      const target = o.tab || o.row ? v2TargetGrid(spec.layout, o.row, o.tab) : null;
      const old = v2RemoveItem(spec.layout, o.panel_key);
      // Without a tab or row the panel stays in its own grid.
      const grid = target ?? ownGrid ?? v2TargetGrid(spec.layout);
      if (!grid) {
        throw new OpError('No grid to move the panel into');
      }
      const size = defaultSize(el.spec?.vizConfig?.group);
      const w = clampW(o.width, old?.spec?.width ?? size.w);
      const h = clampH(o.height, old?.spec?.height ?? size.h);
      if (ownGrid && ownGrid !== grid) {
        normalizeGrid(ownGrid.spec.items);
      }
      placeInGrid(grid, o.panel_key, w, h, {
        x: o.x ?? (target ? undefined : old?.spec?.x),
        y: o.y ?? (target ? undefined : old?.spec?.y),
      });
      const where = [o.tab && `tab "${o.tab}"`, o.row && `row "${o.row}"`].filter(Boolean).join(', ');
      const pos = o.x !== undefined || o.y !== undefined ? `x ${o.x ?? 0}, y ${o.y ?? 0}` : '';
      const sz = o.width !== undefined || o.height !== undefined ? `${w}×${h}` : '';
      changes.push({
        kind: 'other',
        text: `Move "${el.spec?.title ?? o.panel_key}"${where ? ` to ${where}` : ''}${pos ? ` at ${pos}` : ''}${sz ? `, size ${sz}` : ''}`,
      });
    } else if (o.op === 'add_tab') {
      if (!o.title?.trim()) {
        throw new OpError('add_tab needs a title');
      }
      if (spec.layout.kind !== 'TabsLayout') {
        wrapInPlace(spec.layout, 'TabsLayout', o.existing_title || 'Overview');
        if (children(spec.layout).length) {
          changes.push({ kind: 'other', text: `Put the existing panels in tab "${o.existing_title || 'Overview'}"` });
        }
      }
      if (children(spec.layout).some((t) => sameTitle(t.spec?.title, o.title))) {
        throw new OpError(`Tab "${o.title}" already exists`);
      }
      spec.layout.spec.tabs.push({ kind: 'TabsLayoutTab', spec: { title: o.title.trim(), layout: emptyGrid() } });
      changes.push({ kind: 'add', text: `Add tab "${o.title.trim()}"` });
    } else if (o.op === 'add_row') {
      if (!o.title?.trim()) {
        throw new OpError('add_row needs a title');
      }
      let scope = scopeLayout(spec.layout, o.tab);
      if (scope.kind === 'TabsLayout') {
        throw new OpError(`This dashboard has tabs; say which tab the row "${o.title}" goes in`);
      }
      if (isGrid(scope)) {
        wrapInPlace(scope, 'RowsLayout', o.existing_title || 'Overview');
        if (children(scope).length) {
          changes.push({ kind: 'other', text: `Put the existing panels in row "${o.existing_title || 'Overview'}"` });
        }
      }
      if (children(scope).some((r) => sameTitle(r.spec?.title, o.title))) {
        throw new OpError(`Row "${o.title}" already exists`);
      }
      scope.spec.rows.push({
        kind: 'RowsLayoutRow',
        spec: { title: o.title.trim(), collapse: Boolean(o.collapsed), layout: emptyGrid() },
      });
      changes.push({ kind: 'add', text: `Add row "${o.title.trim()}"${o.tab ? ` in tab "${o.tab}"` : ''}` });
    } else if (o.op === 'rename_container') {
      const c = findContainer(spec.layout, o.tab, o.row);
      changes.push({ kind: 'other', text: `Rename ${o.row ? 'row' : 'tab'} "${c.item.spec.title}" → "${o.title}"` });
      c.item.spec.title = o.title;
    } else if (o.op === 'remove_container') {
      const c = findContainer(spec.layout, o.tab, o.row);
      const inside = v2Items(c.item.spec.layout).length;
      if (inside) {
        throw new OpError(
          `${o.row ? 'Row' : 'Tab'} "${c.item.spec.title}" still has ${inside} panel(s); move or remove them first`
        );
      }
      c.list.splice(c.index, 1);
      changes.push({ kind: 'remove', text: `Remove ${o.row ? 'row' : 'tab'} "${c.item.spec.title}"` });
    } else if (o.op === 'remove_panel') {
      const el = spec.elements[o.panel_key];
      if (!el) {
        throw new OpError(`panel_key "${o.panel_key}" does not exist on this dashboard`);
      }
      const grid = findGridOf(spec.layout, { spec: { element: { name: o.panel_key } } });
      delete spec.elements[o.panel_key];
      v2RemoveItem(spec.layout, o.panel_key);
      if (grid) {
        normalizeGrid(grid.spec.items);
      }
      touched.delete(o.panel_key);
      changes.push({ kind: 'remove', text: `Remove panel "${el.spec?.title ?? o.panel_key}"` });
    } else {
      applyCommon(spec, o, changes, 'v2', ds);
    }
  }
  const views = [...touched].filter((k) => spec.elements[k]).map((k) => v2View(k, spec.elements[k]));
  return { spec, changes, touched: views };
}

// ---------------------------------------------------------------- layout facts

export interface PanelPlace {
  tab?: string;
  row?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** Where every panel sits: its tab, row and grid position. Also returns each grid's items for layout notes. */
export function panelPlaces(layout: Json): {
  places: Record<string, PanelPlace>;
  grids: Array<{ where: string; items: Json[]; auto: boolean }>;
} {
  const places: Record<string, PanelPlace> = {};
  const grids: Array<{ where: string; items: Json[]; auto: boolean }> = [];
  const walk = (l: Json, tab?: string, row?: string, depth = 0) => {
    if (!l || depth > 6) {
      return;
    }
    if (l.kind === 'GridLayout' || l.kind === 'AutoGridLayout') {
      const items: Json[] = l.spec?.items ?? [];
      grids.push({
        where: [tab && `tab "${tab}"`, row && `row "${row}"`].filter(Boolean).join(', ') || 'dashboard',
        items,
        auto: l.kind === 'AutoGridLayout',
      });
      for (const it of items) {
        const sp = it.spec ?? {};
        const key = sp.element?.name;
        if (key) {
          places[key] = { tab, row, x: sp.x, y: sp.y, w: sp.width, h: sp.height };
        }
      }
      return;
    }
    for (const item of l.spec?.tabs ?? []) {
      walk(item?.spec?.layout, item?.spec?.title, row, depth + 1);
    }
    for (const item of l.spec?.rows ?? []) {
      walk(item?.spec?.layout, tab, item?.spec?.title, depth + 1);
    }
  };
  walk(layout);
  return { places, grids };
}

const NEEDS_UNIT = new Set(['timeseries', 'stat', 'gauge', 'bargauge', 'barchart']);

/** Short, factual hints for "optimize this dashboard" (the model decides what to change). */
export function layoutNotes(spec: Json): string[] {
  const notes: string[] = [];
  const { grids } = panelPlaces(spec.layout);
  for (const g of grids) {
    if (g.auto) {
      continue;
    }
    const lines = new Map<number, number>();
    for (const it of g.items) {
      const y = it.spec?.y ?? 0;
      lines.set(y, (lines.get(y) ?? 0) + (it.spec?.width ?? 0));
    }
    for (const [y, width] of lines) {
      if (width < 24) {
        notes.push(`${g.where}: the line at y ${y} uses ${width} of 24 columns`);
      }
    }
    if (g.items.length > 16) {
      notes.push(`${g.where}: ${g.items.length} panels in one grid; consider rows or tabs`);
    }
  }
  for (const [key, el] of Object.entries<Json>(spec.elements ?? {})) {
    const s = el.spec ?? {};
    const type = s.vizConfig?.group;
    if (NEEDS_UNIT.has(type) && !s.vizConfig?.spec?.fieldConfig?.defaults?.unit) {
      notes.push(`${key} "${s.title}" (${type}) has no unit`);
    }
    if (type !== 'text' && !String(s.title ?? '').trim()) {
      notes.push(`${key} (${type}) has no title`);
    }
  }
  return notes.slice(0, 20);
}

// ---------------------------------------------------------------- operations shared by both schemas

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;

function applyCommon(spec: Json, o: Operation, changes: ChangeLine[], schema: 'v1' | 'v2', ds: DsTypes) {
  if (o.op === 'set_title') {
    if (!o.title?.trim()) {
      throw new OpError('set_title needs a title');
    }
    changes.push({ kind: 'other', text: `Rename dashboard "${spec.title}" → "${o.title}"` });
    spec.title = o.title.trim();
  } else if (o.op === 'set_time') {
    if (schema === 'v1') {
      spec.time = { from: o.from, to: o.to };
    } else {
      spec.timeSettings = { ...(spec.timeSettings ?? {}), from: o.from, to: o.to };
    }
    changes.push({ kind: 'other', text: `Default time range ${o.from} to ${o.to}` });
  } else if (o.op === 'add_variable') {
    if (!VAR_NAME.test(o.name ?? '') || o.name.startsWith('__')) {
      throw new OpError(`Invalid variable name "${o.name}"`);
    }
    const existing = schema === 'v1' ? v1Variables(spec) : v2Variables(spec);
    if (existing.some((v) => (v.name ?? v.spec?.name) === o.name)) {
      throw new OpError(`Variable "${o.name}" already exists`);
    }
    const kind: VariableKind = o.kind ?? 'query';
    const multi = kind === 'datasource' ? false : o.multi !== false && kind !== 'textbox';
    const includeAll = o.include_all ?? (multi && kind === 'query');
    const label = o.label ?? o.name;
    const hide = o.hide ? 'hideVariable' : 'dontHide';
    const csv = String(o.query ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const options = csv.map((v) => {
      const [text, value] = v.includes(' : ') ? v.split(' : ').map((x) => x.trim()) : [v, v];
      return { text, value, selected: false };
    });
    const first = options[0] ? { text: options[0].text, value: options[0].value } : { text: '', value: '' };
    const allOrFirst = includeAll ? { text: 'All', value: '$__all' } : first;
    let detail = o.query ?? '';
    if (kind === 'query') {
      if (!o.datasource_uid || !o.query) {
        throw new OpError(`Query variable "${o.name}" needs datasource_uid and query`);
      }
      const type = dsTypeOf(ds, o.datasource_uid);
      if (schema === 'v1') {
        pushV1Var(spec, {
          type: 'query',
          name: o.name,
          label,
          hide: o.hide ? 2 : 0,
          datasource: { type, uid: o.datasource_uid },
          query: o.query,
          definition: o.query,
          regex: o.regex ?? '',
          refresh: 2,
          multi,
          includeAll,
          current: includeAll ? { text: 'All', value: '$__all' } : {},
          options: [],
          sort: 1,
        });
      } else {
        pushV2Var(spec, {
          kind: 'QueryVariable',
          spec: {
            name: o.name,
            label,
            hide,
            refresh: 'onTimeRangeChanged',
            skipUrlSync: false,
            query: {
              kind: 'DataQuery',
              group: type,
              version: 'v0',
              datasource: { name: o.datasource_uid },
              spec: { query: o.query, refId: 'v' },
            },
            definition: o.query,
            regex: o.regex ?? '',
            sort: 'alphabeticalAsc',
            current: includeAll ? { text: 'All', value: '$__all' } : { text: '', value: '' },
            options: [],
            multi,
            includeAll,
            allowCustomValue: true,
          },
        });
      }
    } else if (kind === 'custom') {
      if (!options.length) {
        throw new OpError(`Custom variable "${o.name}" needs query as comma-separated values`);
      }
      if (schema === 'v1') {
        pushV1Var(spec, {
          type: 'custom',
          name: o.name,
          label,
          hide: o.hide ? 2 : 0,
          query: o.query,
          multi,
          includeAll,
          current: allOrFirst,
          options,
        });
      } else {
        pushV2Var(spec, {
          kind: 'CustomVariable',
          spec: {
            name: o.name,
            label,
            hide,
            skipUrlSync: false,
            query: o.query,
            current: allOrFirst,
            options,
            multi,
            includeAll,
            allowCustomValue: true,
          },
        });
      }
    } else if (kind === 'datasource') {
      const pluginId = String(o.ds_type ?? '');
      if (!/^[a-z0-9-]+$/.test(pluginId)) {
        throw new OpError(`Data source variable "${o.name}" needs ds_type, e.g. "prometheus"`);
      }
      // Panels can now use datasource_uid "${name}".
      ds[`\${${o.name}}`] = pluginId;
      ds[`$${o.name}`] = pluginId;
      detail = `${pluginId} data sources${o.regex ? ` matching ${o.regex}` : ''}`;
      if (schema === 'v1') {
        pushV1Var(spec, {
          type: 'datasource',
          name: o.name,
          label,
          hide: o.hide ? 2 : 0,
          query: pluginId,
          regex: o.regex ?? '',
          refresh: 1,
          multi: false,
          includeAll: false,
          current: {},
          options: [],
        });
      } else {
        pushV2Var(spec, {
          kind: 'DatasourceVariable',
          spec: {
            name: o.name,
            label,
            hide,
            skipUrlSync: false,
            pluginId,
            regex: o.regex ?? '',
            refresh: 'onDashboardLoad',
            current: { text: '', value: '' },
            options: [],
            multi: false,
            includeAll: false,
            allowCustomValue: false,
          },
        });
      }
    } else {
      if (schema === 'v1') {
        pushV1Var(spec, {
          type: 'textbox',
          name: o.name,
          label,
          hide: o.hide ? 2 : 0,
          query: o.query ?? '',
          current: { text: o.query ?? '', value: o.query ?? '' },
        });
      } else {
        pushV2Var(spec, {
          kind: 'TextVariable',
          spec: {
            name: o.name,
            label,
            hide,
            skipUrlSync: false,
            query: o.query ?? '',
            current: { text: o.query ?? '', value: o.query ?? '' },
          },
        });
      }
    }
    changes.push({ kind: 'add', text: `Add ${kind} variable $${o.name}`, detail });
  } else {
    throw new OpError(`Unknown operation ${JSON.stringify((o as Json).op)}`);
  }
}

function pushV1Var(spec: Json, v: Json) {
  spec.templating = spec.templating ?? { list: [] };
  spec.templating.list = [...(spec.templating.list ?? []), v];
}

function pushV2Var(spec: Json, v: Json) {
  spec.variables = [...(spec.variables ?? []), v];
}

// ---------------------------------------------------------------- new dashboards

export function emptyV1Dashboard(title: string): Json {
  return {
    title,
    description: '',
    tags: [],
    editable: true,
    schemaVersion: 42,
    time: { from: 'now-6h', to: 'now' },
    timepicker: {},
    timezone: 'browser',
    refresh: '',
    graphTooltip: 1,
    panels: [],
    templating: { list: [] },
    annotations: { list: [] },
    links: [],
  };
}

export function emptyV2Dashboard(title: string): Json {
  return {
    title,
    description: '',
    tags: [],
    editable: true,
    cursorSync: 'Crosshair',
    liveNow: false,
    preload: false,
    links: [],
    annotations: [],
    variables: [],
    elements: {},
    layout: { kind: 'GridLayout', spec: { items: [] } },
    timeSettings: {
      from: 'now-6h',
      to: 'now',
      timezone: 'browser',
      autoRefresh: '',
      autoRefreshIntervals: ['5s', '10s', '30s', '1m', '5m', '15m', '30m', '1h', '2h', '1d'],
      fiscalYearStartMonth: 0,
      hideTimepicker: false,
    },
  };
}

// ---------------------------------------------------------------- validation helpers

/** Current value of each dashboard variable, as used to run a query for checking. */
export function variableValues(spec: Json, schema: 'v1' | 'v2'): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const list = schema === 'v1' ? v1Variables(spec) : v2Variables(spec);
  for (const v of list) {
    const name = v.name ?? v.spec?.name;
    const cur = v.current ?? v.spec?.current;
    if (!name) {
      continue;
    }
    const value = cur?.value;
    out[name] = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  }
  return out;
}

/**
 * Make a dashboard query runnable outside the dashboard: built-in interval variables get fixed values, and
 * dashboard variables get their current value, or ".+" when it is "All" or several values.
 */
export function substituteVariables(expr: string, values: Record<string, string | undefined>): string {
  // label="$var" with no single value to put in: check with any value instead (label=~".+").
  for (const [name, v] of Object.entries(values)) {
    if (v === undefined || v === '' || v === '$__all') {
      const ref = `\\$(?:\\{${name}(?::\\w+)?\\}|${name}\\b)`;
      expr = expr.replace(new RegExp(`([\\w.]+)\\s*=\\s*"${ref}"`, 'g'), '$1=~".+"');
    }
  }
  return expr
    .replace(/\$__rate_interval|\$\{__rate_interval\}/g, '2m')
    .replace(/\$__interval_ms|\$\{__interval_ms\}/g, '60000')
    .replace(/\$__interval|\$\{__interval\}/g, '1m')
    .replace(/\$__range|\$\{__range\}/g, '1h')
    .replace(/\$\{(\w+)(?::\w+)?\}|\$(\w+)|\[\[(\w+)\]\]/g, (m, a, b, c) => {
      const name = a ?? b ?? c;
      if (name.startsWith('__')) {
        return m;
      }
      const v = values[name];
      if (v === undefined && !(name in values)) {
        return m;
      }
      // ".+" rather than ".*": Loki rejects a stream selector that can match nothing but empty labels.
      return v === undefined || v === '' || v === '$__all' ? '.+' : v;
    });
}

/** Variables that can hold several values (multi-select or "All"). */
export function multiValueVariables(spec: Json, schema: 'v1' | 'v2'): string[] {
  const list: Json[] = schema === 'v1' ? (spec.templating?.list ?? []) : (spec.variables ?? []);
  return list
    .map((v) => (schema === 'v1' ? v : v.spec))
    .filter((s) => s && (s.multi || s.includeAll))
    .map((s) => s.name);
}

/**
 * Panels whose queries compare a label with "=" to a variable that can hold several values. Grafana turns
 * several values (or "All") into a regex, so "=" never matches and the panel shows no data.
 */
export function exactMatchOnMultiValue(views: PanelView[], multi: string[]): string[] {
  const out: string[] = [];
  for (const v of views) {
    for (const name of multi) {
      const re = new RegExp(`[\\w.]+\\s*=\\s*"\\$(?:\\{${name}(?::\\w+)?\\}|${name}\\b)"`);
      if (v.queries.some((q) => re.test(q.expr))) {
        out.push(`"${v.title}" uses ="$${name}"`);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- where a change is saved

export type SaveTarget = 'in_place' | 'copy' | 'new';

const MANAGERS: Record<string, string> = {
  'classic-file-provisioning': 'from files',
  terraform: 'by Terraform',
  kubectl: 'with kubectl',
  plugin: 'by a plugin',
};

export function saveTarget(meta: { managedBy?: string; canSave: boolean } | null): {
  target: SaveTarget;
  reason?: string;
} {
  if (!meta) {
    return { target: 'new' };
  }
  if (meta.managedBy === 'repo') {
    return {
      target: 'copy',
      reason: 'This dashboard is managed by Git Sync; changing it needs a pull request, so Apply saves a copy.',
    };
  }
  if (meta.managedBy) {
    return {
      target: 'copy',
      reason: `This dashboard is provisioned ${MANAGERS[meta.managedBy] ?? `by ${meta.managedBy}`}, so a change saved here would be overwritten. Apply saves a copy.`,
    };
  }
  if (!meta.canSave) {
    return { target: 'copy', reason: 'You cannot save this dashboard, so Apply saves a copy.' };
  }
  return { target: 'in_place' };
}

/** Normalise model-supplied operations: accept only known ops and fields. */
export function parseOperations(raw: unknown): Operation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OpError('operations must be a non-empty array');
  }
  if (raw.length > MAX_OPERATIONS) {
    throw new OpError(`At most ${MAX_OPERATIONS} operations per proposal`);
  }
  const str = (v: unknown, max = 200) => (v === undefined || v === null ? undefined : String(v).slice(0, max));
  const num = (v: unknown) => (v === undefined || v === null || !isFinite(Number(v)) ? undefined : Number(v));
  const place = (o: Json): Placement => ({ tab: str(o.tab), row: str(o.row), x: num(o.x), y: num(o.y) });
  return raw.map((item: Json) => {
    const o = normaliseOp(item);
    switch (o?.op) {
      case 'add_panel':
        return { op: 'add_panel', panel: pickPanel(o.panel), ...place(o) };
      case 'update_panel':
        return { op: 'update_panel', panel_key: String(o.panel_key ?? ''), changes: pickPanel(o.changes) };
      case 'remove_panel':
        return { op: 'remove_panel', panel_key: String(o.panel_key ?? '') };
      case 'move_panel':
        return {
          op: 'move_panel',
          panel_key: String(o.panel_key ?? ''),
          ...place(o),
          width: num(o.width),
          height: num(o.height),
        };
      case 'add_tab':
        return { op: 'add_tab', title: String(o.title ?? ''), existing_title: str(o.existing_title) };
      case 'add_row':
        return {
          op: 'add_row',
          title: String(o.title ?? ''),
          tab: str(o.tab),
          collapsed: o.collapsed === undefined ? undefined : Boolean(o.collapsed),
          existing_title: str(o.existing_title),
        };
      case 'rename_container':
        return { op: 'rename_container', tab: str(o.tab), row: str(o.row), title: String(o.title ?? '') };
      case 'remove_container':
        return { op: 'remove_container', tab: str(o.tab), row: str(o.row) };
      case 'add_variable': {
        const kind = ['query', 'custom', 'datasource', 'textbox'].includes(o.kind) ? o.kind : undefined;
        return {
          op: 'add_variable',
          name: String(o.name ?? ''),
          label: str(o.label),
          kind,
          datasource_uid: str(o.datasource_uid),
          query: str(o.query, 2000),
          ds_type: str(o.ds_type),
          regex: str(o.regex, 500),
          multi: o.multi === undefined ? undefined : Boolean(o.multi),
          include_all: o.include_all === undefined ? undefined : Boolean(o.include_all),
          hide: o.hide === undefined ? undefined : Boolean(o.hide),
        };
      }
      case 'set_time':
        return { op: 'set_time', from: String(o.from ?? 'now-6h'), to: String(o.to ?? 'now') };
      case 'set_title':
        return { op: 'set_title', title: String(o.title ?? '') };
      default:
        throw new OpError(`Unknown operation ${JSON.stringify(o?.op)}`);
    }
  });
}

const OP_NAMES = [
  'add_panel',
  'update_panel',
  'remove_panel',
  'move_panel',
  'add_tab',
  'add_row',
  'rename_container',
  'remove_container',
  'add_variable',
  'set_time',
  'set_title',
];

/** Models write operations in a few shapes: {op}, {action|type: op}, or {add_panel: {...}}. Accept all of them. */
function normaliseOp(item: Json): Json {
  if (!item || typeof item !== 'object') {
    return item;
  }
  if (typeof item.op === 'string') {
    return item;
  }
  for (const k of ['action', 'operation', 'type']) {
    if (typeof item[k] === 'string' && OP_NAMES.includes(item[k])) {
      return { ...item, op: item[k] };
    }
  }
  const keys = Object.keys(item);
  if (keys.length === 1 && OP_NAMES.includes(keys[0]) && item[keys[0]] && typeof item[keys[0]] === 'object') {
    return { op: keys[0], ...item[keys[0]] };
  }
  return item;
}

function pickPanel(raw: unknown): PanelSpec {
  const p = (raw ?? {}) as Json;
  const out: PanelSpec = {};
  const str = (k: keyof PanelSpec, max: number) => {
    if (p[k] !== undefined) {
      (out as Json)[k] = String(p[k]).slice(0, max);
    }
  };
  str('title', 200);
  str('description', 1000);
  str('datasource_uid', 200);
  str('unit', 50);
  str('content', 5000);
  str('threshold_style', 20);
  if (p.type !== undefined) {
    out.type = String(p.type) as PanelType;
  }
  for (const k of ['decimals', 'min', 'max', 'width', 'height'] as const) {
    if (p[k] !== undefined && p[k] !== null && isFinite(Number(p[k]))) {
      out[k] = Number(p[k]);
    }
  }
  if (p.stack !== undefined) {
    out.stack = Boolean(p.stack);
  }
  if (Array.isArray(p.queries)) {
    out.queries = p.queries.map((q: Json) => ({
      expr: String(typeof q === 'string' ? q : (q?.expr ?? '')).slice(0, 4000),
      legend: q?.legend ? String(q.legend).slice(0, 200) : undefined,
      ...(q?.name ? { name: String(q.name).slice(0, 100) } : {}),
      ...(q?.unit ? { unit: String(q.unit).slice(0, 50) } : {}),
    }));
  }
  if (Array.isArray(p.thresholds)) {
    out.thresholds = p.thresholds.slice(0, 5).map((t: Json) => ({ value: Number(t?.value), color: String(t?.color) }));
  }
  return out;
}
