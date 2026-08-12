import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = join(process.cwd(), 'src');

const REGISTRATION =
  /^\s{2,}([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(?:asClass|asFunction|asValue|aliasTo)\(/gm;
const AS_CLASS = /asClass\(\s*([A-Z][a-zA-Z0-9]*)\s*\)/g;
const CTOR_PARAM = /(?:private|public|protected)\s+readonly\s+([a-zA-Z][a-zA-Z0-9]*)\s*:/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function collect(pattern: RegExp, source: string): string[] {
  const found: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}

const files = walk(SRC);
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

const registered = new Set<string>();
const diConstructed = new Set<string>();
for (const source of sources.values()) {
  for (const name of collect(REGISTRATION, source)) registered.add(name);
  for (const name of collect(AS_CLASS, source)) diConstructed.add(name);
}

const explicitlyInjected = new Map<string, Set<string>>();
for (const source of sources.values()) {
  const re =
    /asClass\(\s*([A-Z][a-zA-Z0-9]*)\s*\)[\s\S]{0,200}?\.inject\(\s*\([^)]*\)\s*=>\s*\(\{([\s\S]*?)\}\)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const [, className, body] = match;
    if (!className || !body) continue;
    const keys = new Set(collect(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm, body));
    explicitlyInjected.set(className, keys);
  }
}

function constructorParamsOf(className: string, source: string): string[] | null {
  const declaration = new RegExp(`export\\s+class\\s+${className}\\b`).exec(source);
  if (!declaration) return null;

  const body = source.slice(declaration.index);
  const ctor = /constructor\s*\(/.exec(body);
  if (!ctor) return [];

  let depth = 0;
  let end = ctor.index + ctor[0].length - 1;
  for (let i = end; i < body.length; i += 1) {
    if (body[i] === '(') depth += 1;
    else if (body[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return collect(CTOR_PARAM, body.slice(ctor.index, end));
}

describe('DI wiring (CLASSIC injection resolves by parameter name)', () => {
  it('found the registrations and the DI-constructed classes', () => {
    assert.ok(registered.size > 40, `expected many registrations, found ${registered.size}`);
    assert.ok(
      diConstructed.size > 40,
      `expected many asClass entries, found ${diConstructed.size}`,
    );
    assert.ok(registered.has('transactionManager'));
    assert.ok(diConstructed.has('LifecycleService'));
  });

  it('resolves every constructor parameter of every asClass-registered service', () => {
    const unresolvable: string[] = [];

    for (const className of diConstructed) {
      const injected = explicitlyInjected.get(className) ?? new Set<string>();

      for (const [file, source] of sources) {
        const params = constructorParamsOf(className, source);
        if (params === null) continue;

        for (const param of params) {
          if (registered.has(param) || injected.has(param)) continue;
          unresolvable.push(`${className} (${file.replace(process.cwd(), '.')}) → "${param}"`);
        }
        break;
      }
    }

    assert.deepEqual(
      unresolvable,
      [],
      `These constructor parameters match no container registration, so the\n` +
        `owning service throws AwilixResolutionError on first resolve:\n  ` +
        unresolvable.join('\n  '),
    );
  });
});
