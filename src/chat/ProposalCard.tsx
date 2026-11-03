// The card under an answer that shows a proposed dashboard change: what changes, live previews of the new or
// changed panels, warnings, and the Apply / Discard / Undo buttons. Only this card can save (design doc:
// docs/design/dashboard-editing.md).
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { css } from '@emotion/css';
import { dataFrameFromJSON, DataFrameJSON, GrafanaTheme2, LoadingState, PanelData, rangeUtil } from '@grafana/data';
import { getBackendSrv, locationService, PanelRenderer } from '@grafana/runtime';
import { Alert, Badge, Button, Icon, LoadingPlaceholder, Stack, Text, useStyles2 } from '@grafana/ui';
import {
  applyProposal,
  discardProposal,
  getProposal,
  Proposal,
  subscribeProposals,
  undoProposal,
} from '../agent/dashboards';
import { Json, PanelView, substituteVariables } from '../agent/dashboardOps';

const PREVIEW_HEIGHT = 180;
const RANGE = { from: 'now-1h', to: 'now' };

function useProposal(id: string): Proposal | undefined {
  return useSyncExternalStore(subscribeProposals, () => getProposal(id));
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** A failing preview must never break the card. */
class PreviewBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Text color="secondary" variant="bodySmall">
        Preview unavailable
      </Text>
    ) : (
      this.props.children
    );
  }
}

