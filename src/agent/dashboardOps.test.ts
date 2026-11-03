import {
  applyV1,
  emptyV2Dashboard,
  exactMatchOnMultiValue,
  multiValueVariables,
  needsV2Layout,
  normalizeGrid,
  applyV2,
  emptyV1Dashboard,
  OpError,
  parseOperations,
  saveTarget,
  substituteVariables,
  v2TargetGrid,
  variableValues,
} from './dashboardOps';

const ds = { prom: 'prometheus', logs: 'loki' };

const v1 = () => ({
  title: 'Shop',
  panels: [
    {
      id: 1,
      type: 'timeseries',
      title: 'Requests',
      gridPos: { x: 0, y: 0, w: 12, h: 8 },
      datasource: { type: 'prometheus', uid: 'prom' },
      targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prom' }, expr: 'sum(rate(x[5m]))' }],
      fieldConfig: { defaults: { unit: 'reqps', color: { mode: 'palette-classic' } }, overrides: [] },
    },
    {
      id: 2,
      type: 'row',
      title: 'More',
      collapsed: true,
      gridPos: { x: 0, y: 8, w: 24, h: 1 },
      panels: [
        {
          id: 3,
          type: 'stat',
          title: 'Errors',
          gridPos: { x: 0, y: 9, w: 6, h: 4 },
          targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prom' }, expr: 'sum(errors)' }],
        },
      ],
    },
  ],
  templating: { list: [{ name: 'service', current: { value: '$__all' } }] },
});

const v2 = () => ({
  title: 'Shop v2',
  elements: {
    'panel-1': {
      kind: 'Panel',
      spec: {
        id: 1,
        title: 'Requests',
        data: {
          kind: 'QueryGroup',
          spec: {
            queries: [
              {
                kind: 'PanelQuery',
                spec: {
                  refId: 'A',
                  query: { kind: 'DataQuery', group: 'prometheus', datasource: { name: 'prom' }, spec: { expr: 'up' } },
                },
              },
            ],
          },
        },
        vizConfig: {
          kind: 'VizConfig',
          group: 'timeseries',
          spec: { options: {}, fieldConfig: { defaults: {}, overrides: [] } },
        },
      },
    },
  },
  layout: {
    kind: 'RowsLayout',
    spec: {
      rows: [
        {
          kind: 'RowsLayoutRow',
          spec: {
            title: 'Top',
            layout: {
              kind: 'GridLayout',
              spec: {
                items: [
                  {
                    kind: 'GridLayoutItem',
                    spec: { x: 0, y: 0, width: 12, height: 8, element: { kind: 'ElementReference', name: 'panel-1' } },
                  },
                ],
              },
            },
          },
        },
        { kind: 'RowsLayoutRow', spec: { title: 'Bottom', layout: { kind: 'AutoGridLayout', spec: { items: [] } } } },
      ],
    },
  },
  variables: [],
});

