// Dashboard building and editing (docs/design/dashboard-editing.md).
// propose_dashboard_change only reads: it builds the changed dashboard in memory, runs the new queries and keeps
// a proposal. Saving happens only when the user clicks Apply in the chat UI (applyProposal); the model has no
// way to call it.
import { llm } from '@grafana/llm';
import { config, getBackendSrv, locationService } from '@grafana/runtime';
import {
  applyV1,
  applyV2,
  ApplyResult,
  ChangeLine,
  DsTypes,
  emptyV1Dashboard,
  Json,
  OpError,
  Operation,
  PanelView,
  parseOperations,
  saveTarget,
  SaveTarget,
  substituteVariables,
  variableValues,
} from './dashboardOps';

export const NAMESPACE = (): string => (config as Json).namespace || 'default';
type ApiVersion = 'v1beta1' | 'v2';
const api = (v: ApiVersion, uid?: string) =>
  `/apis/dashboard.grafana.app/${v}/namespaces/${NAMESPACE()}/dashboards${uid ? `/${encodeURIComponent(uid)}` : ''}`;

const PANEL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    type: {
      type: 'string',
      enum: ['timeseries', 'stat', 'gauge', 'bargauge', 'table', 'barchart', 'piechart', 'heatmap', 'logs', 'text'],
    },
    datasource_uid: { type: 'string' },
    queries: {
      type: 'array',
      items: {
        type: 'object',
        properties: { expr: { type: 'string' }, legend: { type: 'string' } },
        required: ['expr'],
      },
    },
    unit: { type: 'string' },
    description: { type: 'string' },
    decimals: { type: 'number' },
    min: { type: 'number' },
    max: { type: 'number' },
    thresholds: {
      type: 'array',
      items: { type: 'object', properties: { value: { type: 'number' }, color: { type: 'string' } } },
    },
    stack: { type: 'boolean' },
    width: { type: 'number' },
    height: { type: 'number' },
    content: { type: 'string' },
  },
};

export const PROPOSE_TOOL: llm.Tool = {
  type: 'function',
  function: {
    name: 'propose_dashboard_change',
    description:
      'Propose creating a dashboard (omit dashboard_uid) or changing one (dashboard_uid from the context or ' +
      'search_dashboards). Nothing is saved: the user sees the change with live previews and decides with an Apply ' +
      'button. Every query is run first; a failing query returns an error for you to fix. Discover metric and ' +
      'label names before writing queries. Use panel keys from get_dashboard for update_panel/remove_panel. Each ' +
      'call replaces the previous unapplied proposal, so include every operation the user still wants. ' +
      'Operations: add_panel {panel, row?}, update_panel {panel_key, changes}, remove_panel {panel_key}, ' +
      'add_variable {name, label, datasource_uid, query e.g. "label_values(metric, service)"}, set_time {from, to}, ' +
      'set_title {title}. A panel (or changes): {title, type: timeseries|stat|gauge|bargauge|table|barchart|' +
      'piechart|heatmap|logs|text, datasource_uid, queries: [{expr, legend}], unit (Grafana unit id such as ' +
      'reqps, percentunit, s, ms, bytes, short), description, decimals, min, max, thresholds: [{value, color}], ' +
      'stack, width (1-24), height, content (Markdown, text panels only)}. Use dashboard variables like ' +
      '$service in queries when the dashboard has them, and $__rate_interval in rate().',
    parameters: {
      type: 'object',
      properties: {
        dashboard_uid: { type: 'string', description: 'Dashboard to change; omit to create a new dashboard' },
        title: { type: 'string', description: 'Title for a new dashboard' },
        folder_uid: { type: 'string', description: 'Folder for a new dashboard (optional)' },
        summary: { type: 'string', description: 'One line describing the change, used as the version message' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['add_panel', 'update_panel', 'remove_panel', 'add_variable', 'set_time', 'set_title'],
              },
              panel: PANEL_SCHEMA,
              row: { type: 'string' },
              panel_key: { type: 'string' },
              changes: PANEL_SCHEMA,
              name: { type: 'string' },
              label: { type: 'string' },
              datasource_uid: { type: 'string' },
              query: { type: 'string' },
              multi: { type: 'boolean' },
              from: { type: 'string' },
              to: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['op'],
          },
        },
      },
      required: ['operations'],
      additionalProperties: false,
    },
  },
};

export type ProposalStatus = 'pending' | 'applying' | 'applied' | 'discarded' | 'superseded' | 'undone' | 'error';

