import { Anchor, Button, Group, Loader, Popover, Progress, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconArrowsDiff, IconHistory, IconListDetails } from '@tabler/icons-react';
import { Link, useNavigate } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { useActivity, type ActivityItem } from '@/lib/activity';

const ICON = { export: IconListDetails, run: IconHistory, sync: IconArrowsDiff } as const;

/** Header button, only there while something runs in the background: lists each job and links to it. */
export function ActivityButton() {
  const items = useActivity();
  const { key: current, accounts, switchTo } = useCurrentAccount();
  const navigate = useNavigate();
  const [opened, { close, toggle }] = useDisclosure(false);
  if (!items.length) return null;

  const open = async (it: ActivityItem) => {
    close();
    // Pages show the current account's data: go to the job's account first.
    if (it.accountKey !== current) await switchTo(it.accountKey);
    navigate(it.to);
  };

  return (
    <Popover opened={opened} onChange={(o) => !o && close()} position="bottom-end" width={360} shadow="md" withArrow>
      <Popover.Target>
        <Button variant="light" size="compact-md" leftSection={<Loader size={14} />} onClick={toggle} aria-label="Running in the background">
          Running · {items.length}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          {items.map((it) => {
            const Icon = ICON[it.kind];
            return (
              <UnstyledButton key={it.id} onClick={() => void open(it)}>
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  <Icon size={18} style={{ flexShrink: 0, marginTop: 2 }} />
                  <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={600} lineClamp={2}>
                      {it.title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {it.detail}
                      {accounts.length > 1 ? ` · ${it.userName}` : ''}
                    </Text>
                    {it.progress ? (
                      <Progress value={(it.progress.done / it.progress.total) * 100} size="xs" />
                    ) : (
                      <Progress value={100} size="xs" animated striped />
                    )}
                  </Stack>
                </Group>
              </UnstyledButton>
            );
          })}
          <Anchor component={Link} to="/changes" size="xs" onClick={close}>
            Open the Change log
          </Anchor>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
