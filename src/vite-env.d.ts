/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional baked-in private key (64-char hex) for an unattended self-hosted
   * kiosk. When set at build time, the game boots straight into a local
   * signing identity (see createKioskSession) instead of requiring an
   * interactive "Sign in with Signet" that lands auth-only. Leave unset for
   * normal/production builds.
   */
  readonly VITE_PALLASITE_KIOSK_NSEC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
