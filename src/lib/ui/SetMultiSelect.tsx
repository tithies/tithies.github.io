import { MultiSelect, Pill, Text, Tooltip, type ComboboxParsedItem, type MultiSelectProps } from '@mantine/core';
import { useMemo } from 'react';
import { fold } from '@/lib/format';

/** The typing area of a multi-select starts small and grows, so a picked value and it share one line. */
export const ONE_LINE_PILLS = { inputField: { minWidth: 40, flex: '1 1 40px', width: 0 } };

type Props = Omit<MultiSelectProps, 'data' | 'filter' | 'renderOption' | 'renderPill' | 'value' | 'onChange' | 'styles'> & {
  /** Set code → set name. */
  names: Map<string, string>;
  value: string[];
  onChange: (value: string[]) => void;
};

/**
 * Set filter: picked sets show as their code ("M20") so the field stays one line (hovering one shows
 * the full name); the list shows the name and the code and searches both.
 */
export function SetMultiSelect({ names, ...props }: Props) {
  const data = useMemo(
    () => [...names].sort((a, b) => a[1].localeCompare(b[1])).map(([value]) => ({ value, label: value.toUpperCase() })),
    [names],
  );
  const filter = ({ options, search }: { options: ComboboxParsedItem[]; search: string }) => {
    const words = fold(search).split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      if (!('value' in o)) return true;
      const hay = fold(`${names.get(String(o.value)) ?? ''} ${o.value}`);
      return words.every((w) => hay.includes(w));
    });
  };
  return (
    <MultiSelect
      searchable
      clearable
      {...props}
      data={data}
      filter={filter}
      renderOption={({ option }) => (
        <Text size="sm">
          {names.get(option.value) ?? option.value}{' '}
          <Text span size="xs" c="dimmed">
            {option.label}
          </Text>
        </Text>
      )}
      renderPill={({ option, value, onRemove, disabled }) => (
        <Tooltip label={names.get(String(value)) ?? String(value)} withinPortal openDelay={300}>
          <Pill withRemoveButton={!disabled && !props.readOnly} onRemove={onRemove} disabled={disabled}>
            {option?.label ?? value}
          </Pill>
        </Tooltip>
      )}
      styles={ONE_LINE_PILLS}
    />
  );
}
