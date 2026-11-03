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
] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

export interface PanelQuery {
  expr: string;
  legend?: string;
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
}

export type Operation =
  | { op: 'add_panel'; panel: PanelSpec; row?: string }
  | { op: 'update_panel'; panel_key: string; changes: PanelSpec }
  | { op: 'remove_panel'; panel_key: string }
  | { op: 'add_variable'; name: string; label?: string; datasource_uid: string; query: string; multi?: boolean }
  | { op: 'set_time'; from: string; to: string }
  | { op: 'set_title'; title: string };

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

export const MAX_OPERATIONS = 30;
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
    default:
      return { w: 12, h: 8 };
  }
}

const clampW = (w: unknown, dflt: number) => Math.max(2, Math.min(GRID_COLUMNS, Math.round(Number(w) || dflt)));
const clampH = (h: unknown, dflt: number) => Math.max(2, Math.min(40, Math.round(Number(h) || dflt)));

function checkPanelSpec(p: PanelSpec, isNew: boolean) {
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
  if (p.stack !== undefined) {
    d.custom = { ...(d.custom ?? {}), stacking: { mode: p.stack ? 'normal' : 'none', group: 'A' } };
  }
  return d;
}

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
    return { query: q.expr, queryType: 'traceql', limit: 20 };
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
  const q = p.queries?.map((x) => x.expr).join('\n');
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

/** The grid a new panel goes into: inside the row or tab with this title, otherwise the last grid in the layout. */
export function v2TargetGrid(layout: Json, row?: string): GridTarget | null {
  let last: GridTarget | null = null;
  let named: GridTarget | null = null;
  const walk = (l: Json, inNamed: boolean) => {
    if (!l) {
      return;
    }
    if (l.kind === 'GridLayout' || l.kind === 'AutoGridLayout') {
      l.spec = l.spec ?? {};
      l.spec.items = l.spec.items ?? [];
      last = l as GridTarget;
      if (inNamed && !named) {
        named = l as GridTarget;
      }
      return;
    }
    for (const item of l.spec?.rows ?? l.spec?.tabs ?? []) {
      walk(item?.spec?.layout, inNamed || (Boolean(row) && item?.spec?.title === row));
    }
  };
  walk(layout, false);
  return named ?? last;
}

function v2Items(layout: Json): Json[] {
  const out: Json[] = [];
  const walk = (l: Json) => {
    if (!l) {
      return;
    }
    if (l.kind === 'GridLayout' || l.kind === 'AutoGridLayout') {
      out.push(...(l.spec?.items ?? []));
      return;
    }
    for (const item of l.spec?.rows ?? l.spec?.tabs ?? []) {
      walk(item?.spec?.layout);
    }
  };
  walk(layout);
  return out;
}

