import { historyApi } from './historyApi';
import {
  ask,
  cleanGeneratedTitle,
  continueAsCopy,
  getChatState,
  newChat,
  openSession,
  refreshHistoryStatus,
} from './store';

jest.mock('@grafana/llm', () => ({
  llm: {
    Model: { BASE: 'base' },
    chatCompletions: jest.fn(() =>
      Promise.resolve({ choices: [{ message: { content: '"Checkout 5xx spike after deploy."' } }] })
    ),
  },
}));

jest.mock('../agent/agent', () => ({
  runAgent: jest.fn(
    async (q: string, onStep: (s: { kind: string; text: string }) => void, _l: unknown, h: unknown[]) => {
      onStep({ kind: 'model', text: 'query_prometheus {"expr":"up"}' });
      onStep({ kind: 'tool', text: 'query_prometheus → ' + 'x'.repeat(10000) });
      onStep({ kind: 'stats', text: 'step 1' });
      onStep({ kind: 'answer', text: 'Errors rose at 14:05.' });
      return [...h, { role: 'user', content: q }, { role: 'assistant', content: 'Errors rose at 14:05.' }];
    }
  ),
}));

jest.mock('../agent/dashboards', () => ({ takeProposalNotes: () => [] }));

jest.mock('./historyApi', () => ({
  ...jest.requireActual('./historyApi'),
  historyApi: {
    status: jest.fn(() => Promise.resolve({ enabled: true })),
    save: jest.fn((_id: string, body: { base_version: number }) => Promise.resolve({ version: body.base_version + 1 })),
    get: jest.fn(),
    patch: jest.fn(() => Promise.resolve()),
    remove: jest.fn(() => Promise.resolve()),
    list: jest.fn(() => Promise.resolve([])),
  },
}));

const api = historyApi as jest.Mocked<typeof historyApi>;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  jest.clearAllMocks();
  newChat();
  await refreshHistoryStatus();
});

test('saves after the first answer and names the conversation', async () => {
  await ask('why are checkout requests failing?');
  for (let i = 0; i < 5; i++) {
    await flush();
  }
  const id = getChatState().sessionId;
  expect(api.save).toHaveBeenCalledTimes(2);
  // First under the question, then under the generated title.
  expect(api.save.mock.calls[0][0]).toBe(id);
  expect(api.save.mock.calls[0][1].title).toBe('why are checkout requests failing?');
  expect(api.save.mock.calls[1][1].title).toBe('Checkout 5xx spike after deploy');
  expect(getChatState().title).toBe('Checkout 5xx spike after deploy');

  const data = api.save.mock.calls[1][1].data as any;
  expect(data.turns).toHaveLength(1);
  expect(data.turns[0].answer).toBe('Errors rose at 14:05.');
  expect(data.turns[0].steps.some((s: any) => s.kind === 'stats')).toBe(false);
  expect(data.turns[0].steps.find((s: any) => s.kind === 'tool').text.length).toBeLessThan(4100);
  expect(data.history).toHaveLength(2);

  // A later question does not resend the title, so a rename made elsewhere is kept.
  await ask('and payments?');
  await flush();
  await flush();
  expect(api.save).toHaveBeenCalledTimes(3);
  expect(api.save.mock.calls[2][1].title).toBeUndefined();
  expect(api.save.mock.calls[2][1].turn_count).toBe(2);
});

test('does nothing when history is not configured', async () => {
  api.status.mockResolvedValueOnce({ enabled: false, error: 'not configured' });
  await refreshHistoryStatus();
  await ask('hello');
  await flush();
  expect(api.save).not.toHaveBeenCalled();
  expect(getChatState().turns).toHaveLength(1);
});

test("opens someone else's shared conversation read-only and continues it as a copy", async () => {
  api.get.mockResolvedValueOnce({
    id: 'shared-session-1',
    title: 'RCA: checkout',
    shared: true,
    turn_count: 1,
    created_at: '',
    updated_at: '',
    owner_name: 'Alice',
    is_owner: false,
    data: {
      version: 1,
      turns: [{ id: 41, question: 'q', steps: [], answer: 'a', liveText: '', startedAt: 1, finishedAt: 2 }],
      history: [{ role: 'user', content: 'q' }],
      lastAskedContext: null,
    },
  } as any);
  await openSession('shared-session-1');
  let s = getChatState();
  expect(s.readOnly).toBe(true);
  expect(s.ownerName).toBe('Alice');
  expect(s.turns[0].restored).toBe(true);

  await ask('can I ask?');
  expect(getChatState().turns).toHaveLength(1);

  continueAsCopy();
  await flush();
  await flush();
  s = getChatState();
  expect(s.readOnly).toBe(false);
  expect(s.sessionId).not.toBe('shared-session-1');
  expect(api.save).toHaveBeenCalledWith(s.sessionId, expect.objectContaining({ title: 'RCA: checkout (continued)' }));
});

test('saves build on the version this tab last saved or loaded', async () => {
  await ask('first');
  for (let i = 0; i < 5; i++) {
    await flush();
  }
  // Question saved at version 0 -> 1, then the generated title at 1 -> 2.
  expect(api.save.mock.calls.map((c) => c[1].base_version)).toEqual([0, 1]);
});

test('keeps both versions when another tab continued the same conversation', async () => {
  api.get.mockResolvedValueOnce({
    id: 'mine-session-1',
    title: 'Checkout latency',
    shared: true,
    turn_count: 1,
    created_at: '',
    updated_at: '',
    owner_name: 'Me',
    is_owner: true,
    version: 5,
    data: {
      version: 1,
      turns: [{ id: 7, question: 'q', steps: [], answer: 'a', liveText: '', startedAt: 1, finishedAt: 2 }],
      history: [],
      lastAskedContext: null,
    },
  } as any);
  await openSession('mine-session-1');
  // The other tab saved version 6 in the meantime.
  api.save.mockRejectedValueOnce({ status: 409 });
  await ask('follow-up');
  for (let i = 0; i < 5; i++) {
    await flush();
  }
  const s = getChatState();
  expect(api.save.mock.calls[0][0]).toBe('mine-session-1');
  expect(api.save.mock.calls[0][1].base_version).toBe(5);
  // This tab's conversation is saved under a new id instead of overwriting the other tab's.
  expect(s.sessionId).not.toBe('mine-session-1');
  expect(api.save.mock.calls[1][0]).toBe(s.sessionId);
  expect(api.save.mock.calls[1][1]).toEqual(
    expect.objectContaining({ base_version: 0, title: 'Checkout latency (copy)', turn_count: 2 })
  );
  expect(s.shared).toBe(false);
  expect(s.notice).toMatch(/continued in another tab/);
  expect(s.saveError).toBeUndefined();
});

test('reports a conversation that cannot be opened', async () => {
  api.get.mockRejectedValueOnce({ status: 404 });
  await openSession('missing-session');
  expect(getChatState().loadError).toMatch(/not been shared with you/);
  expect(getChatState().loading).toBe(false);
});

test('cleans model titles', () => {
  expect(cleanGeneratedTitle('<think>hmm</think>\n\nTitle: "Payments latency spike."\nmore')).toBe(
    'Payments latency spike'
  );
  expect(cleanGeneratedTitle('   ')).toBeUndefined();
  expect(cleanGeneratedTitle('x'.repeat(200))).toBeUndefined();
  expect(cleanGeneratedTitle('I can see the following data sources in this conversation:')).toBeUndefined();
});
