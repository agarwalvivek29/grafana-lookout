// Setup screen: one page to get Lookout working.
// 1. AI model: writes grafana-llm-app's settings (provider, URL, key, model) and tests tool calling.
// 2. Data sources: shows which metrics, logs and traces sources Lookout can use.
// 3. Panel previews: whether an image renderer is configured.
import React, { useCallback, useEffect, useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps } from '@grafana/data';
import { llm } from '@grafana/llm';
import { config, getBackendSrv } from '@grafana/runtime';
import {
  Alert,
  Button,
  Field,
  Icon,
  Input,
  RadioButtonGroup,
  SecretInput,
  Stack,
  Text,
  TextLink,
  useStyles2,
} from '@grafana/ui';
import { testIds } from '../testIds';

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<{}>> {}

const LLM_APP = 'grafana-llm-app';

type PresetId = 'openrouter' | 'openai' | 'ollama' | 'custom';
interface Preset {
  label: string;
  provider: 'custom' | 'openai';
  url: string;
  model: string;
  keyRequired: boolean;
}
const PRESETS: Record<PresetId, Preset> = {
  openrouter: {
    label: 'OpenRouter',
    provider: 'custom',
    url: 'https://openrouter.ai/api',
    model: 'anthropic/claude-sonnet-4.5',
    keyRequired: true,
  },
  openai: { label: 'OpenAI', provider: 'openai', url: 'https://api.openai.com', model: 'gpt-4.1', keyRequired: true },
  ollama: {
    label: 'Ollama (local)',
    provider: 'custom',
    url: 'http://ollama:11434',
    model: 'qwen3:14b',
    keyRequired: false,
  },
  custom: { label: 'Other OpenAI-compatible', provider: 'custom', url: '', model: '', keyRequired: false },
};

interface LlmSettings {
  enabled?: boolean;
  jsonData?: {
    provider?: string;
    openAI?: { url?: string; [k: string]: unknown };
    models?: { default?: string; mapping?: Record<string, string> };
    [k: string]: unknown;
  };
  secureJsonFields?: Record<string, boolean>;
}

type Status = { state: 'idle' | 'busy' | 'ok' | 'warn' | 'error'; text?: string };

/** Data source types Lookout's tools understand, by signal. */
export const SUPPORTED_TYPES: Record<string, string[]> = {
  Metrics: ['prometheus'],
  Logs: ['loki', 'quickwit-quickwit-datasource'],
  Traces: ['tempo'],
};
const ADD_HINT: Record<string, string> = {
  Metrics: 'none yet. Add a Prometheus data source (works with Prometheus, Mimir, VictoriaMetrics and Thanos).',
  Logs: 'none yet. Add a Loki or Quickwit data source.',
  Traces: 'none yet. Add a Tempo data source.',
};

function guessPreset(s: LlmSettings | null): PresetId {
  const url = s?.jsonData?.openAI?.url ?? '';
  if (s?.jsonData?.provider === 'openai') {
    return 'openai';
  }
  if (url.includes('openrouter.ai')) {
    return 'openrouter';
  }
  if (url.includes(':11434')) {
    return 'ollama';
  }
  return url ? 'custom' : 'openrouter';
}

function fetchLlmSettings(): Promise<LlmSettings> {
  return getBackendSrv().get<LlmSettings>(`/api/plugins/${LLM_APP}/settings`, undefined, undefined, {
    showErrorAlert: false,
  });
}

async function post(url: string, data: unknown) {
  return lastValueFrom(getBackendSrv().fetch({ url, method: 'POST', data, showSuccessAlert: false }));
}

function errorText(e: any): string {
  return e?.data?.message ?? e?.message ?? String(e);
}

function StatusLine({ status }: { status: Status }) {
  if (status.state === 'idle' || !status.text) {
    return null;
  }
  const icon = status.state === 'ok' ? 'check-circle' : status.state === 'busy' ? 'spinner' : 'exclamation-triangle';
  const color =
    status.state === 'ok'
      ? 'success'
      : status.state === 'busy'
        ? 'secondary'
        : status.state === 'warn'
          ? 'warning'
          : 'error';
  return (
    <Text color={color}>
      <Icon name={icon} /> {status.text}
    </Text>
  );
}

