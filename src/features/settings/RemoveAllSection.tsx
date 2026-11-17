import { Alert, Anchor, Button, Group, List, Modal, Paper, Stack, Text, TextInput, useMantineColorScheme } from '@mantine/core';
import { IconAlertTriangle, IconTrashX } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { useActivity } from '@/lib/activity';
import { changeLogCounts } from '@/lib/changes/log';
import { sendMessage } from '@/lib/messaging';
import { SettingsSection } from '@/lib/ui/SettingsSection';

const CONFIRM_WORD = 'delete';
const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** What goes, with how much of it there is now. */
function WhatGoes({ accounts, actions, running }: { accounts: number; actions: number; running: number }) {
  return (
    <List size="sm" spacing={2}>
      <List.Item>
        Every account ({n(accounts)}), with its Selling runs, synced decks, collection snapshot and Comparator options
      </List.Item>
      <List.Item>The F2F caches (prices looked up, bulk rates, the set list)</List.Item>
      <List.Item>
        The{' '}
        <Anchor component={Link} to="/changes" size="sm">
          Change log
        </Anchor>{' '}
        ({plural(actions, 'action')}): the only record of what Tithies changed on Moxfield, with the cards an export deleted (as a CSV to import them back)
      </List.Item>
      <List.Item>Every setting and preference (Selling and Moxfield settings, hidden columns, page sizes, the theme)</List.Item>
      {running > 0 && <List.Item>{plural(running, 'job')} running now (checks, syncs, exports): stopped first</List.Item>}
    </List>
  );
}

/** Settings → Remove all data: everything Tithies keeps in this browser goes, as after a fresh install. */
export function RemoveAllSection() {
  const { accounts } = useCurrentAccount();
  const changes = useLiveQuery(changeLogCounts, []);
  const running = useActivity().length;
  const { clearColorScheme } = useMantineColorScheme();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counts = { accounts: accounts.length, actions: changes?.ops ?? 0, running };

  const close = () => {
    if (removing) return;
    setConfirming(false);
    setTyped('');
    setError(null);
  };
  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await sendMessage('removeAllData', undefined);
      // The dashboard's own preferences (page sizes, the theme); then a fresh start, like a new install.
      localStorage.clear();
      clearColorScheme();
      window.location.hash = '#/';
      window.location.reload();
    } catch (e) {
      setError(`Not everything could be removed: ${e instanceof Error ? e.message : String(e)}`);
      setRemoving(false);
    }
  };

  return (
    <SettingsSection title="Remove all data" icon={IconTrashX} description="Tithies as after a fresh install: everything it keeps in this browser, for every account.">
      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          <WhatGoes {...counts} />
          <Group justify="space-between" align="flex-end">
            <Text size="xs" c="dimmed" maw={640}>
              What Tithies changed on Moxfield stays as it is: only what Tithies keeps here goes. To clear only some of it, use Stored data or Reset settings
              above.
            </Text>
            <Button color="red" leftSection={<IconTrashX size={16} />} onClick={() => setConfirming(true)}>
              Remove all data…
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Modal opened={confirming} onClose={close} title="Remove all data?" centered size="lg">
        <Stack>
          <Text size="sm">This removes, for good:</Text>
          <WhatGoes {...counts} />
          {counts.actions > 0 && (
            <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
              The Change log can't be found again afterwards. If you may need it (to check what an export did, or to import deleted cards back), open it and
              download what you need first.
            </Alert>
          )}
          <TextInput
            label={`Type “${CONFIRM_WORD}” to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            disabled={removing}
            data-autofocus
          />
          {error && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close} disabled={removing}>
              Cancel
            </Button>
            <Button color="red" leftSection={<IconTrashX size={16} />} disabled={typed.trim().toLowerCase() !== CONFIRM_WORD} loading={removing} onClick={() => void remove()}>
              Remove all data
            </Button>
          </Group>
        </Stack>
      </Modal>
    </SettingsSection>
  );
}
