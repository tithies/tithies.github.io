import { ActionIcon, AppShell, Burger, Divider, Group, NavLink, Text, Title, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconArrowsDiff, IconCards, IconCash, IconHistory, IconMoon, IconSettings, IconSun } from '@tabler/icons-react';
import { Link, Outlet, useLocation } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { AccountSelector } from '@/lib/ui/AccountSelector';
import { UpdateBanner } from '@/lib/ui/UpdateBanner';
import iconUrl from '@/assets/tithies-icon.webp';

/** Each feature contributes a section to the navbar. Its settings go in a section of the global Settings page. */
const NAV = [
  {
    label: 'Selling',
    icon: IconCash,
    links: [{ to: '/f2f/runs', label: 'Runs', icon: IconHistory }],
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
  const { key: accountKey, loading } = useCurrentAccount();

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Group gap={8} wrap="nowrap">
              <img src={iconUrl} width={38} height={38} alt="" />
              <Title order={3}>Tithies</Title>
            </Group>
            <Text c="dimmed" size="sm" visibleFrom="sm">
              Moxfield × Face to Face Games
            </Text>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <AccountSelector />
            <Tooltip label={scheme === 'dark' ? 'Light theme' : 'Dark theme'}>
              <ActionIcon variant="default" size="lg" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle color scheme">
                {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppShell.Section grow>
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
        </AppShell.Section>
        <AppShell.Section>
          <Divider mb="xs" />
          <NavLink component={Link} to="/settings" label="Settings" leftSection={<IconSettings size={18} />} active={pathname === '/settings'} />
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main>
        <UpdateBanner />
        {/* Every page remounts when the account changes: no state of one account survives into another's view. */}
        {!loading && <Outlet key={accountKey ?? 'none'} />}
      </AppShell.Main>
    </AppShell>
  );
}