describe('applyV1', () => {
  it('adds a panel next to existing ones, below everything', () => {
    const r = applyV1(
      v1(),
      parseOperations([
        {
          op: 'add_panel',
          panel: {
            title: 'p95',
            type: 'timeseries',
            datasource_uid: 'prom',
            unit: 's',
            queries: [{ expr: 'histogram_quantile(0.95, x)', legend: '{{service}}' }],
          },
        },
      ]),
      ds
    );
    const added = r.spec.panels[r.spec.panels.length - 1];
    expect(added).toMatchObject({ id: 4, title: 'p95', gridPos: { x: 0, y: 13, w: 12, h: 8 } });
    expect(added.targets[0]).toEqual({
      refId: 'A',
      datasource: { type: 'prometheus', uid: 'prom' },
      expr: 'histogram_quantile(0.95, x)',
      legendFormat: '{{service}}',
    });
    expect(added.fieldConfig.defaults.unit).toBe('s');
    expect(r.changes[0]).toMatchObject({ kind: 'add', text: 'Add panel "p95" (timeseries)' });
    expect(r.touched.map((t) => t.key)).toEqual(['panel-4']);
  });

  it('places two new panels side by side', () => {
    const r = applyV1(
      emptyV1Dashboard('New'),
      parseOperations([
        { op: 'add_panel', panel: { title: 'a', datasource_uid: 'prom', queries: ['up'] } },
        { op: 'add_panel', panel: { title: 'b', datasource_uid: 'prom', queries: ['up'] } },
        { op: 'add_panel', panel: { title: 'c', datasource_uid: 'prom', queries: ['up'] } },
      ]),
      ds
    );
    expect(r.spec.panels.map((p: any) => [p.gridPos.x, p.gridPos.y])).toEqual([
      [0, 0],
      [12, 0],
      [0, 8],
    ]);
  });

  it('updates a panel inside a collapsed row and keeps unrelated settings', () => {
    const r = applyV1(
      v1(),
      parseOperations([
        {
          op: 'update_panel',
          panel_key: 'panel-3',
          changes: { unit: 'percentunit', queries: [{ expr: 'sum(errors) / sum(total)' }] },
        },
      ]),
      ds
    );
    const p = r.spec.panels[1].panels[0];
    expect(p.fieldConfig.defaults.unit).toBe('percentunit');
    expect(p.targets[0].expr).toBe('sum(errors) / sum(total)');
    expect(r.changes[0].text).toBe('Change "Errors": unit, query');
    expect(r.changes[0].detail).toBe('sum(errors)\n→ sum(errors) / sum(total)');
  });

  it('names the panel by its current title when renaming', () => {
    const r = applyV1(
      v1(),
      parseOperations([{ op: 'update_panel', panel_key: 'panel-1', changes: { title: 'Traffic' } }]),
      ds
    );
    expect(r.changes[0].text).toBe('Change "Requests": title (now "Traffic")');
  });

  it('keeps existing field config when changing the unit', () => {
    const r = applyV1(
      v1(),
      parseOperations([{ op: 'update_panel', panel_key: 'panel-1', changes: { unit: 'short' } }]),
      ds
    );
    expect(r.spec.panels[0].fieldConfig.defaults).toEqual({ unit: 'short', color: { mode: 'palette-classic' } });
  });

  it('removes a panel and does not change the original', () => {
    const orig = v1();
    const r = applyV1(orig, parseOperations([{ op: 'remove_panel', panel_key: 'panel-1' }]), ds);
    expect(r.spec.panels.map((p: any) => p.id)).toEqual([2]);
    expect(orig.panels).toHaveLength(2);
  });

  it('adds a variable, renames and sets the time range', () => {
    const r = applyV1(
      v1(),
      parseOperations([
        { op: 'add_variable', name: 'env', datasource_uid: 'prom', query: 'label_values(up, env)' },
        { op: 'set_title', title: 'Shop 2' },
        { op: 'set_time', from: 'now-24h', to: 'now' },
      ]),
      ds
    );
    expect(r.spec.templating.list[1]).toMatchObject({
      type: 'query',
      name: 'env',
      query: 'label_values(up, env)',
      includeAll: true,
    });
    expect(r.spec.title).toBe('Shop 2');
    expect(r.spec.time).toEqual({ from: 'now-24h', to: 'now' });
  });

  it('rejects unknown panels, data sources, types and bad variables', () => {
    expect(() => applyV1(v1(), parseOperations([{ op: 'remove_panel', panel_key: 'panel-99' }]), ds)).toThrow(OpError);
    expect(() =>
      applyV1(
        v1(),
        parseOperations([{ op: 'add_panel', panel: { title: 'x', datasource_uid: 'nope', queries: ['up'] } }]),
        ds
      )
    ).toThrow(/Unknown data source/);
    expect(() =>
      applyV1(
        v1(),
        parseOperations([
          { op: 'add_panel', panel: { title: 'x', type: 'iframe', datasource_uid: 'prom', queries: ['up'] } },
        ]),
        ds
      )
    ).toThrow(/Unsupported panel type/);
    expect(() =>
      applyV1(v1(), parseOperations([{ op: 'add_variable', name: 'service', datasource_uid: 'prom', query: 'x' }]), ds)
    ).toThrow(/already exists/);
    expect(() =>
      applyV1(
        v1(),
        parseOperations([{ op: 'add_variable', name: '__proto__', datasource_uid: 'prom', query: 'x' }]),
        ds
      )
    ).toThrow(/Invalid variable/);
  });

  it('adds a markdown text panel without a data source', () => {
    const r = applyV1(
      v1(),
      parseOperations([{ op: 'add_panel', panel: { title: 'Notes', type: 'text', content: '# Hi' } }]),
      ds
    );
    const p = r.spec.panels[r.spec.panels.length - 1];
    expect(p.options).toEqual({ mode: 'markdown', content: '# Hi' });
    expect(p.targets).toBeUndefined();
  });
});

