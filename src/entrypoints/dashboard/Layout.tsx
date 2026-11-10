import { ActionIcon, AppShell, Burger, Group, NavLink, Text, Title, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconArrowsDiff, IconCards, IconCash, IconHistory, IconMoon, IconSettings, IconSun } from '@tabler/icons-react';
import { Link, Outlet, useLocation } from 'react-router';
import { UpdateBanner } from '@/lib/ui/UpdateBanner';

/** Each feature contributes a section to the navbar. */
const NAV = [
  {
    label: 'F2F buylist',
    icon: IconCash,
    links: [
      { to: '/f2f/runs', label: 'Runs', icon: IconHistory },
      { to: '/f2f/settings', label: 'Settings', icon: IconSettings },
    ],
  },
  {
    label: 'Decks',
    icon: IconCards,
    links: [{ to: '/decks/mismatches', label: 'Mismatches', icon: IconArrowsDiff }],
  },
];

export function Layout() {
  const [opened, { toggle }] = useDisclosure();
  const { pathname } = useLocation();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Title order={3}>Tithies</Title>
            <Text c="dimmed" size="sm" visibleFrom="sm">
              Moxfield × Face to Face Games
            </Text>
          </Group>
          <Tooltip label={scheme === 'dark' ? 'Light theme' : 'Dark theme'}>
            <ActionIcon variant="default" size="lg" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle color scheme">
              {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {NAV.map((section) => (
          <NavLink key={section.label} label={section.label} leftSection={<section.icon size={18} />} defaultOpened childrenOffset={12}>
            {section.links.map((l) => (
              <NavLink
                key={l.to}
                component={Link}
                to={l.to}
                label={l.label}
                leftSection={<l.icon size={16} />}
                active={pathname === l.to || (l.to === '/f2f/runs' && pathname.startsWith('/f2f/runs/'))}
              />
            ))}
          </NavLink>
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <UpdateBanner />
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
