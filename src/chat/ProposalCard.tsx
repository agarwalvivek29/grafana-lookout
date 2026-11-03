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
import { PanelView, substituteVariables } from '../agent/dashboardOps';

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
        const series = results.flatMap((r) => r.frames ?? []).slice(0, 20).map((f) => dataFrameFromJSON(f));
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
          <ul className={s.changes}>
            {p.changes.map((c, i) => (
              <li key={i}>
                <Icon name={CHANGE_ICON[c.kind]} size="sm" /> {c.text}
                {c.detail && <pre className={s.detail}>{c.detail}</pre>}
              </li>
            ))}
          </ul>
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
          {p.status !== 'applied' &&
            p.previews.map((v) => <PanelPreview key={v.key} view={v} vars={p.vars} />)}
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
  json: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    max-height: 300px;
    overflow: auto;
  `,
});
