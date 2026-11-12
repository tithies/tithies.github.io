import { Stack, Text, Title } from '@mantine/core';
import { SellingSettings } from '@/features/f2f-buylist/ui/SellingSettings';
import { AccountsSettings } from './AccountsSettings';
import { GeneralSettings } from './GeneralSettings';
import { ResetSection } from './ResetSection';
import { SiteSettings } from './SiteSettings';
import { StoredDataSection } from './StoredDataSection';

/** One Settings page for the whole extension: shared settings, then each tool's, then data and reset. */
export function SettingsPage() {
  return (
    <Stack maw={1100} gap="xl">
      <div>
        <Title order={2}>Settings</Title>
        <Text size="sm" c="dimmed">
          Your accounts, shared settings, each tool's own settings, and everything Tithies keeps in this browser. Settings are shared by every account.
        </Text>
      </div>
      <GeneralSettings />
      <AccountsSettings />
      <SiteSettings />
      <SellingSettings />
      <StoredDataSection />
      <ResetSection />
    </Stack>
  );
}
