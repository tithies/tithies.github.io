import { Box, Button, Group, Menu, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconChevronDown, IconSettings, IconUserPlus } from '@tabler/icons-react';
import { useNavigate } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { addAccountFromAction } from '@/lib/accounts/data';
import { accountKey, accountLabel, type AccountRow } from '@/lib/accounts/types';
import { SITE_TYPES, siteOf } from '@/lib/sites/registry';
import { useSiteSessions } from '@/lib/sites/useSiteSessions';
import { SiteIcon } from './SiteIcon';

/** Green dot: logged in on the site right now (in an open tab). */
export function LiveDot({ label }: { label: string }) {
  return (
    <Tooltip label={label} withinPortal>
      <Box w={8} h={8} bg="teal.5" style={{ borderRadius: '50%', flexShrink: 0 }} aria-label={label} />
    </Tooltip>
  );
}

function AccountName({ account }: { account: AccountRow }) {
  return (
    <div style={{ minWidth: 0 }}>
      <Text size="sm" truncate>
        {accountLabel(account)}
      </Text>
      {account.nickname && (
        <Text size="xs" c="dimmed" truncate>
          {account.userName}
        </Text>
      )}
    </div>
  );
}

/**
 * Header: the account every page shows, with its site icon, and the other accounts to switch to.
 * Accounts appear here once Tithies has acted as them (a run started from the site, a sync…).
 */
export function AccountSelector() {
  const { account, accounts, switchTo } = useCurrentAccount();
  const { live, liveKeys } = useSiteSessions();
  const navigate = useNavigate();
  const known = new Set(accounts.map((a) => a.key));
  const notAdded = SITE_TYPES.flatMap((type) => live[type].filter((id) => !known.has(accountKey(type, id.userId))).map((identity) => ({ type, identity })));
  const liveLabel = (a: AccountRow) => `Logged in on ${siteOf(a.type).label} right now`;

  return (
    <Menu position="bottom-end" width={290} withinPortal shadow="md">
      <Menu.Target>
        <Button variant="default" size="sm" px="xs" rightSection={<IconChevronDown size={14} />} aria-label="Account" maw={260}>
          {account ? (
            <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
              <SiteIcon type={account.type} size={18} />
              <Text size="sm" truncate>
                {accountLabel(account)}
              </Text>
              {liveKeys.has(account.key) && <LiveDot label={liveLabel(account)} />}
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              No account yet
            </Text>
          )}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Accounts</Menu.Label>
        {accounts.length ? (
          accounts.map((a) => (
            <Menu.Item
              key={a.key}
              leftSection={<SiteIcon type={a.type} size={18} />}
              rightSection={
                <Group gap={6} wrap="nowrap">
                  {liveKeys.has(a.key) && <LiveDot label={liveLabel(a)} />}
                  {a.key === account?.key && <IconCheck size={14} />}
                </Group>
              }
              onClick={() => void switchTo(a.key)}
            >
              <AccountName account={a} />
            </Menu.Item>
          ))
        ) : (
          <Menu.Item disabled>
            <Text size="xs" c="dimmed">
              Accounts are added when you start something as them: a selling check from your Moxfield collection, or a deck sync.
            </Text>
          </Menu.Item>
        )}
        {notAdded.length > 0 && (
          <>
            <Menu.Divider />
            <Menu.Label>Logged in now, not in Tithies yet</Menu.Label>
            {notAdded.map(({ type, identity }) => (
              <Menu.Item key={`${type}:${identity.userId}`} leftSection={<SiteIcon type={type} size={18} />} rightSection={<IconUserPlus size={14} />} onClick={() => void addAccountFromAction(type, identity)}>
                <Text size="sm">
                  Use {identity.userName}
                  <Text span size="xs" c="dimmed">
                    {' '}
                    ({siteOf(type).label})
                  </Text>
                </Text>
              </Menu.Item>
            ))}
          </>
        )}
        <Menu.Divider />
        <Menu.Item leftSection={<IconSettings size={16} />} onClick={() => navigate('/settings')}>
          Manage accounts
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
