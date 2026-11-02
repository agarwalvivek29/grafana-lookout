// Module-scope conversation store (R3/D5): lives outside React so it survives page navigation
// and drawer close/reopen. Persistence to plugin user storage comes later (M1).
import { useSyncExternalStore } from 'react';
import { toRecord, urlVariables } from './vars';
import { llm } from '@grafana/llm';
import { runAgent, AgentStep } from '../agent/agent';

export interface ChatContext {
  dashboard_uid?: string;
  dashboard_title?: string;
  panel_key?: string;
  panel_title?: string;
  time_range?: { from: unknown; to: unknown };
  timezone?: string;
  variables?: Record<string, string>;
}

export interface Turn {
  id: number;
  question: string;
  steps: AgentStep[];
  answer?: string;
  error?: string;
  liveText: string;
  startedAt: number;
  finishedAt?: number;
  /** What changed on the dashboard since the previous question (shown above the question). */
  contextChanges?: string[];
}

interface State {
  turns: Turn[];
  running: boolean;
  context: ChatContext | null;
  /** The user removed the context chips; don't re-attach dashboard context until they reopen. */
  contextCleared?: boolean;
}

let state: State = { turns: [], running: false, context: null };
let history: llm.Message[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function updateTurn(id: number, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) {
  set({
    turns: state.turns.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)),
  });
}

export function useChat(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
}

export function setContext(context: ChatContext | null) {
  set({ context, contextCleared: context === null });
}

/**
 * Live dashboard context read from the current URL. Grafana keeps the dashboard uid, time range and
 * every variable value in the URL (`/d/<uid>?from&to&var-x`), so this reflects what the user sees now.
 * Panel-specific context is kept only while the user stays on the same dashboard.
 */
export function readLiveContext(prev: ChatContext | null): ChatContext | null {
  const m = window.location.pathname.match(/\/d\/([^/]+)/);
  if (!m) {
    // Not on a dashboard (e.g. Explore): keep the last known dashboard context.
    return prev;
  }
  const params = new URLSearchParams(window.location.search);
  const variables = toRecord(urlVariables(window.location.search));
  const sameDashboard = prev?.dashboard_uid === m[1];
  const title = document.title.replace(/ - Dashboards - Grafana$/, '').replace(/ - Grafana$/, '');
  return {
    dashboard_uid: m[1],
    dashboard_title: title || prev?.dashboard_title,
    panel_key: sameDashboard ? prev?.panel_key : undefined,
    panel_title: sameDashboard ? prev?.panel_title : undefined,
    time_range: {
      from: params.get('from') ?? prev?.time_range?.from ?? 'now-6h',
      to: params.get('to') ?? prev?.time_range?.to ?? 'now',
    },
    timezone: params.get('timezone') ?? prev?.timezone,
    variables,
  };
}

/** Called on every in-app navigation: keeps the chips in sync with the dashboard. */
export function syncContextFromLocation() {
  if (state.contextCleared) {
    return;
  }
  const next = readLiveContext(state.context);
  if (JSON.stringify(next) !== JSON.stringify(state.context)) {
    set({ context: next });
  }
}

function describeChanges(before: ChatContext | null, after: ChatContext | null): string[] {
  if (!before?.dashboard_uid || !after?.dashboard_uid) {
    return [];
  }
  const changes: string[] = [];
  if (before.dashboard_uid !== after.dashboard_uid) {
    changes.push(`dashboard: "${before.dashboard_title}" → "${after.dashboard_title}"`);
  }
  const names = new Set([...Object.keys(before.variables ?? {}), ...Object.keys(after.variables ?? {})]);
  for (const n of names) {
    const a = before.variables?.[n];
    const b = after.variables?.[n];
    if (a !== b) {
      changes.push(`${n}: ${a ?? '(unset)'} → ${b ?? '(unset)'}`);
    }
  }
  const tr = (c: ChatContext) => `${String(c.time_range?.from)} to ${String(c.time_range?.to)}`;
  if (tr(before) !== tr(after)) {
    changes.push(`time range: ${tr(before)} → ${tr(after)}`);
  }
  return changes;
}

export function newChat() {
  history = [];
  lastAskedContext = null;
  set({ turns: [], running: false });
}

function withContext(question: string, ctx: ChatContext | null, changes: string[] = []): string {
  if (!ctx?.dashboard_uid) {
    return question;
  }
  const changeNote = changes.length
    ? `The user changed the dashboard since the previous question (${changes.join('; ')}). ` +
      'Answer for the CURRENT values, not the earlier ones. '
    : '';
  const parts = [`dashboard "${ctx.dashboard_title ?? ctx.dashboard_uid}" (uid ${ctx.dashboard_uid})`];
  if (ctx.panel_key) {
    parts.push(`panel "${ctx.panel_title}" (key ${ctx.panel_key})`);
  }
  if (ctx.time_range) {
    parts.push(`time range ${JSON.stringify(ctx.time_range)}${ctx.timezone ? ` (timezone ${ctx.timezone})` : ''}`);
  }
  if (ctx.variables && Object.keys(ctx.variables).length) {
    parts.push(`variables ${JSON.stringify(ctx.variables)}`);
  }
  return `[Context: ${changeNote}The user is looking at ${parts.join(', ')}. Use get_dashboard to read it before answering.]\n\n${question}`;
}

let lastAskedContext: ChatContext | null = null;

export async function ask(question: string) {
  if (state.running || !question.trim()) {
    return;
  }
  // Re-read what the user sees right now (variables, time range, dashboard) before every question.
  syncContextFromLocation();
  const ctx = state.context;
  const changes = history.length ? describeChanges(lastAskedContext, ctx) : [];
  lastAskedContext = ctx;
  const id = nextId++;
  const turn: Turn = { id, question, steps: [], liveText: '', startedAt: Date.now(), contextChanges: changes };
  set({ turns: [...state.turns, turn], running: true });
  try {
    history = await runAgent(
      withContext(question, ctx, changes),
      (step) => {
        if (step.kind === 'answer') {
          updateTurn(id, { answer: step.text });
        } else if (step.kind === 'error') {
          updateTurn(id, { error: step.text });
        } else {
          updateTurn(id, (t) => ({ steps: [...t.steps, step] }));
        }
      },
      (text) => updateTurn(id, { liveText: text }),
      history
    );
  } catch (e) {
    updateTurn(id, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    updateTurn(id, { finishedAt: Date.now(), liveText: '' });
    set({ running: false });
  }
}
