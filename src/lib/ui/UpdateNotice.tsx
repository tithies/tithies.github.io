import { Affix, Anchor, Button, CloseButton, Group, Paper, Stack, Text, ThemeIcon, Tooltip, Transition } from '@mantine/core';
import { IconDownload, IconSparkles } from '@tabler/icons-react';
import { browser } from 'wxt/browser';
import { compareVersions, downloadUrl, RELEASE_PAGE_URL, updateCheckItem, type ReleaseInfo, type UpdateCheckState } from '@/lib/release';
import { useUpdateState } from './UpdateCheck';

/** Where the published page explains how to update. */
const HOW_TO_UPDATE_URL = `${RELEASE_PAGE_URL}#update`;

/** The newer published Tithies, if there is one (the menu's UpdateCheckButton runs the checks; this reads their stored result). */
function useNewerRelease(): { current: string; newer: ReleaseInfo | null; state: UpdateCheckState | null } {
  const current = browser.runtime.getManifest().version;
  const state = useUpdateState();
  const latest = state?.latest;
  return { current, newer: latest && compareVersions(latest.version, current) > 0 ? latest : null, state };
}

/**
 * A toast floating at the top of every dashboard page when a newer Tithies is published, until it
 * is closed: closing hides it for that version (a manual check in the menu brings it back). The
 * menu's UpdateMenuButton stays there while the update isn't installed.
 */
export function UpdateToast() {
  const { current, newer, state } = useNewerRelease();
  const shown = !!newer && state?.dismissed !== newer.version;

  const dismiss = async () => {
    if (!newer) return;
    await updateCheckItem.setValue({ ...(await updateCheckItem.getValue()), dismissed: newer.version });
  };

  return (
    <Affix position={{ top: 12, left: '50%' }} zIndex={300} style={{ transform: 'translateX(-50%)', width: 'min(460px, calc(100vw - 32px))' }}>
      <Transition mounted={shown} transition="slide-down" duration={200}>
        {(styles) =>
          newer ? (
            <Paper style={styles} shadow="lg" radius="md" p="sm" withBorder role="status" aria-live="polite">
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <ThemeIcon variant="light" color="blue" radius="xl" size="lg">
                  <IconSparkles size={18} />
                </ThemeIcon>
                <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={600}>
                    Tithies {newer.version} is available
                  </Text>
                  <Text size="xs" c="dimmed">
                    You have {current}. Download the new zip, replace the files in your Tithies folder with the new ones, then click the reload ↻ icon on the
                    Tithies card in <code>chrome://extensions</code>. Your data is kept.
                  </Text>
                  <Group gap="xs">
                    <Button component="a" href={downloadUrl(newer)} size="xs" leftSection={<IconDownload size={14} />}>
                      Download {newer.version}
                    </Button>
                    <Anchor href={HOW_TO_UPDATE_URL} target="_blank" size="xs">
                      How to update
                    </Anchor>
                  </Group>
                </Stack>
                <CloseButton size="sm" onClick={() => void dismiss()} aria-label="Close: don't show this again for this version" />
              </Group>
            </Paper>
          ) : (
            <span />
          )
        }
      </Transition>
    </Affix>
  );
}

/**
 * Under the account selector, while a newer Tithies is published and not installed: a button to
 * download it, and a link to how to update. Unlike the toast, it can't be closed.
 */
export function UpdateMenuButton() {
  const { current, newer } = useNewerRelease();
  if (!newer) return null;
  return (
    <Stack gap={2}>
      <Tooltip label={`Tithies ${newer.version} is available (you have ${current})`} withinPortal position="right">
        <Button component="a" href={downloadUrl(newer)} variant="light" color="blue" size="compact-md" fullWidth justify="flex-start" leftSection={<IconDownload size={16} />}>
          <Text span inherit truncate>
            Download {newer.version}
          </Text>
        </Button>
      </Tooltip>
      <Anchor href={HOW_TO_UPDATE_URL} target="_blank" size="xs" px={4}>
        How to update
      </Anchor>
    </Stack>
  );
}
