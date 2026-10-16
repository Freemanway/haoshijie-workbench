import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 前端直接引用共享包源码（风控、地址拆分），与后端同一套规则
    alias: { '@hsj/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
