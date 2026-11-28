// Dedicated pre-import setup module for Firebase App Check development debug mode.
// Must be imported BEFORE `firebase/app-check` so `self.FIREBASE_APPCHECK_DEBUG_TOKEN`
// is assigned before App Check SDK initialization executes.
// Has zero imports to avoid circular dependencies or duplicate Firebase initialization.

export interface AppCheckDevSetupState {
  isDevMode: boolean;
  mode: string;
  debugModeActive: boolean;
  tokenMode: 'auto-generated' | 'env-configured' | 'disabled';
  assignedBeforeSdkInit: boolean;
}

const IS_DEV_MODE = import.meta.env ? Boolean(import.meta.env.DEV) : false;
const RUNTIME_MODE =
  import.meta.env && typeof import.meta.env.MODE === 'string'
    ? import.meta.env.MODE
    : IS_DEV_MODE
      ? 'development'
      : 'production';

let debugModeActive = false;
let tokenMode: AppCheckDevSetupState['tokenMode'] = 'disabled';
let assignedBeforeSdkInit = false;

if (typeof window !== 'undefined') {
  if (IS_DEV_MODE) {
    const rawEnvDebugToken = String(
      (import.meta.env ? import.meta.env.VITE_APPCHECK_DEBUG_TOKEN : '') ?? ''
    )
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();

    const debugTokenSetting: string | boolean = rawEnvDebugToken || true;
    (
      self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }
    ).FIREBASE_APPCHECK_DEBUG_TOKEN = debugTokenSetting;

    debugModeActive = true;
    tokenMode =
      typeof debugTokenSetting === 'string' ? 'env-configured' : 'auto-generated';
    assignedBeforeSdkInit = true;

    console.info(
      `[Nimo] App Check pre-init setup: DEV=${IS_DEV_MODE}, MODE="${RUNTIME_MODE}", debugMode=true (${
        tokenMode === 'auto-generated'
          ? 'self.FIREBASE_APPCHECK_DEBUG_TOKEN = true'
          : 'VITE_APPCHECK_DEBUG_TOKEN configured'
      }).`
    );
  } else {
    console.info(
      `[Nimo] App Check pre-init setup: production mode active (MODE="${RUNTIME_MODE}", debugMode=false).`
    );
  }
}

export const appCheckDevSetupState: AppCheckDevSetupState = {
  isDevMode: IS_DEV_MODE,
  mode: RUNTIME_MODE,
  debugModeActive,
  tokenMode,
  assignedBeforeSdkInit,
};
