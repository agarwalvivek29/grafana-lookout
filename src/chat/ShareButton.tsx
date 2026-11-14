// Share a conversation with the org by link, for RCAs and hand-overs.
import React, { useState } from 'react';
import { Alert, Button, ClipboardButton, Input, Modal, Stack, Text } from '@grafana/ui';
import { errorText, sessionLink } from './historyApi';
import { setSessionShared, useChat } from './store';

export function ShareButton() {
  const { sessionId, shared, turns, running, readOnly } = useChat();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (readOnly) {
    return null;
  }

  const change = async (next: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await setSessionShared(sessionId, next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        fill="text"
        size="sm"
        icon={shared ? 'users-alt' : 'share-alt'}
        disabled={!turns.length || (running && turns.length === 1)}
        tooltip={turns.length ? undefined : 'Ask a question first'}
        onClick={() => setOpen(true)}
      >
        {shared ? 'Shared' : 'Share'}
      </Button>
      <Modal title="Share this conversation" isOpen={open} onDismiss={() => setOpen(false)}>
        <Stack direction="column" gap={2}>
          {error && <Alert severity="error" title={error} />}
          {shared ? (
            <>
              <Text>Anyone in your Grafana organization with this link can read the conversation.</Text>
              <Stack direction="row" gap={1}>
                <Input readOnly value={sessionLink(sessionId)} aria-label="Conversation link" />
                <ClipboardButton icon="copy" variant="primary" getText={() => sessionLink(sessionId)}>
                  Copy link
                </ClipboardButton>
              </Stack>
              <Text variant="bodySmall" color="secondary">
                They see it read-only and can continue it as their own copy. Questions you ask later are added to the
                same link.
              </Text>
              <Modal.ButtonRow>
                <Button variant="secondary" disabled={busy} onClick={() => change(false)}>
                  Stop sharing
                </Button>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </Modal.ButtonRow>
            </>
          ) : (
            <>
              <Text>
                Anyone in your Grafana organization with the link will be able to read this conversation, including the
                answers and tool results it contains.
              </Text>
              <Text variant="bodySmall" color="secondary">
                That can include data from data sources they cannot query themselves. Links in the answers still open
                with their own permissions.
              </Text>
              <Modal.ButtonRow>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button icon="share-alt" disabled={busy} onClick={() => change(true)}>
                  Share with my org
                </Button>
              </Modal.ButtonRow>
            </>
          )}
        </Stack>
      </Modal>
    </>
  );
}