describe('applyV2', () => {
  it('adds a panel to the named row, or to the last grid', () => {
    const named = applyV2(
      v2(),
      parseOperations([
        { op: 'add_panel', row: 'Top', panel: { title: 'b', datasource_uid: 'prom', queries: ['up'] } },
      ]),
      ds
    );
    const top = named.spec.layout.spec.rows[0].spec.layout.spec.items;
    expect(top[1].spec).toMatchObject({ x: 12, y: 0, width: 12, height: 8, element: { name: 'panel-2' } });
    expect(named.spec.elements['panel-2'].spec.data.spec.queries[0].spec.query).toMatchObject({
      group: 'prometheus',
      datasource: { name: 'prom' },
      spec: { expr: 'up' },
    });

    const last = applyV2(
      v2(),
      parseOperations([{ op: 'add_panel', panel: { title: 'c', datasource_uid: 'prom', queries: ['up'] } }]),
      ds
    );
    expect(last.spec.layout.spec.rows[1].spec.layout.spec.items).toEqual([
      { kind: 'AutoGridLayoutItem', spec: { element: { kind: 'ElementReference', name: 'panel-2' } } },
    ]);
  });

  it('updates and removes panels and their layout items', () => {
    const r = applyV2(
      v2(),
      parseOperations([
        { op: 'update_panel', panel_key: 'panel-1', changes: { type: 'stat', unit: 'reqps', width: 6 } },
      ]),
      ds
    );
    const s = r.spec.elements['panel-1'].spec;
    expect(s.vizConfig.group).toBe('stat');
    expect(s.vizConfig.spec.fieldConfig.defaults.unit).toBe('reqps');
    expect(r.spec.layout.spec.rows[0].spec.layout.spec.items[0].spec.width).toBe(6);

    const removed = applyV2(v2(), parseOperations([{ op: 'remove_panel', panel_key: 'panel-1' }]), ds);
    expect(removed.spec.elements).toEqual({});
    expect(removed.spec.layout.spec.rows[0].spec.layout.spec.items).toEqual([]);
  });

  it('finds the grid in tabs', () => {
    const layout = {
      kind: 'TabsLayout',
      spec: {
        tabs: [
          { spec: { title: 'A', layout: { kind: 'GridLayout', spec: { items: [] } } } },
          { spec: { title: 'B', layout: { kind: 'GridLayout', spec: { items: [] } } } },
        ],
      },
    };
    expect(v2TargetGrid(layout, 'A')).toBe(layout.spec.tabs[0].spec.layout);
    expect(v2TargetGrid(layout)).toBe(layout.spec.tabs[1].spec.layout);
  });
});

describe('variables', () => {
  it('reads current values', () => {
    expect(variableValues(v1(), 'v1')).toEqual({ service: '$__all' });
  });
  it('substitutes built-ins and dashboard variables', () => {
    const vals = { service: '$__all', env: 'prod', multi: undefined };
    expect(
      substituteVariables('rate(x{service=~"$service", env="${env}", m=~"[[multi]]"}[$__rate_interval]) $other', vals)
    ).toBe('rate(x{service=~".+", env="prod", m=~".+"}[2m]) $other');
  });
});

describe('exact matches on multi-value variables', () => {
  it('checks label="$var" with any value when the variable has no single value', () => {
    expect(substituteVariables('up{service="$service", env="${env}"}', { service: '$__all', env: undefined })).toBe(
      'up{service=~".+", env=~".+"}'
    );
    expect(substituteVariables('up{service="$service"}', { service: 'checkout' })).toBe('up{service="checkout"}');
  });
  it('flags panels that compare a multi-value variable with =', () => {
    const spec = {
      templating: {
        list: [
          { name: 'service', multi: true },
          { name: 'env', multi: false },
        ],
      },
    };
    const views = [
      {
        key: 'a',
        title: 'Bad',
        type: 'stat',
        queries: [{ dsUid: 'p', dsType: 'prometheus', expr: 'up{service="$service"}' }],
        fieldConfig: {},
        options: {},
      },
      {
        key: 'b',
        title: 'Good',
        type: 'stat',
        queries: [{ dsUid: 'p', dsType: 'prometheus', expr: 'up{service=~"$service", env="$env"}' }],
        fieldConfig: {},
        options: {},
      },
    ];
    expect(exactMatchOnMultiValue(views, multiValueVariables(spec, 'v1'))).toEqual(['"Bad" uses ="$service"']);
  });
});

