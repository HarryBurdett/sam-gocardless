/**
 * Vite config for the GoCardless plugin frontend.
 *
 * Produces a UMD bundle that registers the entry component on
 * `window.__SAM_APPS__['gocardless']`. SAM's AppLoader (in
 * `packages/frontend/src/plugins/AppLoader.tsx`) injects a `<script>`
 * pointing at /api/apps/gocardless/static/index.js — that's the file
 * this build produces.
 *
 * React + ReactDOM are externals: the SAM host page already provides
 * them on `window.__SAM_SHARED__`. We don't bundle a second copy.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'GoCardlessApp',
      formats: ['umd'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: {
        globals: {
          react: '__SAM_SHARED__.react',
          'react-dom': '__SAM_SHARED__.reactDom',
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    minify: 'esbuild',
  },
});
