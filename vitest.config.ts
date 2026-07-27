import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      'electron-log/main': resolve(__dirname, 'tests/stubs/electron-log.ts'),
      electron: resolve(__dirname, 'tests/stubs/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