function ModelSection() {
  const s = useStyles2(getStyles);
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [missing, setMissing] = useState(false);
  const [preset, setPreset] = useState<PresetId>('openrouter');
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [keySet, setKeySet] = useState(false);
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  const apply = useCallback((cur: LlmSettings) => {
    setSettings(cur);
    const p = guessPreset(cur);
    setPreset(p);
    setUrl(cur.jsonData?.openAI?.url ?? PRESETS[p].url);
    setModel(cur.jsonData?.models?.mapping?.base ?? PRESETS[p].model);
    setKeySet(Boolean(cur.secureJsonFields?.openAIKey));
  }, []);

  useEffect(() => {
    fetchLlmSettings()
      .then(apply)
      .catch(() => setMissing(true));
  }, [apply]);

  const test = async () => {
    setStatus({ state: 'busy', text: 'Testing the model…' });
    try {
      const health = await llm.health();
      if (!health.ok) {
        setStatus({ state: 'error', text: `The LLM plugin is not ready: ${health.error ?? 'unknown error'}` });
        return;
      }
      const started = performance.now();
      const res = await llm.chatCompletions({
        model: llm.Model.BASE,
        messages: [
          { role: 'system', content: 'This is a connectivity test.' },
          { role: 'user', content: 'Call the ping tool now.' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Connectivity check',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      });
      const ms = Math.round(performance.now() - started);
      if (res.choices[0]?.message?.tool_calls?.length) {
        setStatus({ state: 'ok', text: `Connected: the model answered in ${ms} ms and can call tools.` });
      } else {
        setStatus({
          state: 'warn',
          text: 'Connected, but the model did not call the tool. Lookout needs a model with tool calling; choose another model.',
        });
      }
    } catch (e) {
      setStatus({ state: 'error', text: `Test failed: ${errorText(e)}` });
    }
  };

  const save = async () => {
    setStatus({ state: 'busy', text: 'Saving…' });
    try {
      // Re-read so settings changed elsewhere (other models, extra options) are kept.
      const cur = await fetchLlmSettings();
      const m = model.trim();
      const jsonData = {
        ...cur.jsonData,
        provider: PRESETS[preset].provider,
        openAI: { ...cur.jsonData?.openAI, url: url.trim() },
        models: {
          ...cur.jsonData?.models,
          default: 'base',
          mapping: { ...cur.jsonData?.models?.mapping, base: m, large: m },
        },
      };
      await post(`/api/plugins/${LLM_APP}/settings`, {
        enabled: true,
        pinned: true,
        jsonData,
        secureJsonData: key ? { openAIKey: key } : undefined,
      });
      setKey('');
      apply(await fetchLlmSettings());
      await test();
    } catch (e) {
      setStatus({ state: 'error', text: `Could not save: ${errorText(e)}` });
    }
  };

  if (missing) {
    return (
      <Alert severity="warning" title="The Grafana LLM plugin is not installed">
        Lookout talks to the model through the open-source{' '}
        <TextLink href={`/plugins/${LLM_APP}`}>Grafana LLM plugin</TextLink>. Install it from the plugin catalog (or set{' '}
        <code>GF_PLUGINS_PREINSTALL_SYNC=grafana-llm-app</code>), then reload this page.
      </Alert>
    );
  }
  if (!settings) {
    return <Text color="secondary">Loading…</Text>;
  }
  const p = PRESETS[preset];
  const canSave = Boolean(url.trim() && model.trim() && (!p.keyRequired || key || keySet));

  return (
    <div className={s.section}>
      <Field label="Provider" description="Any OpenAI-compatible endpoint works. The model must support tool calling.">
        <RadioButtonGroup
          options={(Object.keys(PRESETS) as PresetId[]).map((id) => ({ value: id, label: PRESETS[id].label }))}
          value={preset}
          onChange={(v) => {
            setPreset(v);
            setUrl(PRESETS[v].url);
            setModel(PRESETS[v].model);
          }}
        />
      </Field>
      <Field label="API URL">
        <Input
          width={60}
          data-testid={testIds.appConfig.apiUrl}
          value={url}
          placeholder="https://your-endpoint/api"
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
      </Field>
      <Field
        label="API key"
        description={p.keyRequired ? 'Stored encrypted by Grafana.' : 'Optional for this provider.'}
      >
        <SecretInput
          width={60}
          data-testid={testIds.appConfig.apiKey}
          value={key}
          isConfigured={keySet}
          placeholder="Paste your API key"
          onChange={(e) => setKey(e.currentTarget.value)}
          onReset={() => setKeySet(false)}
        />
      </Field>
      <Field label="Model" description="The model ID as your provider names it.">
        <Input
          width={60}
          data-testid={testIds.appConfig.model}
          value={model}
          onChange={(e) => setModel(e.currentTarget.value)}
        />
      </Field>
      <Stack direction="row" gap={1} alignItems="center">
        <Button data-testid={testIds.appConfig.save} onClick={save} disabled={!canSave || status.state === 'busy'}>
          Save and test
        </Button>
        <Button
          variant="secondary"
          data-testid={testIds.appConfig.test}
          onClick={test}
          disabled={status.state === 'busy'}
        >
          Test
        </Button>
      </Stack>
      <StatusLine status={status} />
      <Text variant="bodySmall" color="secondary">
        These settings belong to the Grafana LLM plugin, so other AI features in Grafana use them too. More options are
        on its{' '}
        <TextLink href={`/plugins/${LLM_APP}`} inline>
          configuration page
        </TextLink>
        .
      </Text>
    </div>
  );
}

function DataSourcesSection() {
  const s = useStyles2(getStyles);
  const [byKind, setByKind] = useState<Record<string, string[]> | null>(null);
  useEffect(() => {
    getBackendSrv()
      .get<Array<{ name: string; type: string }>>('/api/datasources')
      .then((all) => {
        const out: Record<string, string[]> = {};
        for (const [kind, types] of Object.entries(SUPPORTED_TYPES)) {
          out[kind] = all.filter((d) => types.includes(d.type)).map((d) => d.name);
        }
        setByKind(out);
      })
      .catch(() => setByKind({}));
  }, []);
  if (!byKind) {
    return <Text color="secondary">Loading…</Text>;
  }
  return (
    <div className={s.section}>
      {Object.keys(SUPPORTED_TYPES).map((kind) => {
        const names = byKind[kind] ?? [];
        const list = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
        return (
          <Stack key={kind} direction="row" gap={1} alignItems="flex-start">
            <Icon name={names.length ? 'check-circle' : 'minus-circle'} className={names.length ? s.ok : s.muted} />
            <Text>
              <strong>{kind}:</strong> {names.length ? list : ADD_HINT[kind]}
            </Text>
          </Stack>
        );
      })}
      <Text variant="bodySmall" color="secondary">
        Lookout only reads data the signed-in user can already see. Questions and tool results are sent to the model
        provider above; nothing else leaves your Grafana.
      </Text>
    </div>
  );
}

function PreviewsSection() {
  const s = useStyles2(getStyles);
  return (
    <div className={s.section}>
      {config.rendererAvailable ? (
        <Text>
          <Icon name="check-circle" className={s.ok} /> Image renderer found: links to dashboard panels show a picture
          of the panel.
        </Text>
      ) : (
        <Text>
          <Icon name="minus-circle" className={s.muted} /> No image renderer: Explore links still show live charts,
          panel links show none.{' '}
          <TextLink href="https://grafana.com/docs/grafana/latest/setup-grafana/image-rendering/" external inline>
            Set up the Grafana Image Renderer
          </TextLink>{' '}
          to add panel pictures.
        </Text>
      )}
    </div>
  );
}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const enable = async () => {
    await post(`/api/plugins/${plugin.meta.id}/settings`, {
      enabled: true,
      pinned: true,
      jsonData: plugin.meta.jsonData ?? {},
    });
    window.location.reload();
  };
  return (
    <div data-testid={testIds.appConfig.container} className={s.page}>
      {!plugin.meta.enabled && (
        <Alert severity="info" title="Lookout is not enabled yet">
          <Stack direction="column" gap={1} alignItems="flex-start">
            <span>Enable it to add “Ask Lookout AI” to dashboards, panel menus and the command palette.</span>
            <Button size="sm" onClick={enable}>
              Enable Lookout
            </Button>
          </Stack>
        </Alert>
      )}
      <Text element="h3" variant="h4">
        1. AI model
      </Text>
      <ModelSection />
      <Text element="h3" variant="h4">
        2. Data sources
      </Text>
      <DataSourcesSection />
      <Text element="h3" variant="h4">
        3. Panel previews (optional)
      </Text>
      <PreviewsSection />
    </div>
  );
};

export default AppConfig;

const getStyles = (theme: GrafanaTheme2) => ({
  page: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2)};
    max-width: 820px;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(2)};
  `,
  ok: css`
    color: ${theme.colors.success.text};
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
  `,
});
