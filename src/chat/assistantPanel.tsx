// Floating right-hand assistant panel (stand-in for the docked extension sidebar, which Grafana
// restricts to an allowlist of plugins; tracked as V1.1). Mounted in its own React root on
// document.body so it stays open across in-app navigation (R3/D5) and leaves the page clickable
// (no mask), so the dashboard and the chat can be used side by side.
import React, { useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { css } from '@emotion/css';
import { GrafanaTheme2, ThemeContext } from '@grafana/data';
import { config, locationService } from '@grafana/runtime';
import { Button, IconButton, Stack, Text, useStyles2 } from '@grafana/ui';
import pluginJson from '../plugin.json';
import { ChatPanel } from './ChatPanel';
import { HistoryList } from './HistoryList';
import { ChatContext, newChat, openSession, setContext, syncContextFromLocation, useChat } from './store';
import { sessionPath } from './historyApi';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let stopListening: (() => void) | null = null;

function Panel({ onClose }: { onClose: () => void }) {
  const s = useStyles2(getStyles);
  // Expanded = the assistant takes the whole content area (below the top bar), thread centred.
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const { history, running, sessionId, turns } = useChat();
  return (
    <aside
      className={expanded ? `${s.panel} ${s.expanded}` : s.panel}
      aria-label="Lookout AI assistant"
      role="complementary"
    >
      <div className={s.header}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Text variant="h5">Lookout</Text>
          <Stack direction="row" gap={0.5}>
            {history?.enabled && (
              <IconButton
                name="history"
                tooltip={showHistory ? 'Back to the conversation' : 'Conversation history'}
                variant={showHistory ? 'primary' : 'secondary'}
                onClick={() => setShowHistory(!showHistory)}
              />
            )}
            <IconButton
              name={expanded ? 'compress-arrows' : 'expand-arrows'}
              tooltip={expanded ? 'Back to side panel' : 'Expand'}
              onClick={() => setExpanded(!expanded)}
            />
            <IconButton
              name="external-link-alt"
              tooltip="Open as page"
              onClick={() => {
                onClose();
                locationService.push(turns.length ? sessionPath(sessionId) : `/a/${pluginJson.id}/chat`);
              }}
            />
            <IconButton name="times" tooltip="Close (Esc)" onClick={onClose} />
          </Stack>
        </Stack>
      </div>
      <div className={s.body}>
        <div className={expanded ? s.centered : s.fill}>
          {showHistory ? (
            <div className={s.history}>
              <Button
                icon="plus"
                variant="secondary"
                fill="outline"
                disabled={running}
                onClick={() => {
                  newChat();
                  setShowHistory(false);
                }}
              >
                New chat
              </Button>
              <HistoryList
                onOpen={(id) => {
                  openSession(id);
                  setShowHistory(false);
                }}
              />
            </div>
          ) : (
            <ChatPanel panelMode={!expanded} />
          )}
        </div>
      </div>
    </aside>
  );
}

export function closeAssistantPanel() {
  stopListening?.();
  stopListening = null;
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.removeEventListener('keydown', onKey);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && host) {
    closeAssistantPanel();
  }
}

export function openAssistantPanel(context: ChatContext | null) {
  setContext(context);
  if (root) {
    return;
  }
  // Variable, time-range and dashboard changes all update the URL through Grafana's history.
  stopListening = locationService.getHistory().listen(() => syncContextFromLocation());
  host = document.createElement('div');
  host.setAttribute('data-testid', 'lookout-panel');
  document.body.appendChild(host);
  root = createRoot(host);
  document.addEventListener('keydown', onKey);
  root.render(
    <ThemeContext.Provider value={config.theme2}>
      <Panel onClose={closeAssistantPanel} />
    </ThemeContext.Provider>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css`
    position: fixed;
    top: 48px;
    right: 0;
    bottom: 0;
    width: min(480px, 100vw);
    z-index: ${theme.zIndex.modal};
    background: ${theme.colors.background.primary};
    border-left: 1px solid ${theme.colors.border.medium};
    box-shadow: ${theme.shadows.z3};
    display: flex;
    flex-direction: column;
    font-family: ${theme.typography.fontFamily};
    color: ${theme.colors.text.primary};
    @media (max-width: 1023px) {
      width: 100vw;
    }
  `,
  expanded: css`
    left: 0;
    width: 100vw;
  `,
  fill: css`
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  `,
  centered: css`
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: 860px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  `,
  history: css`
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
    padding-top: ${theme.spacing(1.5)};
  `,
  header: css`
    padding: ${theme.spacing(1.5, 2)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  body: css`
    flex: 1;
    min-height: 0;
    padding: ${theme.spacing(0, 2, 2)};
    display: flex;
    flex-direction: column;
  `,
});
