// Prototype chat UI following the design spec: flat thread (10A), answer first (2A), steps live
// while working and auto-collapsed afterwards (6A), context chips (3A), trust line (8A).
import React, { useEffect, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import {
  Alert,
  Button,
  Collapse,
  Icon,
  IconButton,
  Spinner,
  Stack,
  Tag,
  Text,
  TextArea,
  useStyles2,
} from '@grafana/ui';
import { AgentStep, stepLabel } from '../agent/agent';
import { SafeMarkdown } from './SafeMarkdown';
import { LinkPreviews } from './LinkPreviews';
import { ProposalCard } from './ProposalCard';
import { ShareButton } from './ShareButton';
import { ask, continueAsCopy, initHistory, newChat, setContext, Turn, useChat } from './store';

const STARTERS_PANEL = ['Explain this panel', 'Is this normal for the last 24 hours?', 'Show related error logs'];
const STARTERS_PAGE = [
  'Which services have the most errors right now?',
  'Which dashboard shows latency for a service?',
  'Find the slowest traces in the last hour',
  'Build a dashboard for a service',
];

interface ToolStep {
  label: string;
  raw: string;
  result?: string;
}

// A failed tool call returns {"error": ...} (see executeCalls); a result that merely contains the word "error",
// such as a log line's level, is not a failure.
const isFailure = (result?: string) => Boolean(result && /^\S+ → \{"error":/.test(result));

function toolSteps(steps: AgentStep[]): ToolStep[] {
  const out: ToolStep[] = [];
  for (const s of steps) {
    if (s.kind === 'model') {
      out.push({ label: stepLabel(s.text), raw: s.text });
    } else if (s.kind === 'tool' && out.length) {
      out[out.length - 1].result = s.text;
    }
  }
  return out;
}

function Steps({ turn, done }: { turn: Turn; done: boolean }) {
  const s = useStyles2(getStyles);
  const steps = toolSteps(turn.steps);
  const failedCount = steps.filter((x) => isFailure(x.result)).length;
  // Collapsed once the answer is in, even if the model recovered from a failed step; open only on request
  // or when the whole turn ended in an error.
  const [open, setOpen] = useState(Boolean(turn.error));
  const [details, setDetails] = useState(false);
  if (!steps.length) {
    return null;
  }
  const list = (
    <div className={s.steps}>
      {steps.map((st, i) => {
        const running = !done && i === steps.length - 1 && !st.result;
        const err = isFailure(st.result);
        return (
          <div key={i} className={s.step}>
            {running ? <Spinner inline size="sm" /> : <Icon name={err ? 'exclamation-triangle' : 'check'} size="sm" />}
            <span className={s.stepLabel} title={st.label}>
              {st.label}
            </span>
            {details && <pre className={s.raw}>{`${st.raw}\n→ ${st.result ?? ''}`}</pre>}
          </div>
        );
      })}
      <Button variant="secondary" fill="text" size="sm" onClick={() => setDetails(!details)}>
        {details ? 'Hide details' : 'Details'}
      </Button>
    </div>
  );
  if (!done) {
    return list;
  }
  const secs = turn.finishedAt ? Math.round((turn.finishedAt - turn.startedAt) / 1000) : 0;
  return (
    <Collapse
      label={`Ran ${steps.length} step${steps.length === 1 ? '' : 's'} · ${secs}s${
        failedCount ? ` · ${failedCount} retried` : ''
      }`}
      isOpen={open}
      onToggle={() => setOpen(!open)}
    >
      {list}
    </Collapse>
  );
}

function TurnView({ turn, last, running }: { turn: Turn; last: boolean; running: boolean }) {
  const s = useStyles2(getStyles);
  const done = !(last && running);
  const proposalId = [...turn.steps].reverse().find((st) => st.kind === 'proposal')?.text;
  const ref = useRef<HTMLDivElement>(null);
  // When a new turn starts, bring its question to the top so the answer reads from its first line.
  useEffect(() => {
    if (last) {
      ref.current?.scrollIntoView({ block: 'start' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={s.turn} ref={ref}>
      {turn.contextChanges && turn.contextChanges.length > 0 && (
        <Text variant="bodySmall" color="secondary">
          <Icon name="sync" size="sm" /> Dashboard changed: {turn.contextChanges.join(' · ')}
        </Text>
      )}
      <div className={s.question}>{turn.question}</div>
      {!done && !turn.liveText && turn.steps.length === 0 && (
        <Text color="secondary" italic>
          Thinking…
        </Text>
      )}
      {!done && <Steps turn={turn} done={false} />}
      {!done && turn.liveText && <SafeMarkdown markdown={turn.liveText} />}
      {turn.answer && <SafeMarkdown markdown={turn.answer} />}
      {proposalId && (done || turn.answer) && <ProposalCard id={proposalId} />}
      {proposalId && turn.restored && (
        <Text variant="bodySmall" color="secondary">
          <Icon name="apps" size="sm" /> A dashboard change was proposed here. Proposals are not kept in history; check
          the dashboard&apos;s version history for what was saved.
        </Text>
      )}
      {turn.answer && !proposalId && <LinkPreviews markdown={turn.answer} />}
      {turn.error && <Alert severity="error" title={turn.error} />}
      {done && <Steps turn={turn} done />}
    </div>
  );
}

export function ChatPanel({ panelMode }: { panelMode?: boolean }) {
  const s = useStyles2(getStyles);
  const { turns, running, context, history, title, readOnly, ownerName, loading, loadError, saveError, notice } =
    useChat();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initHistory();
  }, []);

  const send = (q: string) => {
    ask(q);
    setDraft('');
  };

  const starters = context?.panel_key ? STARTERS_PANEL : STARTERS_PAGE;

  return (
    <div className={s.root}>
      {history?.enabled && (title || turns.length > 0) && (
        <div className={s.sessionBar}>
          <span className={s.sessionTitle} title={title}>
            {title ?? 'New conversation'}
          </span>
          <ShareButton />
        </div>
      )}
      <div className={s.thread}>
        {loading && <Spinner />}
        {loadError && <Alert severity="error" title={loadError} />}
        {turns.length === 0 && !loading && !loadError && (
          <div className={s.empty}>
            <Text variant="h5">Ask about your data</Text>
            <Stack direction="column" gap={1}>
              {starters.map((q) => (
                <Button key={q} variant="secondary" size="sm" onClick={() => send(q)} disabled={running}>
                  {q}
                </Button>
              ))}
            </Stack>
          </div>
        )}
        {turns.map((t, i) => (
          <TurnView key={t.id} turn={t} last={i === turns.length - 1} running={running} />
        ))}
        <div ref={endRef} />
      </div>
      <div className={s.composer}>
        {readOnly ? (
          <Stack direction="row" justifyContent="space-between" alignItems="center" wrap="wrap">
            <Text variant="bodySmall" color="secondary">
              <Icon name="users-alt" size="sm" /> Shared by {ownerName ?? 'someone in your org'} · read-only
            </Text>
            <Stack direction="row" gap={1}>
              <Button variant="secondary" size="sm" onClick={newChat}>
                New chat
              </Button>
              <Button size="sm" icon="comment-alt" onClick={continueAsCopy}>
                Continue as my copy
              </Button>
            </Stack>
          </Stack>
        ) : (
          <>
            {context?.dashboard_uid && (
              <Stack direction="row" gap={0.5} wrap="wrap">
                <Tag name={`Dashboard: ${context.dashboard_title ?? context.dashboard_uid}`} colorIndex={9} />
                {context.panel_title && <Tag name={`Panel: ${context.panel_title}`} colorIndex={9} />}
                {Object.entries(context.variables ?? {})
                  .slice(0, 3)
                  .map(([k, v]) => (
                    <Tag key={k} name={`${k}: ${v === '$__all' ? 'All' : v}`} colorIndex={9} />
                  ))}
                <IconButton name="times" size="sm" tooltip="Remove context" onClick={() => setContext(null)} />
              </Stack>
            )}
            <TextArea
              value={draft}
              rows={panelMode ? 2 : 3}
              placeholder="Ask about metrics, logs, traces or dashboards…"
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              disabled={running || loading}
            />
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Text variant="bodySmall" color="secondary">
                Uses your Grafana permissions. Answers can be wrong; check the links.
              </Text>
              <Stack direction="row" gap={1}>
                <Button variant="secondary" size="sm" onClick={newChat} disabled={running}>
                  New chat
                </Button>
                <Button
                  size="sm"
                  icon={running ? 'spinner' : 'ai-sparkle'}
                  onClick={() => send(draft)}
                  disabled={running || !draft.trim()}
                >
                  Send
                </Button>
              </Stack>
            </Stack>
            {saveError && (
              <Text variant="bodySmall" color="warning">
                {saveError}
              </Text>
            )}
            {notice && (
              <Text variant="bodySmall" color="secondary">
                <Icon name="info-circle" size="sm" /> {notice}
              </Text>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  `,
  sessionBar: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1, 0)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  sessionTitle: css`
    flex: 1;
    min-width: 0;
    font-weight: ${theme.typography.fontWeightMedium};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  thread: css`
    flex: 1;
    overflow-y: auto;
    padding: ${theme.spacing(1, 0)};
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(2, 0)};
  `,
  turn: css`
    padding: ${theme.spacing(2, 0)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  question: css`
    background: ${theme.colors.background.secondary};
    padding: ${theme.spacing(1, 1.5)};
    border-radius: ${theme.shape.radius.default};
    white-space: pre-wrap;
  `,
  steps: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  step: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
    align-items: center;
  `,
  stepLabel: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  raw: css`
    width: 100%;
    font-size: ${theme.typography.bodySmall.fontSize};
    white-space: pre-wrap;
    max-height: 200px;
    overflow: auto;
  `,
  composer: css`
    border-top: 1px solid ${theme.colors.border.weak};
    padding-top: ${theme.spacing(1)};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
});