export interface PanelCheck {
  key: string;
  title: string;
  result: 'data' | 'no data' | 'not checked';
  series?: number;
}

export interface Proposal {
  id: string;
  target: SaveTarget;
  reason?: string;
  title: string;
  sourceUid?: string;
  sourceTitle?: string;
  apiVersion: ApiVersion;
  /** The saved resource the proposal was built from (edits only). */
  before?: Json;
  after: Json;
  folderUid?: string;
  summary: string;
  changes: ChangeLine[];
  previews: PanelView[];
  checks: PanelCheck[];
  /** Current dashboard variable values, used to run preview queries. */
  vars: Record<string, string | undefined>;
  status: ProposalStatus;
  error?: string;
  savedUid?: string;
  savedResourceVersion?: string;
}

// ---------------------------------------------------------------- proposal store

const proposals = new Map<string, Proposal>();
const listeners = new Set<() => void>();
const notesForModel: string[] = [];
let counter = 0;

function put(p: Proposal) {
  proposals.set(p.id, p);
  listeners.forEach((l) => l());
}

function patch(id: string, change: Partial<Proposal>) {
  const p = proposals.get(id);
  if (p) {
    put({ ...p, ...change });
  }
}

export function subscribeProposals(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getProposal(id: string): Proposal | undefined {
  return proposals.get(id);
}

/** What the user did with proposals since the last question, so the model knows what was saved. */
export function takeProposalNotes(): string[] {
  return notesForModel.splice(0);
}

export function discardProposal(id: string) {
  const p = proposals.get(id);
  if (p?.status === 'pending' || p?.status === 'error') {
    patch(id, { status: 'discarded', error: undefined });
    notesForModel.push(`The user discarded proposal ${id}; nothing was saved.`);
  }
}

// ---------------------------------------------------------------- reading

async function dataSourceTypes(): Promise<DsTypes> {
  const list = await getBackendSrv().get<Array<{ uid: string; type: string }>>('/api/datasources');
  const out: DsTypes = {};
  for (const d of list) {
    out[d.uid] = d.type;
  }
  return out;
}

/** Data sources referenced through a template variable (uid "${ds}") take the type the dashboard stored. */
function templateDataSources(spec: Json, ds: DsTypes) {
  const walk = (x: unknown) => {
    if (!x || typeof x !== 'object') {
      return;
    }
    const o = x as Json;
    if (typeof o.uid === 'string' && o.uid.startsWith('$') && typeof o.type === 'string') {
      ds[o.uid] = ds[o.uid] ?? o.type;
    }
    if (typeof o.group === 'string' && typeof o.datasource?.name === 'string' && o.datasource.name.startsWith('$')) {
      ds[o.datasource.name] = ds[o.datasource.name] ?? o.group;
    }
    Object.values(o).forEach(walk);
  };
  walk(spec);
}

interface Loaded {
  apiVersion: ApiVersion;
  resource: Json;
  managedBy?: string;
  canSave: boolean;
  folderUid?: string;
}

async function loadDashboard(uid: string): Promise<Loaded> {
  const v1 = await getBackendSrv().get<Json>(api('v1beta1', uid), undefined, undefined, { showErrorAlert: false });
  const stored = String(v1.status?.conversion?.storedVersion ?? 'v1');
  const apiVersion: ApiVersion = stored.startsWith('v2') ? 'v2' : 'v1beta1';
  const resource =
    apiVersion === 'v2'
      ? await getBackendSrv().get<Json>(api('v2', uid), undefined, undefined, { showErrorAlert: false })
      : v1;
  let canSave = false;
  try {
    const dto = await getBackendSrv().get<Json>(`${api('v1beta1', uid)}/dto`, undefined, undefined, {
      showErrorAlert: false,
    });
    canSave = Boolean(dto.access?.canSave);
  } catch {
    canSave = false;
  }
  const ann = resource.metadata?.annotations ?? {};
  return {
    apiVersion,
    resource,
    managedBy: ann['grafana.app/managedBy'],
    canSave,
    folderUid: ann['grafana.app/folder'],
  };
}

// ---------------------------------------------------------------- checking queries

const CHECKABLE = new Set(['prometheus', 'loki']);

async function checkPanel(view: PanelView, vars: Record<string, string | undefined>): Promise<PanelCheck> {
  const runnable = view.queries.filter((q) => CHECKABLE.has(q.dsType) && q.dsUid && !q.dsUid.startsWith('$'));
  if (!runnable.length) {
    return { key: view.key, title: view.title, result: 'not checked' };
  }
  const res = await getBackendSrv().post<{ results: Record<string, { error?: string; frames?: Json[] }> }>(
    '/api/ds/query',
    {
      from: 'now-1h',
      to: 'now',
      queries: runnable.map((q, i) => ({
        refId: String.fromCharCode(65 + i),
        datasource: { uid: q.dsUid, type: q.dsType },
        expr: substituteVariables(q.expr, vars),
        range: true,
        instant: false,
        maxDataPoints: 60,
        ...(q.dsType === 'loki' ? { queryType: 'range', maxLines: 20 } : {}),
      })),
    },
    { showErrorAlert: false }
  );
  let series = 0;
  for (const [ref, r] of Object.entries(res.results ?? {})) {
    if (r.error) {
      const q = runnable[ref.charCodeAt(0) - 65];
      throw new OpError(`Query for panel "${view.title}" failed: ${r.error}. Query: ${q?.expr}`);
    }
    series += (r.frames ?? []).filter((f) => (f.data?.values?.[0]?.length ?? 0) > 0).length;
  }
  return { key: view.key, title: view.title, result: series ? 'data' : 'no data', series };
}

// ---------------------------------------------------------------- the tool

export async function proposeDashboardChange(args: Json): Promise<string> {
  const ops: Operation[] = parseOperations(args.operations);
  const ds = await dataSourceTypes();
  const uid = args.dashboard_uid ? String(args.dashboard_uid) : '';
  let loaded: Loaded | null = null;
  let applied: ApplyResult;
  let schema: 'v1' | 'v2' = 'v1';
  if (uid) {
    loaded = await loadDashboard(uid);
    schema = loaded.apiVersion === 'v2' ? 'v2' : 'v1';
    templateDataSources(loaded.resource.spec, ds);
    applied = (schema === 'v2' ? applyV2 : applyV1)(loaded.resource.spec, ops, ds);
  } else {
    const title = String(args.title ?? '').trim();
    if (!title) {
      throw new OpError('A new dashboard needs a title');
    }
    applied = applyV1(emptyV1Dashboard(title), ops, ds);
  }
  const vars = variableValues(applied.spec, schema);
  const checks: PanelCheck[] = [];
  for (const view of applied.touched.slice(0, 12)) {
    checks.push(await checkPanel(view, vars));
  }

  const { target, reason } = saveTarget(loaded ? { managedBy: loaded.managedBy, canSave: loaded.canSave } : null);
  const sourceTitle = loaded?.resource.spec?.title;
  const title = target === 'copy' ? `${applied.spec.title} (copy)` : applied.spec.title;

  // A newer proposal replaces any earlier one that was not applied.
  for (const p of proposals.values()) {
    if (p.status === 'pending' || p.status === 'error') {
      put({ ...p, status: 'superseded' });
    }
  }
  const id = `p${++counter}`;
  const summary = String(args.summary ?? '').slice(0, 200) || applied.changes.map((c) => c.text).join('; ');
  put({
    id,
    target,
    reason,
    title,
    sourceUid: uid || undefined,
    sourceTitle,
    apiVersion: loaded?.apiVersion ?? 'v1beta1',
    before: loaded?.resource,
    after: applied.spec,
    folderUid: loaded ? (loaded.managedBy === 'repo' ? undefined : loaded.folderUid) : args.folder_uid,
    summary,
    changes: applied.changes,
    previews: applied.touched.filter((v) => v.type !== 'text').slice(0, 4),
    checks,
    vars,
    status: 'pending',
  });
  return JSON.stringify({
    proposal_id: id,
    saves_as: target === 'new' ? 'new dashboard' : target === 'copy' ? 'a copy' : 'change in place',
    reason,
    title,
    changes: applied.changes.map((c) => c.text),
    checks: checks.map((c) => ({ panel: c.title, result: c.result, series: c.series })),
    note:
      'The user now sees this proposal with live previews and an Apply button. Nothing is saved until they ' +
      'click the button on the card below your answer. In one or two sentences say what you prepared and ' +
      'mention panels with no data. Never say it was created or saved, and do not link to it.',
  });
}

// ---------------------------------------------------------------- applying and undoing (user actions only)

function messageAnnotation(text: string) {
  return { 'grafana.app/message': `Lookout: ${text}`.slice(0, 500) };
}

function copySpec(spec: Json, title: string): Json {
  const s = JSON.parse(JSON.stringify(spec));
  delete s.uid;
  delete s.id;
  delete s.version;
  s.title = title;
  return s;
}

export async function applyProposal(id: string) {
  const p = proposals.get(id);
  if (!p || (p.status !== 'pending' && p.status !== 'error')) {
    return;
  }
  patch(id, { status: 'applying', error: undefined });
  const srv = getBackendSrv();
  try {
    let saved: Json;
    if (p.target === 'in_place' && p.before) {
      const meta = p.before.metadata;
      saved = await srv.put(
        api(p.apiVersion, meta.name),
        {
          apiVersion: `dashboard.grafana.app/${p.apiVersion}`,
          kind: 'Dashboard',
          metadata: {
            name: meta.name,
            resourceVersion: meta.resourceVersion,
            labels: meta.labels,
            annotations: { ...(meta.annotations ?? {}), ...messageAnnotation(p.summary) },
          },
          spec: p.after,
        },
        { showErrorAlert: false }
      );
    } else {
      const annotations: Json = messageAnnotation(p.summary);
      if (p.folderUid) {
        annotations['grafana.app/folder'] = p.folderUid;
      }
      saved = await srv.post(
        api(p.apiVersion),
        {
          apiVersion: `dashboard.grafana.app/${p.apiVersion}`,
          kind: 'Dashboard',
          metadata: { generateName: 'lookout-', annotations },
          spec: p.target === 'copy' ? copySpec(p.after, p.title) : p.after,
        },
        { showErrorAlert: false }
      );
    }
    const savedUid = saved.metadata?.name;
    patch(id, { status: 'applied', savedUid, savedResourceVersion: saved.metadata?.resourceVersion });
    notesForModel.push(
      `The user applied proposal ${id}: ${p.target === 'in_place' ? 'saved' : 'created'} dashboard "${p.title}" ` +
        `(uid ${savedUid}, link /d/${savedUid}). Further changes to it need dashboard_uid ${savedUid}.`
    );
    reloadIfViewing(savedUid);
  } catch (e) {
    patch(id, { status: 'error', error: saveError(e) });
  }
}

export async function undoProposal(id: string) {
  const p = proposals.get(id);
  if (!p || p.status !== 'applied' || !p.savedUid) {
    return;
  }
  patch(id, { status: 'applying', error: undefined });
  const srv = getBackendSrv();
  try {
    if (p.target === 'in_place' && p.before) {
      const current = await srv.get<Json>(api(p.apiVersion, p.savedUid), undefined, undefined, {
        showErrorAlert: false,
      });
      if (current.metadata?.resourceVersion !== p.savedResourceVersion) {
        throw new Error('The dashboard changed after Lookout saved it. Use its version history to restore.');
      }
      await srv.put(
        api(p.apiVersion, p.savedUid),
        {
          apiVersion: `dashboard.grafana.app/${p.apiVersion}`,
          kind: 'Dashboard',
          metadata: {
            ...current.metadata,
            managedFields: undefined,
            annotations: { ...(current.metadata?.annotations ?? {}), ...messageAnnotation(`undo ${p.summary}`) },
          },
          spec: p.before.spec,
        },
        { showErrorAlert: false }
      );
    } else {
      await srv.delete(api(p.apiVersion, p.savedUid), undefined, { showErrorAlert: false });
    }
    patch(id, { status: 'undone' });
    notesForModel.push(
      `The user undid proposal ${id}: ` +
        (p.target === 'in_place' ? `dashboard ${p.savedUid} was restored.` : `dashboard ${p.savedUid} was deleted.`)
    );
    if (p.target === 'in_place') {
      reloadIfViewing(p.savedUid);
    } else if (window.location.pathname.includes(`/d/${p.savedUid}`)) {
      locationService.push('/dashboards');
    }
  } catch (e) {
    patch(id, { status: 'applied', error: saveError(e) });
  }
}

function saveError(e: unknown): string {
  const err = e as Json;
  if (err?.status === 409) {
    return 'This dashboard changed since the proposal was made. Ask again to rebuild it from the latest version.';
  }
  if (err?.status === 403) {
    return 'Grafana refused the save: you do not have permission to save here.';
  }
  return String(err?.data?.message ?? err?.message ?? e);
}

/** Show the saved version when the user is looking at the dashboard that changed. */
function reloadIfViewing(uid?: string) {
  if (!uid || !window.location.pathname.includes(`/d/${uid}`)) {
    return;
  }
  const { pathname, search } = locationService.getLocation();
  const params = new URLSearchParams(search);
  // A changed query string makes Grafana load the dashboard again from the API.
  params.set('lookout', String(Date.now()));
  locationService.replace(`${pathname}?${params.toString()}`);
}
