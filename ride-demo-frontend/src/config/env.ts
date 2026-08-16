/**
 * Typed access to the client-visible Vite environment.
 *
 * Everything here ships in the JS bundle. Never put a secret in a VITE_* var.
 */

function required(name: 'VITE_API_BASE_URL' | 'VITE_SOCKET_URL'): string {
  const value = import.meta.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value.replace(/\/+$/, '');
}

export const env = {
  apiBaseUrl: required('VITE_API_BASE_URL'),
  socketUrl: required('VITE_SOCKET_URL'),
  /** Vite's build-mode flag. The only place the app reads it. */
  isDev: import.meta.env.DEV,
} as const;
