import { ActionIcon, Badge, Button, Group, Menu, Modal, Paper, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconCopy, IconDeviceFloppy, IconDots, IconPencil, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { hasUnsavedOptions, isModified, loadedPreset, PRESET_NAME_MAX, presetNameError, type ComparisonState, type SaveTarget } from '../config';

interface Props {
  state: ComparisonState;
  load: (id: string) => void;
  save: (to: SaveTarget) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
}

/** Runs `fn`; a thrown Error becomes a message (the pure state functions validate names). */
function attempt(fn: () => void, setError: (e: string | null) => void): boolean {
  try {
    fn();
    setError(null);
    return true;
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** "Save as…": a new preset under a name; the name of an existing preset overwrites it (said on the button). */
function SaveAsModal({ state, onClose, save, onSaved }: { state: ComparisonState; onClose: () => void; save: Props['save']; onSaved?: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const existing = state.presets.find((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase()) ?? null;
  const nameError = trimmed && !existing ? presetNameError(state, name) : null;
  const canSave = !!trimmed && !nameError;
  const submit = () => {
    if (!canSave) return;
    if (attempt(() => save(existing ? { overwriteId: existing.id } : { name }), setError)) {
      onClose();
      onSaved?.();
    }
  };
  return (
    <Modal opened onClose={onClose} title="Save the options as a preset" centered>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack>
          <Text size="sm" c="dimmed">
            A preset keeps the decks and folders left out, the boards counted, the proxy option and which rows are shown.
          </Text>
          <TextInput
            label="Name"
            placeholder="e.g. Commander decks only"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={PRESET_NAME_MAX}
            error={nameError}
            description={existing ? `“${existing.name}” already exists: its options will be replaced by these.` : undefined}
            data-autofocus
          />
          {error && (
            <Text size="sm" c="red">
              {error}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} color={existing ? 'yellow' : undefined} leftSection={<IconDeviceFloppy size={16} />}>
              {existing ? `Overwrite “${existing.name}”` : 'Save as new preset'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function RenameModal({ state, id, onClose, rename }: { state: ComparisonState; id: string | null; onClose: () => void; rename: Props['rename'] }) {
  const preset = state.presets.find((p) => p.id === id);
  const [name, setName] = useState(preset?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const nameError = id && name.trim() ? presetNameError(state, name, id) : null;
  return (
    <Modal opened={!!preset} onClose={onClose} title="Rename the preset" centered>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (id && name.trim() && !nameError && attempt(() => rename(id, name), setError)) onClose();
        }}
      >
        <Stack>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={PRESET_NAME_MAX} error={nameError ?? error} data-autofocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || !!nameError}>
              Rename
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * Named presets of the page's options. Picking one changes the inputs; the inputs are saved as
 * they change, but a preset only changes on Save (into the loaded preset) or Save as (a new one,
 * or over the preset of that name).
 */
export function PresetBar({ state, load, save, rename, remove }: Props) {
  /** Save as is open; `then` runs once it saved (a switch waiting for it). */
  const [savingAs, setSavingAs] = useState<{ then?: () => void } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const current = loadedPreset(state);
  const modified = isModified(state);
  const pick = (id: string | null) => {
    if (!id || id === state.loadedPresetId) return;
    if (hasUnsavedOptions(state)) setSwitchTo(id);
    else load(id);
  };
  const deletingPreset = state.presets.find((p) => p.id === deleting);

  return (
    <Paper withBorder p="sm" radius="md">
      <Group gap="sm" wrap="wrap">
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          Preset
        </Text>
        <Select
          aria-label="Preset"
          placeholder={state.presets.length ? 'Unsaved options' : 'No preset saved yet'}
          data={state.presets.map((p) => ({ value: p.id, label: p.name }))}
          value={state.loadedPresetId}
          onChange={pick}
          disabled={!state.presets.length}
          allowDeselect={false}
          w={260}
          searchable={state.presets.length > 8}
        />
        {modified && (
          <Badge color="yellow" variant="light">
            Modified
          </Badge>
        )}
        <Tooltip
          label={current ? (modified ? `Save the changes into “${current.name}”` : `No changes since “${current.name}” was loaded`) : 'Save the options as a new preset'}
        >
          <Button
            variant="light"
            leftSection={<IconDeviceFloppy size={16} />}
            disabled={!!current && !modified}
            onClick={() => (current ? save({ overwriteId: current.id }) : setSavingAs({}))}
          >
            Save
          </Button>
        </Tooltip>
        <Button variant="default" leftSection={<IconCopy size={16} />} onClick={() => setSavingAs({})}>
          Save as…
        </Button>
        {current && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Preset actions">
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setRenaming(current.id)}>
                Rename “{current.name}”
              </Menu.Item>
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setDeleting(current.id)}>
                Delete “{current.name}”
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
        <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 200 }}>
          {current
            ? modified
              ? `Your changes are kept here, but “${current.name}” only changes when you click Save.`
              : `The options below are those of “${current.name}”.`
            : 'Save the options below under a name to switch back to them later.'}
        </Text>
      </Group>

      {savingAs && <SaveAsModal state={state} onClose={() => setSavingAs(null)} save={save} onSaved={savingAs.then} />}
      {renaming && <RenameModal state={state} id={renaming} onClose={() => setRenaming(null)} rename={rename} />}

      <Modal opened={!!deletingPreset} onClose={() => setDeleting(null)} title="Delete the preset?" centered>
        <Stack>
          <Text size="sm">
            “{deletingPreset?.name}” is deleted. The options shown now stay as they are.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              onClick={() => {
                if (deleting) remove(deleting);
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={!!switchTo} onClose={() => setSwitchTo(null)} title="Switch preset?" centered>
        <Stack>
          <Text size="sm">
            {current ? `You changed the options since “${current.name}” was loaded.` : "The options shown now aren't saved in a preset."} Switching replaces them
            with “{state.presets.find((p) => p.id === switchTo)?.name}”: save them first to keep them.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSwitchTo(null)}>
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={() => {
                const target = switchTo;
                setSwitchTo(null);
                if (!target) return;
                // Into the loaded preset, then switch; without one, Save as first.
                if (current) {
                  save({ overwriteId: current.id });
                  load(target);
                } else setSavingAs({ then: () => load(target) });
              }}
            >
              {current ? `Save into “${current.name}” and switch` : 'Save as… first'}
            </Button>
            <Button
              color="yellow"
              onClick={() => {
                if (switchTo) load(switchTo);
                setSwitchTo(null);
              }}
            >
              Switch
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
