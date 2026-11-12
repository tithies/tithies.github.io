import { Button, Stack, Text, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { dateTime, timeAgo } from '@/lib/format';
import { CHECK_EVERY_MS, compareVersions, getLatestRelease, RELEASE_PAGE_URL, updateCheckItem, type UpdateCheckState } from '@/lib/release';

/** A manual check spins the icon at least this long, so a fast answer still shows it happened. */
const MIN_SPIN_MS = 600;
/** How often the header refreshes "… ago" and sees whether the automatic check is due. */
const TICK_MS = 60_000;

/** The stored update-check state, kept current: a check or a dismissed banner in any tab updates it. */
export function useUpdateState(): UpdateCheckState | null {
  const [state, setState] = useState<UpdateCheckState | null>(null);
  useEffect(() => {
    let alive = true;
    void updateCheckItem.getValue().then((s) => alive && setState(s));
    const unwatch = updateCheckItem.watch((s) => setState(s ?? { checkedAt: 0 }));
    return () => {
      alive = false;
      unwatch();
    };
  }, []);
  return state;
}

/**
 * Header: when Tithies last looked for a new version, with a refresh icon; a click looks now.
 * It also runs the automatic check (every CHECK_EVERY_MS while a dashboard page is open); the
 * banner (UpdateBanner) shows what it finds.
 */
export function UpdateCheckButton() {
  const current = browser.runtime.getManifest().version;
  const state = useUpdateState();
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      void getLatestRelease();
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, []);

  const checkNow = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await Promise.all([getLatestRelease({ force: true }), new Promise((r) => setTimeout(r, MIN_SPIN_MS))]);
    } finally {
      setChecking(false);
      setNow(Date.now());
    }
  };

  const checkedAt = state?.checkedAt ?? 0;
  const failed = state?.ok === false;
  const latest = state?.latest;
  const newer = latest && compareVersions(latest.version, current) > 0 ? latest : undefined;
  const when = now - checkedAt < 45_000 ? 'just now' : timeAgo(checkedAt, now);
  const label = checking
    ? 'Checking for updates…'
    : !checkedAt
      ? 'Check for updates'
      : failed
        ? `Update check failed ${when}`
        : newer
          ? `Tithies ${newer.version} available`
          : `Update checked ${when}`;
  const host = new URL(RELEASE_PAGE_URL).host;

  return (
    <Tooltip
      multiline
      w={280}
      withinPortal
      label={
        <Stack gap={2}>
          <Text size="xs">
            Installed: {current}
            {latest ? ` · latest published: ${latest.version}` : ''}
          </Text>
          {checkedAt > 0 && (
            <Text size="xs">
              {failed ? `Couldn't reach ${host} (offline?) on ${dateTime(checkedAt)}.` : `Last check: ${dateTime(checkedAt)}.`}
            </Text>
          )}
          <Text size="xs">
            Tithies checks every {CHECK_EVERY_MS / 3600_000} hours while a page is open. Click to check now.
          </Text>
        </Stack>
      }
    >
      <Button
        variant="subtle"
        color={failed ? 'orange' : newer ? 'blue' : 'gray'}
        size="sm"
        px="xs"
        fw={400}
        onClick={() => void checkNow()}
        rightSection={<IconRefresh size={16} className={checking ? 'ti-spin' : undefined} />}
        aria-label={`${label}. Check for updates now`}
      >
        <Text span size="xs" c={failed ? 'orange' : newer ? 'blue' : 'dimmed'} visibleFrom="sm">
          {label}
        </Text>
      </Button>
    </Tooltip>
  );
}
