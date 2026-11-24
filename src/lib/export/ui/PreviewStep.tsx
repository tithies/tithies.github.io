import { Alert, Badge, List, ScrollArea, SimpleGrid, Stack, Table, Tabs, Text } from '@mantine/core';
import { IconAlertTriangle, IconEye, IconInfoCircle } from '@tabler/icons-react';
import { finishLabel } from '@/lib/format';
import { langLabel } from '@/lib/cards/languages';
import type { SiteProvider } from '@/lib/sites/provider';
import { Stat } from '@/lib/ui/Stat';
import type { DeckPlan, ExportPlan } from '../types';

const n = (v: number) => v.toLocaleString('en-CA');
export const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** About how long the requests take at the site's pace. */
export function estimate(site: SiteProvider, requests: number): string {
  const s = Math.round((requests * (site.pacing.intervalMs + site.pacing.jitterMs / 2)) / 1000);
  return s < 60 ? `about ${Math.max(5, s)} seconds` : `about ${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'}`;
}

/** One target of the preview: its plan, the account's name, and where it is in the list. */
export interface PreviewTarget {
  /** Its number in the target list (1-based). */
  number: number;
  plan: ExportPlan;
  name: string;
  /** An export to the same account runs before it: this one's counts were read before that export. */
  after?: string;
}

