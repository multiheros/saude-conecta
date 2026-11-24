import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({ root: import.meta.dirname, base: '/painel/', plugins: [react()], build: { outDir: '../dist/gestor/painel', emptyOutDir: true, assetsInlineLimit: 0 } });
