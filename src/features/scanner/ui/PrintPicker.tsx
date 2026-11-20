import { Select } from '@mantine/core';
import { useMemo } from 'react';
import type { PrintInfo } from '../reference';

const keyOf = (p: Pick<PrintInfo, 'scryfallId' | 'back'>) => `${p.scryfallId}${p.back ? '~back' : ''}`;

/** Search the reference set's prints (your owned prints, back faces too) by name. */
export function PrintPicker({ prints, onPick }: { prints: readonly PrintInfo[]; onPick: (p: PrintInfo) => void }) {
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
      w={260}
      placeholder="Another of your prints…"
      searchable
      clearable={false}
      limit={40}
      data={data}
      value={null}
      nothingFoundMessage="Not in your collection"
      onChange={(v) => {
        const p = v ? byKey.get(v) : undefined;
        if (p) onPick(p);
      }}
      comboboxProps={{ withinPortal: true }}
    />
  );
}
