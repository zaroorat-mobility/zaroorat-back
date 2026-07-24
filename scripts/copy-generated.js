/**
 * Copy the generated Prisma client into dist/.
 *
 * The client is emitted to src/generated/prisma as plain .js + .d.ts. `tsc`
 * only compiles .ts, so it silently leaves those files behind and the compiled
 * output dies at runtime with:
 *
 *   Cannot find module '../../generated/prisma'
 *
 * Nothing catches this at build time — tsc and tsc-alias both exit 0 — so the
 * copy has to be an explicit build step.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src', 'generated');
const destination = path.join(root, 'dist', 'generated');

if (!fs.existsSync(source)) {
  console.error(
    `Generated Prisma client not found at ${path.relative(root, source)}.\n` +
      `Run "npm run prisma:generate" before building.`,
  );
  process.exit(1);
}

fs.cpSync(source, destination, { recursive: true });

console.log(`Copied ${path.relative(root, source)} -> ${path.relative(root, destination)}`);
