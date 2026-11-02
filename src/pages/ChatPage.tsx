import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { llm } from '@grafana/llm';
import { PluginPage } from '@grafana/runtime';
import { Alert, useStyles2 } from '@grafana/ui';
import { testIds } from '../components/testIds';
import { ChatPanel } from '../chat/ChatPanel';
import { ask, ChatContext, setContext } from '../chat/store';

// Full-page chat (design 1A). Accepts ?q=&ctx=&autorun=1 from other entry points.
function ChatPage() {
  const s = useStyles2(getStyles);
  const [health, setHealth] = useState<string | null>(null);

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

  return (
    <PluginPage>
      <div data-testid={testIds.chatPage.container} className={s.page}>
        {health && <Alert severity="warning" title={health} />}
        <ChatPanel />
      </div>
    </PluginPage>
  );
}

export default ChatPage;

const getStyles = (theme: GrafanaTheme2) => ({
  page: css`
    max-width: 820px;
    margin: 0 auto;
    height: calc(100vh - 160px);
    display: flex;
    flex-direction: column;
  `,
});
