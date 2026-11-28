import firebaseConfig from '../../firebase-applet-config.json';
import { appCheckDevSetupState, type AppCheckDevSetupState } from '../appCheckDevSetup';
import { appCheck, appCheckStatus, getAppCheckError } from '../firebase';
import type { AppCheckStatus } from '../types';

export const APP_CHECK_IDB_NAME = 'firebase-app-check-database';
export const APP_CHECK_IDB_STORE = 'firebase-app-check-store';
export const APP_CHECK_IDB_DEBUG_KEY = 'debug-token';

export type AppCheckIndexedDbAccessStatus =
  | 'ok'
  | 'unavailable'
  | 'not-initialized-yet'
  | 'store-missing'
  | 'open-error'
  | 'read-error'
  | 'blocked'
  | 'timed-out';

export interface AppCheckIndexedDbDiagnostics {
  indexedDbAvailable: boolean;
  databaseName: string;
  storeName: string;
  accessStatus: AppCheckIndexedDbAccessStatus;
  databaseVersion: number | null;
  storeExists: boolean;
  debugTokenPresent: boolean;
  cachedAppCheckTokenPresent: boolean;
  errorMessage: string | null;
}

export interface AppCheckDebugReport {
  timestamp: string;
  environment: {
    isDev: boolean;
    mode: string;
    hostname: string;
    origin: string;
    isDevOrPreviewHost: boolean;
  };
  debugMode: {
    active: boolean;
    tokenMode: AppCheckDevSetupState['tokenMode'];
    assignedBeforeSdkInit: boolean;
    globalFlagConfigured: boolean;
    globalFlagType: 'boolean' | 'string' | 'unset';
  };
  appCheck: {
    initialized: boolean;
    status: AppCheckStatus;
    error: string | null;
  };
  indexedDb: AppCheckIndexedDbDiagnostics;
  recaptchaConfig: {
    enterpriseKeyConfigured: boolean;
    v3KeyConfigured: boolean;
    fallbackConfigKeyPresent: boolean;
  };
  firebaseApp: {
    projectId: string;
    appId: string;
    authDomain: string;
    firestoreDatabaseId: string;
  };
  troubleshootingHints: string[];
}

function readCleanEnvFlag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.trim().replace(/^["']|["']$/g, '').trim().length > 0;
}

function readGlobalDebugFlagInfo(): {
  configured: boolean;
  type: 'boolean' | 'string' | 'unset';
} {
  if (typeof globalThis === 'undefined') {
    return { configured: false, type: 'unset' };
  }
  const value = (
    globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }
  ).FIREBASE_APPCHECK_DEBUG_TOKEN;
  if (typeof value === 'boolean') {
    return { configured: value, type: 'boolean' };
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return { configured: true, type: 'string' };
  }
  return { configured: false, type: 'unset' };
}

/**
 * Safely inspects Firebase App Check's IndexedDB database (`firebase-app-check-database`)
 * without ever exposing or logging stored token values, and without creating an empty
 * schema if the Firebase SDK has not yet initialized the database.
 */
