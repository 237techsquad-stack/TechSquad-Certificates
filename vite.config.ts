import { defineConfig, loadEnv } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import { nitro } from 'nitro/vite'

import viteReact from '@vitejs/plugin-react'

const config = defineConfig(({ mode }) => {
  const serverEnvironment = loadEnv(mode, process.cwd(), [
    'MONGODB_URI',
    'MONGODB_DATABASE_NAME',
    'AUTH_SESSION_KEY',
    'APP_ORIGIN',
  ])

  for (const name of [
    'MONGODB_URI',
    'MONGODB_DATABASE_NAME',
    'AUTH_SESSION_KEY',
    'APP_ORIGIN',
  ] as const) {
    if (serverEnvironment[name] !== undefined) {
      process.env[name] = serverEnvironment[name]
    }
  }

  const configuredDatabaseName =
    serverEnvironment.MONGODB_DATABASE_NAME?.trim()
  if (configuredDatabaseName) {
    process.env.MONGODB_DATABASE_NAME = configuredDatabaseName
  }

  return {
    resolve: { tsconfigPaths: true },
    plugins: [tanstackStart(), nitro(), viteReact()],
  }
})

export default config
