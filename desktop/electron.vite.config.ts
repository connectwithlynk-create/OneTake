import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `index` is the main process; `analyzer` is the utilityProcess
        // child that runs the heavy analysis pipeline off the main thread.
        input: {
          index: 'src/main/index.ts',
          analyzer: 'src/analyzer/index.ts',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
