import { ActionIcon, AppShell, Box, Burger, Divider, Group, NavLink, Stack, Text, Title, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconArrowsDiff, IconCamera, IconCards, IconCash, IconHistory, IconListDetails, IconMoon, IconSettings, IconSun } from '@tabler/icons-react';
import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { AccountSelector } from '@/lib/ui/AccountSelector';
import { ActivityButton } from '@/lib/ui/ActivityButton';
import { InitialSyncButton, InitialSyncProvider } from '@/lib/ui/InitialSync';
import { UpdateMenuButton, UpdateToast } from '@/lib/ui/UpdateNotice';
import { UpdateCheckButton } from '@/lib/ui/UpdateCheck';
import iconUrl from '@/assets/tithies-icon.webp';
import { MenuArt } from './MenuArt';

/** Each feature contributes a section to the navbar. Its settings go in a section of the global Settings page. */
const NAV = [
  {
    label: 'Selling',
    icon: IconCash,
    links: [{ to: '/f2f/runs', label: 'Runs', icon: IconHistory }],
  },
  {
    label: 'Collection',
    icon: IconCards,
    links: [
      { to: '/collection/comparator', label: 'Comparator', icon: IconArrowsDiff },
      { to: '/collection/scanner', label: 'Scanner', icon: IconCamera },
    ],
  },
];

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const { pathname } = useLocation();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');
  const { key: accountKey, loading } = useCurrentAccount();
  // Phones: the menu covers the page, so going to a page closes it.
  useEffect(close, [pathname]);

  return (
    // The initial-sync prompt of new accounts, opened from the menu and from pages.
    <InitialSyncProvider>
      {/* No header: the logo, the account and the app's buttons sit at the top of the menu, so pages get the whole height. */}
      <AppShell navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
        <AppShell.Navbar p="xs">
          <MenuArt />
          <AppShell.Section>
            <Group justify="space-between" wrap="nowrap" px={4} pt={2} pb="xs">
              <Group gap={8} wrap="nowrap">
                <img src={iconUrl} width={34} height={34} alt="" />
                <Title order={3}>Tithies</Title>
              </Group>
              <Group gap={4} wrap="nowrap">
                <Tooltip label={scheme === 'dark' ? 'Light theme' : 'Dark theme'}>
                  <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle color scheme">
                    {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
                  </ActionIcon>
                </Tooltip>
                <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Close the menu" />
              </Group>
            </Group>
            <Stack gap={6} mb="md">
              {/* The account band spans the menu's whole width (past its padding). */}
              <Box mx="-xs">
                <AccountSelector />
              </Box>
              {/* While a newer Tithies is published: its download, and how to update. */}
              <UpdateMenuButton />
              <InitialSyncButton />
              <ActivityButton />
            </Stack>
          </AppShell.Section>
          <AppShell.Section grow>
            {/* A section is a heading (small, bold, uppercase, with its icon) over its links; a line separates sections. */}
            {NAV.map((section, i) => (
              <div key={section.label}>
                {i > 0 && <Divider my="sm" />}
                <Group gap={6} px="sm" pb={6} wrap="nowrap" c="dimmed">
                  <section.icon size={14} stroke={2.2} />
                  <Text size="xs" fw={700} tt="uppercase" style={{ letterSpacing: '0.07em' }}>
                    {section.label}
                  </Text>
                </Group>
                {section.links.map((l) => (
                  <NavLink
                    key={l.to}
                    component={Link}
                    to={l.to}
                    label={l.label}
                    leftSection={<l.icon size={18} />}
                    active={pathname === l.to || (l.to === '/f2f/runs' && pathname.startsWith('/f2f/runs/'))}
                  />
                ))}
              </div>
            ))}
          </AppShell.Section>
          <AppShell.Section>
            <NavLink
              component={Link}
              to="/changes"
              label="Change log"
              leftSection={<IconListDetails size={18} />}
              active={pathname === '/changes'}
              className="ti-nav-on-art"
            />
            <NavLink
              component={Link}
              to="/settings"
              label="Settings"
              leftSection={<IconSettings size={18} />}
              active={pathname === '/settings'}
              className="ti-nav-on-art"
            />
            <UpdateCheckButton />
          </AppShell.Section>
        </AppShell.Navbar>
        <AppShell.Main>
          {/* Phones: the menu is hidden, this opens it. */}
          <Group gap={8} wrap="nowrap" mb="sm" hiddenFrom="sm">
            <Burger opened={opened} onClick={toggle} size="sm" aria-label="Open the menu" />
            <img src={iconUrl} width={28} height={28} alt="" />
            <Title order={4}>Tithies</Title>
          </Group>
          {/* A newer Tithies: a toast floating at the top, until closed. */}
          <UpdateToast />
          {/* Every page remounts when the account changes: no state of one account survives into another's view. */}
          {!loading && <Outlet key={accountKey ?? 'none'} />}
        </AppShell.Main>
      </AppShell>
    </InitialSyncProvider>
  );
}
