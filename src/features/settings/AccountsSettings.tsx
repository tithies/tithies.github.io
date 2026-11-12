import { Badge, Button, Group, Modal, Paper, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconTrash, IconUsers } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { setNickname } from '@/lib/accounts/data';
import { accountLabel, type AccountRow } from '@/lib/accounts/types';
import { timeAgo } from '@/lib/format';
import { sendMessage } from '@/lib/messaging';
import { siteOf } from '@/lib/sites/registry';
import { useSiteSessions } from '@/lib/sites/useSiteSessions';
import { LiveDot } from '@/lib/ui/AccountSelector';
import { SettingsSection } from '@/lib/ui/SettingsSection';
import { SiteIcon } from '@/lib/ui/SiteIcon';

/** Saved when the field loses focus or on Enter. */
function NicknameInput({ account }: { account: AccountRow }) {
  const [value, setValue] = useState(account.nickname ?? '');
  useEffect(() => setValue(account.nickname ?? ''), [account.nickname]);
  const save = () => {
    if (value.trim() !== (account.nickname ?? '')) void setNickname(account.key, value);
  };
  return (
    <TextInput
      size="xs"
      placeholder="e.g. Main, Cube"
      maxLength={40}
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      aria-label={`Nickname of ${account.userName}`}
    />
  );
}

/** Settings → Accounts: every account Tithies has acted as, with nicknames and "Forget". */
export function AccountsSettings() {
  const { accounts, key: currentKey } = useCurrentAccount();
  const { liveKeys } = useSiteSessions();
  const [forgetting, setForgetting] = useState<AccountRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = async () => {
    if (!forgetting) return;
    setBusy(true);
    setError(null);
    try {
      await sendMessage('forgetAccount', { accountKey: forgetting.key });
      setForgetting(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Accounts"
      icon={IconUsers}
      description="Each account keeps its own runs, synced decks, collection and options. Settings on this page are shared by all of them."
    >
      <Paper withBorder radius="md">
        {accounts.length === 0 ? (
          <Text p="md" size="sm" c="dimmed">
            No account yet. An account is added when Tithies acts as it: "Check selling prices" on your Moxfield collection, or "Sync decks" on the
            Mismatches page.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="sm" horizontalSpacing="md">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Account</Table.Th>
                  <Table.Th w={200}>Nickname</Table.Th>
                  <Table.Th>Logged in now</Table.Th>
                  <Table.Th>Last used</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {accounts.map((a) => (
                  <Table.Tr key={a.key}>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <SiteIcon type={a.type} size={20} />
                        <div>
                          <Text size="sm">{a.userName}</Text>
                          <Text size="xs" c="dimmed">
                            {siteOf(a.type).label}
                          </Text>
                        </div>
                        {a.key === currentKey && (
                          <Badge size="xs" variant="light">
                            Shown now
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <NicknameInput account={a} />
                    </Table.Td>
                    <Table.Td>
                      {liveKeys.has(a.key) ? (
                        <Group gap={6} wrap="nowrap">
                          <LiveDot label={`Logged in on ${siteOf(a.type).label} in an open tab`} />
                          <Text size="sm">Yes</Text>
                        </Group>
                      ) : (
                        <Text size="sm" c="dimmed">
                          No (only this one can sync when it is)
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {timeAgo(a.lastUsedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => setForgetting(a)}>
                        Forget
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>
      <Text size="xs" c="dimmed">
        The browser holds one login per site at a time: other accounts stay viewable here, but only the account logged in on the site can be synced.
      </Text>

      <Modal opened={forgetting != null} onClose={() => !busy && setForgetting(null)} title={forgetting ? `Forget ${accountLabel(forgetting)}?` : ''} centered>
        {forgetting && (
          <Stack gap="sm">
            <Text size="sm">
              This deletes, for good, everything Tithies keeps for <b>{forgetting.userName}</b> ({siteOf(forgetting.type).label}): its Selling runs and
              results, its synced decks and collection, and its Mismatches options. Running checks and syncs of this account are stopped first.
            </Text>
            <Text size="sm" c="dimmed">
              Nothing on {siteOf(forgetting.type).label} is touched. The account comes back (empty) the next time Tithies acts as it. Export the runs you want
              to keep to CSV first.
            </Text>
            {error && (
              <Text size="sm" c="red">
                {error}
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForgetting(null)} disabled={busy}>
                Keep it
              </Button>
              <Button color="red" leftSection={<IconTrash size={16} />} loading={busy} onClick={() => void forget()}>
                Forget {accountLabel(forgetting)}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </SettingsSection>
  );
}
