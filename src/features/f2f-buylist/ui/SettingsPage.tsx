import { Alert, Button, Group, NumberInput, Paper, SimpleGrid, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { IconCheck, IconTrash } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '@/lib/db';
import { clearCaches } from '../runner';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '@/lib/settings';
import type { BulkRates } from '../types';
import { dateTime, money } from './format';

const RATE_LABELS: [keyof BulkRates, string][] = [
  ['cu', 'Common / uncommon'],
  ['rare', 'Rare'],
  ['mythic', 'Mythic rare'],
  ['foilCu', 'Foil common / uncommon'],
  ['foilRare', 'Foil rare'],
  ['foilMythic', 'Foil mythic rare'],
  ['basic', 'Basic land'],
  ['foilBasic', 'Foil basic land'],
  ['fullArtBasic', 'Full-art basic land'],
  ['promo', 'Promotional card'],
];

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const cacheCount = useLiveQuery(() => db.f2fCache.count(), []);
  const bulk = useLiveQuery(() => db.meta.get('bulkRates'), [])?.value as BulkRates | undefined;

  useEffect(() => void getSettings().then(setS), []);
  if (!s) return null;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSaved(false);
    setS({ ...s, [k]: v });
  };
  const n = (v: string | number, fallback: number) => (v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

  return (
    <Stack maw={900}>
      <Title order={2}>F2F buylist settings</Title>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Politeness (F2F rate limits)
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput label="Min. gap between requests" suffix=" ms" min={500} max={30000} step={250} value={s.requestIntervalMs} onChange={(v) => set('requestIntervalMs', n(v, DEFAULT_SETTINGS.requestIntervalMs))} />
          <NumberInput label="Random extra delay (jitter)" suffix=" ms" min={0} max={10000} step={250} value={s.jitterMs} onChange={(v) => set('jitterMs', n(v, DEFAULT_SETTINGS.jitterMs))} />
          <NumberInput label="Prints per request" description="Split automatically when F2F has over 100 results" min={5} max={100} value={s.batchSize} onChange={(v) => set('batchSize', n(v, DEFAULT_SETTINGS.batchSize))} />
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="xs">
          Requests go one at a time. On HTTP 429 Tithies waits for F2F's Retry-After, and pauses the run after 3 failures in a row.
        </Text>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Pricing & lookup
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput
            label="Store-credit bonus"
            description="F2F advertises +30 % in store credit"
            suffix=" %"
            min={0}
            max={200}
            value={Math.round(s.creditBonus * 100)}
            onChange={(v) => set('creditBonus', n(v, 30) / 100)}
          />
          <NumberInput label="Reuse F2F results for" description="F2F changes prices during the day · 0 = always fresh" suffix=" h" min={0} max={336} value={s.cacheTtlHours} onChange={(v) => set('cacheTtlHours', n(v, DEFAULT_SETTINGS.cacheTtlHours))} />
          <NumberInput label="Moxfield page size" description="Rows per Moxfield request (max 5000 = one request)" min={25} max={5000} step={100} value={s.moxfieldPageSize} onChange={(v) => set('moxfieldPageSize', n(v, DEFAULT_SETTINGS.moxfieldPageSize))} />
          <Switch mt="md" label="Fallback search by set + number for prints not found by name" checked={s.fallbackEnabled} onChange={(e) => set('fallbackEnabled', e.currentTarget.checked)} />
          <NumberInput label="Max fallback requests per run" description="Also the most cards checked on Shopify's search when both searches miss" min={0} max={2000} value={s.fallbackCap} onChange={(v) => set('fallbackCap', n(v, DEFAULT_SETTINGS.fallbackCap))} disabled={!s.fallbackEnabled} />
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="xs">
          The credit bonus is stored with each run when it starts, so changing it only affects new runs.
        </Text>
      </Paper>

      <Group>
        <Button
          leftSection={saved ? <IconCheck size={16} /> : undefined}
          color={saved ? 'teal' : undefined}
          onClick={async () => {
            setS(await saveSettings(s));
            setSaved(true);
          }}
        >
          {saved ? 'Saved' : 'Save settings'}
        </Button>
        <Button variant="default" onClick={() => setS(DEFAULT_SETTINGS)}>
          Restore defaults
        </Button>
      </Group>

      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Title order={4}>Cache & bulk rates</Title>
          <Button
            variant="light"
            color="red"
            size="xs"
            leftSection={<IconTrash size={14} />}
            onClick={async () => {
              await clearCaches();
            }}
          >
            Clear cache ({cacheCount ?? 0} prints)
          </Button>
        </Group>
        {bulk ? (
          <>
            <Text size="sm" c="dimmed" mb="xs">
              From F2F's wholesale-bulk page, fetched {dateTime(bulk.fetchedAt)} (refreshed every 24 h). Per card, cash:
            </Text>
            <Table withRowBorders={false} verticalSpacing={2} maw={420}>
              <Table.Tbody>
                {RATE_LABELS.map(([k, label]) => (
                  <Table.Tr key={k}>
                    <Table.Td>{label}</Table.Td>
                    <Table.Td ta="right" className="ti-num">
                      {money(bulk[k] as number)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Text size="xs" c="dimmed" mt="xs">
              F2F excludes Unfinity, Unstable and Unsanctioned from bulk; those count as $0.
            </Text>
          </>
        ) : (
          <Alert color="gray">Bulk rates are fetched at the start of the next run.</Alert>
        )}
      </Paper>
    </Stack>
  );
}
