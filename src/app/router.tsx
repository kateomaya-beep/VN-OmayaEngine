import { createHashRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { ErrorScreen } from './ErrorScreen';
import { LibraryPage } from '../modules/library/LibraryPage';
import { ConstructorPage } from '../modules/constructor/ConstructorPage';
import { PlayerPage } from '../modules/player/PlayerPage';

export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <ErrorScreen />,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'project/:projectId', element: <ConstructorPage /> },
    ],
  },
  // Player runs full-screen without the app chrome.
  { path: '/play/:projectId', element: <PlayerPage />, errorElement: <ErrorScreen /> },
]);