describe('saveTarget', () => {
  it('saves in place only when allowed and not managed elsewhere', () => {
    expect(saveTarget(null).target).toBe('new');
    expect(saveTarget({ canSave: true }).target).toBe('in_place');
    expect(saveTarget({ canSave: false }).target).toBe('copy');
    expect(saveTarget({ canSave: true, managedBy: 'classic-file-provisioning' })).toMatchObject({ target: 'copy' });
    expect(saveTarget({ canSave: true, managedBy: 'repo' }).reason).toMatch(/Git Sync/);
  });
});

describe('parseOperations', () => {
  it('drops fields the model may not set', () => {
    const [op] = parseOperations([
      {
        op: 'add_panel',
        panel: {
          title: 't',
          datasource_uid: 'prom',
          queries: [{ expr: 'up' }],
          links: [{ url: 'https://evil' }],
          options: { x: 1 },
        },
      },
    ]);
    expect(op).toEqual({
      op: 'add_panel',
      row: undefined,
      panel: { title: 't', datasource_uid: 'prom', queries: [{ expr: 'up', legend: undefined }] },
    });
  });
  it('accepts the other shapes models use', () => {
    expect(parseOperations([{ action: 'set_title', title: 'a' }, { add_panel: { panel: { title: 'b' } } }])).toEqual([
      { op: 'set_title', title: 'a' },
      { op: 'add_panel', row: undefined, panel: { title: 'b' } },
    ]);
  });
  it('rejects unknown operations and too many', () => {
    expect(() => parseOperations([{ op: 'delete_dashboard' }])).toThrow(/Unknown operation/);
    expect(() => parseOperations([])).toThrow();
    expect(() => parseOperations(new Array(81).fill({ op: 'set_title', title: 'x' }))).toThrow(/At most/);
  });
});

