import { defineConfig } from 'vite'
// @ts-expect-error plain ESM plugin, no types
import finish from './finish/vite-plugin.mjs'

export default defineConfig({
  server: { port: 3094, strictPort: true, host: 'localhost', watch: { ignored: ['**/.finish/**', '**/recordings/**'] } },
  plugins: [finish()],
})
