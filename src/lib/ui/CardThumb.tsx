import { HoverCard, Image } from '@mantine/core';

export interface CardThumbProps {
  alt: string;
  small: string | null | undefined;
  large?: string | null;
  fallbackSmall?: string | null;
  fallbackLarge?: string | null;
}

/** Small card image for table rows; hovering shows it large. */
export function CardThumb({ alt, small, large, fallbackSmall, fallbackLarge }: CardThumbProps) {
  if (!small) return null;
  return (
    <HoverCard openDelay={150} position="right" shadow="md" withinPortal>
      <HoverCard.Target>
        <Image src={small} w={36} h={50} radius={3} fit="cover" loading="lazy" alt={alt} fallbackSrc={fallbackSmall ?? undefined} />
      </HoverCard.Target>
      <HoverCard.Dropdown p={4}>
        <Image src={large ?? small} w={244} radius="md" alt={alt} fallbackSrc={fallbackLarge ?? undefined} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
