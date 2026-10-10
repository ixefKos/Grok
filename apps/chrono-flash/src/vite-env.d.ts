/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GIT_SHA?: string
  readonly VITE_SOFT_UNLOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