describe('layout: tabs, rows and moving panels (v2)', () => {
  const panel = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    datasource_uid: 'prom',
    queries: [{ expr: 'up' }],
    ...extra,
  });
  const gridOf = (spec: any, tab: number) => spec.layout.spec.tabs[tab].spec.layout.spec.items;

  it('builds a tabbed dashboard with a stat strip on top', () => {
    const r = applyV2(
      emptyV2Dashboard('APM'),
      parseOperations([
        { op: 'add_tab', title: 'Summary' },
        { op: 'add_tab', title: 'Errors' },
        { op: 'add_panel', tab: 'Summary', panel: panel('Throughput', { width: 12 }) },
        { op: 'add_panel', tab: 'Summary', x: 0, y: 0, panel: panel('Rate', { type: 'stat', width: 6, height: 4 }) },
        { op: 'add_panel', tab: 'Summary', x: 6, y: 0, panel: panel('Errors', { type: 'stat', width: 6, height: 4 }) },
        { op: 'add_panel', tab: 'Errors', panel: panel('Error logs', { type: 'logs', datasource_uid: 'logs' }) },
      ]),
      ds
    );
    expect(r.spec.layout.kind).toBe('TabsLayout');
    expect(r.spec.layout.spec.tabs.map((t: any) => t.spec.title)).toEqual(['Summary', 'Errors']);
    const summary = gridOf(r.spec, 0).map((it: any) => [
      r.spec.elements[it.spec.element.name].spec.title,
      it.spec.x,
      it.spec.y,
      it.spec.width,
    ]);
    // The stats placed at y 0 push the time series below them.
    expect(summary).toEqual([
      ['Rate', 0, 0, 6],
      ['Errors', 6, 0, 6],
      ['Throughput', 0, 4, 12],
    ]);
    expect(gridOf(r.spec, 1)).toHaveLength(1);
  });

  it('wraps existing panels into the first tab and rows into a tab', () => {
    const r = applyV2(
      v2(),
      parseOperations([
        { op: 'add_tab', title: 'Runtime', existing_title: 'Service' },
        { op: 'add_row', tab: 'Runtime', title: 'JVM' },
        { op: 'add_row', tab: 'Runtime', title: 'Go', collapsed: true },
        { op: 'add_panel', tab: 'Runtime', row: 'Go', panel: panel('Goroutines') },
      ]),
      ds
    );
    const tabs = r.spec.layout.spec.tabs;
    expect(tabs.map((t: any) => t.spec.title)).toEqual(['Service', 'Runtime']);
    expect(tabs[0].spec.layout.kind).toBe('RowsLayout'); // the original rows, unchanged
    const rows = tabs[1].spec.layout.spec.rows;
    expect(rows.map((x: any) => [x.spec.title, x.spec.collapse])).toEqual([
      ['JVM', false],
      ['Go', true],
    ]);
    expect(rows[1].spec.layout.spec.items).toHaveLength(1);
    expect(r.changes.map((c) => c.text)).toContain('Put the existing panels in tab "Service"');
  });

  it('moves a panel to another tab and closes the gap it left', () => {
    let spec = applyV2(
      emptyV2Dashboard('x'),
      parseOperations([
        { op: 'add_tab', title: 'A' },
        { op: 'add_tab', title: 'B' },
        { op: 'add_panel', tab: 'A', panel: panel('one', { width: 24 }) },
        { op: 'add_panel', tab: 'A', panel: panel('two', { width: 24 }) },
      ]),
      ds
    ).spec;
    const r = applyV2(spec, parseOperations([{ op: 'move_panel', panel_key: 'panel-1', tab: 'B' }]), ds);
    spec = r.spec;
    expect(gridOf(spec, 0).map((it: any) => [it.spec.element.name, it.spec.y])).toEqual([['panel-2', 0]]);
    expect(gridOf(spec, 1).map((it: any) => it.spec.element.name)).toEqual(['panel-1']);
    expect(r.changes[0].text).toBe('Move "one" to tab "B"');
  });

  it('resizes and repositions within the same grid without overlaps', () => {
    const items = [
      { kind: 'GridLayoutItem', spec: { x: 0, y: 0, width: 12, height: 8, element: { name: 'a' } } },
      { kind: 'GridLayoutItem', spec: { x: 12, y: 0, width: 12, height: 8, element: { name: 'b' } } },
      { kind: 'GridLayoutItem', spec: { x: 0, y: 0, width: 24, height: 4, element: { name: 'c' } } },
    ];
    normalizeGrid(items, 'c');
    expect(items.map((i) => [i.spec.element.name, i.spec.x, i.spec.y])).toEqual([
      ['c', 0, 0],
      ['a', 0, 4],
      ['b', 12, 4],
    ]);
  });

  it('refuses to remove a tab that still has panels, and needs tab names to exist', () => {
    const spec = applyV2(
      emptyV2Dashboard('x'),
      parseOperations([
        { op: 'add_tab', title: 'A' },
        { op: 'add_panel', tab: 'A', panel: panel('one') },
      ]),
      ds
    ).spec;
    expect(() => applyV2(spec, parseOperations([{ op: 'remove_container', tab: 'A' }]), ds)).toThrow(
      /still has 1 panel/
    );
    expect(() => applyV2(spec, parseOperations([{ op: 'add_panel', tab: 'Nope', panel: panel('x') }]), ds)).toThrow(
      /No tab "Nope". Tabs: "A"/
    );
    expect(() => applyV2(spec, parseOperations([{ op: 'add_row', title: 'r' }]), ds)).toThrow(/say which tab/);
  });

  it('knows which operations need the v2 layout', () => {
    expect(needsV2Layout(parseOperations([{ op: 'add_panel', panel: panel('x') }]))).toBe(false);
    expect(needsV2Layout(parseOperations([{ op: 'add_panel', tab: 'A', panel: panel('x') }]))).toBe(true);
    expect(needsV2Layout(parseOperations([{ op: 'add_tab', title: 'A' }]))).toBe(true);
    expect(() => applyV1(v1(), parseOperations([{ op: 'add_tab', title: 'A' }]), ds)).toThrow(/needs the v2/);
  });
});

