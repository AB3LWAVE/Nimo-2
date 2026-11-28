import firebaseConfig from '../../firebase-applet-config.json';
import { appCheck, appCheckStatus, getAppCheckError } from '../firebase';
import type { AppCheckStatus } from '../types';

export interface AppCheckDebugReport {
  timestamp: string;
  environment: {
    isDev: boolean;
    mode: string;
    hostname: string;
    origin: string;
    isDevOrPreviewHost: boolean;
  };
  appCheck: {
    initialized: boolean;
    status: AppCheckStatus;
    error: string | null;
  };
  debugTokens: {
    globalSelfToken: string | boolean | null;
    viteAppCheckDebugToken: string | null;
    viteFirebaseAppCheckDebugToken: string | null;
    localStorageToken: string | null;
  };
  recaptchaConfig: {
    viteRecaptchaEnterpriseKey: string | null;
    viteRecaptchaSiteKey: string | null;
    firebaseConfigRecaptchaSiteKey: string | null;
  };
  firebaseConfig: {
    projectId: string;
    appId: string;
    apiKey: string;
    authDomain: string;
    firestoreDatabaseId: string;
    storageBucket: string;
    messagingSenderId: string;
    measurementId: string;
    oAuthClientId: string;
    recaptchaSiteKey: string;
  };
  exchangeDebugTokenEndpoint: string;
  troubleshootingHints: string[];
}

function readCleanEnv(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^["']|["']$/g, '').trim();
  return cleaned || null;
}

function detectDevOrPreviewHost(hostname: string, isDev: boolean): boolean {
  return (
    isDev ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('ais-dev-') ||
    hostname === 'scf.usercontent.goog' ||
    hostname.endsWith('.scf.usercontent.goog') ||
    hostname === 'aistudio.google.com' ||
    hostname.endsWith('.aistudio.google.com')
  );
}

function readLocalStorageDebugToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('firebase-app-check-debug-token');
  } catch {
    return null;
  }
}

export function getAppCheckDebugReport(): AppCheckDebugReport {
  const env: Record<string, unknown> =
    typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env as unknown as Record<string, unknown>)
      : {};
  const isDev = Boolean(env.DEV);
  const mode = typeof env.MODE === 'string' ? env.MODE : 'unknown';
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'server';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'server';

  const globalSelfToken =
    typeof globalThis !== 'undefined'
      ? ((globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean })
          .FIREBASE_APPCHECK_DEBUG_TOKEN ?? null)
      : null;

  const currentError = getAppCheckError();

  return {
    timestamp: new Date().toISOString(),
    environment: {
      isDev,
      mode,
      hostname,
      origin,
      isDevOrPreviewHost: detectDevOrPreviewHost(hostname, isDev),
    },
    appCheck: {
      initialized: Boolean(appCheck),
      status: appCheckStatus,
      error: currentError,
    },
    debugTokens: {
      globalSelfToken,
      viteAppCheckDebugToken: readCleanEnv(env.VITE_APPCHECK_DEBUG_TOKEN),
      viteFirebaseAppCheckDebugToken: readCleanEnv(
        env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN
      ),
      localStorageToken: readLocalStorageDebugToken(),
    },
    recaptchaConfig: {
      viteRecaptchaEnterpriseKey: readCleanEnv(env.VITE_RECAPTCHA_ENTERPRISE_KEY),
      viteRecaptchaSiteKey: readCleanEnv(env.VITE_RECAPTCHA_SITE_KEY),
      firebaseConfigRecaptchaSiteKey: readCleanEnv(firebaseConfig.recaptchaSiteKey),
    },
    firebaseConfig: {
      projectId: firebaseConfig.projectId,
      appId: firebaseConfig.appId,
      apiKey: firebaseConfig.apiKey,
      authDomain: firebaseConfig.authDomain,
      firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
      storageBucket: firebaseConfig.storageBucket,
      messagingSenderId: firebaseConfig.messagingSenderId,
      measurementId: firebaseConfig.measurementId,
      oAuthClientId: firebaseConfig.oAuthClientId,
      recaptchaSiteKey: firebaseConfig.recaptchaSiteKey,
    },
    exchangeDebugTokenEndpoint: `https://content-firebaseappcheck.googleapis.com/v1/projects/${firebaseConfig.projectId}/apps/${firebaseConfig.appId}:exchangeDebugToken`,
    troubleshootingHints: [
      `Confirm the active debug token UUID is registered under Firebase Console -> App Check -> Apps -> ${firebaseConfig.appId} -> Manage debug tokens.`,
      `Check Google Cloud Console -> APIs & Services -> Credentials for API key "${firebaseConfig.apiKey}" (verify HTTP referrer allowlist includes "${origin}" and Firebase App Check API is permitted).`,
      `Verify Firebase App Check API (firebaseappcheck.googleapis.com) is enabled on project "${firebaseConfig.projectId}".`,
    ],
  };
}

/**
 * Prints the current environment's Firebase App Check status, detected debug tokens,
 * and exact Firebase app configuration to the browser console to diagnose 403 errors.
 */
export function logAppCheckDebugReport(): AppCheckDebugReport {
  const report = getAppCheckDebugReport();

  if (typeof console !== 'undefined') {
    const label = report.appCheck.error
      ? '[Nimo App Check Debug] 403 / Auth Diagnostic Report'
      : '[Nimo App Check Debug] Environment & Configuration Report';

    if (typeof console.groupCollapsed === 'function') {
      console.groupCollapsed(label);
    } else {
      console.info(label);
    }

    console.info('Environment:', report.environment);
    console.info('App Check Status:', report.appCheck);
    console.info('Detected Debug Tokens:', report.debugTokens);
    console.info('reCAPTCHA Configuration:', report.recaptchaConfig);
    console.info('Exact Firebase App Configuration:', report.firebaseConfig);
    console.info('Debug Exchange Endpoint:', report.exchangeDebugTokenEndpoint);

    if (report.appCheck.error) {
      console.warn('Detected App Check Error:', report.appCheck.error);
      console.info('403 Troubleshooting Checklist:', report.troubleshootingHints);
    }

    if (typeof console.groupEnd === 'function') {
      console.groupEnd();
    }
  }

  return report;
}

if (typeof window !== 'undefined') {
  (
    window as unknown as {
      __nimoAppCheckDebug?: () => AppCheckDebugReport;
    }
  ).__nimoAppCheckDebug = logAppCheckDebugReport;
}
