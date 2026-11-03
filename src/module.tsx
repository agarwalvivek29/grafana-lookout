import React, { Suspense, lazy } from 'react';
import { AppPlugin, PluginExtensionPanelContext, PluginExtensionPoints } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/AppConfig/AppConfig';
import type { ChatContext } from './chat/store';
import { isSafeVariableName, toRecord, urlVariables } from './chat/vars';

const App = lazy(() => import('./components/App/App'));
const LazyAppConfig = lazy(() => import('./components/AppConfig/AppConfig'));

const AppConfig = (props: AppConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAppConfig {...props} />
  </Suspense>
);

function panelContext(ctx: PluginExtensionPanelContext | undefined): ChatContext {
  const scoped = new Map<string, string>();
  for (const [k, v] of Object.entries(ctx?.scopedVars ?? {})) {
    if (!k.startsWith('__') && isSafeVariableName(k) && v && typeof v.value !== 'object') {
      scoped.set(k, String(v.value));
    }
  }
  // Dashboard variables are also in the URL (var-*); include them so answers keep the same env/service.
  const fromUrl = urlVariables(window.location.search);
  for (const [k, v] of fromUrl) {
    if (!scoped.has(k)) {
      scoped.set(k, v);
    }
  }
  const vars = toRecord(scoped);
  return {
    dashboard_uid: ctx?.dashboard?.uid,
    dashboard_title: ctx?.dashboard?.title,
    panel_key: ctx ? `panel-${ctx.id}` : undefined,
    panel_title: ctx?.title,
    time_range: ctx?.timeRange,
    timezone: ctx?.timeZone,
    variables: vars,
  };
}

function dashboardContextFromUrl(): ChatContext | null {
  const m = window.location.pathname.match(/\/d\/([^/]+)/);
  if (!m) {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const vars = toRecord(urlVariables(window.location.search));
  const title = document.title.replace(/ - Dashboards - Grafana$/, '').replace(/ - Grafana$/, '');
  return {
    dashboard_uid: m[1],
    dashboard_title: title,
    time_range: { from: params.get('from') ?? 'now-6h', to: params.get('to') ?? 'now' },
    variables: vars,
  };
}

async function openPanel(context: ChatContext | null, question?: string) {
  const [{ openAssistantPanel }, { ask }] = await Promise.all([
    import('./chat/assistantPanel'),
    import('./chat/store'),
  ]);
  openAssistantPanel(context);
  if (question) {
    ask(question);
  }
}

export const plugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Setup',
    icon: 'cog',
    body: AppConfig,
    id: 'configuration',
  })
  // Dashboard sidebar button (Grafana 13 dashboard experience): opens the assistant next to the dashboard.
  .addLink({
    targets: [PluginExtensionPoints.DashboardSidebar],
    title: 'Ask Lookout AI',
    description: 'Open the assistant next to this dashboard',
    icon: 'ai-sparkle',
    onClick: () => {
      openPanel(dashboardContextFromUrl());
    },
  })
  .addLink<PluginExtensionPanelContext>({
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    title: 'Ask Lookout AI',
    description: 'Ask the assistant about this panel',
    icon: 'ai-sparkle',
    onClick: (_e, helpers) => {
      openPanel(panelContext(helpers.context));
    },
  })
  .addLink<PluginExtensionPanelContext>({
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    title: 'Explain with AI',
    description: 'Explain what this panel shows and whether the current values look normal',
    icon: 'ai-sparkle',
    onClick: (_e, helpers) => {
      openPanel(
        panelContext(helpers.context),
        'Explain this panel: what it measures, how the values changed over the dashboard time range (peaks, steps, recoveries and when they happened), and what to check next.'
      );
    },
  })
  .addLink({
    targets: [PluginExtensionPoints.CommandPalette],
    title: 'Ask Lookout AI…',
    description: 'Open the AI assistant',
    icon: 'ai-sparkle',
    onClick: () => {
      openPanel(dashboardContextFromUrl());
    },
  });
