import { useEffect, useState } from 'react';

/** Fallback height of the AppShell header (see Layout.tsx), used if Mantine's CSS variable can't be read. */
const FALLBACK_APP_HEADER_HEIGHT = 56;

/**
 * The table header pins right below the AppShell header. Mantine publishes that height as a CSS
 * variable, but as an expression ("calc(3.5rem * 1)"), so let the browser resolve it on a probe.
 */
function appHeaderHeight(parent: HTMLElement): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(--app-shell-header-height, 0px)';
  parent.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px > 0 ? px : FALLBACK_APP_HEADER_HEIGHT;
}

/** Scroll-driven animations (Chrome 115+). Without them the header just scrolls away. */
const supported = () => typeof CSS !== 'undefined' && CSS.supports('animation-timeline', 'scroll()');

/**
 * Keeps a mantine-datatable's header visible while the page scrolls past the top of the table.
 *
 * Plain `position: sticky` can't do it: the table sits in its own horizontal scroll container,
 * and that container becomes the sticky reference. So the real `<thead>` is moved down by a CSS
 * scroll-driven animation (see `.ti-sticky-head` in dashboard.css): the browser ties its offset
 * to the page's scroll position, off the main thread, with no scroll handler and no lag. It stays
 * in the table, so column widths, horizontal scrolling and sort clicks keep working.
 *
 * The script only describes the animation's range, in page-scroll pixels: from the moment the
 * table's top reaches the app header to the moment the header would hit the last row. That range
 * changes with layout, not with scrolling, so it is recomputed on resize and when the table or
 * the page height changes.
 *
 * Attach the returned ref to an element that wraps the DataTable. It is a callback ref, so it also
 * works when the table only mounts after a loading state.
 */
export function useStickyTableHeader<T extends HTMLElement = HTMLDivElement>() {
  const [root, setRoot] = useState<T | null>(null);

  useEffect(() => {
    if (!root || !supported()) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const thead = root.querySelector<HTMLElement>('thead');
      const table = thead?.parentElement;
      if (!thead || !table) return;
      const room = Math.max(table.offsetHeight - thead.offsetHeight, 0);
      const from = Math.max(table.getBoundingClientRect().top + window.scrollY - appHeaderHeight(root), 0);
      root.style.setProperty('--ti-stick-from', `${Math.round(from)}px`);
      root.style.setProperty('--ti-stick-to', `${Math.round(from + room)}px`);
      root.style.setProperty('--ti-stick-room', `${room}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    root.classList.add('ti-sticky-head');
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    // The table itself, and the page: filters above the table can open or close and push it down.
    observer.observe(root);
    observer.observe(document.body);
    schedule();
    return () => {
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      root.classList.remove('ti-sticky-head');
      for (const v of ['from', 'to', 'room']) root.style.removeProperty(`--ti-stick-${v}`);
    };
  }, [root]);

  return setRoot;
}