describe('tables and traces', () => {
  it('merges several table queries into one table with named columns', () => {
    const r = applyV2(
      emptyV2Dashboard('x'),
      parseOperations([
        {
          op: 'add_panel',
          panel: {
            title: 'Endpoints',
            type: 'table',
            datasource_uid: 'prom',
            queries: [
              { expr: 'a', legend: 'rate' },
              { expr: 'b', legend: 'p95' },
            ],
          },
        },
      ]),
      ds
    );
    expect(r.spec.elements['panel-1'].spec.data.spec.transformations).toEqual([
      { kind: 'Transformation', group: 'merge', spec: { options: {} } },
      {
        kind: 'Transformation',
        group: 'organize',
        spec: { options: { excludeByName: { Time: true }, renameByName: { 'Value #A': 'rate', 'Value #B': 'p95' } } },
      },
    ]);
  });
  it('names table columns and sets their units', () => {
    const r = applyV1(
      emptyV1Dashboard('x'),
      parseOperations([
        {
          op: 'add_panel',
          panel: {
            title: 'E',
            type: 'table',
            datasource_uid: 'prom',
            queries: [
              { expr: 'a', legend: '{{span_name}}', name: 'Rate', unit: 'reqps' },
              { expr: 'b', name: 'p95', unit: 's' },
            ],
          },
        },
      ]),
      ds
    );
    const p = r.spec.panels[0];
    expect(p.transformations[1].options.renameByName).toEqual({ 'Value #A': 'Rate', 'Value #B': 'p95' });
    expect(p.fieldConfig.overrides).toEqual([
      { matcher: { id: 'byName', options: 'Rate' }, properties: [{ id: 'unit', value: 'reqps' }] },
      { matcher: { id: 'byName', options: 'p95' }, properties: [{ id: 'unit', value: 's' }] },
    ]);
  });
  it('turns a trace search in a traces panel into a table', () => {
    const r = applyV1(
      emptyV1Dashboard('x'),
      parseOperations([
        {
          op: 'add_panel',
          panel: { title: 'Errors', type: 'traces', datasource_uid: 'tempo', queries: ['{ status = error }'] },
        },
      ]),
      { ...ds, tempo: 'tempo' }
    );
    expect(r.spec.panels[0]).toMatchObject({
      type: 'table',
      targets: [{ queryType: 'traceql', tableType: 'traces', query: '{ status = error }' }],
    });
  });
});

describe('variables and panel options', () => {
  it('adds data source and custom variables, and panels can use the data source variable', () => {
    const dsCopy = { ...ds };
    const r = applyV2(
      emptyV2Dashboard('x'),
      parseOperations([
        { op: 'add_variable', kind: 'datasource', name: 'metrics', ds_type: 'prometheus', hide: true },
        {
          op: 'add_variable',
          kind: 'custom',
          name: 'spanKind',
          query: 'Server : SPAN_KIND_SERVER, Consumer : SPAN_KIND_CONSUMER',
        },
        {
          op: 'add_panel',
          panel: { title: 'x', datasource_uid: '${metrics}', queries: [{ expr: 'up{kind="$spanKind"}' }] },
        },
      ]),
      dsCopy
    );
    const [dsVar, custom] = r.spec.variables;
    expect(dsVar).toMatchObject({
      kind: 'DatasourceVariable',
      spec: { name: 'metrics', pluginId: 'prometheus', hide: 'hideVariable' },
    });
    expect(custom.spec.options.map((o: any) => [o.text, o.value])).toEqual([
      ['Server', 'SPAN_KIND_SERVER'],
      ['Consumer', 'SPAN_KIND_CONSUMER'],
    ]);
    expect(custom.spec.current).toEqual({ text: 'Server', value: 'SPAN_KIND_SERVER' });
    expect(r.spec.elements['panel-1'].spec.data.spec.queries[0].spec.query).toMatchObject({
      group: 'prometheus',
      datasource: { name: '${metrics}' },
    });
  });

  it('draws thresholds as lines on time series', () => {
    const r = applyV1(
      emptyV1Dashboard('x'),
      parseOperations([
        {
          op: 'add_panel',
          panel: {
            title: 'err',
            datasource_uid: 'prom',
            queries: ['up'],
            thresholds: [{ value: 1, color: 'yellow' }],
            threshold_style: 'dashed',
          },
        },
      ]),
      ds
    );
    expect(r.spec.panels[0].fieldConfig.defaults.custom.thresholdsStyle).toEqual({ mode: 'dashed' });
  });
});
