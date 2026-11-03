import { runTool } from './agent';

const get = jest.fn();
const post = jest.fn();
jest.mock('@grafana/llm', () => ({ llm: {} }));
jest.mock('@grafana/runtime', () => ({ getBackendSrv: () => ({ get, post }) }));

const types: Record<string, string> = { loki1: 'loki', qw1: 'quickwit-quickwit-datasource', es1: 'elasticsearch' };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    const m = url.match(/^\/api\/datasources\/uid\/([^/]+)$/);
    if (m) {
      return Promise.resolve({ type: types[m[1]] });
    }
    if (url.endsWith('/resources/labels')) {
      return Promise.resolve({ data: ['service_name', 'level'] });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});

describe('logs tools on Loki', () => {
  test('logs_sample reads Loki frames and flags level mismatches', async () => {
    post.mockResolvedValue({
      results: {
        A: {
          frames: [
            {
              schema: { fields: [{ name: 'labels' }, { name: 'Time' }, { name: 'Line' }] },
              data: {
                values: [
                  [{ service_name: 'checkout', level: 'info' }],
                  [1700000000000],
                  ['2024-01-01 ERROR payment declined'],
                ],
              },
            },
          ],
        },
      },
    });
    const out = JSON.parse(
      await runTool('logs_sample', JSON.stringify({ datasource_uid: 'loki1', query: '{service_name="checkout"}' }))
    );
    expect(post.mock.calls[0][1].queries[0]).toMatchObject({
      expr: '{service_name="checkout"}',
      queryType: 'range',
      maxLines: 5,
    });
    expect(out.untrusted_log_lines[0]).toMatchObject({
      service: 'checkout',
      level_in_text: 'ERROR',
      level_mismatch: true,
    });
  });

  test('logs_top_values builds a LogQL topk over the window', async () => {
    post.mockResolvedValue({
      results: {
        A: {
          frames: [
            {
              schema: { fields: [{ name: 'Time' }, { name: 'Value', labels: { level: 'error' } }] },
              data: { values: [[1], [7]] },
            },
            {
              schema: { fields: [{ name: 'Time' }, { name: 'Value', labels: { level: 'info' } }] },
              data: { values: [[1], [90]] },
            },
          ],
        },
      },
    });
    const out = JSON.parse(
      await runTool(
        'logs_top_values',
        JSON.stringify({ datasource_uid: 'loki1', query: '{app="x"}', field: 'level', minutes: 30 })
      )
    );
    expect(post.mock.calls[0][1].queries[0].expr).toBe('topk(10, sum by (level) (count_over_time({app="x"} [30m])))');
    expect(out.top).toEqual([
      { value: 'info', count: 90 },
      { value: 'error', count: 7 },
    ]);
  });

  test('logs_label_values lists labels', async () => {
    const out = JSON.parse(await runTool('logs_label_values', JSON.stringify({ datasource_uid: 'loki1' })));
    expect(out.values).toEqual(['service_name', 'level']);
  });

  test('logs_explore_link opens a Loki query', async () => {
    const out = JSON.parse(
      await runTool('logs_explore_link', JSON.stringify({ datasource_uid: 'loki1', query: '{app="x"}' }))
    );
    const panes = JSON.parse(decodeURIComponent(out.url.split('panes=')[1]));
    expect(panes.a.queries[0]).toMatchObject({ expr: '{app="x"}', datasource: { uid: 'loki1', type: 'loki' } });
  });
});

describe('logs tools dispatch', () => {
  test('unsupported log datasource types return an error the model can read', async () => {
    const out = JSON.parse(await runTool('logs_sample', JSON.stringify({ datasource_uid: 'es1', query: 'x' })));
    expect(out.error).toMatch(/not supported for logs/);
  });

  test('logs_label_values on Quickwit points the model at logs_top_values', async () => {
    const out = JSON.parse(await runTool('logs_label_values', JSON.stringify({ datasource_uid: 'qw1' })));
    expect(out.error).toMatch(/logs_top_values/);
  });
});

