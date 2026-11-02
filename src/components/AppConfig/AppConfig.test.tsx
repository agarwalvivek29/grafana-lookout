import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AppConfig, { AppConfigProps } from './AppConfig';
import { testIds } from 'components/testIds';

const get = jest.fn();
jest.mock('@grafana/llm', () => ({ llm: {} }));
jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  config: { rendererAvailable: false },
  getBackendSrv: () => ({ get, fetch: jest.fn() }),
}));

const props = {
  plugin: { meta: { id: 'sample-app', name: 'Sample App', type: PluginType.app, enabled: true, jsonData: {} } },
  query: {},
} as unknown as AppConfigProps;

describe('Components/AppConfig', () => {
  beforeEach(() => get.mockReset());

  test('shows the model form and detected data sources', async () => {
    get.mockImplementation((url: string) =>
      url.includes('grafana-llm-app')
        ? Promise.resolve({
            jsonData: { provider: 'custom', openAI: { url: 'https://openrouter.ai/api' } },
            secureJsonFields: {},
          })
        : Promise.resolve([
            { name: 'Prom', type: 'prometheus' },
            { name: 'Logs', type: 'loki' },
          ])
    );
    // @ts-ignore - addConfigPage/setChannelSupport are not needed here
    render(
      <MemoryRouter>
        <AppConfig {...props} />
      </MemoryRouter>
    );
    expect(await screen.findByTestId(testIds.appConfig.apiUrl)).toHaveValue('https://openrouter.ai/api');
    await waitFor(() => expect(screen.getByText('Prom')).toBeInTheDocument());
    expect(screen.getByText(/Add a Tempo data source/)).toBeInTheDocument();
    expect(screen.getByText(/No image renderer/)).toBeInTheDocument();
  });

  test('explains how to install the LLM plugin when it is missing', async () => {
    get.mockImplementation((url: string) =>
      url.includes('grafana-llm-app') ? Promise.reject(new Error('404')) : Promise.resolve([])
    );
    // @ts-ignore
    render(
      <MemoryRouter>
        <AppConfig {...props} />
      </MemoryRouter>
    );
    expect(await screen.findByText(/The Grafana LLM plugin is not installed/)).toBeInTheDocument();
  });
});
