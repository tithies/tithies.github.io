import { Group, NumberInput, Text, type MantineSize } from '@mantine/core';
import type { DataTablePaginationRenderContext } from 'mantine-datatable';
import { useState } from 'react';

/** Page buttons Mantine shows at most (first, last, the current one, a sibling on each side, two gaps). */
const BUTTONS = 7;

/** A page number to type: the buttons only reach the pages around the current one. */
function PageJump({ page, totalPages, setPage, size }: { page: number; totalPages: number; setPage: (p: number) => void; size: MantineSize }) {
  const [value, setValue] = useState<string | number>('');
  const go = () => {
    const p = Math.round(Number(value));
    if (value !== '' && Number.isFinite(p)) setPage(Math.min(totalPages, Math.max(1, p)));
    setValue('');
  };
  return (
    <Group gap={6} wrap="nowrap">
      <Text size={size} c="dimmed">
        Page
      </Text>
      <NumberInput
        size={size}
        w={64}
        min={1}
        max={totalPages}
        allowDecimal={false}
        allowNegative={false}
        hideControls
        placeholder={String(page)}
        value={value}
        onChange={setValue}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go();
        }}
        onBlur={go}
        aria-label={`Go to page (1 to ${totalPages})`}
      />
      <Text size={size} c="dimmed" className="ti-num" style={{ whiteSpace: 'nowrap' }}>
        of {totalPages}
      </Text>
    </Group>
  );
}

/**
 * Every paged table's footer: the rows shown, the page size, a page number to type (when the
 * buttons can't show every page), and the page buttons. Pass as `renderPagination`.
 */
export function renderPagination({ state, actions, Controls }: DataTablePaginationRenderContext) {
  return (
    <>
      <Controls.Text />
      <Controls.PageSizeSelector />
      {state.totalPages > BUTTONS && <PageJump page={state.page} totalPages={state.totalPages} setPage={actions.setPage} size={state.paginationSize} />}
      <Controls.Pagination />
    </>
  );
}
