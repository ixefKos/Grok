import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function resolveGitSha(): string {
  const fromEnv = (process.env.VITE_GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || '').trim()
  if (fromEnv) return fromEnv
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_GIT_SHA': JSON.stringify(resolveGitSha()),
  },
})
