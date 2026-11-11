import { Paper, SegmentedControl, Stack, Text, useMantineColorScheme, type MantineColorScheme } from '@mantine/core';
import { IconAdjustments } from '@tabler/icons-react';
import { SettingsSection } from '@/lib/ui/SettingsSection';

/** Settings shared by every tool. */
export function GeneralSettings() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <SettingsSection title="General" icon={IconAdjustments} description="Shared by every tool.">
      <Paper withBorder p="md" radius="md">
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Theme
          </Text>
          <SegmentedControl
            w="fit-content"
            value={colorScheme}
            onChange={(v) => setColorScheme(v as MantineColorScheme)}
            data={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'auto', label: 'Same as the system' },
            ]}
          />
          <Text size="xs" c="dimmed">
            The button at the top right switches between dark and light too.
          </Text>
        </Stack>
      </Paper>
    </SettingsSection>
  );
}
