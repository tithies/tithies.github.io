import { ActionIcon, Badge, Button, Group, Menu, Modal, Paper, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconDeviceFloppy, IconDots, IconPencil, IconTrash } from '@tabler/icons-react';
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

function SaveModal({ state, opened, onClose, save }: { state: ComparisonState; opened: boolean; onClose: () => void; save: Props['save'] }) {
  const [mode, setMode] = useState<'new' | 'overwrite'>('new');
  const [name, setName] = useState('');
  const [overwriteId, setOverwriteId] = useState<string | null>(state.loadedPresetId);
  const [error, setError] = useState<string | null>(null);
  const nameError = mode === 'new' && name.trim() ? presetNameError(state, name) : null;
  const canSave = mode === 'new' ? !!name.trim() && !nameError : !!overwriteId;
  const submit = () => {
    if (!canSave) return;
    if (attempt(() => save(mode === 'new' ? { name } : { overwriteId: overwriteId! }), setError)) onClose();
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Save the current options" centered>
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
          {state.presets.length > 0 && (
            <SegmentedControl
              value={mode}
              onChange={(v) => setMode(v as 'new' | 'overwrite')}
              data={[
                { value: 'new', label: 'New preset' },
                { value: 'overwrite', label: 'Overwrite a preset' },
              ]}
            />
          )}
          {mode === 'new' ? (
            <TextInput
              label="Name"
              placeholder="e.g. Commander decks only"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              maxLength={PRESET_NAME_MAX}
              error={nameError}
              data-autofocus
            />
          ) : (
            <Select
              label="Preset to overwrite"
              data={state.presets.map((p) => ({ value: p.id, label: p.name }))}
              value={overwriteId}
              onChange={setOverwriteId}
              allowDeselect={false}
            />
          )}
          {error && (
            <Text size="sm" c="red">
              {error}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} leftSection={<IconDeviceFloppy size={16} />}>
              {mode === 'new' ? 'Save' : 'Overwrite'}
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
 * they change, but a preset only changes when it is saved over.
 */
export function PresetBar({ state, load, save, rename, remove }: Props) {
  const [saving, setSaving] = useState(false);
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
        <Button variant="light" leftSection={<IconDeviceFloppy size={16} />} onClick={() => setSaving(true)}>
          Save
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
              ? `Your changes are kept here, but “${current.name}” only changes when you save over it.`
              : `The options below are those of “${current.name}”.`
            : 'Save the options below under a name to switch back to them later.'}
        </Text>
      </Group>

      {saving && <SaveModal state={state} opened onClose={() => setSaving(false)} save={save} />}
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
                setSwitchTo(null);
                setSaving(true);
              }}
            >
              Save first
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
