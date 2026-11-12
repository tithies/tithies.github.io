import { Alert, Button, Group, Text } from '@mantine/core';
import { IconInfoCircle, IconRefresh, IconUserExclamation } from '@tabler/icons-react';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { addAccountFromAction } from '@/lib/accounts/data';
import { accountLabel } from '@/lib/accounts/types';
import { siteOf } from '@/lib/sites/registry';
import { useSiteSessions } from '@/lib/sites/useSiteSessions';
import type { SiteType } from '@/lib/sites/types';

/**
 * Who is logged in on the site, next to features that read it (syncs): only the current account
 * can be synced, and the browser holds one login per site at a time.
 */
export function AccountHint({ type = 'moxfield' }: { type?: SiteType }) {
  const { account } = useCurrentAccount();
  const { live, liveKeys, silentTabs } = useSiteSessions();
  const site = siteOf(account?.type ?? type);
  const others = live[site.type];

  if (!account) {
    if (!others.length) return null;
    return (
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} p="xs">
        <Text size="sm">
          {site.label} is logged in as <b>{others[0].userName}</b>: syncing adds this account to Tithies.
        </Text>
      </Alert>
    );
  }
  if (liveKeys.has(account.key)) return null;
  if (others.length) {
    const other = others[0];
    return (
      <Alert color="yellow" variant="light" icon={<IconUserExclamation size={18} />} p="xs">
        <Group justify="space-between" gap="xs">
          <Text size="sm" style={{ flex: 1, minWidth: 240 }}>
            {site.label} is logged in as <b>{other.userName}</b> in your open tabs, but Tithies shows <b>{accountLabel(account)}</b>. Syncing reads{' '}
            {accountLabel(account)}'s data: log in as {account.userName} on {site.label} first, or switch Tithies to {other.userName}.
          </Text>
          <Button size="xs" variant="light" color="yellow" onClick={() => void addAccountFromAction(site.type, other)}>
            Switch Tithies to {other.userName}
          </Button>
        </Group>
      </Alert>
    );
  }
  if (silentTabs[site.type] > 0) {
    return (
      <Alert color="gray" variant="light" icon={<IconRefresh size={18} />} p="xs">
        <Text size="sm">
          Reload your open {site.label} tabs so Tithies can see which account is logged in there (they were opened before Tithies was installed, updated or
          reloaded).
        </Text>
      </Alert>
    );
  }
  return null;
}