function PanelPreview({ view, vars }: { view: PanelView; vars: Record<string, string | undefined> }) {
  const s = useStyles2(getStyles);
  const { ref, width } = useWidth();
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timeRange = useMemo(() => rangeUtil.convertRawToRange(RANGE), []);
  const queries = useMemo(() => view.queries.filter((q) => q.dsUid && !q.dsUid.startsWith('$')), [view]);
  useEffect(() => {
    let cancelled = false;
    if (!queries.length) {
      return;
    }
    getBackendSrv()
      .post<{ results: Record<string, { error?: string; frames?: DataFrameJSON[] }> }>(
        '/api/ds/query',
        {
          ...RANGE,
          queries: queries.map((q, i) => ({
            refId: String.fromCharCode(65 + i),
            datasource: { uid: q.dsUid, type: q.dsType },
            expr: substituteVariables(q.expr, vars),
            query: q.dsType === 'tempo' ? q.expr : undefined,
            queryType: q.dsType === 'loki' ? 'range' : q.dsType === 'tempo' ? 'traceql' : undefined,
            legendFormat: q.legend,
            range: true,
            instant: false,
            maxDataPoints: 120,
            maxLines: 50,
          })),
        },
        { showErrorAlert: false }
      )
      .then((res) => {
        if (cancelled) {
          return;
        }
        const results = Object.values(res.results ?? {});
        const failed = results.find((r) => r.error);
        if (failed) {
          setError(failed.error!);
          return;
        }
        const series = results
          .flatMap((r) => r.frames ?? [])
          .slice(0, 20)
          .map((f) => dataFrameFromJSON(f));
        if (!series.some((f) => f.length > 0)) {
          setError('no data in the last hour');
          return;
        }
        setData({ state: LoadingState.Done, series, timeRange });
      })
      .catch((e) => !cancelled && setError(String(e?.data?.message ?? e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [queries, vars, timeRange]);
  return (
    <div className={s.preview}>
      <div className={s.previewTitle}>{view.title}</div>
      <div ref={ref} className={s.previewBody}>
        {error || !queries.length ? (
          <Text color="secondary" variant="bodySmall">
            Preview: {error ?? 'no query to preview'}
          </Text>
        ) : !data || !width ? (
          <LoadingPlaceholder text="Loading preview…" />
        ) : (
          <PreviewBoundary>
            <PanelRenderer
              title=""
              pluginId={view.type}
              width={width}
              height={PREVIEW_HEIGHT}
              data={data}
              options={view.options}
              fieldConfig={view.fieldConfig as any}
            />
          </PreviewBoundary>
        )}
      </div>
    </div>
  );
}

interface Box {
  key: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  row?: boolean;
}

interface Group {
  label: string;
  boxes: Box[];
}

/** The layout of a dashboard spec as labelled groups of boxes (one per tab/row grid). */
function layoutGroups(spec: Json, v2: boolean): Group[] {
  if (!v2) {
    const boxes: Box[] = (spec.panels ?? []).map((p: Json) => ({
      key: p.type === 'row' ? `row-${p.id}` : `panel-${p.id}`,
      title: p.title ?? '',
      x: p.gridPos?.x ?? 0,
      y: p.gridPos?.y ?? 0,
      w: p.gridPos?.w ?? 12,
      h: p.type === 'row' ? 1 : (p.gridPos?.h ?? 8),
      row: p.type === 'row',
    }));
    return [{ label: '', boxes }];
  }
  const groups: Group[] = [];
  const walk = (l: Json, label: string[]) => {
    if (!l) {
      return;
    }
    if (l.kind === 'GridLayout' || l.kind === 'AutoGridLayout') {
      const auto = l.kind === 'AutoGridLayout';
      groups.push({
        label: label.join(' · '),
        boxes: (l.spec?.items ?? []).map((it: Json, i: number) => {
          const key = it.spec?.element?.name;
          return {
            key,
            title: spec.elements?.[key]?.spec?.title ?? key,
            x: auto ? (i % 3) * 8 : (it.spec?.x ?? 0),
            y: auto ? Math.floor(i / 3) * 8 : (it.spec?.y ?? 0),
            w: auto ? 8 : (it.spec?.width ?? 12),
            h: auto ? 8 : (it.spec?.height ?? 8),
          };
        }),
      });
      return;
    }
    for (const t of l.spec?.tabs ?? []) {
      walk(t.spec?.layout, [...label, `Tab: ${t.spec?.title}`]);
    }
    for (const r of l.spec?.rows ?? []) {
      walk(r.spec?.layout, [...label, `Row: ${r.spec?.title}`]);
    }
  };
  walk(spec.layout, []);
  return groups;
}

/** Panels that are new or sit somewhere else after the change. */
function changedKeys(p: Proposal): Set<string> {
  const after = layoutGroups(p.after, p.apiVersion === 'v2');
  const before = p.before ? layoutGroups(p.before.spec, (p.beforeApiVersion ?? p.apiVersion) === 'v2') : [];
  const where = new Map<string, string>();
  for (const g of before) {
    for (const b of g.boxes) {
      where.set(b.key, `${g.label}|${b.x},${b.y},${b.w},${b.h}`);
    }
  }
  const out = new Set<string>();
  for (const g of after) {
    for (const b of g.boxes) {
      if (where.get(b.key) !== `${g.label}|${b.x},${b.y},${b.w},${b.h}`) {
        out.add(b.key);
      }
    }
  }
  return out;
}

const UNIT = 6; // px per grid row in the map

function LayoutMap({ p }: { p: Proposal }) {
  const s = useStyles2(getStyles);
  const groups = useMemo(() => layoutGroups(p.after, p.apiVersion === 'v2'), [p]);
  const changed = useMemo(() => changedKeys(p), [p]);
  const [all, setAll] = useState(false);
  // Only worth showing when something is placed differently.
  if (!changed.size || !groups.some((g) => g.boxes.length)) {
    return null;
  }
  const shown = all ? groups : groups.slice(0, 4);
  return (
    <div className={s.map} data-testid="lookout-layout-map">
      <Text variant="bodySmall" color="secondary">
        Layout after the change{changed.size ? ` (${changed.size} new or moved, highlighted)` : ''}
      </Text>
      {shown.map((g, gi) => {
        const height = Math.max(4, ...g.boxes.map((b) => b.y + b.h)) * UNIT;
        return (
          <div key={gi}>
            {g.label && <div className={s.mapLabel}>{g.label}</div>}
            <div className={s.mapGrid} style={{ height }}>
              {g.boxes.map((b) => (
                <div
                  key={b.key}
                  className={`${s.mapBox} ${changed.has(b.key) ? s.mapChanged : ''} ${b.row ? s.mapRow : ''}`}
                  style={{
                    left: `${(b.x / 24) * 100}%`,
                    width: `calc(${(b.w / 24) * 100}% - 2px)`,
                    top: b.y * UNIT,
                    height: b.h * UNIT - 2,
                  }}
                  title={b.title}
                >
                  {b.title}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {groups.length > 4 && (
        <Button size="sm" variant="secondary" fill="text" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${groups.length} sections`}
        </Button>
      )}
    </div>
  );
}

const CHANGE_ICON = { add: 'plus', update: 'pen', remove: 'trash-alt', other: 'cog' } as const;

function heading(p: Proposal): string {
  if (p.target === 'new') {
    return `New dashboard: ${p.title}`;
  }
  if (p.target === 'copy') {
    return `Copy of "${p.sourceTitle}" with changes`;
  }
  return `Change to "${p.sourceTitle}"`;
}

function applyLabel(p: Proposal): string {
  return p.target === 'new' ? 'Create dashboard' : p.target === 'copy' ? 'Save as copy' : 'Apply';
}

export function ProposalCard({ id }: { id: string }) {
  const s = useStyles2(getStyles);
  const p = useProposal(id);
  const [showJson, setShowJson] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (!p) {
    return null;
  }
  const inactive = p.status === 'discarded' || p.status === 'superseded' || p.status === 'undone';
  const badge =
    p.status === 'applied' ? (
      <Badge color="green" text="Saved" icon="check" />
    ) : p.status === 'undone' ? (
      <Badge color="blue" text="Undone" />
    ) : p.status === 'discarded' ? (
      <Badge color="blue" text="Discarded" />
    ) : p.status === 'superseded' ? (
      <Badge color="blue" text="Replaced by a newer proposal" />
    ) : (
      <Badge color="orange" text="Not saved" />
    );
  const noData = p.checks.filter((c) => c.result === 'no data');
  const unchecked = p.checks.filter((c) => c.result === 'not checked');
  const savedPath = p.savedUid ? `/d/${encodeURIComponent(p.savedUid)}` : '';
  return (
    <div className={s.card} data-testid="lookout-proposal">
      <Stack direction="row" justifyContent="space-between" alignItems="center" wrap="wrap">
        <Text weight="medium">
          <Icon name="apps" /> {heading(p)}
        </Text>
        {badge}
      </Stack>
      {!inactive && (
        <>
          {p.reason && p.status !== 'applied' && <Alert severity="info" title={p.reason} />}
          {p.status !== 'applied' &&
            p.notes.map((n) => (
              <Text key={n} variant="bodySmall" color="secondary">
                <Icon name="info-circle" size="sm" /> {n}
              </Text>
            ))}
          <ul className={s.changes}>
            {(showAll ? p.changes : p.changes.slice(0, 12)).map((c, i) => (
              <li key={i}>
                <Icon name={CHANGE_ICON[c.kind]} size="sm" /> {c.text}
                {c.detail && <pre className={s.detail}>{c.detail}</pre>}
              </li>
            ))}
          </ul>
          {p.changes.length > 12 && (
            <Button size="sm" variant="secondary" fill="text" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer changes' : `Show all ${p.changes.length} changes`}
            </Button>
          )}
          {noData.length > 0 && (
            <Text variant="bodySmall" color="warning">
              <Icon name="exclamation-triangle" size="sm" /> No data in the last hour:{' '}
              {noData.map((c) => `"${c.title}"`).join(', ')}
            </Text>
          )}
          {unchecked.length > 0 && (
            <Text variant="bodySmall" color="secondary">
              Not checked (data source type): {unchecked.map((c) => `"${c.title}"`).join(', ')}
            </Text>
          )}
          {p.status !== 'applied' && <LayoutMap p={p} />}
          {p.status !== 'applied' && p.previews.map((v) => <PanelPreview key={v.key} view={v} vars={p.vars} />)}
          {p.error && <Alert severity="error" title={p.error} />}
          <Stack direction="row" gap={1} wrap="wrap" alignItems="center">
            {(p.status === 'pending' || p.status === 'error') && (
              <>
                <Button size="sm" icon="save" onClick={() => applyProposal(p.id)}>
                  {applyLabel(p)}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => discardProposal(p.id)}>
                  Discard
                </Button>
              </>
            )}
            {p.status === 'applying' && <LoadingPlaceholder text="Saving…" />}
            {p.status === 'applied' && (
              <>
                <Button size="sm" icon="external-link-alt" onClick={() => locationService.push(savedPath)}>
                  Open dashboard
                </Button>
                <Button size="sm" variant="secondary" icon="history-alt" onClick={() => undoProposal(p.id)}>
                  Undo
                </Button>
              </>
            )}
            {p.status !== 'applied' && (
              <Button size="sm" variant="secondary" fill="text" onClick={() => setShowJson(!showJson)}>
                {showJson ? 'Hide JSON' : 'View JSON'}
              </Button>
            )}
          </Stack>
          {showJson && p.status !== 'applied' && <pre className={s.json}>{JSON.stringify(p.after, null, 2)}</pre>}
        </>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  changes: css`
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  detail: css`
    margin: ${theme.spacing(0.5, 0, 0, 2.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 120px;
    overflow: auto;
  `,
  preview: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
  `,
  previewTitle: css`
    padding: ${theme.spacing(0.5, 1)};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  previewBody: css`
    height: ${PREVIEW_HEIGHT}px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  `,
  map: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  mapLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-top: ${theme.spacing(0.5)};
  `,
  mapGrid: css`
    position: relative;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
  `,
  mapBox: css`
    position: absolute;
    margin: 1px;
    padding: 0 ${theme.spacing(0.5)};
    font-size: 10px;
    line-height: 14px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: 2px;
  `,
  mapChanged: css`
    color: ${theme.colors.text.primary};
    border-color: ${theme.colors.primary.border};
    background: ${theme.colors.primary.transparent};
  `,
  mapRow: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  json: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    max-height: 300px;
    overflow: auto;
  `,
});
