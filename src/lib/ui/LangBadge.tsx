import { Badge, Group, Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { isEnglish, langBadge, langLabel } from '@/lib/cards/languages';

interface Props {
  /** The language shown ("FR"); nothing for English. */
  lang?: string;
  /** A language mismatch to warn about (see `mismatchText`), shown as a yellow icon. */
  warning?: string | null;
}

/**
 * A non-English card's language, and a warning when the site's Language field and the print
 * disagree. It sits at the right end of its row (after the card name).
 */
export function LangBadge({ lang, warning }: Props) {
  const badge = !isEnglish(lang);
  if (!badge && !warning) return null;
  return (
    <Group gap={4} wrap="nowrap" style={{ flexShrink: 0, marginLeft: 'auto' }}>
      {badge && (
        <Tooltip label={langLabel(lang)}>
          <Badge size="xs" variant="light" color="grape" radius="sm">
            {langBadge(lang)}
          </Badge>
        </Tooltip>
      )}
      {warning && (
        <Tooltip label={warning} multiline w={280}>
          <IconAlertTriangle size={14} color="var(--mantine-color-yellow-6)" aria-label={warning} style={{ flexShrink: 0 }} />
        </Tooltip>
      )}
    </Group>
  );
}
