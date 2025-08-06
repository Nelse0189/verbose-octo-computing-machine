/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BROWSERBASE_API_KEY: string
  readonly VITE_BROWSERBASE_PROJECT_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

