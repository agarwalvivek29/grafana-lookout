import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppRootProps, PluginType } from '@grafana/data';
import { render, waitFor } from '@testing-library/react';
import App from './App';

jest.mock('@grafana/llm', () => ({ llm: { health: () => Promise.resolve({ ok: true }) } }));
jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('Components/App', () => {
  test('renders the chat page', async () => {
    const props = {
      basename: 'a/sample-app',
      meta: { id: 'sample-app', name: 'Sample App', type: PluginType.app, enabled: true, jsonData: {} },
      query: {},
      path: '',
      onNavChanged: jest.fn(),
    } as unknown as AppRootProps;
    const { queryByText } = render(
      <MemoryRouter>
        <App {...props} />
      </MemoryRouter>
    );
    await waitFor(() => expect(queryByText(/ask about your data/i)).toBeInTheDocument(), { timeout: 3000 });
  });
});
