import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` keeps asset URLs relative so the build works on GitHub Pages
// project sites (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  plugins: [react()],
  // The wa-sqlite worker is an ES module worker ({ type: 'module' }).
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
