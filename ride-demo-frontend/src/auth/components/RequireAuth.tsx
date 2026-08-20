import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from '../hooks/useAuth.ts';

/**
 * Authentication only — no role checks. Authorization is a separate concern and
 * the backend's role model (`authorize({ roles })`) is not modelled here yet.
 *
 * Renders nothing while the session is being restored, so a reload on a
 * protected route cannot flash the login page before the refresh call lands.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'initializing') return null;

  if (status === 'anonymous') {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
