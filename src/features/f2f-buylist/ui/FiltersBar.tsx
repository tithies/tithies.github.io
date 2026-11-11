import { Badge, Button, Collapse, Group, MultiSelect, NumberInput, Paper, SegmentedControl, SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useDebouncedCallback, useDisclosure } from '@mantine/hooks';
import { IconAdjustmentsHorizontal, IconBan, IconBox, IconCards, IconCash, IconSearch, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import type { Item } from '../types';
import { activeFilterCount, detailedFinish, EMPTY_FILTERS, type Filters } from './filtering';
import { FINISH_LABEL, rarityLabel } from './format';

interface Props {
  filters: Filters;
  onChange: (f: Filters) => void;
  items: Item[];
  counts: { all: number; buylist: number; bulk: number; notBought: number };
}

export const STATUS_OPTIONS = [
  { value: 'exact', label: 'Exact match' },
  { value: 'loose', label: 'Loose match' },
  { value: 'price_check', label: 'Check price manually' },
  { value: 'not_found', label: 'Not found on F2F' },
  { value: 'unlisted', label: 'Not sold by F2F (oversized)' },
  { value: 'error', label: 'Error (lookup failed)' },
  { value: 'pending', label: 'Not checked yet' },
];

/** Category toggle label, with the same icon (and colour) as the table's category column. */
function CategoryLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <Group gap={6} wrap="nowrap" justify="center">
      {icon}
      <span>{text}</span>
    </Group>
  );
}

export function FiltersBar({ filters, onChange, items, counts }: Props) {
  const advanced = activeFilterCount({ ...filters, q: '', category: 'all' });
  const [opened, { toggle, open }] = useDisclosure(advanced > 0);
  // Filters set from elsewhere (e.g. clicking "Needs review") should be visible.
  useEffect(() => {
    if (advanced > 0) open();
  }, [advanced, open]);
  const [q, setQ] = useState(filters.q);
  const pushQ = useDebouncedCallback((v: string) => onChange({ ...filters, q: v }), 250);
  useEffect(() => setQ(filters.q), [filters.q]);

  const options = useMemo(() => {
    const sets = new Map<string, string>();
    const rarities = new Set<string>();
    const finishes = new Set<string>();
    for (const i of items) {
      sets.set(i.set, i.setName);
      rarities.add(i.rarity);
      finishes.add(detailedFinish(i));
    }
    // Only the extras: the standard finishes are already in the Finish filter.
    const standard = new Set<string>(Object.values(FINISH_LABEL));
    return {
      finishes: [...finishes].filter((v) => !standard.has(v)).sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v })),
      sets: [...sets.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, name]) => ({ value, label: `${name} (${value.toUpperCase()})` })),
      rarities: [...rarities].filter(Boolean).sort().map((r) => ({ value: r, label: rarityLabel(r) })),
    };
  }, [items]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...filters, [k]: v });
  const numVal = (v: string | number) => (v === '' || v == null ? null : Number(v));

  return (
    <Paper withBorder p="sm" radius="md">
      <Group gap="sm" wrap="wrap">
        <TextInput
          placeholder="Search name, set, number, reason…"
          leftSection={<IconSearch size={16} />}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            pushQ(e.currentTarget.value);
          }}
          rightSection={
            q ? (
              <IconX
                size={14}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  setQ('');
                  set('q', '');
                }}
              />
            ) : null
          }
          w={280}
        />
        <SegmentedControl
          value={filters.category}
          onChange={(v) => set('category', v as Filters['category'])}
          data={[
            { value: 'all', label: <CategoryLabel icon={<IconCards size={16} />} text={`All (${counts.all})`} /> },
            { value: 'buylist', label: <CategoryLabel icon={<IconCash size={16} color="var(--mantine-color-teal-5)" />} text={`Buylist (${counts.buylist})`} /> },
            { value: 'bulk', label: <CategoryLabel icon={<IconBox size={16} color="var(--mantine-color-orange-5)" />} text={`Bulk (${counts.bulk})`} /> },
            { value: 'not_bought', label: <CategoryLabel icon={<IconBan size={16} color="var(--mantine-color-gray-5)" />} text={`Not bought (${counts.notBought})`} /> },
          ]}
        />
        <Button
          variant={advanced ? 'light' : 'default'}
          leftSection={<IconAdjustmentsHorizontal size={16} />}
          rightSection={advanced ? <Badge size="xs" circle>{advanced}</Badge> : null}
          onClick={toggle}
        >
          Filters
        </Button>
        {activeFilterCount(filters) > 0 && (
          <Button variant="subtle" color="gray" leftSection={<IconX size={14} />} onClick={() => onChange(EMPTY_FILTERS)}>
            Reset
          </Button>
        )}
      </Group>
      <Collapse expanded={opened}>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} mt="sm" spacing="sm">
          <MultiSelect label="Sets" placeholder="Any set" data={options.sets} value={filters.sets} onChange={(v) => set('sets', v)} searchable clearable />
          <MultiSelect
            label="Finish"
            placeholder="Any finish"
            data={Object.entries(FINISH_LABEL).map(([value, label]) => ({ value, label }))}
            value={filters.finishes}
            onChange={(v) => set('finishes', v)}
            clearable
          />
          <MultiSelect
            label="Special finish"
            placeholder="Any special finish"
            data={options.finishes}
            value={filters.specialFinishes}
            onChange={(v) => set('specialFinishes', v)}
            searchable
            clearable
          />
          <MultiSelect label="Rarity" placeholder="Any rarity" data={options.rarities} value={filters.rarities} onChange={(v) => set('rarities', v)} clearable />
          <MultiSelect label="Status" placeholder="Any status" data={STATUS_OPTIONS} value={filters.status} onChange={(v) => set('status', v)} clearable />
          <Group grow gap="xs" align="flex-end">
            <NumberInput label="Buy cash min" prefix="$" min={0} decimalScale={2} value={filters.minBuy ?? ''} onChange={(v) => set('minBuy', numVal(v))} />
            <NumberInput label="max" prefix="$" min={0} decimalScale={2} value={filters.maxBuy ?? ''} onChange={(v) => set('maxBuy', numVal(v))} />
          </Group>
          <Group grow gap="xs" align="flex-end">
            <NumberInput label="% cash min" suffix=" %" min={0} max={500} value={filters.minPct ?? ''} onChange={(v) => set('minPct', numVal(v))} />
            <NumberInput label="max" suffix=" %" min={0} max={500} value={filters.maxPct ?? ''} onChange={(v) => set('maxPct', numVal(v))} />
          </Group>
          <NumberInput label="Min copies owned" min={1} value={filters.minQty ?? ''} onChange={(v) => set('minQty', numVal(v))} />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              F2F stock (NM)
            </Text>
            <SegmentedControl
              size="xs"
              value={filters.stock}
              onChange={(v) => set('stock', v as Filters['stock'])}
              data={[
                { value: 'any', label: 'Any' },
                { value: 'in', label: 'In stock' },
                { value: 'out', label: 'No stock' },
              ]}
            />
          </Stack>
          <Group gap="lg" align="flex-end" pb={6}>
            <Switch label="Needs review" checked={filters.problems} onChange={(e) => set('problems', e.currentTarget.checked)} />
            <Switch label="Has a note under the name" checked={filters.noted} onChange={(e) => set('noted', e.currentTarget.checked)} />
          </Group>
        </SimpleGrid>
      </Collapse>
    </Paper>
  );
}
