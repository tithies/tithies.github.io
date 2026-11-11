import { Flex, Paper, Stack, Title } from '@mantine/core';
import medallionUrl from '@/assets/tithies-medallion.webp';

/** First-use card of a tool: the Tithies medallion next to a title and the steps to get going. */
export function GettingStarted({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper withBorder p="lg" radius="md" maw={760}>
      <Flex gap="lg" align={{ base: 'center', xs: 'flex-start' }} direction={{ base: 'column', xs: 'row' }}>
        <img src={medallionUrl} width={120} height={120} alt="" style={{ flexShrink: 0 }} />
        <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
          <Title order={4}>{title}</Title>
          {children}
        </Stack>
      </Flex>
    </Paper>
  );
}