/** The decks a deck export writes into: new ones, the ones it adds to, those too big. */
function DecksTable({ decks }: { decks: DeckPlan[] }) {
  return (
    <ScrollArea.Autosize mah={260}>
      <Table fz="xs" verticalSpacing={2} striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Deck</Table.Th>
            <Table.Th ta="right">Added</Table.Th>
            <Table.Th ta="right">Cards now → after</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {decks.map((d) => (
            <Table.Tr key={d.name}>
              <Table.Td c={d.over ? 'red' : undefined}>{d.name}</Table.Td>
              <Table.Td ta="right" className="ti-num">
                {n(d.copies)}
              </Table.Td>
              <Table.Td ta="right" className="ti-num" c={d.over ? 'red' : undefined}>
                {n(d.before)} → {n(d.after)}
              </Table.Td>
              <Table.Td>
                {d.over ? (
                  <Badge size="xs" color="red" variant="light">
                    Too big
                  </Badge>
                ) : (
                  <Badge size="xs" color={d.existing ? 'gray' : 'teal'} variant="light">
                    {d.existing ? 'Already there' : 'New'}
                  </Badge>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea.Autosize>
  );
}

/** What would change for one target, read live. */
export function PreviewStep({ site, plan, name }: { site: SiteProvider; plan: ExportPlan; name: string }) {
  const removeCount = plan.remove.entries.length;
  const decks = plan.decks;
  const created = decks?.filter((d) => !d.existing).length ?? 0;
  return (
    <Stack>
      <Alert color="blue" variant="light" icon={<IconEye size={18} />} p="xs">
        <b>Preview only.</b> Nothing has been changed on {site.label} yet, and nothing will be until you confirm on the next step.
      </Alert>
      {plan.blocked && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
          {plan.blocked}
        </Alert>
      )}
      {plan.warnings.map((w, i) => (
        <Alert
          key={i}
          color={w.level === 'danger' ? 'red' : w.level === 'warning' ? 'yellow' : 'blue'}
          variant="light"
          icon={w.level === 'info' ? <IconInfoCircle size={18} /> : <IconAlertTriangle size={18} />}
          p="xs"
        >
          {w.text}
        </Alert>
      ))}
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Stat
          label="Would be deleted"
          value={removeCount ? plural(plan.remove.copies, 'copy', 'copies') : 'Nothing'}
          color={removeCount ? 'red' : undefined}
          lines={[removeCount ? plural(removeCount, 'entry', 'entries') : 'Nothing would be deleted']}
        />
        <Stat label="Would be added" value={plural(plan.add.copies, 'copy', 'copies')} color="teal" lines={[plural(plan.add.prints, 'print'), ...(decks ? ['In the mainboard'] : [])]} />
        {decks && decks.length > 1 ? (
          <Stat label="Decks" value={`${n(created)} new`} lines={[`${plural(decks.length - created, 'deck')} already there`, `Copies in them: ${n(plan.before)} → ${n(plan.after)}`]} />
        ) : (
          <Stat label={`In ${plan.targetLabel}`} value={`${n(plan.before)} → ${n(plan.after)}`} lines={['Copies now → after the export']} />
        )}
      </SimpleGrid>
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          If you confirm, Tithies will, in order:
        </Text>
        <List type="ordered" size="sm" spacing={2}>
          {plan.steps.map((s, i) => (
            <List.Item key={i}>{s}</List.Item>
          ))}
        </List>
        <Text size="xs" c="dimmed">
          That would be {plural(plan.writes, 'change')} sent to {name} on {site.label} and about {plural(plan.reads, 'read')}, {estimate(site, plan.writes + plan.reads)}.
          Every change it sends will be kept in the Change log, exactly as sent.
        </Text>
      </Stack>
      <Tabs defaultValue={removeCount ? 'removed' : decks && decks.length > 1 ? 'decks' : 'added'} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="added">To add ({n(plan.items.length)})</Tabs.Tab>
          {decks && decks.length > 1 && (
            <Tabs.Tab value="decks" color={decks.some((d) => d.over) ? 'red' : undefined}>
              Decks ({n(decks.length)})
            </Tabs.Tab>
          )}
          <Tabs.Tab value="removed" disabled={!removeCount} color="red">
            To delete ({n(removeCount)})
          </Tabs.Tab>
        </Tabs.List>
        {decks && decks.length > 1 && (
          <Tabs.Panel value="decks" pt="xs">
            <DecksTable decks={decks} />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="added" pt="xs">
          <ScrollArea.Autosize mah={260}>
            <Table fz="xs" verticalSpacing={2} striped>
              <Table.Tbody>
                {plan.items.map((i) => (
                  <Table.Tr key={i.key}>
                    <Table.Td className="ti-num" w={50}>
                      ×{i.qty}
                    </Table.Td>
                    <Table.Td>{i.name}</Table.Td>
                    <Table.Td>
                      {i.set.toUpperCase()} #{i.cn} · {finishLabel(i.finish)}
                    </Table.Td>
                    <Table.Td c="dimmed">{langLabel(i.lang)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Tabs.Panel>
        <Tabs.Panel value="removed" pt="xs">
          <ScrollArea.Autosize mah={260}>
            <Table fz="xs" verticalSpacing={2} striped>
              <Table.Tbody>
                {plan.remove.entries.slice(0, 2000).map((e) => (
                  <Table.Tr key={e.entryId}>
                    <Table.Td className="ti-num" w={50}>
                      ×{e.qty}
                    </Table.Td>
                    <Table.Td>{e.name}</Table.Td>
                    <Table.Td>
                      {e.set.toUpperCase()} #{e.cn} · {finishLabel(e.finish)}
                    </Table.Td>
                    <Table.Td c="dimmed">
                      {e.lang.toUpperCase()} · {e.condition}
                      {e.isProxy ? ' · proxy' : ''}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {removeCount > 2000 && (
              <Text size="xs" c="dimmed">
                …and {n(removeCount - 2000)} more.
              </Text>
            )}
          </ScrollArea.Autosize>
          <Text size="xs" c="dimmed" mt={4}>
            If the export runs, the Change log will keep every deleted entry, with a CSV to import them back on {site.label}.
          </Text>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

/** A target's name in the tabs and the run order: "the binder “Trade”" (plus whose, with several accounts). */
export const targetTitle = (t: Pick<PreviewTarget, 'plan' | 'name'>, accounts: number): string =>
  t.plan.target.kind === 'collection' || accounts <= 1 ? t.plan.targetLabel : `${t.plan.targetLabel} of ${t.name}`;

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The preview of several targets: what they add up to, then one tab per target with its own
 * preview (red when it would delete cards or can't be exported).
 */
export function PreviewTabs({ site, targets }: { site: SiteProvider; targets: PreviewTarget[] }) {
  const accounts = new Set(targets.map((t) => t.plan.target.accountKey)).size;
  const writes = targets.reduce((s, t) => s + t.plan.writes, 0);
  const reads = targets.reduce((s, t) => s + t.plan.reads, 0);
  return (
    <Stack>
      <Text size="sm">
        {plural(targets.length, 'export')}, one after another, each on its own (its own row in the Change log, its own check): {plural(writes, 'change')} sent and
        about {plural(reads, 'read')} in all, {estimate(site, writes + reads)}.
      </Text>
      <Tabs defaultValue={String(targets[0].number)} keepMounted={false}>
        <Tabs.List>
          {targets.map((t) => {
            const bad = !!t.plan.blocked || t.plan.remove.entries.length > 0;
            return (
              <Tabs.Tab key={t.number} value={String(t.number)} color={bad ? 'red' : undefined} leftSection={bad ? <IconAlertTriangle size={14} color="var(--mantine-color-red-6)" /> : undefined}>
                {t.number}. {capitalize(targetTitle(t, accounts))}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
        {targets.map((t) => (
          <Tabs.Panel key={t.number} value={String(t.number)} pt="sm">
            <Stack>
              {t.after && (
                <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} p="xs">
                  This export runs after the export to {t.after}, on the same account: the counts here were read before it. Tithies reads them again when this export
                  starts.
                </Alert>
              )}
              <PreviewStep site={site} plan={t.plan} name={t.name} />
            </Stack>
          </Tabs.Panel>
        ))}
      </Tabs>
    </Stack>
  );
}