describe('logs_top_values on Loki with a field that is not a label', () => {
  test('returns the total and tells the model how to group instead', async () => {
    post.mockResolvedValue({
      results: {
        A: {
          frames: [
            { schema: { fields: [{ name: 'Time' }, { name: 'Value', labels: {} }] }, data: { values: [[1], [42]] } },
          ],
        },
      },
    });
    const out = JSON.parse(
      await runTool(
        'logs_top_values',
        JSON.stringify({ datasource_uid: 'loki1', query: '{app="x"}', field: 'message' })
      )
    );
    expect(out.total).toBe(42);
    expect(out.note).toMatch(/not a label/);
  });
});

describe('explore_link', () => {
  test('warns when the query has no data in the linked range', async () => {
    post.mockResolvedValue({ results: { A: { frames: [] } } });
    const out = JSON.parse(
      await runTool('explore_link', JSON.stringify({ datasource_uid: 'prom', expr: 'up{job="x"}', from: 'now-30m' }))
    );
    expect(post.mock.calls[0][1].queries[0].expr).toBe('max_over_time((up{job="x"})[30m:1m])');
    expect(out.url).toMatch(/^\/explore\?/);
    expect(out.warning).toMatch(/no data/);
  });

  test('links normally when the query has data', async () => {
    post.mockResolvedValue({
      results: {
        A: {
          frames: [
            { schema: { fields: [{ name: 'Time' }, { name: 'Value', labels: {} }] }, data: { values: [[1], [3]] } },
          ],
        },
      },
    });
    const out = JSON.parse(await runTool('explore_link', JSON.stringify({ datasource_uid: 'prom', expr: 'up' })));
    expect(out.warning).toBeUndefined();
    expect(out.series_in_range).toBe(1);
  });
});

describe('stripPreamble', () => {
  const { stripPreamble } = jest.requireActual('./agent');
  test.each([
    ['Perfect! Now I have all the information needed to answer your question.\n\nNo, it is fine.', 'No, it is fine.'],
    ['Perfect! Now I can provide a comprehensive explanation.\n\n## Panel', '## Panel'],
    ['Great! The checkout service is failing.', 'The checkout service is failing.'],
    ['The checkout service is failing.', 'The checkout service is failing.'],
    ['I have no data for that service.', 'I have no data for that service.'],
  ])('%s', (input, expected) => {
    expect(stripPreamble(input)).toBe(expected);
  });
});

describe('prom_range_summary', () => {
  test('summarises how a series changed and when it peaked', async () => {
    const t0 = Date.parse('2026-01-01T10:00:00Z');
    const times = Array.from({ length: 30 }, (_, i) => t0 + i * 60_000);
    const vals = times.map((_, i) => (i >= 10 && i < 16 ? 1.0 : 0.25));
    post.mockResolvedValue({
      results: {
        A: {
          frames: [
            {
              schema: { fields: [{ name: 'Time' }, { name: 'Value', labels: { span_name: 'POST /orders' } }] },
              data: { values: [times, vals] },
            },
          ],
        },
      },
    });
    const out = JSON.parse(
      await runTool(
        'prom_range_summary',
        JSON.stringify({ datasource_uid: 'prom', expr: 'rate(x[$__rate_interval])', from: 'now-30m', to: 'now' })
      )
    );
    expect(post.mock.calls[0][1].queries[0].expr).toBe('rate(x[2m])');
    const s = out.series[0];
    expect(s).toMatchObject({ first: 0.25, last: 0.25, min: 0.25, max: 1 });
    expect(s.max_at).toMatch(/^\d\d:10$/);
    expect(s.samples).toHaveLength(12);
    expect(s.elevated_episodes).toHaveLength(1);
    expect(s.elevated_episodes[0].from).toMatch(/:10$/);
    expect(s.elevated_episodes[0].to).toMatch(/:15$/);
    expect(s.elevated_pct_of_time).toBe(20);
    expect(out.times_in).toBeTruthy();
  });
});
