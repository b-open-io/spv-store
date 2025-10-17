#!/usr/bin/env bun
import { existsSync, rmSync } from 'fs';
import { $ } from 'bun';

// Clean dist directory
if (existsSync('./dist')) {
  rmSync('./dist', { recursive: true });
}

// Build CommonJS
await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'node',
  format: 'cjs',
  naming: 'index.cjs',
  external: ['@bsv/sdk', 'better-sqlite3'],
  minify: false,
  sourcemap: 'external',
});

// Build ESM (modern)
await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  naming: 'index.modern.js',
  external: ['@bsv/sdk', 'better-sqlite3'],
  minify: false,
  sourcemap: 'external',
});

// Build ESM (module)
await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  naming: 'index.module.js',
  external: ['@bsv/sdk', 'better-sqlite3'],
  minify: false,
  sourcemap: 'external',
});

// Build UMD (browser bundle with global)
await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'browser',
  format: 'iife',
  naming: 'index.umd.js',
  external: ['better-sqlite3'],
  minify: false,
  sourcemap: 'external',
  define: {
    'global': 'window',
  },
});

// Generate TypeScript declarations
await $`bunx tsc --emitDeclarationOnly --outDir ./dist`;

console.log('✅ Build complete!');
