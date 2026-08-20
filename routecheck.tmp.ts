import { createApp } from './src/app/app.js';

async function main() {
  const app = await createApp();
  await app.ready();

  const spec = (await app.inject({ method: 'GET', url: '/docs/json' })).json();
  const documented = new Set<string>();
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(ops as object))
      documented.add(`${method.toUpperCase()} ${path}`);
  }

  // Fastify's own route table, normalised to the OpenAPI path style.
  const registered: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = line.match(/([\w/:*.-]+)\s+\((.+)\)/);
    if (!m) continue;
    const url = m[1]!.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/';
    for (const verb of m[2]!.split(',').map((v) => v.trim())) {
      if (verb === 'HEAD' || verb === 'OPTIONS') continue;
      registered.push(`${verb} ${url}`);
    }
  }

  const appRoutes = registered.filter((r) => !r.includes('/docs'));
  const missing = appRoutes.filter((r) => !documented.has(r));

  console.error('TOTAL_APP_ROUTES:', appRoutes.length);
  console.error('DOCUMENTED:', documented.size);
  console.error('MISSING_FROM_SWAGGER:', missing.length ? missing.join(', ') : 'none');
  console.error('--- SPEC PATHS ---');
  for (const p of Object.keys(spec.paths ?? {}).sort()) {
    const ops = spec.paths[p];
    console.error(
      ' ',
      Object.keys(ops)
        .map((m) => m.toUpperCase())
        .join(','),
      p,
      '| tags:',
      JSON.stringify(Object.values(ops)[0]?.tags),
      '| sec:',
      Object.values(ops)[0]?.security ? 'bearer' : '-',
    );
  }
  await app.close();
  process.exit(0);
}
main();