export function inspectAppCheckIndexedDb(
  appId: string,
  timeoutMs = 2000,
  idbFactory?: IDBFactory
): Promise<AppCheckIndexedDbDiagnostics> {
  const factory =
    idbFactory ??
    (typeof indexedDB !== 'undefined' ? indexedDB : undefined);

  if (!factory || typeof factory.open !== 'function') {
    return Promise.resolve({
      indexedDbAvailable: false,
      databaseName: APP_CHECK_IDB_NAME,
      storeName: APP_CHECK_IDB_STORE,
      accessStatus: 'unavailable',
      databaseVersion: null,
      storeExists: false,
      debugTokenPresent: false,
      cachedAppCheckTokenPresent: false,
      errorMessage: 'IndexedDB API is unavailable in this environment.',
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let notInitializedYet = false;
    let dbToClose: IDBDatabase | null = null;

    const finish = (result: AppCheckIndexedDbDiagnostics) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        dbToClose?.close();
      } catch {
        // Ignore close errors during diagnostic cleanup
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        indexedDbAvailable: true,
        databaseName: APP_CHECK_IDB_NAME,
        storeName: APP_CHECK_IDB_STORE,
        accessStatus: 'timed-out',
        databaseVersion: null,
        storeExists: false,
        debugTokenPresent: false,
        cachedAppCheckTokenPresent: false,
        errorMessage: `IndexedDB open timed out after ${timeoutMs}ms (storage may be blocked in this context).`,
      });
    }, timeoutMs);

    try {
      const openReq = factory.open(APP_CHECK_IDB_NAME, 1);

      openReq.onupgradeneeded = (event) => {
        // If oldVersion is 0, the database did not exist yet. Abort immediately so
        // diagnostics do not bump the DB version without creating Firebase's store.
        if ((event as IDBVersionChangeEvent).oldVersion === 0) {
          notInitializedYet = true;
          try {
            openReq.transaction?.abort();
          } catch {
            // Ignore abort failure
          }
        }
      };

      openReq.onblocked = () => {
        finish({
          indexedDbAvailable: true,
          databaseName: APP_CHECK_IDB_NAME,
          storeName: APP_CHECK_IDB_STORE,
          accessStatus: 'blocked',
          databaseVersion: null,
          storeExists: false,
          debugTokenPresent: false,
          cachedAppCheckTokenPresent: false,
          errorMessage: 'IndexedDB open was blocked by another connection or browser policy.',
        });
      };

      openReq.onerror = () => {
        if (notInitializedYet) {
          finish({
            indexedDbAvailable: true,
            databaseName: APP_CHECK_IDB_NAME,
            storeName: APP_CHECK_IDB_STORE,
            accessStatus: 'not-initialized-yet',
            databaseVersion: null,
            storeExists: false,
            debugTokenPresent: false,
            cachedAppCheckTokenPresent: false,
            errorMessage: null,
          });
          return;
        }
        finish({
          indexedDbAvailable: true,
          databaseName: APP_CHECK_IDB_NAME,
          storeName: APP_CHECK_IDB_STORE,
          accessStatus: 'open-error',
          databaseVersion: null,
          storeExists: false,
          debugTokenPresent: false,
          cachedAppCheckTokenPresent: false,
          errorMessage:
            openReq.error?.message || 'Failed to open Firebase App Check IndexedDB.',
        });
      };

      openReq.onsuccess = () => {
        const db = openReq.result;
        dbToClose = db;

        if (!db.objectStoreNames.contains(APP_CHECK_IDB_STORE)) {
          finish({
            indexedDbAvailable: true,
            databaseName: APP_CHECK_IDB_NAME,
            storeName: APP_CHECK_IDB_STORE,
            accessStatus: 'store-missing',
            databaseVersion: db.version,
            storeExists: false,
            debugTokenPresent: false,
            cachedAppCheckTokenPresent: false,
            errorMessage: `Object store "${APP_CHECK_IDB_STORE}" was not found.`,
          });
          return;
        }

        try {
          const tx = db.transaction(APP_CHECK_IDB_STORE, 'readonly');
          const store = tx.objectStore(APP_CHECK_IDB_STORE);
          const debugReq = store.get(APP_CHECK_IDB_DEBUG_KEY);
          const appTokenReq = store.get(`${appId}-[DEFAULT]`);

          let debugTokenPresent = false;
          let cachedAppCheckTokenPresent = false;
          let completedReads = 0;

          const maybeComplete = () => {
            completedReads += 1;
            if (completedReads >= 2) {
              finish({
                indexedDbAvailable: true,
                databaseName: APP_CHECK_IDB_NAME,
                storeName: APP_CHECK_IDB_STORE,
                accessStatus: 'ok',
                databaseVersion: db.version,
                storeExists: true,
                debugTokenPresent,
                cachedAppCheckTokenPresent,
                errorMessage: null,
              });
            }
          };

          debugReq.onsuccess = () => {
            const record = debugReq.result as { value?: unknown } | undefined;
            debugTokenPresent =
              typeof record?.value === 'string' && record.value.trim().length > 0;
            maybeComplete();
          };
          debugReq.onerror = () => {
            maybeComplete();
          };

          appTokenReq.onsuccess = () => {
            const record = appTokenReq.result as { value?: unknown } | undefined;
            cachedAppCheckTokenPresent = Boolean(record?.value);
            maybeComplete();
          };
          appTokenReq.onerror = () => {
            maybeComplete();
          };

          tx.onerror = () => {
            finish({
              indexedDbAvailable: true,
              databaseName: APP_CHECK_IDB_NAME,
              storeName: APP_CHECK_IDB_STORE,
              accessStatus: 'read-error',
              databaseVersion: db.version,
              storeExists: true,
              debugTokenPresent: false,
              cachedAppCheckTokenPresent: false,
              errorMessage:
                tx.error?.message || 'Failed reading Firebase App Check IndexedDB store.',
            });
          };
        } catch (err) {
          finish({
            indexedDbAvailable: true,
            databaseName: APP_CHECK_IDB_NAME,
            storeName: APP_CHECK_IDB_STORE,
            accessStatus: 'read-error',
            databaseVersion: db.version,
            storeExists: true,
            debugTokenPresent: false,
            cachedAppCheckTokenPresent: false,
            errorMessage:
              err instanceof Error ? err.message : String(err || 'IndexedDB read error'),
          });
        }
      };
    } catch (err) {
      finish({
        indexedDbAvailable: true,
        databaseName: APP_CHECK_IDB_NAME,
        storeName: APP_CHECK_IDB_STORE,
        accessStatus: 'open-error',
        databaseVersion: null,
        storeExists: false,
        debugTokenPresent: false,
        cachedAppCheckTokenPresent: false,
        errorMessage:
          err instanceof Error ? err.message : String(err || 'IndexedDB open exception'),
      });
    }
  });
}

