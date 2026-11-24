import { Alert, Checkbox, List, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { SiteProvider } from '@/lib/sites/provider';
import type { ExportPlan } from '../types';
import { plural, targetTitle } from './PreviewStep';

/** One export to confirm, in the order they run. */
export interface ConfirmTarget {
  /** The draft's id (its typed confirmation) and its number in the list (1-based). */
  id: number;
  number: number;
  plan: ExportPlan;
  /** "alice" (the account's label), and its username (typed to replace its whole collection). */
  name: string;
  userName: string;
}

const destructive = (t: ConfirmTarget) => t.plan.remove.entries.length > 0;
/** What must be typed to confirm a target that deletes cards: the username (whole collection) or the binder's name. */
export const confirmWord = (t: ConfirmTarget) => (t.plan.remove.wholeCollection ? t.userName : (t.plan.binder?.name ?? ''));
/** Every destructive target has its word typed. */
export const typedAll = (targets: readonly ConfirmTarget[], typed: Readonly<Record<number, string>>) =>
  targets.every((t) => !destructive(t) || (typed[t.id] ?? '').trim() === confirmWord(t).trim());

/** "delete 30 copies, then add 117 copies to the binder “Trade”" */
function whatItDoes(t: ConfirmTarget, accounts: number): string {
  const p = t.plan;
  const del = destructive(t) ? `delete ${plural(p.remove.copies, 'copy', 'copies')}, then add ` : 'add ';
  return `${del}${plural(p.add.copies, 'copy', 'copies')} to ${targetTitle(t, accounts)}`;
}

export interface ConfirmStepProps {
  site: SiteProvider;
  /** In the order they run. */
  targets: ConfirmTarget[];
  /** The compared account's name, when a target is that account. */
  sameName: string | null;
  understood: boolean;
  setUnderstood: (v: boolean) => void;
  sameUnderstood: boolean;
  setSameUnderstood: (v: boolean) => void;
  typed: Readonly<Record<number, string>>;
  setTyped: (id: number, v: string) => void;
  startError: string | null;
}

/** The last check before changing anything: what each export will do, then the confirmations. */
export function ConfirmStep({ site, targets, sameName, understood, setUnderstood, sameUnderstood, setSameUnderstood, typed, setTyped, startError }: ConfirmStepProps) {
  const several = targets.length > 1;
  const anyDestructive = targets.some(destructive);
  const names = [...new Set(targets.map((t) => t.name))];
  const accounts = names.length;
  const onlyCollections = targets.every((t) => t.plan.target.kind === 'collection');
  const whose = names.length === 1 ? `${names[0]}'s` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}'s`;
  const scope = onlyCollections ? (names.length === 1 ? 'collection' : 'collections') : names.length === 1 ? 'binders and collection' : 'binders and collections';
  return (
    <Stack>
      <Alert color={anyDestructive ? 'red' : 'blue'} variant="light" icon={<IconAlertTriangle size={18} />} title="Nothing has been changed yet">
        {several ? (
          <Stack gap={6}>
            <Text size="sm">
              When you click the button below, Tithies will make these {targets.length} exports, one after another. Each one is its own export, with its own row in the
              Change log; if one fails, the others still run.
            </Text>
            <List type="ordered" size="sm" spacing={2}>
              {targets.map((t) => (
                <List.Item key={t.id}>
                  Target {t.number}: on <b>{t.name}</b>, {whatItDoes(t, accounts)}.
                </List.Item>
              ))}
            </List>
            <Text size="sm">{site.label} has no undo; the Change log will keep what is deleted, as a CSV to import back.</Text>
          </Stack>
        ) : (
          <Text size="sm">
            When you click the button below, Tithies will change <b>{targets[0].name}</b> on {site.label}: it will {whatItDoes(targets[0], 1)}.{' '}
            {site.label} has no undo; the Change log will keep what is deleted, as a CSV to import back.
          </Text>
        )}
      </Alert>
      <Checkbox
        checked={understood}
        onChange={(e) => setUnderstood(e.currentTarget.checked)}
        label={several ? `I understand that these exports will change ${whose} ${scope} on ${site.label}` : `I understand that this will change ${whose} ${scope} on ${site.label}`}
      />
      {sameName && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} title={`${sameName} is the account you're comparing`}>
          <Stack gap="xs">
            <Text size="sm">
              On {site.label}, the cards of a binder are cards of the collection. Exporting to this account would therefore change the very collection this page
              compares with your decks:
            </Text>
            <List size="sm" spacing={2}>
              <List.Item>cards “Missing from collection” you export would become owned: they wouldn't be missing any more;</List.Item>
              <List.Item>cards “Not in any deck” you export would be added once more: the collection would then have them twice;</List.Item>
              <List.Item>the next “Sync decks and collection” would show the collection as it is after the export.</List.Item>
            </List>
            <Checkbox checked={sameUnderstood} onChange={(e) => setSameUnderstood(e.currentTarget.checked)} label="I want to change the collection I'm comparing" />
          </Stack>
        </Alert>
      )}
      {targets.filter(destructive).map((t) => {
        const word = confirmWord(t);
        const v = typed[t.id] ?? '';
        const label = t.plan.remove.wholeCollection ? `Type the username ${word} to delete the whole collection` : `Type the binder name “${word}” to replace its cards`;
        return (
          <TextInput
            key={t.id}
            label={several ? `Target ${t.number}: ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label}
            value={v}
            onChange={(e) => setTyped(t.id, e.currentTarget.value)}
            error={v && v.trim() !== word.trim() ? "That's not it" : undefined}
          />
        );
      })}
      {startError && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
          {startError}
        </Alert>
      )}
    </Stack>
  );
}

