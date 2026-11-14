// Client for the backend's conversation-history routes (pkg/plugin/resources.go).
import { lastValueFrom } from 'rxjs';
import { config, getBackendSrv } from '@grafana/runtime';
import pluginJson from '../plugin.json';

const BASE = `/api/plugins/${pluginJson.id}/resources`;

export interface HistoryStatus {
  enabled: boolean;
  error?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  shared: boolean;
  turn_count: number;
  created_at: string;
  updated_at: string;
}

export interface SavedSession<D> extends SessionSummary {
  owner_name: string;
  is_owner: boolean;
  /** Goes up by one on every save; a save names the version it builds on. */
  version: number;
  data: D;
}

async function request<T>(method: string, path: string, data?: unknown): Promise<T> {
  const res = await lastValueFrom(
    getBackendSrv().fetch<T>({
      url: `${BASE}/${path}`,
      method,
      data,
      showErrorAlert: false,
      showSuccessAlert: false,
    })
  );
  return res.data;
}

export function errorText(e: unknown): string {
  const err = e as { status?: number; data?: { message?: string } | string; message?: string };
  if (err?.status === 404) {
    return 'This conversation does not exist, or it has not been shared with you.';
  }
  const msg = typeof err?.data === 'string' ? err.data : err?.data?.message;
  return (msg || err?.message || String(e)).trim();
}

export const historyApi = {
  status: () => request<HistoryStatus>('GET', 'history/status'),
  list: (q = '') => request<SessionSummary[]>('GET', `sessions${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  get: <D>(id: string) => request<SavedSession<D>>('GET', `sessions/${encodeURIComponent(id)}`),
  save: (id: string, body: { base_version: number; title?: string; turn_count: number; data: unknown }) =>
    request<{ version: number }>('PUT', `sessions/${encodeURIComponent(id)}`, body),
  patch: (id: string, body: { title?: string; shared?: boolean }) =>
    request<void>('PATCH', `sessions/${encodeURIComponent(id)}`, body),
  remove: (id: string) => request<void>('DELETE', `sessions/${encodeURIComponent(id)}`),
};

/** In-app path of a saved conversation. */
export function sessionPath(id: string): string {
  return `/a/${pluginJson.id}/chat/s/${encodeURIComponent(id)}`;
}

/** Full link to paste in Slack or an incident doc. */
export function sessionLink(id: string): string {
  return `${window.location.origin}${config.appSubUrl ?? ''}${sessionPath(id)}`;
}

export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
