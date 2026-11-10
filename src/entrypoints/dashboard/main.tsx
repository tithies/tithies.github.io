import '@mantine/core/styles.css';
import 'mantine-datatable/styles.css';
import './dashboard.css';
import { Badge, createTheme, MantineProvider } from '@mantine/core';
import ReactDOM from 'react-dom/client';
import { createHashRouter, Navigate, RouterProvider } from 'react-router';
import { Layout } from './Layout';
import { RunsPage } from '@/features/f2f-buylist/ui/RunsPage';
import { RunDetailPage } from '@/features/f2f-buylist/ui/RunDetailPage';
import { SettingsPage } from '@/features/f2f-buylist/ui/SettingsPage';
import { MismatchPage } from '@/features/deck-mismatch/ui/MismatchPage';

const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  components: {
    // Badges must always show their full text (Mantine truncates with "…" when space is tight).
    Badge: Badge.extend({
      styles: {
        root: { overflow: 'visible', flexShrink: 0, maxWidth: 'none' },
        label: { overflow: 'visible', textOverflow: 'clip' },
      },
    }),
  },
});

const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/f2f/runs" replace /> },
      { path: 'f2f/runs', element: <RunsPage /> },
      { path: 'f2f/runs/:runId', element: <RunDetailPage /> },
      { path: 'f2f/settings', element: <SettingsPage /> },
      { path: 'decks/mismatches', element: <MismatchPage /> },
      { path: '*', element: <Navigate to="/f2f/runs" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    <RouterProvider router={router} />
  </MantineProvider>,
);
