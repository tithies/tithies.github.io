import { Group, Paper, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';

export interface StatProps {
  label: string;
  value?: string;
  /** Custom content shown instead of the big value. */
  children?: React.ReactNode;
  /** Extra dimmed lines under the value. */
  lines?: React.ReactNode[];
  color?: string;
  icon?: React.ReactNode;
  /** Makes the whole card a toggle button. */
  onClick?: () => void;
  active?: boolean;
  /** Added to the label while active (default " · filtered"). */
  activeSuffix?: string;
  hint?: string;
}

/** Dashboard stat card; with `onClick` it becomes a toggle (e.g. a filter). */
export function Stat({ label, value, children, lines = [], color, icon, onClick, active, activeSuffix = ' · filtered', hint }: StatProps) {
  const body = (
    <Paper
      withBorder
      p="sm"
      radius="md"
      h="100%"
      style={active ? { borderColor: 'var(--mantine-primary-color-filled)', boxShadow: '0 0 0 1px var(--mantine-primary-color-filled)' } : undefined}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Text size="xs" c={active ? 'blue' : 'dimmed'} tt="uppercase" fw={600}>
            {label}
            {active ? activeSuffix : ''}
          </Text>
          {value != null && (
            <Text size="xl" fw={700} c={color} className="ti-num">
              {value}
            </Text>
          )}
          {children}
          {lines.map((l, i) => (
            <Text key={i} size="xs" c="dimmed" component="div">
              {l}
            </Text>
          ))}
        </Stack>
        {icon}
      </Group>
    </Paper>
  );
  if (!onClick) return body;
  return (
    <Tooltip label={hint} disabled={!hint} openDelay={400}>
      <UnstyledButton onClick={onClick} h="100%" w="100%" style={{ textAlign: 'left' }} aria-pressed={active}>
        {body}
      </UnstyledButton>
    </Tooltip>
  );
}
