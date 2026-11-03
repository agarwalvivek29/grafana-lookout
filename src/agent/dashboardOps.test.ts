import {
  applyV1,
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
    ).toBe('rate(x{service=~".*", env="prod", m=~".*"}[2m]) $other');
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
    expect(() => parseOperations(new Array(31).fill({ op: 'set_title', title: 'x' }))).toThrow(/At most/);
  });
});
