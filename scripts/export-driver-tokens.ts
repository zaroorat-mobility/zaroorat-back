import { writeFileSync } from 'node:fs';
import { lightTokens, darkTokens } from './_tokens/defaults.js';
import { defaultComponents } from './_tokens/components.js';
import { stringsEn } from './_tokens/strings/en.js';

writeFileSync(
  '/tmp/zar-tokens.json',
  JSON.stringify({ lightTokens, darkTokens, defaultComponents, stringsEn }, null, 2),
);
console.log('ok keys', Object.keys(lightTokens), 'strings', Object.keys(stringsEn).length);
