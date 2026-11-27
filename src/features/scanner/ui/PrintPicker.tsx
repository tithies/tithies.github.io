import { Select } from '@mantine/core';
import { useMemo } from 'react';
import type { PrintInfo } from '../reference';

const keyOf = (p: Pick<PrintInfo, 'scryfallId' | 'back'>) => `${p.scryfallId}${p.back ? '~back' : ''}`;

/** Search prints by name (back faces too): the reference set's (your owned prints), or every print of the index. */
export function PrintPicker({
  prints,
  onPick,
  placeholder = 'Another of your prints…',
  nothingFound = 'Not in your collection',
  w = 260,
}: {
  prints: readonly PrintInfo[];
  onPick: (p: PrintInfo) => void;
  placeholder?: string;
  nothingFound?: string;
  w?: number;
}) {
  const { data, byKey } = useMemo(() => {
    const byKey = new Map<string, PrintInfo>();
    for (const p of prints) byKey.set(keyOf(p), p);
    const data = [...byKey.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.set.localeCompare(b.set) || a.cn.localeCompare(b.cn, undefined, { numeric: true }))
      .map((p) => ({
        value: keyOf(p),
        label: `${p.name} · ${p.set.toUpperCase()} #${p.cn}${p.lang && p.lang !== 'en' ? ` · ${p.lang.toUpperCase()}` : ''}${p.back ? ' · back' : ''}`,
      }));
    return { data, byKey };
  }, [prints]);
  return (
    <Select
      size="xs"
      w={w}
      placeholder={placeholder}
      searchable
      clearable={false}
      limit={40}
      data={data}
      value={null}
      nothingFoundMessage={nothingFound}
      onChange={(v) => {
        const p = v ? byKey.get(v) : undefined;
        if (p) onPick(p);
      }}
      comboboxProps={{ withinPortal: true }}
    />
  );
}
