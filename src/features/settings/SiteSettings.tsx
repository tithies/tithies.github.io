import { Button, Group, NumberInput, Paper, SimpleGrid, Text, Title } from '@mantine/core';
import { IconCheck, IconRestore } from '@tabler/icons-react';
import { DEFAULT_SETTINGS, MOXFIELD_SETTING_KEYS, type Settings } from '@/lib/settings';
import { MAX_COLLECTION_PAGE_SIZE, MOX_PACING } from '@/lib/sites/moxfield/constants';
import { SiteIcon } from '@/lib/ui/SiteIcon';
import { SettingsSection } from '@/lib/ui/SettingsSection';
import { useSettingsForm } from '@/lib/ui/useSettingsForm';

const FIELD_LABELS: Partial<Record<keyof Settings, string>> = {
  moxfieldIntervalMs: 'Min. gap between requests',
  moxfieldJitterMs: 'Random extra delay',
  moxfieldPageSize: 'Collection rows per request (panel)',
};

const MoxfieldIcon = ({ size = 20 }: { size?: number }) => <SiteIcon type="moxfield" size={size} />;

/** Settings → Moxfield: how fast Tithies talks to Moxfield (shared by every Moxfield account). */
export function SiteSettings() {
  const { s, set, reset, invalid, num: n } = useSettingsForm(FIELD_LABELS);
  if (!s) return null;

  return (
    <SettingsSection
      title="Moxfield"
      icon={MoxfieldIcon}
      description="How fast Tithies reads your decks and collection on Moxfield (every Moxfield account)."
      actions={
        <>
          {invalid ? (
            <Text size="xs" c="yellow">
              Not saved: {invalid}
            </Text>
          ) : (
            <Group gap={4}>
              <IconCheck size={14} color="var(--mantine-color-teal-5)" />
              <Text size="xs" c="dimmed">
                Changes are saved automatically
              </Text>
            </Group>
          )}
          <Button variant="default" size="xs" leftSection={<IconRestore size={14} />} onClick={() => reset(MOXFIELD_SETTING_KEYS)}>
            Reset to defaults
          </Button>
        </>
      }
    >
      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Politeness (Moxfield rate limits)
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput
            label={FIELD_LABELS.moxfieldIntervalMs}
            description={`Deck and collection syncs · default ${MOX_PACING.intervalMs} ms`}
            suffix=" ms"
            min={250}
            max={30000}
            step={250}
            value={s.moxfieldIntervalMs}
            onChange={(v) => set('moxfieldIntervalMs', n(v, DEFAULT_SETTINGS.moxfieldIntervalMs))}
          />
          <NumberInput
            label={`${FIELD_LABELS.moxfieldJitterMs} (jitter)`}
            description={`Default ${MOX_PACING.jitterMs} ms`}
            suffix=" ms"
            min={0}
            max={10000}
            step={250}
            value={s.moxfieldJitterMs}
            onChange={(v) => set('moxfieldJitterMs', n(v, DEFAULT_SETTINGS.moxfieldJitterMs))}
          />
          <NumberInput
            label={FIELD_LABELS.moxfieldPageSize}
            description={`"Check selling prices" in the panel · max ${MAX_COLLECTION_PAGE_SIZE} = one request`}
            min={25}
            max={MAX_COLLECTION_PAGE_SIZE}
            step={100}
            value={s.moxfieldPageSize}
            onChange={(v) => set('moxfieldPageSize', n(v, DEFAULT_SETTINGS.moxfieldPageSize))}
          />
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="xs">
          Requests go one at a time. Moxfield sends no Retry-After: on HTTP 429 Tithies waits 30 s, 60 s, then 120 s, and stops after that. A shorter gap
          syncs faster but makes rate limiting more likely. Moxfield's API is private (see the README).
        </Text>
      </Paper>
    </SettingsSection>
  );
}
