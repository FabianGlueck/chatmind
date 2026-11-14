// Desktop spec §1: bundle the main process, preload and settings window with esbuild, and lay out the
// staging folder electron-builder packs (build/app). The native modules are copied from the pnpm tree at
// the lockfile's versions; better-sqlite3 13 ships N-API prebuilds, which load in Electron unchanged.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.resolve(import.meta.dirname, '..');
const out = path.join(here, 'build', 'app');
const webDist = path.resolve(here, '..', 'web', 'dist');
const NATIVE = ['better-sqlite3', 'sqlite-vec'];

if (!existsSync(path.join(webDist, 'index.html'))) {
  console.error(`no web build at ${webDist} — run "pnpm --filter @chatmind/web build" first`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, logLevel: 'warning', sourcemap: 'linked', legalComments: 'none' };
await build({ ...common, entryPoints: [path.join(here, 'src', 'main.ts')], outfile: path.join(out, 'main.cjs'), platform: 'node', format: 'cjs', target: 'node24', external: ['electron', ...NATIVE] });
await build({ ...common, entryPoints: [path.join(here, 'src', 'settings', 'preload.ts')], outfile: path.join(out, 'preload.cjs'), platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
await build({ ...common, entryPoints: [path.join(here, 'src', 'settings', 'settings.ts')], outfile: path.join(out, 'settings.js'), platform: 'browser', format: 'iife', target: 'chrome140' });
cpSync(path.join(here, 'src', 'settings', 'settings.html'), path.join(out, 'settings.html'));
cpSync(webDist, path.join(out, 'web'), { recursive: true });

// The native modules and what they need at runtime, resolved the way @chatmind/index resolves them.
const indexDir = path.resolve(here, '..', '..', 'packages', 'index');
const versions = {};
function copyPackage(name, fromDir) {
  const dest = path.join(out, 'node_modules', name);
  if (existsSync(dest)) return;
  // Look up the package folder itself: sqlite-vec's platform packages have no main to resolve.
  const lookup = createRequire(path.join(fromDir, 'noop.js')).resolve.paths(name) ?? [];
  const found = lookup.map((p) => path.join(p, name)).find((d) => existsSync(path.join(d, 'package.json')));
  if (found === undefined) return; // an optional dependency for another platform
  const dir = realpathSync(found);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  versions[name] = pkg.version;
  // Sources and the Node-ABI build are not needed: the prebuilds are N-API.
  cpSync(dir, dest, { recursive: true, dereference: true, filter: (src) => !['build', 'deps', 'src'].includes(path.relative(dir, src)) });
  // node-addon-api is headers only, but electron-builder's dependency walk wants every declared dependency present.
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) copyPackage(dep, dir);
}
for (const name of NATIVE) copyPackage(name, indexDir);

const own = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
writeFileSync(path.join(out, 'package.json'), `${JSON.stringify({
  name: 'chatmind',
  productName: 'chatmind',
  version: own.version,
  description: 'Non-linear chat over an Obsidian vault',
  author: 'Fabian Glück',
  license: own.license,
  main: 'main.cjs',
  dependencies: Object.fromEntries(NATIVE.map((n) => [n, versions[n]])),
}, null, 2)}\n`);
console.log(`staged ${out} (${Object.entries(versions).map(([n, v]) => `${n}@${v}`).join(', ')})`);
