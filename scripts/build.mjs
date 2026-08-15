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
  build({
    entryPoints: ['src/renderer/app.tsx'],
    outfile: 'dist/renderer/renderer.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome110',
    sourcemap: true,
  }),
]);

await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');
await cp('build/icon.png', 'dist/renderer/logo.png');
await cp('node_modules/@fontsource-variable/noto-sans-sc/index.css', 'dist/renderer/noto-sans-sc.css');
await cp('node_modules/@fontsource-variable/noto-sans-sc/files', 'dist/renderer/files', { recursive: true });
await cp('node_modules/@fontsource-variable/noto-sans-sc/LICENSE', 'dist/renderer/Noto-Sans-SC-LICENSE.txt');
