import { Alert, Anchor, Button, Group, Text } from '@mantine/core';
import { IconDownload, IconSparkles } from '@tabler/icons-react';
import { browser } from 'wxt/browser';
import { compareVersions, downloadUrl, RELEASE_PAGE_URL, updateCheckItem } from '@/lib/release';
import { useUpdateState } from './UpdateCheck';

/**
 * Banner shown on every dashboard page when a newer Tithies is published. The header's
 * UpdateCheckButton runs the checks; this shows their stored result.
 */
export function UpdateBanner() {
  const current = browser.runtime.getManifest().version;
  const state = useUpdateState();
  const latest = state?.latest;
  if (!latest || compareVersions(latest.version, current) <= 0 || state.dismissed === latest.version) return null;

  const dismiss = async () => {
    await updateCheckItem.setValue({ ...(await updateCheckItem.getValue()), dismissed: latest.version });
  };

  return (
    <Alert color="blue" variant="light" icon={<IconSparkles size={18} />} mb="md" withCloseButton onClose={() => void dismiss()} title={`Tithies ${latest.version} is available`}>
      <Text size="sm">
        You have {current}. Download the new zip, replace the files in your Tithies folder with the new ones, then click the reload ↻ icon on the
        Tithies card in <code>chrome://extensions</code>. Your data is kept.
      </Text>
      <Group gap="xs" mt="xs">
        <Button component="a" href={downloadUrl(latest)} size="xs" leftSection={<IconDownload size={14} />}>
          Download {latest.version}
        </Button>
        <Anchor href={`${RELEASE_PAGE_URL}#update`} target="_blank" size="sm">
          How to update
        </Anchor>
      </Group>
    </Alert>
  );
}