function v2RemoveItem(layout: Json, key: string) {
  const walk = (l: Json) => {
    if (!l) {
      return;
    }
    if (l.kind === 'GridLayout' || l.kind === 'AutoGridLayout') {
      l.spec.items = (l.spec?.items ?? []).filter((it: Json) => it.spec?.element?.name !== key);
      return;
    }
    for (const item of l.spec?.rows ?? l.spec?.tabs ?? []) {
      walk(item?.spec?.layout);
    }
  };
  walk(layout);
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
              transformations: [],
              queryOptions: {},
            },
          },
          vizConfig: {
            kind: 'VizConfig',
            group: type,
            version: '',
            spec: {
              options: defaultOptions(type, p.content),
              fieldConfig: { defaults: mergeFieldDefaults({}, p), overrides: [] },
            },
          },
        },
      };
      const grid = v2TargetGrid(spec.layout, o.row);
      if (!grid) {
        throw new OpError('This dashboard layout has no grid to add a panel to');
      }
      const ref = { kind: 'ElementReference', name: key };
      if (grid.kind === 'AutoGridLayout') {
        grid.spec.items.push({ kind: 'AutoGridLayoutItem', spec: { element: ref } });
      } else {
        const size = defaultSize(type);
        const w = clampW(p.width, size.w);
        const h = clampH(p.height, size.h);
        const items: Json[] = grid.spec.items;
        const bottom = Math.max(0, ...items.map((it) => (it.spec?.y ?? 0) + (it.spec?.height ?? 0)));
        // Fill the last line if there is room, otherwise start a new one.
        const lastLine = items.filter((it) => (it.spec?.y ?? 0) + (it.spec?.height ?? 0) === bottom);
        const lineY = lastLine.length ? Math.min(...lastLine.map((it) => it.spec.y ?? 0)) : bottom;
        const lineEnd = Math.max(
          0,
          ...items.filter((it) => (it.spec?.y ?? 0) === lineY).map((it) => (it.spec?.x ?? 0) + (it.spec?.width ?? 0))
        );
        const fits = lastLine.length > 0 && lineEnd + w <= GRID_COLUMNS && items.length > 0;
        items.push({
          kind: 'GridLayoutItem',
          spec: { x: fits ? lineEnd : 0, y: fits ? lineY : bottom, width: w, height: h, element: ref },
        });
      }
      spec.elements[key] = el;
      touched.add(key);
      changes.push({ kind: 'add', text: `Add panel "${p.title}" (${type})`, detail: describePanel(p) });
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
        }
      }
      touched.add(o.panel_key);
      changes.push({
        kind: 'update',
        text: `Change "${oldTitle}": ${updateSummary(c).join(', ')}${c.title && c.title !== oldTitle ? ` (now "${c.title}")` : ''}`,
        detail: c.queries ? `${before}\n→ ${describePanel(c)}` : undefined,
      });
    } else if (o.op === 'remove_panel') {
      const el = spec.elements[o.panel_key];
      if (!el) {
        throw new OpError(`panel_key "${o.panel_key}" does not exist on this dashboard`);
      }
      delete spec.elements[o.panel_key];
      v2RemoveItem(spec.layout, o.panel_key);
      touched.delete(o.panel_key);
      changes.push({ kind: 'remove', text: `Remove panel "${el.spec?.title ?? o.panel_key}"` });
    } else {
      applyCommon(spec, o, changes, 'v2', ds);
    }
  }
  const views = [...touched].filter((k) => spec.elements[k]).map((k) => v2View(k, spec.elements[k]));
  return { spec, changes, touched: views };
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
    const type = dsTypeOf(ds, o.datasource_uid);
    const multi = o.multi !== false;
    if (schema === 'v1') {
      spec.templating = spec.templating ?? { list: [] };
      spec.templating.list = [
        ...(spec.templating.list ?? []),
        {
          type: 'query',
          name: o.name,
          label: o.label ?? o.name,
          datasource: { type, uid: o.datasource_uid },
          query: o.query,
          definition: o.query,
          refresh: 2,
          multi,
          includeAll: multi,
          current: multi ? { text: 'All', value: '$__all' } : {},
          options: [],
          sort: 1,
        },
      ];
    } else {
      spec.variables = [
        ...(spec.variables ?? []),
        {
          kind: 'QueryVariable',
          spec: {
            name: o.name,
            label: o.label ?? o.name,
            hide: 'dontHide',
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
            regex: '',
            sort: 'alphabeticalAsc',
            current: multi ? { text: 'All', value: '$__all' } : { text: '', value: '' },
            options: [],
            multi,
            includeAll: multi,
            allowCustomValue: true,
          },
        },
      ];
    }
    changes.push({ kind: 'add', text: `Add variable $${o.name}`, detail: o.query });
  } else {
    throw new OpError(`Unknown operation ${JSON.stringify((o as Json).op)}`);
  }
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
 * dashboard variables get their current value, or ".*" when it is "All" or several values.
 */
export function substituteVariables(expr: string, values: Record<string, string | undefined>): string {
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
      return v === undefined || v === '' || v === '$__all' ? '.*' : v;
    });
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
  return raw.map((item: Json) => {
    const o = normaliseOp(item);
    switch (o?.op) {
      case 'add_panel':
        return { op: 'add_panel', panel: pickPanel(o.panel), row: o.row ? String(o.row) : undefined };
      case 'update_panel':
        return { op: 'update_panel', panel_key: String(o.panel_key ?? ''), changes: pickPanel(o.changes) };
      case 'remove_panel':
        return { op: 'remove_panel', panel_key: String(o.panel_key ?? '') };
      case 'add_variable':
        return {
          op: 'add_variable',
          name: String(o.name ?? ''),
          label: o.label ? String(o.label) : undefined,
          datasource_uid: String(o.datasource_uid ?? ''),
          query: String(o.query ?? ''),
          multi: o.multi === undefined ? undefined : Boolean(o.multi),
        };
      case 'set_time':
        return { op: 'set_time', from: String(o.from ?? 'now-6h'), to: String(o.to ?? 'now') };
      case 'set_title':
        return { op: 'set_title', title: String(o.title ?? '') };
      default:
        throw new OpError(`Unknown operation ${JSON.stringify(o?.op)}`);
    }
  });
}

const OP_NAMES = ['add_panel', 'update_panel', 'remove_panel', 'add_variable', 'set_time', 'set_title'];

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
    }));
  }
  if (Array.isArray(p.thresholds)) {
    out.thresholds = p.thresholds.slice(0, 5).map((t: Json) => ({ value: Number(t?.value), color: String(t?.color) }));
  }
  return out;
}
