import { ActionIcon, Badge, Group, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconBan, IconBox, IconCash, IconClock, IconExternalLink, IconRefreshAlert, IconShoppingCart, IconTag } from '@tabler/icons-react';
import type { DataTableColumn } from 'mantine-datatable';
import { sizedImage } from '@/lib/f2f/api';
import { CardThumb } from '@/lib/ui/CardThumb';
import { f2fLinks, scryfallCardLink, scryfallImage } from '@/lib/f2f/links';
import { categoryOf, matchOf, type Category, type Item } from '../types';
import { detailedFinish, isProblem, nameNote, pctOf } from './filtering';
import { money, moneyUsd, pct, pctColor, RARITY_COLOR, rarityLabel } from './format';

const num = (children: React.ReactNode, c?: string) => (
  <Text size="sm" className="ti-num" c={c} ta="right">
    {children}
  </Text>
);

/**
 * Green cash = F2F buys it at a card price, orange box = bulk, grey ban = F2F doesn't buy it at all (tokens,
 * Unfinity…). Rows still being looked up show a grey clock, failed lookups a grey retry icon.
 * "Needs review" isn't an icon: those rows are tinted red (see `reviewRowClass`).
 */
const CATEGORY_ICON: Record<Category, { color: string; icon: React.ReactNode }> = {
  buylist: { color: 'teal', icon: <IconCash size={18} /> },
  bulk: { color: 'orange', icon: <IconBox size={18} /> },
  not_bought: { color: 'gray', icon: <IconBan size={18} /> },
};

/**
 * Red background for rows that need review (the rows counted by the "Needs review" card); the
 * colours are in dashboard.css. A class rather than the table's `rowBackgroundColor`, which
 * loses to its striped and hover rules.
 */
export const reviewRowClass = (item: Item) => (isProblem(item) ? 'ti-review-row' : undefined);

export function CategoryIcon({ item }: { item: Item }) {
  if (item.status === 'error') {
    return (
      <Tooltip label={`Needs review — lookup failed: ${item.error ?? 'unknown error'}. Use "Retry errors" on the run.`} multiline w={280}>
        <ThemeIcon color="gray" variant="light">
          <IconRefreshAlert size={18} />
        </ThemeIcon>
      </Tooltip>
    );
  }
  if (item.status !== 'done') {
    return (
      <Tooltip label={item.status === 'fallback' ? 'Waiting for fallback search' : item.status === 'shop_search' ? 'Waiting for Shopify search' : 'Waiting to be checked'}>
        <ThemeIcon color="gray" variant="light">
          <IconClock size={18} />
        </ThemeIcon>
      </Tooltip>
    );
  }
  const category = categoryOf(item) ?? 'bulk';
  const review = isProblem(item);
  const lines = [
    review && 'Needs review',
    category === 'buylist' && 'F2F buys this card',
    category === 'bulk' && `Bulk — ${item.bulkReason ?? "F2F doesn't buy it individually"}`,
    category === 'not_bought' && 'Not bought by F2F (not even as bulk)',
    category === 'not_bought' && item.bulkReason,
    item.match === 'loose' && `Loose match: ${item.matchNote ?? ''}`,
    item.match === 'price_check' && `Check the price manually: ${item.matchNote ?? ''}`,
    matchOf(item) === 'not_found' && `Exact print not found on F2F${item.matchNote ? ` (${item.matchNote})` : ''}`,
    matchOf(item) === 'unlisted' && "Not on F2F: F2F doesn't list oversized cards",
    item.match === 'exact' && item.matchNote,
    item.fromCache && 'From cache',
  ].filter(Boolean);
  return (
    <Tooltip
      multiline
      w={280}
      label={
        <Stack gap={2}>
          {lines.map((l, i) => (
            <Text key={String(l)} size="xs" fw={review && i === 0 ? 700 : undefined}>
              {l}
            </Text>
          ))}
        </Stack>
      }
    >
      <ThemeIcon color={CATEGORY_ICON[category].color} variant="filled">
        {CATEGORY_ICON[category].icon}
      </ThemeIcon>
    </Tooltip>
  );
}

/** The line under the card name; the "Has a note" filter finds exactly these rows. */
function NameNoteLine({ item }: { item: Item }) {
  const note = nameNote(item);
  if (!note) return null;
  return (
    <Text size="xs" c={note.color} lineClamp={1} title={note.title}>
      {note.text}
    </Text>
  );
}

