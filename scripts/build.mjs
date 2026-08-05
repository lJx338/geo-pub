import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });

await Promise.all([
  build({
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: ['src/preload.ts'],
    outfile: 'dist/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: ['src/stealth-preload.ts'],
    outfile: 'dist/stealth-preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
]);

await cp('src/renderer', 'dist/renderer', { recursive: true });
await cp('build/icon.png', 'dist/renderer/logo.png');
