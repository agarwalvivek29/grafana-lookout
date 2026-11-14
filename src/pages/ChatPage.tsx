import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { llm } from '@grafana/llm';
import { locationService, PluginPage } from '@grafana/runtime';
import { Alert, Button, useStyles2 } from '@grafana/ui';
import { testIds } from '../components/testIds';
import { ChatPanel } from '../chat/ChatPanel';
import { HistoryList } from '../chat/HistoryList';
import { sessionPath } from '../chat/historyApi';
import { ask, ChatContext, getChatState, newChat, openSession, setContext, useChat } from '../chat/store';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';

// Full-page chat (design 1A) with the conversation history beside it. Accepts ?q=&ctx=&autorun=1 from other
// entry points, and /chat/s/<id> opens a saved or shared conversation.
function ChatPage() {
  const s = useStyles2(getStyles);
  const [health, setHealth] = useState<string | null>(null);
  const { sessionId: urlSession } = useParams<{ sessionId?: string }>();
  const chat = useChat();

  useEffect(() => {
    llm
      .health()
      .then((h) => setHealth(h.ok ? null : `AI isn't set up yet: ${h.error ?? 'LLM plugin not ready'}`))
      .catch((e) => setHealth(`AI isn't set up yet: ${String(e)}`));
    const p = new URLSearchParams(window.location.search);
    try {
      if (p.get('ctx')) {
        setContext(JSON.parse(p.get('ctx')!) as ChatContext);
      }
    } catch {
      // ignore malformed context
    }
    if (p.get('autorun') === '1' && p.get('q')) {
      ask(p.get('q')!);
    }
  }, []);

  // The URL decides which conversation is open when it changes (a shared link, back/forward)...
  useEffect(() => {
    if (urlSession && urlSession !== getChatState().sessionId) {
      openSession(urlSession);
    }
  }, [urlSession]);

  // ...and follows the conversation otherwise, so the address bar is always a link to what is on screen.
  useEffect(() => {
    if (chat.sessionId === urlSession) {
      return;
    }
    if (chat.turns.length) {
      locationService.replace(sessionPath(chat.sessionId));
    } else if (urlSession && !chat.loading) {
      locationService.replace(`${PLUGIN_BASE_URL}/${ROUTES.Chat}`);
    }
  }, [chat.sessionId, chat.turns.length, chat.loading, urlSession]);

  const showHistory = chat.history?.enabled;

  return (
    <PluginPage>
      <div data-testid={testIds.chatPage.container} className={showHistory ? s.layout : s.single}>
        {showHistory && (
          <nav className={s.sidebar} aria-label="Conversations">
            <div>
              <Button icon="plus" variant="secondary" fill="outline" onClick={newChat} disabled={chat.running}>
                New chat
              </Button>
            </div>
            <HistoryList onOpen={(id) => locationService.push(sessionPath(id))} />
          </nav>
        )}
        <div className={s.page}>
          {health && <Alert severity="warning" title={health} />}
          <ChatPanel />
        </div>
      </div>
    </PluginPage>
  );
}

export default ChatPage;

const getStyles = (theme: GrafanaTheme2) => ({
  single: css`
    max-width: 820px;
    margin: 0 auto;
    height: calc(100vh - 160px);
    display: flex;
    flex-direction: column;
  `,
  layout: css`
    display: grid;
    grid-template-columns: 280px minmax(0, 820px);
    justify-content: center;
    gap: ${theme.spacing(3)};
    height: calc(100vh - 160px);
    @media (max-width: 900px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  sidebar: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
    min-height: 0;
    @media (max-width: 900px) {
      display: none;
    }
  `,
  page: css`
    display: flex;
    flex-direction: column;
    min-height: 0;
  `,
});
