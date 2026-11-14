// Past conversations of the signed-in user, newest first. Used as the chat page's sidebar and as the
// assistant panel's history view.
import React, { useEffect, useState } from 'react';
import { css, cx } from '@emotion/css';
import { dateTimeFormatTimeAgo, GrafanaTheme2 } from '@grafana/data';
import { ConfirmModal, Icon, IconButton, Input, Spinner, Text, useStyles2 } from '@grafana/ui';
import { errorText, historyApi, SessionSummary } from './historyApi';
import { deleteSession, initHistory, renameSession, useChat } from './store';

interface Props {
  onOpen: (id: string) => void;
}

export function HistoryList({ onOpen }: Props) {
  const s = useStyles2(getStyles);
  const { history, listVersion, sessionId } = useChat();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<SessionSummary>();

  useEffect(() => {
    initHistory();
  }, []);

  useEffect(() => {
    if (!history?.enabled) {
      return;
    }
    let cancelled = false;
    // Wait for typing to pause before searching.
    const t = setTimeout(
      () =>
        historyApi
          .list(query.trim())
          .then((r) => !cancelled && (setRows(r), setError(undefined)))
          .catch((e) => !cancelled && setError(errorText(e))),
      query ? 250 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [history?.enabled, query, listVersion]);

  if (!history) {
    return <Spinner />;
  }
  if (!history.enabled) {
    return (
      <Text variant="bodySmall" color="secondary">
        {history.error ?? 'Conversation history is not configured.'}
      </Text>
    );
  }

  return (
    <div className={s.root}>
      <Input
        prefix={<Icon name="search" />}
        placeholder="Search conversations"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        aria-label="Search conversations"
      />
      {error && (
        <Text variant="bodySmall" color="error">
          {error}
        </Text>
      )}
      {rows === null && !error && <Spinner />}
      {rows?.length === 0 && (
        <Text variant="bodySmall" color="secondary">
          {query ? 'No conversation matches.' : 'Your conversations will show up here.'}
        </Text>
      )}
      <ul className={s.list} aria-label="Conversation history">
        {rows?.map((r) => (
          <li key={r.id} className={cx(s.item, r.id === sessionId && s.current)}>
            {editing === r.id ? (
              <Input
                autoFocus
                defaultValue={r.title}
                aria-label="Conversation title"
                onBlur={() => setEditing(undefined)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setEditing(undefined);
                  } else if (e.key === 'Enter') {
                    const title = e.currentTarget.value.trim();
                    setEditing(undefined);
                    if (title && title !== r.title) {
                      renameSession(r.id, title).catch((err) => setError(errorText(err)));
                    }
                  }
                }}
              />
            ) : (
              <>
                <button className={s.open} onClick={() => onOpen(r.id)} title={r.title}>
                  <span className={s.title}>{r.title || 'Untitled'}</span>
                  <span className={s.meta}>
                    {r.shared && <Icon name="users-alt" size="xs" title="Shared with your org" />}
                    {dateTimeFormatTimeAgo(r.updated_at)} · {r.turn_count} question{r.turn_count === 1 ? '' : 's'}
                  </span>
                </button>
                <span className={s.actions}>
                  <IconButton name="pen" size="sm" tooltip="Rename" onClick={() => setEditing(r.id)} />
                  <IconButton name="trash-alt" size="sm" tooltip="Delete" onClick={() => setDeleting(r)} />
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <ConfirmModal
        isOpen={Boolean(deleting)}
        title="Delete conversation"
        body={`Delete “${deleting?.title}”?${deleting?.shared ? ' Links you shared to it will stop working.' : ''}`}
        confirmText="Delete"
        onConfirm={() => {
          const id = deleting!.id;
          setDeleting(undefined);
          deleteSession(id).catch((e) => setError(errorText(e)));
        }}
        onDismiss={() => setDeleting(undefined)}
      />
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  root: css`
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    min-height: 0;
  `,
  list: css`
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    border-radius: ${theme.shape.radius.default};
    padding-right: ${theme.spacing(0.5)};
    &:hover {
      background: ${theme.colors.action.hover};
    }
    & > span:last-child {
      visibility: hidden;
    }
    &:hover > span:last-child,
    &:focus-within > span:last-child {
      visibility: visible;
    }
  `,
  current: css`
    background: ${theme.colors.action.selected};
  `,
  open: css`
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: ${theme.spacing(0.75, 1)};
    background: none;
    border: none;
    color: ${theme.colors.text.primary};
    text-align: left;
    cursor: pointer;
  `,
  title: css`
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  meta: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
    align-items: center;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(0.25)};
  `,
});
