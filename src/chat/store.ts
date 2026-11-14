// Module-scope conversation store (R3/D5): lives outside React so it survives page navigation
// and drawer close/reopen. Every finished turn is also saved to the conversation history (historyApi)
// when an admin has configured a history database.
import { useSyncExternalStore } from 'react';
import { toRecord, urlVariables } from './vars';
import { llm } from '@grafana/llm';
import { runAgent, AgentStep } from '../agent/agent';
import { takeProposalNotes } from '../agent/dashboards';
import { errorText, historyApi, HistoryStatus, newSessionId } from './historyApi';

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
  /** Loaded from history: dashboard proposals from that time are no longer in memory. */
  restored?: boolean;
}

export interface State {
  turns: Turn[];
  running: boolean;
  context: ChatContext | null;
  /** The user removed the context chips; don't re-attach dashboard context until they reopen. */
  contextCleared?: boolean;
  /** Id this conversation is saved under; a new chat gets a new one. */
  sessionId: string;
  title?: string;
  shared: boolean;
  /** Someone else's shared conversation: readable, not continuable (see continueAsCopy). */
  readOnly: boolean;
  ownerName?: string;
  /** A saved conversation is being fetched. */
  loading: boolean;
  loadError?: string;
  saveError?: string;
  /** Something the user should know about how this conversation was saved. */
  notice?: string;
  /** null until the backend has said whether history is configured. */
  history: HistoryStatus | null;
  /** Bumped after every save, rename or delete so history lists refresh. */
  listVersion: number;
}

let state: State = {
  turns: [],
  running: false,
  context: null,
  sessionId: newSessionId(),
  shared: false,
  readOnly: false,
  loading: false,
  history: null,
  listVersion: 0,
};
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

export function getChatState(): State {
  return state;
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
    // While a dashboard (re)loads the page title is briefly the generic "Dashboards".
    dashboard_title:
      (title && title !== 'Dashboards' ? title : undefined) ?? (sameDashboard ? prev?.dashboard_title : undefined),
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
  titlePending = false;
  version = 0;
  set({
    turns: [],
    running: false,
    sessionId: newSessionId(),
    title: undefined,
    shared: false,
    readOnly: false,
    ownerName: undefined,
    loading: false,
    loadError: undefined,
    saveError: undefined,
    notice: undefined,
  });
}

// ---- Conversation history -------------------------------------------------------------------------

/** What is stored per conversation. The backend keeps it as opaque JSON. */
interface SavedData {
  version: 1;
  turns: Turn[];
  history: llm.Message[];
  lastAskedContext: ChatContext | null;
}

// Tool results can be large (log lines, series); keep enough to read the investigation back and to let the
// model continue it, without saving megabytes per conversation.
const MAX_STEP_CHARS = 4000;
const MAX_MESSAGE_CHARS = 16000;
const TITLE_CHARS = 80;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [trimmed ${text.length - max} characters]` : text;
}

function savedData(): SavedData {
  return {
    version: 1,
    turns: state.turns.map(({ restored: _restored, ...t }) => ({
      ...t,
      liveText: '',
      steps: t.steps.filter((st) => st.kind !== 'stats').map((st) => ({ ...st, text: clip(st.text, MAX_STEP_CHARS) })),
    })),
    history: history.map((m) =>
      m.role === 'tool' && typeof m.content === 'string' ? { ...m, content: clip(m.content, MAX_MESSAGE_CHARS) } : m
    ),
    lastAskedContext,
  };
}

let statusRequest: Promise<HistoryStatus> | null = null;

/** Asks the backend once whether history is configured. Safe to call from every component. */
export function initHistory(): Promise<HistoryStatus> {
  if (!statusRequest) {
    statusRequest = historyApi
      .status()
      .catch((e): HistoryStatus => ({ enabled: false, error: errorText(e) }))
      .then((h) => {
        set({ history: h });
        return h;
      });
  }
  return statusRequest;
}

/** Re-check after an admin changes the history database on the Setup page. */
export function refreshHistoryStatus(): Promise<HistoryStatus> {
  statusRequest = null;
  return initHistory();
}

/** The title has been generated but not saved yet. Sent once, so a rename elsewhere is not overwritten. */
let titlePending = false;
/** Version of this conversation as last loaded or saved by this tab; 0 when it has never been saved. */
let version = 0;
let saveChain: Promise<void> = Promise.resolve();

function isConflict(e: unknown): boolean {
  return (e as { status?: number })?.status === 409;
}

async function saveNow(id: string): Promise<void> {
  const title = titlePending ? state.title : undefined;
  const res = await historyApi.save(id, {
    base_version: version,
    title,
    turn_count: state.turns.length,
    data: savedData(),
  });
  version = res.version;
  if (title === state.title) {
    titlePending = false;
  }
}

function persist(): Promise<void> {
  const id = state.sessionId;
  saveChain = saveChain.then(async () => {
    const h = await initHistory();
    if (!h.enabled || state.readOnly || !state.turns.length || state.sessionId !== id) {
      return;
    }
    try {
      try {
        await saveNow(id);
      } catch (e) {
        if (!isConflict(e) || state.sessionId !== id) {
          throw e;
        }
        // Another tab saved this conversation since this tab loaded it. Keep both: this tab's version becomes
        // a conversation of its own instead of overwriting the other one.
        const title = `${state.title ?? fallbackTitle(state.turns[0].question)} (copy)`;
        version = 0;
        titlePending = true;
        set({
          sessionId: newSessionId(),
          title,
          shared: false,
          notice: `This conversation was also continued in another tab, so this tab's version was saved separately as “${title}”.`,
        });
        await saveNow(state.sessionId);
      }
      set({ saveError: undefined, listVersion: state.listVersion + 1 });
    } catch (e) {
      set({ saveError: `Not saved to history: ${errorText(e)}` });
    }
  });
  return saveChain;
}

