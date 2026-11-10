import { Badge, Button, Checkbox, Divider, Group, Popover, ScrollArea, Stack } from '@mantine/core';
import { IconColumns } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_HIDDEN_COLUMNS, hiddenColumnsItem } from '@/lib/settings';
import { COLUMN_META } from './columns';

/** Hidden table columns, persisted in chrome.storage.local and synced across open dashboards. */
export function useHiddenColumns() {
  const [hidden, setHidden] = useState<string[]>(DEFAULT_HIDDEN_COLUMNS);
  useEffect(() => {
    void hiddenColumnsItem.getValue().then(setHidden);
    return hiddenColumnsItem.watch((v) => setHidden(v ?? DEFAULT_HIDDEN_COLUMNS));
  }, []);
  const save = useCallback((next: string[]) => {
    setHidden(next);
    void hiddenColumnsItem.setValue(next);
  }, []);
  return { hidden: useMemo(() => new Set(hidden), [hidden]), save };
}

export function ColumnsMenu({ hidden, onChange }: { hidden: ReadonlySet<string>; onChange: (next: string[]) => void }) {
  const toggleable = COLUMN_META.filter((c) => c.toggleable);
  const hiddenCount = toggleable.filter((c) => hidden.has(c.accessor)).length;
  const toggle = (accessor: string, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(accessor);
    else next.add(accessor);
    onChange([...next]);
  };

  return (
    <Popover position="bottom-end" shadow="md" withArrow>
      <Popover.Target>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconColumns size={14} />}
          rightSection={hiddenCount ? <Badge size="xs" variant="light">{hiddenCount} hidden</Badge> : null}
        >
          Columns
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <ScrollArea.Autosize mah={420} type="auto">
          <Stack gap={6} pr="sm">
            {toggleable.map((c) => (
              <Checkbox key={c.accessor} size="xs" label={c.label} checked={!hidden.has(c.accessor)} onChange={(e) => toggle(c.accessor, e.currentTarget.checked)} />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <Divider my="xs" />
        <Group gap="xs" justify="space-between">
          <Button size="compact-xs" variant="subtle" onClick={() => onChange([])}>
            Show all
          </Button>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => onChange(DEFAULT_HIDDEN_COLUMNS)}>
            Reset to default
          </Button>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
