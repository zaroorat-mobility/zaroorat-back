// Runs an integration check against the real backend, through a Vite dev server
// so that import.meta.env is populated exactly as it is in the browser.
//
//   node checks/run.mjs api | auth | user
//
// The only thing stubbed is the browser (sessionStorage) — never the backend.
import { createServer } from 'vite';

const name = process.argv[2];
if (!['api', 'auth', 'user'].includes(name)) {
  console.error('usage: node checks/run.mjs <api|auth|user>');
  process.exit(2);
}

const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  await server.ssrLoadModule(`/checks/${name}`); // Vite resolves .ts / .tsx
} finally {
  await server.close();
}