function CardImage({ item }: { item: Item }) {
  return (
    <CardThumb
      alt={item.name}
      small={sizedImage(item.doc?.image, 146) ?? scryfallImage(item.scryfallId, 'small')}
      large={sizedImage(item.doc?.image, 488) ?? scryfallImage(item.scryfallId, 'normal')}
      fallbackSmall={scryfallImage(item.scryfallId)}
      fallbackLarge={scryfallImage(item.scryfallId, 'normal')}
    />
  );
}

function Links({ item }: { item: Item }) {
  const handle = item.doc?.handle;
  const buyHref = handle ? f2fLinks.shopProduct(handle) : f2fLinks.shopSearch(item.frontName);
  const priceCheck = item.match === 'price_check';
  const category = categoryOf(item);
  const sellHref = (category === 'buylist' || priceCheck) && handle ? f2fLinks.sellProduct(handle) : f2fLinks.sellBulk;
  const sellLabel = priceCheck
    ? 'Check the buy price on F2F (sell page)'
    : category === 'buylist'
      ? 'Sell to F2F (sell page)'
      : category === 'not_bought'
        ? "F2F doesn't buy this card, not even as bulk"
        : 'Sell as bulk (F2F wholesale page)';
  const notBought = category === 'not_bought' && !priceCheck;
  return (
    <Group gap={2} wrap="nowrap">
      <Tooltip label={handle ? 'Buy on F2F (shop page)' : 'Search on F2F shop'}>
        <ActionIcon component="a" href={buyHref} target="_blank" variant="subtle" aria-label="Buy on F2F">
          <IconShoppingCart size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={sellLabel}>
        {notBought ? (
          <ActionIcon variant="subtle" color="gray" disabled aria-label="Not bought by F2F">
            <IconTag size={16} />
          </ActionIcon>
        ) : (
          <ActionIcon component="a" href={sellHref} target="_blank" variant="subtle" color={category === 'buylist' ? 'teal' : priceCheck ? 'red' : 'orange'} aria-label="Sell to F2F">
            <IconTag size={16} />
          </ActionIcon>
        )}
      </Tooltip>
      <Tooltip label="Scryfall">
        <ActionIcon component="a" href={scryfallCardLink(item.set, item.cn)} target="_blank" variant="subtle" color="gray" aria-label="Scryfall">
          <IconExternalLink size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

const CASH_COLOR: Record<Category, string | undefined> = { buylist: undefined, bulk: 'orange', not_bought: 'dimmed' };

/** Header with a tooltip explaining the (short) column title. */
const head = (title: string, help: string) => (
  <Tooltip label={help} multiline w={240} withinPortal>
    <span>{title}</span>
  </Tooltip>
);

export interface ColumnMeta {
  accessor: string;
  /** Label in the "Columns" menu. */
  label: string;
  /** Icon and Card columns are always shown. */
  toggleable: boolean;
}

/** Every column of the results table, in display order (also drives the "Columns" menu). */
export const COLUMN_META: ColumnMeta[] = [
  { accessor: 'category', label: 'Category icon', toggleable: false },
  { accessor: 'image', label: 'Image', toggleable: true },
  { accessor: 'name', label: 'Card', toggleable: false },
  { accessor: 'set', label: 'Set', toggleable: true },
  { accessor: 'cn', label: 'Collector number', toggleable: true },
  { accessor: 'finish', label: 'Finish', toggleable: true },
  { accessor: 'rarity', label: 'Rarity', toggleable: true },
  { accessor: 'qty', label: 'Quantity owned', toggleable: true },
  { accessor: 'buyCash', label: 'F2F buy price (cash)', toggleable: true },
  { accessor: 'buyCredit', label: 'F2F buy price (credit)', toggleable: true },
  { accessor: 'retail', label: 'F2F sell price', toggleable: true },
  { accessor: 'pctCash', label: '% cash', toggleable: true },
  { accessor: 'pctCredit', label: '% credit', toggleable: true },
  { accessor: 'stock', label: 'F2F stock', toggleable: true },
  { accessor: 'marketUsd', label: 'Market price (USD)', toggleable: true },
  { accessor: 'lineCash', label: 'Total cash (× qty)', toggleable: true },
  { accessor: 'lineCredit', label: 'Total credit (× qty)', toggleable: true },
  { accessor: 'links', label: 'Links', toggleable: true },
];

/** Shrinks a column to its content (the Card column takes the remaining width). */
const tight = { noWrap: true, width: '1%' } as const;

export function buildColumns(hidden: ReadonlySet<string> = new Set()): DataTableColumn<Item>[] {
  const columns: DataTableColumn<Item>[] = [
    { accessor: 'category', title: '', ...tight, sortable: true, render: (i) => <CategoryIcon item={i} /> },
    { accessor: 'image', title: '', ...tight, render: (i) => <CardImage item={i} /> },
    {
      accessor: 'name',
      title: 'Card',
      sortable: true,
      render: (i) => (
        <Stack gap={0}>
          <Text size="sm" fw={500}>
            {i.name}
          </Text>
          <NameNoteLine item={i} />
        </Stack>
      ),
    },
    {
      accessor: 'set',
      title: 'Set',
      ...tight,
      sortable: true,
      render: (i) => (
        <Tooltip label={i.setName}>
          <Badge variant="default" radius="sm">
            {i.set.toUpperCase()}
          </Badge>
        </Tooltip>
      ),
    },
    { accessor: 'cn', title: '#', ...tight, sortable: true, render: (i) => <Text size="sm">{i.cn}</Text> },
    {
      accessor: 'finish',
      title: 'Finish',
      ...tight,
      sortable: true,
      render: (i) =>
        i.finish === 'nonFoil' ? (
          <Text size="sm" c="dimmed">
            Non-foil
          </Text>
        ) : (
          <Badge variant="gradient" gradient={{ from: 'grape', to: 'cyan' }} radius="sm" tt="none">
            {detailedFinish(i)}
          </Badge>
        ),
    },
    {
      accessor: 'rarity',
      title: 'Rarity',
      ...tight,
      sortable: true,
      render: (i) => (
        <Text size="sm" c={RARITY_COLOR[i.rarity] ?? 'gray'}>
          {rarityLabel(i.rarity)}
        </Text>
      ),
    },
    { accessor: 'qty', title: head('Qty', 'Copies you own (all conditions)'), ...tight, sortable: true, textAlign: 'right', render: (i) => num(i.qty) },
    {
      accessor: 'buyCash',
      title: head('Cash', "What F2F pays you per card, in cash (NM). Bulk cards use the wholesale bulk rate; cards F2F doesn't buy are $0."),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (i) => num(money(i.buyCash), CASH_COLOR[categoryOf(i) ?? 'buylist']),
    },
    {
      accessor: 'buyCredit',
      title: head('Credit', 'What F2F pays you per card in store credit (cash + bonus, see Settings)'),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (i) => num(money(i.buyCredit), CASH_COLOR[categoryOf(i) ?? 'buylist']),
    },
    { accessor: 'retail', title: head('F2F sells', "F2F's own NM selling price for this card"), ...tight, sortable: true, textAlign: 'right', render: (i) => num(money(i.retail)) },
    {
      accessor: 'pctCash',
      title: head('% cash', 'Cash buy price ÷ F2F sell price'),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (i) => (
        <Badge color={pctColor(pctOf(i, 'pctCash'))} variant="light" className="ti-num">
          {pct(pctOf(i, 'pctCash'))}
        </Badge>
      ),
    },
    {
      accessor: 'pctCredit',
      title: head('% credit', 'Credit buy price ÷ F2F sell price'),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (i) => (
        <Badge color={pctColor(pctOf(i, 'pctCredit'))} variant="light" className="ti-num">
          {pct(pctOf(i, 'pctCredit'))}
        </Badge>
      ),
    },
    { accessor: 'stock', title: head('Stock', 'NM copies F2F has in stock'), ...tight, sortable: true, textAlign: 'right', render: (i) => num(i.stock ?? '—', i.stock ? undefined : 'dimmed') },
    {
      accessor: 'marketUsd',
      title: head('Market US$', 'Moxfield market price (TCGplayer, USD) for this finish'),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (i) => num(moneyUsd(i.marketUsd), 'dimmed'),
    },
    {
      accessor: 'lineCash',
      title: head('Tot. cash', 'Cash × quantity owned'),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (i) => num(i.buyCash == null ? '—' : money(i.buyCash * i.qty)),
    },
    {
      accessor: 'lineCredit',
      title: head('Tot. credit', 'Credit × quantity owned'),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (i) => num(i.buyCredit == null ? '—' : money(i.buyCredit * i.qty)),
    },
    { accessor: 'links', title: 'Links', ...tight, render: (i) => <Links item={i} /> },
  ];
  return columns.map((c) => (hidden.has(String(c.accessor)) && COLUMN_META.find((m) => m.accessor === c.accessor)?.toggleable ? { ...c, hidden: true } : c));
}
