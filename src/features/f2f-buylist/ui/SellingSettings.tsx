import { Alert, Button, Group, NumberInput, Paper, SimpleGrid, Switch, Table, Text, Title } from '@mantine/core';
import { IconCash, IconCheck, IconRestore } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { db } from '@/lib/db';
import { DEFAULT_SETTINGS, getSettings, settingsItem, settingsSchema, type Settings } from '@/lib/settings';
import { SettingsSection } from '@/lib/ui/SettingsSection';
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

const FIELD_LABELS: Record<keyof Settings, string> = {
  requestIntervalMs: 'Min. gap between requests',
  jitterMs: 'Random extra delay',
  batchSize: 'Prints per request',
  cacheTtlHours: 'Reuse F2F results for',
  creditBonus: 'Store-credit bonus',
  fallbackEnabled: 'Fallback search',
  fallbackCap: 'Max fallback requests per run',
  moxfieldPageSize: 'Moxfield page size',
};

/** Wait after the last keystroke before saving. */
const SAVE_DELAY_MS = 400;

/**
 * Settings → Selling. There is no Save button: each change is saved once it's valid (number
 * fields are clamped to their range when they lose focus). Other pages, and "Reset all
 * settings", update the form through the storage watcher.
 */
export function SellingSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const bulk = useLiveQuery(() => db.meta.get('bulkRates'), [])?.value as BulkRates | undefined;
  /** JSON of the last value written here, to tell our own writes from outside changes. */
  const lastSaved = useRef('');
  const pending = useRef<{ value: Settings; timer: ReturnType<typeof setTimeout> } | null>(null);

  const persist = async (next: Settings) => {
    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = FIELD_LABELS[issue?.path[0] as keyof Settings] ?? 'A value';
      setInvalid(`${field}: ${issue?.message ?? 'invalid value'}`);
      return;
    }
    setInvalid(null);
    lastSaved.current = JSON.stringify(parsed.data);
    await settingsItem.setValue(parsed.data);
  };

  const flush = () => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    const { value } = pending.current;
    pending.current = null;
    void persist(value);
  };

  useEffect(() => {
    let alive = true;
    const load = () =>
      void getSettings().then((v) => {
        if (!alive) return;
        lastSaved.current = JSON.stringify(v);
        setS(v);
      });
    load();
    const unwatch = settingsItem.watch((v) => {
      if (JSON.stringify(v) !== lastSaved.current && !pending.current) load();
    });
    return () => {
      alive = false;
      unwatch();
      flush(); // leaving the page right after typing still saves
    };
  }, []);

  if (!s) return null;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    const next = { ...s, [k]: v };
    setS(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { value: next, timer: setTimeout(flush, SAVE_DELAY_MS) };
  };
  const resetSection = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    setS(DEFAULT_SETTINGS);
    void persist(DEFAULT_SETTINGS);
  };
  const n = (v: string | number, fallback: number) => (v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

  return (
    <SettingsSection
      title="Selling"
      icon={IconCash}
      description="Checking what Face to Face Games pays for your cards."
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
          <Button variant="default" size="xs" leftSection={<IconRestore size={14} />} onClick={resetSection}>
            Reset to defaults
          </Button>
        </>
      }
    >
      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Politeness (F2F rate limits)
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput label={FIELD_LABELS.requestIntervalMs} suffix=" ms" min={500} max={30000} step={250} value={s.requestIntervalMs} onChange={(v) => set('requestIntervalMs', n(v, DEFAULT_SETTINGS.requestIntervalMs))} />
          <NumberInput label={`${FIELD_LABELS.jitterMs} (jitter)`} suffix=" ms" min={0} max={10000} step={250} value={s.jitterMs} onChange={(v) => set('jitterMs', n(v, DEFAULT_SETTINGS.jitterMs))} />
          <NumberInput label={FIELD_LABELS.batchSize} description="Split automatically when F2F has over 100 results" min={5} max={100} value={s.batchSize} onChange={(v) => set('batchSize', n(v, DEFAULT_SETTINGS.batchSize))} />
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
            label={FIELD_LABELS.creditBonus}
            description="F2F advertises +30 % in store credit"
            suffix=" %"
            min={0}
            max={200}
            value={Math.round(s.creditBonus * 100)}
            onChange={(v) => set('creditBonus', n(v, 30) / 100)}
          />
          <NumberInput label={FIELD_LABELS.cacheTtlHours} description="F2F changes prices during the day · 0 = always fresh" suffix=" h" min={0} max={336} value={s.cacheTtlHours} onChange={(v) => set('cacheTtlHours', n(v, DEFAULT_SETTINGS.cacheTtlHours))} />
          <NumberInput label={FIELD_LABELS.moxfieldPageSize} description="Rows per Moxfield request (max 5000 = one request)" min={25} max={5000} step={100} value={s.moxfieldPageSize} onChange={(v) => set('moxfieldPageSize', n(v, DEFAULT_SETTINGS.moxfieldPageSize))} />
          <Switch mt="md" label="Fallback search by set + number for prints not found by name" checked={s.fallbackEnabled} onChange={(e) => set('fallbackEnabled', e.currentTarget.checked)} />
          <NumberInput label={FIELD_LABELS.fallbackCap} description="Also the most cards checked on Shopify's search when both searches miss" min={0} max={2000} value={s.fallbackCap} onChange={(v) => set('fallbackCap', n(v, DEFAULT_SETTINGS.fallbackCap))} disabled={!s.fallbackEnabled} />
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="xs">
          The credit bonus is stored with each run when it starts, so changing it only affects new runs.
        </Text>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          F2F bulk rates
        </Title>
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
    </SettingsSection>
  );
}
