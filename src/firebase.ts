import { initializeApp } from 'firebase/app';
import { getAI, GoogleAIBackend } from 'firebase/ai';
import {
  AppCheck,
  getToken,
  initializeAppCheck,
  onTokenChanged,
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider,
} from 'firebase/app-check';
import {
  deleteUser,
  getAuth,
  GoogleAuthProvider,
  User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import type { AppCheckStatus } from './types';

const DEFAULT_PUBLIC_RECAPTCHA_ENTERPRISE_KEY =
  '6Ldp2CwuAAAAAMzBAZAW1VKn7gSm3zycawyAyzGF';

const IS_DEV_MODE = Boolean(import.meta.env?.DEV);

function getConfiguredDevDebugToken(): string | boolean {
  const rawEnvDebugToken = String(
    import.meta.env?.VITE_APPCHECK_DEBUG_TOKEN ?? ''
  )
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  return rawEnvDebugToken || true;
}

// Development-only: assign FIREBASE_APPCHECK_DEBUG_TOKEN synchronously BEFORE initializeApp / initializeAppCheck.
// In production builds (`import.meta.env.DEV === false`), FIREBASE_APPCHECK_DEBUG_TOKEN is never set.
let devDebugModeEnabled = false;
if (typeof window !== 'undefined') {
  if (IS_DEV_MODE) {
    const debugTokenSetting = getConfiguredDevDebugToken();
    (
      self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }
    ).FIREBASE_APPCHECK_DEBUG_TOKEN = debugTokenSetting;
    devDebugModeEnabled = true;

    if (debugTokenSetting === true) {
      console.info(
        `[Nimo] App Check development debug mode enabled (self.FIREBASE_APPCHECK_DEBUG_TOKEN = true). Look for "Firebase App Check debug token: <UUID>" in the console and register it under Firebase Console -> App Check -> Apps -> ${firebaseConfig.appId} -> Manage debug tokens.`
      );
    } else {
      console.info(
        `[Nimo] App Check development debug mode enabled using VITE_APPCHECK_DEBUG_TOKEN for web app ${firebaseConfig.appId}.`
      );
    }
  } else {
    console.info(
      `[Nimo] App Check production mode active (host="${window.location.hostname}"). Debug token disabled.`
    );
  }
}

const app = initializeApp(firebaseConfig);

let appCheckInstance: AppCheck | null = null;
let appCheckInitialized = false;
let detectedAppCheckStatus: AppCheckStatus = 'unconfigured-site-key';
let detectedAppCheckError: string | null = null;
let loggedVerificationSuccess = false;
const appCheckErrorListeners = new Set<(error: string | null) => void>();

function setAppCheckError(message: string | null) {
  detectedAppCheckError = message;
  appCheckErrorListeners.forEach((cb) => cb(message));
}

export function getAppCheckError(): string | null {
  return detectedAppCheckError;
}

export function subscribeAppCheckError(
  cb: (error: string | null) => void
): () => void {
  appCheckErrorListeners.add(cb);
  cb(detectedAppCheckError);
  return () => {
    appCheckErrorListeners.delete(cb);
  };
}

