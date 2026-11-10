import { Alert, Anchor, Button, Group, Text } from '@mantine/core';
import { IconDownload, IconSparkles } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { compareVersions, downloadUrl, getLatestRelease, RELEASE_PAGE_URL, updateCheckItem, type ReleaseInfo } from '@/lib/release';

/** Banner shown on every dashboard page when a newer Tithies is published. */
export function UpdateBanner() {
  const current = browser.runtime.getManifest().version;
  const [latest, setLatest] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void getLatestRelease().then((s) => {
      if (alive && s.latest && compareVersions(s.latest.version, current) > 0 && s.dismissed !== s.latest.version) setLatest(s.latest);
    });
    return () => {
      alive = false;
    };
  }, [current]);

  if (!latest) return null;

  const dismiss = async () => {
    setLatest(null);
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
