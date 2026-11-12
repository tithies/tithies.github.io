import { Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconHandClick } from '@tabler/icons-react';

export interface StatProps {
  label: string;
  value?: string;
  /** Custom content shown instead of the big value. */
  children?: React.ReactNode;
  /** Extra dimmed lines under the value. */
  lines?: React.ReactNode[];
  color?: string;
  icon?: React.ReactNode;
  /** Makes the whole card a toggle button (e.g. a filter). */
  onClick?: () => void;
  active?: boolean;
  /** Added to the label while active (default " · filtered"). */
  activeSuffix?: string;
  /** What a click does now ("Show only bulk cards"), shown at the bottom of a clickable card. */
  action?: string;
}

/**
 * Dashboard stat card; with `onClick` it becomes a toggle (e.g. a filter). A clickable card says
 * what a click does on its last line and lifts on hover (see .ti-stat-clickable in dashboard.css),
 * so it doesn't look like the cards that only show numbers.
 */
export function Stat({ label, value, children, lines = [], color, icon, onClick, active, activeSuffix = ' · filtered', action }: StatProps) {
  const body = (
    <Paper withBorder p="sm" radius="md" h="100%" className={onClick ? 'ti-stat ti-stat-clickable' : 'ti-stat'} mod={{ active: !!active }}>
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
      {onClick && action && (
        <Group gap={6} wrap="nowrap" mt="auto" pt="xs" className="ti-stat-action">
          <IconHandClick size={15} stroke={1.8} />
          <Text size="xs" fw={600}>
            {action}
          </Text>
        </Group>
      )}
    </Paper>
  );
  if (!onClick) return body;
  return (
    <UnstyledButton onClick={onClick} h="100%" w="100%" className="ti-stat-button" style={{ textAlign: 'left' }} aria-pressed={active}>
      {body}
    </UnstyledButton>
  );
}