export function formatAppCheckExchangeError(
  raw: unknown,
  httpDetails?: string | null
): string | null {
  const errObj =
    raw && typeof raw === 'object'
      ? (raw as {
          code?: unknown;
          message?: unknown;
          customData?: { httpStatus?: unknown; serverResponse?: unknown };
        })
      : null;
  const code = typeof errObj?.code === 'string' ? errObj.code : '';
  const msg = raw instanceof Error ? raw.message : String(raw || '');
  const httpStatus =
    typeof errObj?.customData?.httpStatus === 'number'
      ? errObj.customData.httpStatus
      : null;
  const serverResp =
    typeof errObj?.customData?.serverResponse === 'string'
      ? errObj.customData.serverResponse
      : '';
  const combinedHttp = httpDetails || serverResp || '';
  const lower = `${code} ${msg} ${combinedHttp}`.toLowerCase();

  if (
    httpStatus === 403 ||
    lower.includes('exchangedebugtoken') ||
    lower.includes('fetch-status-error') ||
    lower.includes('initial-throttle') ||
    lower.includes('throttled') ||
    lower.includes('permission_denied') ||
    lower.includes('permission-denied') ||
    lower.includes('attestation') ||
    lower.includes('403')
  ) {
    const parts = [
      code ? `code: ${code}` : '',
      msg ? `raw message: ${msg}` : '',
      combinedHttp
        ? `raw response: ${combinedHttp}`
        : httpStatus
          ? `HTTP ${httpStatus}`
          : '',
    ].filter(Boolean);

    const devHint = IS_DEV_MODE
      ? `In development, copy the "Firebase App Check debug token: <UUID>" printed in your browser console and register it in Firebase Console -> App Check -> Apps -> ${firebaseConfig.appId} -> Manage debug tokens (then refresh).`
      : `Verify your production reCAPTCHA site key and domain allowlist in Firebase Console -> App Check -> Apps -> ${firebaseConfig.appId}.`;

    return `Firebase App Check 403 / authentication failure (${parts.join(' | ')}). ${devHint}`;
  }
  return null;
}

