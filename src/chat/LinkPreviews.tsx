// Link previews under an answer (F1 inline previews). Clicking a preview opens its link.
// - Dashboard panel links: a PNG of the exact panel from Grafana's image renderer, when one is configured.
// - Explore links with a Prometheus-compatible query: a live mini chart rendered in the browser.
// Only same-origin links are previewed (R1), and every request runs as the signed-in user.
import React, { useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { dataFrameFromJSON, DataFrameJSON, GrafanaTheme2, LoadingState, PanelData, rangeUtil } from '@grafana/data';
import { config, getBackendSrv, locationService, PanelRenderer } from '@grafana/runtime';
import { Icon, LoadingPlaceholder, Text, useStyles2 } from '@grafana/ui';
import { safeHtml } from './SafeMarkdown';
import { appPath, withSubUrl } from './links';

const WIDTH = 440;
const HEIGHT = 200;

type Preview =
  | { kind: 'panel'; href: string; label: string; img: string }
  | { kind: 'prom'; href: string; label: string; dsUid: string; expr: string; from: string; to: string };

function parsePreviews(markdown: string): Preview[] {
  const out: Preview[] = [];
  const seen = new Set<string>();
  // Read links from the rendered (sanitized) answer: markdown parsing handles URLs that contain
  // parentheses, e.g. PromQL rate(...) inside an Explore link.
  const doc = new DOMParser().parseFromString(safeHtml(markdown), 'text/html');
  for (const a of Array.from(doc.querySelectorAll('a'))) {
    const label = a.textContent ?? '';
    const href = a.getAttribute('href') ?? '';
    if (seen.has(href) || out.length >= 3) {
      continue;
    }
    const path = appPath(href);
    if (path === null) {
      continue;
    }
    const url = new URL(path, window.location.origin);
    const dash = url.pathname.match(/\/d\/([^/]+)/);
    const panelKey = url.searchParams.get('viewPanel');
    if (dash && panelKey && config.rendererAvailable) {
      const p = new URLSearchParams();
      for (const [k, v] of url.searchParams) {
        if (k === 'viewPanel') {
          continue;
        }
        p.append(k, v);
      }
      p.set('panelId', panelKey);
      p.set('width', String(WIDTH * 2));
      p.set('height', String(HEIGHT * 2));
      p.set('scale', '1');
      p.set('theme', config.theme2.isDark ? 'dark' : 'light');
      p.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
      seen.add(href);
      out.push({ kind: 'panel', href: path, label, img: withSubUrl(`/render/d-solo/${dash[1]}/_?${p.toString()}`) });
      continue;
    }
    if (url.pathname.startsWith('/explore')) {
      try {
        const panes = JSON.parse(url.searchParams.get('panes') ?? '{}');
        const pane = Object.values<any>(panes)[0];
        const q = pane?.queries?.[0];
        if (q?.expr && (q?.datasource?.type === 'prometheus' || !q?.datasource?.type)) {
          seen.add(href);
          out.push({
            kind: 'prom',
            href: path,
            label,
            dsUid: q.datasource?.uid ?? pane.datasource,
            expr: q.expr,
            from: pane.range?.from ?? 'now-1h',
            to: pane.range?.to ?? 'now',
          });
        }
      } catch {
        // not a previewable Explore link
      }
    }
  }
  return out;
}

function PromPreview({ p }: { p: Extract<Preview, { kind: 'prom' }> }) {
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timeRange = useMemo(() => rangeUtil.convertRawToRange({ from: p.from, to: p.to }), [p.from, p.to]);
  useEffect(() => {
    let cancelled = false;
    getBackendSrv()
      .post<{ results: Record<string, { error?: string; frames?: DataFrameJSON[] }> }>('/api/ds/query', {
        from: p.from,
        to: p.to,
        queries: [
          {
            refId: 'A',
            datasource: { uid: p.dsUid, type: 'prometheus' },
            expr: p.expr,
            range: true,
            instant: false,
            maxDataPoints: 200,
          },
        ],
      })
      .then((res) => {
        if (cancelled) {
          return;
        }
        const r = res.results.A;
        if (r?.error) {
          setError(r.error);
          return;
        }
        const series = (r?.frames ?? []).slice(0, 10).map((f) => dataFrameFromJSON(f));
        setData({ state: LoadingState.Done, series, timeRange });
      })
      .catch((e) => !cancelled && setError(String(e?.data?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [p, timeRange]);
  if (error) {
    return (
      <Text color="secondary" variant="bodySmall">
        Preview unavailable: {error}
      </Text>
    );
  }
  if (!data) {
    return <LoadingPlaceholder text="Loading preview…" />;
  }
  return (
    <PanelRenderer
      title=""
      pluginId="timeseries"
      width={WIDTH}
      height={HEIGHT}
      data={data}
      options={{
        legend: { showLegend: false, displayMode: 'hidden', placement: 'bottom', calcs: [] },
        tooltip: { mode: 'multi', sort: 'none' },
      }}
      fieldConfig={{ defaults: { custom: { fillOpacity: 10, lineWidth: 1 } }, overrides: [] }}
    />
  );
}

function PanelImage({ p }: { p: Extract<Preview, { kind: 'panel' }> }) {
  const s = useStyles2(getStyles);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  return (
    <>
      {state === 'loading' && <LoadingPlaceholder text="Rendering panel…" />}
      {state === 'error' && (
        <Text color="secondary" variant="bodySmall">
          Preview unavailable (image renderer)
        </Text>
      )}
      <img
        className={s.img}
        style={{ display: state === 'ok' ? 'block' : 'none' }}
        src={p.img}
        alt={`Preview of ${p.label}`}
        width={WIDTH}
        height={HEIGHT}
        onLoad={() => setState('ok')}
        onError={() => setState('error')}
      />
    </>
  );
}

export function LinkPreviews({ markdown }: { markdown: string }) {
  const s = useStyles2(getStyles);
  const previews = useMemo(() => parsePreviews(markdown), [markdown]);
  if (!previews.length) {
    return null;
  }
  return (
    <div className={s.list}>
      {previews.map((p) => (
        <button
          key={p.href}
          type="button"
          className={s.card}
          data-testid="lookout-preview"
          onClick={() => locationService.push(p.href)}
          title={`Open: ${p.label}`}
          aria-label={`Open ${p.label}`}
        >
          <div className={s.frame}>{p.kind === 'panel' ? <PanelImage p={p} /> : <PromPreview p={p} />}</div>
          <div className={s.caption}>
            <Icon name={p.kind === 'panel' ? 'apps' : 'compass'} size="sm" />
            <span>{p.label}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  list: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  card: css`
    all: unset;
    cursor: pointer;
    display: block;
    max-width: ${WIDTH + 2}px;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
    background: ${theme.colors.background.secondary};
    &:hover,
    &:focus-visible {
      border-color: ${theme.colors.primary.border};
    }
  `,
  frame: css`
    width: ${WIDTH}px;
    max-width: 100%;
    height: ${HEIGHT}px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  `,
  img: css`
    max-width: 100%;
    height: auto;
  `,
  caption: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: center;
    padding: ${theme.spacing(0.5, 1)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.link};
    border-top: 1px solid ${theme.colors.border.weak};
  `,
});
