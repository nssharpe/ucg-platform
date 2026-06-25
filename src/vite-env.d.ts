/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_APP_VERSION?: string;
  // DEV-ONLY seeded test-user credentials (see .env.example, src/lib/dev-auth.ts).
  // Present only in local .env.local; absent in CI/production builds.
  readonly VITE_DEV_AUTH_ATHLETE_EMAIL?: string;
  readonly VITE_DEV_AUTH_ATHLETE_PASSWORD?: string;
  readonly VITE_DEV_AUTH_MANAGER_EMAIL?: string;
  readonly VITE_DEV_AUTH_MANAGER_PASSWORD?: string;
  readonly VITE_DEV_AUTH_ADMIN_EMAIL?: string;
  readonly VITE_DEV_AUTH_ADMIN_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
