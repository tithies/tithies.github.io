import { Badge, Button, Group, Modal, Paper, Stack, Table, Text, useMantineColorScheme } from '@mantine/core';
import { IconCheck, IconRestore } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { SettingsSection } from '@/lib/ui/SettingsSection';
import { listStoredPreferences, resetAllSettings, type StoredPreference } from './stored-data';

const WHERE = { extension: 'Extension storage', local: 'Dashboard local storage' } as const;

/** Settings → Reset settings: every setting and preference back to its default, data kept. */
export function ResetSection() {
  const { colorScheme, clearColorScheme } = useMantineColorScheme();
  const [prefs, setPrefs] = useState<StoredPreference[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  const refresh = useCallback(() => void listStoredPreferences().then(setPrefs), []);
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    browser.storage.onChanged.addListener(onChange);
    window.addEventListener('storage', onChange);
    return () => {
      browser.storage.onChanged.removeListener(onChange);
      window.removeEventListener('storage', onChange);
    };
  }, [refresh]);
  // The theme lives in localStorage, which sends no event to its own page.
  useEffect(refresh, [colorScheme, refresh]);

  const reset = async () => {
    await resetAllSettings();
    clearColorScheme();
    setConfirming(false);
    setDone(true);
    refresh();
  };

  return (
    <SettingsSection
      title="Reset settings"
      icon={IconRestore}
      description="Every setting and preference back to its default. Your data (runs, synced decks, caches) is kept: clear it above."
    >
      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          {prefs && prefs.length > 0 ? (
            <>
              <Text size="sm">These are saved with a value of their own; resetting removes them, so each falls back to its default:</Text>
              <Table withRowBorders={false} verticalSpacing={4}>
                <Table.Tbody>
                  {prefs.map((p) => (
                    <Table.Tr key={`${p.where}:${p.key}`}>
                      <Table.Td>
                        <Text size="sm">{p.label}</Text>
                      </Table.Td>
                      <Table.Td w={200}>
                        <Badge size="xs" variant="light" color={p.where === 'extension' ? 'violet' : 'cyan'}>
                          {WHERE[p.where]}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          ) : (
            <Text size="sm" c="dimmed">
              Every setting is at its default.
            </Text>
          )}
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              Extension storage is shared by the dashboard and the Moxfield panel; local storage belongs to this dashboard.
            </Text>
            <Group gap="sm">
              {done && (
                <Group gap={4}>
                  <IconCheck size={14} color="var(--mantine-color-teal-5)" />
                  <Text size="xs" c="dimmed">
                    Settings reset
                  </Text>
                </Group>
              )}
              <Button color="red" variant="light" leftSection={<IconRestore size={16} />} disabled={!prefs?.length} onClick={() => setConfirming(true)}>
                Reset all settings
              </Button>
            </Group>
          </Group>
        </Stack>
      </Paper>

      <Modal opened={confirming} onClose={() => setConfirming(false)} title="Reset all settings to their defaults?" centered>
        <Stack>
          <Text size="sm">
            Every tool's settings, the Mismatches page options, hidden columns, page sizes, the theme and the Moxfield panel go back to their defaults. Runs,
            synced decks and caches are kept.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void reset()}>
              Reset
            </Button>
          </Group>
        </Stack>
      </Modal>
    </SettingsSection>
  );
}