function fallbackTitle(question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  return q.length > TITLE_CHARS ? `${q.slice(0, TITLE_CHARS - 1)}…` : q;
}

/** Turns the model's reply into a one-line title, or undefined when it is unusable. */
export function cleanGeneratedTitle(text: string): string | undefined {
  const line = text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/^(?:title:\s*)/i, '')
    .replace(/^["'#*\s]+|["'*.\s]+$/g, '');
  // A line ending in a colon is the start of an answer ("I can see these data sources:"), not a title.
  return line && line.length <= 120 && !line.endsWith(':') && line.split(/\s+/).length <= 14 ? line : undefined;
}

/** Names the conversation after its first answer: a few words an on-call engineer would search for later. */
async function generateTitle(turn: Turn): Promise<string> {
  const fallback = fallbackTitle(turn.question);
  if (!turn.answer?.trim()) {
    // Without an answer the model tends to answer the question instead of naming it.
    return fallback;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      llm.chatCompletions({
        model: llm.Model.BASE,
        messages: [
          {
            role: 'system',
            content:
              'You name saved conversations. Reply with the title only: at most 8 words, like an incident or RCA ' +
              'title, naming the service, symptom and time if known. No quotes, no trailing punctuation. Do not ' +
              'answer the question or add anything else.',
          },
          {
            role: 'user',
            content:
              'Name this conversation.\n\n<conversation>\n' +
              `<question>${clip(turn.question, 1000)}</question>\n` +
              `<answer>${clip(turn.answer, 2000)}</answer>\n</conversation>`,
          },
        ],
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 20000);
      }),
    ]);
    return cleanGeneratedTitle(res.choices[0]?.message?.content ?? '') ?? fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function afterTurn(turn: Turn) {
  const id = state.sessionId;
  if (!state.title) {
    // Save straight away under the question, then again once the model has named it.
    set({ title: fallbackTitle(turn.question) });
    titlePending = true;
    persist();
    const h = await initHistory();
    if (!h.enabled) {
      return;
    }
    const title = await generateTitle(turn);
    if (state.sessionId !== id) {
      return;
    }
    if (title !== state.title) {
      set({ title });
      titlePending = true;
    }
  }
  persist();
}

/** Opens a saved conversation (yours, or one shared with your org). */
export async function openSession(id: string) {
  if (state.running || (id === state.sessionId && (state.turns.length || state.loading))) {
    return;
  }
  history = [];
  lastAskedContext = null;
  titlePending = false;
  version = 0;
  set({
    sessionId: id,
    turns: [],
    title: undefined,
    shared: false,
    readOnly: false,
    ownerName: undefined,
    loading: true,
    loadError: undefined,
    saveError: undefined,
    notice: undefined,
  });
  try {
    const s = await historyApi.get<SavedData>(id);
    if (state.sessionId !== id) {
      return;
    }
    const turns = (s.data?.turns ?? []).map((t) => ({ ...t, liveText: '', restored: true }));
    history = s.data?.history ?? [];
    lastAskedContext = s.data?.lastAskedContext ?? null;
    nextId = Math.max(nextId, ...turns.map((t) => t.id + 1));
    version = s.version;
    set({
      turns,
      title: s.title,
      shared: s.shared,
      readOnly: !s.is_owner,
      ownerName: s.owner_name,
      loading: false,
    });
  } catch (e) {
    if (state.sessionId === id) {
      set({ loading: false, loadError: errorText(e) });
    }
  }
}

/** Starts a conversation of your own from a shared one, so you can keep asking where the owner stopped. */
export function continueAsCopy() {
  if (!state.readOnly) {
    return;
  }
  titlePending = true;
  version = 0;
  set({
    sessionId: newSessionId(),
    readOnly: false,
    shared: false,
    ownerName: undefined,
    title: state.title ? `${state.title} (continued)` : undefined,
  });
  persist();
}

export async function renameSession(id: string, title: string) {
  await historyApi.patch(id, { title });
  if (state.sessionId === id) {
    titlePending = false;
    set({ title });
  }
  set({ listVersion: state.listVersion + 1 });
}

export async function setSessionShared(id: string, shared: boolean) {
  if (id === state.sessionId) {
    // The current conversation may still be waiting to be saved; it must exist before it can be shared.
    await persist();
  }
  await historyApi.patch(id, { shared });
  if (state.sessionId === id) {
    set({ shared });
  }
  set({ listVersion: state.listVersion + 1 });
}

export async function deleteSession(id: string) {
  await historyApi.remove(id);
  if (state.sessionId === id) {
    newChat();
  }
  set({ listVersion: state.listVersion + 1 });
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
  if (state.running || state.readOnly || state.loading || !question.trim()) {
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
    const notes = takeProposalNotes();
    const prompt = withContext(question, ctx, changes);
    history = await runAgent(
      notes.length ? `[Since the last answer: ${notes.join(' ')}]\n\n${prompt}` : prompt,
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
    const done = state.turns.find((t) => t.id === id);
    if (done) {
      afterTurn(done);
    }
  }
}
