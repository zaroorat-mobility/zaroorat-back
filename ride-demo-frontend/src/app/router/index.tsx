import { LoginPage, OtpVerificationPage, RequireAuth } from '../../auth/index.ts';
import { AppLayout } from '../../layouts/AppLayout.tsx';
import { DebugPage } from '../../pages/DebugPage.tsx';
import { NotFoundPage } from '../../pages/NotFoundPage.tsx';
import { PlaceholderPage } from '../../pages/PlaceholderPage.tsx';
import { UserProfilePage } from '../../user/index.ts';

/**
 * Sidebar metadata. `protected` drives both the nav badge and the route table
 * below, so the two cannot drift apart.
 */
export const navigation = [
  { path: '/', label: 'Dashboard', protected: false },
  { path: '/auth', label: 'Authentication', protected: false },
  { path: '/profile', label: 'Profile', protected: true },
  { path: '/passenger', label: 'Passenger', protected: true },
  { path: '/driver', label: 'Driver', protected: true },
  { path: '/rides', label: 'Rides', protected: true },
  { path: '/debug', label: 'Debug', protected: false },
] as const;

/** Protected routes still awaiting their own module. */
const protectedPlaceholders = navigation.filter(
  (item) => item.protected && item.path !== '/profile',
);

export const routes = [
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <PlaceholderPage title="Dashboard" /> },
      { path: '/auth', element: <LoginPage /> },
      { path: '/auth/otp', element: <OtpVerificationPage /> },
      { path: '/debug', element: <DebugPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: '/profile', element: <UserProfilePage /> },
          ...protectedPlaceholders.map(({ path, label }) => ({
            path,
            element: <PlaceholderPage title={label} />,
          })),
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
