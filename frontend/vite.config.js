import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../public_react',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        graphics: resolve(__dirname, 'graphics.html'),
        backstage: resolve(__dirname, 'backstage.html'),
        remote: resolve(__dirname, 'remote.html'),
        pad: resolve(__dirname, 'pad.html')
      }
    }
  }
})