export async function getAppCheckDebugReport(
  idbFactory?: IDBFactory
): Promise<AppCheckDebugReport> {
  const env: Record<string, unknown> =
    typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env as unknown as Record<string, unknown>)
      : {};
  const isDev = appCheckDevSetupState.isDevMode || Boolean(env.DEV);
  const mode = appCheckDevSetupState.mode || (typeof env.MODE === 'string' ? env.MODE : 'unknown');
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'server';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'server';
  const globalFlag = readGlobalDebugFlagInfo();
  const currentError = getAppCheckError();
  const indexedDb = await inspectAppCheckIndexedDb(
    firebaseConfig.appId,
    2000,
    idbFactory
  );

  return {
    timestamp: new Date().toISOString(),
    environment: {
      isDev,
      mode,
      hostname,
      origin,
      isDevOrPreviewHost: isDev,
    },
    debugMode: {
      active: appCheckDevSetupState.debugModeActive,
      tokenMode: appCheckDevSetupState.tokenMode,
      assignedBeforeSdkInit: appCheckDevSetupState.assignedBeforeSdkInit,
      globalFlagConfigured: globalFlag.configured,
      globalFlagType: globalFlag.type,
    },
    appCheck: {
      initialized: Boolean(appCheck),
      status: appCheckStatus,
      error: currentError,
    },
    indexedDb,
    recaptchaConfig: {
      enterpriseKeyConfigured: readCleanEnvFlag(env.VITE_RECAPTCHA_ENTERPRISE_KEY),
      v3KeyConfigured: readCleanEnvFlag(env.VITE_RECAPTCHA_SITE_KEY),
      fallbackConfigKeyPresent: readCleanEnvFlag(firebaseConfig.recaptchaSiteKey),
    },
    firebaseApp: {
      projectId: firebaseConfig.projectId,
      appId: firebaseConfig.appId,
      authDomain: firebaseConfig.authDomain,
      firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
    },
    troubleshootingHints: isDev
      ? [
          `In development mode, Firebase stores the generated debug token in IndexedDB ("${APP_CHECK_IDB_NAME}" -> "${APP_CHECK_IDB_STORE}" -> key "${APP_CHECK_IDB_DEBUG_KEY}") and logs "Firebase App Check debug token: <UUID>" in the preview execution context.`,
          `In Chrome DevTools, check Application -> Storage -> IndexedDB -> ${APP_CHECK_IDB_NAME} -> ${APP_CHECK_IDB_STORE} (key "${APP_CHECK_IDB_DEBUG_KEY}") to copy the UUID without printing it in app logs.`,
          `Register that UUID under Firebase Console -> App Check -> Apps -> ${firebaseConfig.appId} -> Manage debug tokens, then reload the page.`,
        ]
      : [
          `Verify your production reCAPTCHA Enterprise site key and deployed domain allowlist in Firebase Console -> App Check -> Apps -> ${firebaseConfig.appId}.`,
          `Verify Firebase App Check API (firebaseappcheck.googleapis.com) and reCAPTCHA Enterprise API are enabled on project "${firebaseConfig.projectId}".`,
        ],
  };
}

/**
 * Logs redacted Firebase App Check runtime, IndexedDB storage, and initialization
 * diagnostics to the browser console without exposing tokens, API keys, or site keys.
 */
export async function logAppCheckDebugReport(): Promise<AppCheckDebugReport> {
  const report = await getAppCheckDebugReport();

  if (typeof console !== 'undefined') {
    const label = report.appCheck.error
      ? '[Nimo App Check Debug] 403 / Initialization Diagnostic Report'
      : '[Nimo App Check Debug] Runtime & IndexedDB Diagnostic Report';

    if (typeof console.groupCollapsed === 'function') {
      console.groupCollapsed(label);
    } else {
      console.info(label);
    }

    console.info('Environment:', report.environment);
    console.info('Debug Mode State:', report.debugMode);
    console.info('App Check Status:', report.appCheck);
    console.info('IndexedDB Diagnostics (redacted):', report.indexedDb);
    console.info('reCAPTCHA Config Flags:', report.recaptchaConfig);
    console.info('Firebase App Identifiers:', report.firebaseApp);

    if (report.appCheck.error || report.indexedDb.errorMessage) {
      if (report.appCheck.error) {
        console.warn('Detected App Check Error:', report.appCheck.error);
      }
      if (report.indexedDb.errorMessage) {
        console.warn('IndexedDB Diagnostic Note:', report.indexedDb.errorMessage);
      }
      console.info('Troubleshooting Checklist:', report.troubleshootingHints);
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
      __nimoAppCheckDebug?: () => Promise<AppCheckDebugReport>;
    }
  ).__nimoAppCheckDebug = logAppCheckDebugReport;
}