function buildAppCheckProvider(): {
  provider: ReCaptchaEnterpriseProvider | ReCaptchaV3Provider;
  status: 'active-recaptcha-enterprise' | 'active-recaptcha-v3';
  providerName: string;
} | null {
  const explicitEnterpriseKey = String(
    import.meta.env?.VITE_RECAPTCHA_ENTERPRISE_KEY || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  const explicitV3Key = String(
    import.meta.env?.VITE_RECAPTCHA_SITE_KEY ||
      firebaseConfig.recaptchaSiteKey ||
      ''
  )
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();

  if (explicitEnterpriseKey && explicitV3Key) {
    console.warn(
      '[Nimo] Both VITE_RECAPTCHA_ENTERPRISE_KEY and VITE_RECAPTCHA_SITE_KEY are set. Using VITE_RECAPTCHA_ENTERPRISE_KEY; remove the unused key.'
    );
  }

  if (explicitEnterpriseKey) {
    return {
      provider: new ReCaptchaEnterpriseProvider(explicitEnterpriseKey),
      status: 'active-recaptcha-enterprise',
      providerName: 'ReCaptchaEnterpriseProvider',
    };
  }

  if (explicitV3Key) {
    return {
      provider: new ReCaptchaV3Provider(explicitV3Key),
      status: 'active-recaptcha-v3',
      providerName: 'ReCaptchaV3Provider',
    };
  }

  if (DEFAULT_PUBLIC_RECAPTCHA_ENTERPRISE_KEY) {
    return {
      provider: new ReCaptchaEnterpriseProvider(DEFAULT_PUBLIC_RECAPTCHA_ENTERPRISE_KEY),
      status: 'active-recaptcha-enterprise',
      providerName: 'ReCaptchaEnterpriseProvider',
    };
  }

  return null;
}

// Initialize Firebase App Check BEFORE Firebase AI Logic, Firestore, and Auth.
if (typeof window !== 'undefined' && !appCheckInitialized) {
  appCheckInitialized = true;

  try {
    const providerConfig = buildAppCheckProvider();

    if (!appCheckInstance && providerConfig) {
      appCheckInstance = initializeAppCheck(app, {
        provider: providerConfig.provider,
        isTokenAutoRefreshEnabled: true,
      });
      detectedAppCheckStatus = providerConfig.status;
      console.info(
        `[Nimo] Firebase App Check initialized (${IS_DEV_MODE ? 'development' : 'production'}, provider: ${providerConfig.providerName}, debugMode: ${devDebugModeEnabled}).`
      );
    } else if (!appCheckInstance) {
      detectedAppCheckStatus = 'unconfigured-site-key';
      console.info(
        '[Nimo] Firebase App Check not initialized: set VITE_RECAPTCHA_SITE_KEY or VITE_RECAPTCHA_ENTERPRISE_KEY.'
      );
    }

    if (appCheckInstance) {
      onTokenChanged(
        appCheckInstance,
        (tokenResult) => {
          setAppCheckError(null);
          if (!loggedVerificationSuccess && tokenResult?.token) {
            loggedVerificationSuccess = true;
            console.info(
              `[Nimo] App Check verification status: verified (token active, debugMode: ${devDebugModeEnabled}).`
            );
          }
        },
        (err) => {
          const formatted =
            formatAppCheckExchangeError(err) ||
            (err instanceof Error ? err.message : String(err || 'App Check token error'));
          console.warn('[Nimo] App Check verification status: FAILED ->', formatted);
          setAppCheckError(formatted);
        }
      );

      void getToken(appCheckInstance, false)
        .then((tokenResult) => {
          if (!loggedVerificationSuccess && tokenResult?.token) {
            loggedVerificationSuccess = true;
            console.info(
              `[Nimo] App Check verification status: verified (token active, debugMode: ${devDebugModeEnabled}).`
            );
          }
        })
        .catch((err) => {
          const formatted =
            formatAppCheckExchangeError(err) ||
            (err instanceof Error ? err.message : String(err || 'App Check authentication failed'));
          console.warn('[Nimo] App Check verification status: FAILED ->', formatted);
          setAppCheckError(formatted);
        });
    }
  } catch (err) {
    console.warn('[Nimo] Firebase App Check initialization warning:', err);
    detectedAppCheckStatus = 'error';
    const formatted =
      formatAppCheckExchangeError(err) ||
      (err instanceof Error ? err.message : String(err || 'App Check initialization failed'));
    console.warn('[Nimo] App Check verification status: FAILED ->', formatted);
    setAppCheckError(formatted);
  }
}

export const appCheck = appCheckInstance;
export const appCheckStatus: AppCheckStatus = detectedAppCheckStatus;

// Protected Firebase services (initialized strictly AFTER App Check)
export const ai = getAI(app, {
  backend: new GoogleAIBackend(),
});
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function deleteAllUserData(
  user: User,
  options?: { deleteAuthAccount?: boolean }
): Promise<{ deletedCount: number; authDeleted: boolean; requiresRecentLogin: boolean }> {
  let deletedCount = 0;

  // 1. Delete chat threads and their messages subcollections
  const threadsSnap = await getDocs(
    query(collection(db, 'chatThreads'), where('ownerId', '==', user.uid))
  );
  for (const threadDoc of threadsSnap.docs) {
    const msgsSnap = await getDocs(
      query(
        collection(db, `chatThreads/${threadDoc.id}/messages`),
        where('ownerId', '==', user.uid)
      )
    );
    for (const msgDoc of msgsSnap.docs) {
      await deleteDoc(msgDoc.ref);
      deletedCount++;
    }
    await deleteDoc(threadDoc.ref);
    deletedCount++;
  }

  // 2. Delete top-level user-owned collections
  const ownerCollections = [
    'vocabItems',
    'studyNotes',
    'quizAttempts',
    'codeSnippets',
    'createDrafts',
  ];
  for (const colName of ownerCollections) {
    const snap = await getDocs(
      query(collection(db, colName), where('ownerId', '==', user.uid))
    );
    for (const itemDoc of snap.docs) {
      await deleteDoc(itemDoc.ref);
      deletedCount++;
    }
  }

  // 3. Delete private PII & user profile
  try {
    await deleteDoc(doc(db, 'users', user.uid, 'private', 'info'));
    deletedCount++;
  } catch {
    // Document may not exist
  }
  try {
    await deleteDoc(doc(db, 'users', user.uid));
    deletedCount++;
  } catch {
    // Document may not exist
  }

  let authDeleted = false;
  let requiresRecentLogin = false;

  if (options?.deleteAuthAccount) {
    try {
      await deleteUser(user);
      authDeleted = true;
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/requires-recent-login') {
        requiresRecentLogin = true;
      } else {
        throw err;
      }
    }
  }

  return { deletedCount, authDeleted, requiresRecentLogin };
}

export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return false;
    }
    return true;
  }
}

if (typeof window !== 'undefined') {
  void testConnection();
}
