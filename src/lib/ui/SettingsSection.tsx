import { Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';

/** One section of the Settings page: a tool's settings, or a global group (data, reset…). */
export function SettingsSection({
  title,
  description,
  icon: Icon,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  icon: React.ComponentType<{ size?: number }>;
  /** Shown on the right of the title (status, reset button…). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-end" gap="sm">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" size="lg" radius="md">
            <Icon size={20} />
          </ThemeIcon>
          <div>
            <Title order={3}>{title}</Title>
            {description && (
              <Text size="sm" c="dimmed">
                {description}
              </Text>
            )}
          </div>
        </Group>
        {actions && <Group gap="xs">{actions}</Group>}
      </Group>
      {children}
    </Stack>
  );
}
