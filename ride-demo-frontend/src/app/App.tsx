import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { AppProviders } from './providers/AppProviders.tsx';
import { routes } from './router/index.tsx';

const router = createBrowserRouter(routes);

export function App() {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
