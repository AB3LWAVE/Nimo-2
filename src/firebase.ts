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
const PINNED_APPCHECK_DEBUG_TOKEN = '7fc60dee-730b-469a-8b95-44ae4d785d5f';

// Assign FIREBASE_APPCHECK_DEBUG_TOKEN synchronously at module load BEFORE initializeApp/initializeAppCheck.
// Never set in production builds (`import.meta.env.DEV === false` on non-preview/non-localhost hosts).
let activePinnedDebugToken: string | null = null;
if (typeof window !== 'undefined') {
  const hostname = window.location.hostname;
  const isDevOrPreviewHost =
    import.meta.env.DEV ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('ais-dev-') ||
    hostname === 'scf.usercontent.goog' ||
    hostname.endsWith('.scf.usercontent.goog') ||
    hostname === 'aistudio.google.com' ||
    hostname.endsWith('.aistudio.google.com');

  if (isDevOrPreviewHost) {
    const rawEnvDebugToken = String(
      import.meta.env.VITE_APPCHECK_DEBUG_TOKEN ??
        import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN ??
        ''
    )
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    const tokenSource = rawEnvDebugToken
      ? 'import.meta.env.VITE_APPCHECK_DEBUG_TOKEN'
      : 'hardcoded default fallback';
    const resolvedDebugToken = rawEnvDebugToken || PINNED_APPCHECK_DEBUG_TOKEN;
    (
      self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }
    ).FIREBASE_APPCHECK_DEBUG_TOKEN = resolvedDebugToken;
    activePinnedDebugToken = resolvedDebugToken;
    console.info(
      `[Nimo] App Check environment verified: dev/preview (host="${hostname}", DEV=${String(
        import.meta.env.DEV
      )}). Pinned debug token assigned synchronously from ${tokenSource}: ${resolvedDebugToken} (appId: ${firebaseConfig.appId}).`
    );
  } else {
    console.info(
      `[Nimo] App Check environment verified: production (host="${hostname}", DEV=${String(
        import.meta.env.DEV
      )}). Debug token disabled.`
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
    return (
      `Firebase App Check 403 / authentication failure (${parts.join(' | ')}). Check Google Cloud API key restrictions, Firebase App Check API enablement, and Manage debug tokens for web app ${firebaseConfig.appId}.`
    );
  }
  return null;
}

async function diagnoseDebugExchangeError(err: unknown): Promise<string | null> {
  let httpDetails: string | null = null;
  if (activePinnedDebugToken && typeof fetch === 'function') {
    try {
      const endpoint = `https://content-firebaseappcheck.googleapis.com/v1/projects/${encodeURIComponent(
        firebaseConfig.projectId
      )}/apps/${encodeURIComponent(
        firebaseConfig.appId
      )}:exchangeDebugToken?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugToken: activePinnedDebugToken }),
      });
      if (!res.ok) {
        const bodyText = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
        httpDetails = `HTTP ${res.status}${bodyText ? ` ${bodyText.slice(0, 600)}` : ''}`;
      }
    } catch (fetchErr) {
      httpDetails =
        fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    }
  }
  return formatAppCheckExchangeError(err, httpDetails);
}

if (typeof window !== 'undefined' && !appCheckInitialized) {
  appCheckInitialized = true;

  const explicitEnterpriseKey = String(
    import.meta.env.VITE_RECAPTCHA_ENTERPRISE_KEY || ''
  )
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  const explicitV3Key = String(
    import.meta.env.VITE_RECAPTCHA_SITE_KEY ||
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

  const enterpriseKey =
    explicitEnterpriseKey ||
    (!explicitV3Key ? DEFAULT_PUBLIC_RECAPTCHA_ENTERPRISE_KEY : '');

  try {
    if (!appCheckInstance) {
      if (enterpriseKey) {
        appCheckInstance = initializeAppCheck(app, {
          provider: new ReCaptchaEnterpriseProvider(enterpriseKey),
          isTokenAutoRefreshEnabled: true,
        });
        detectedAppCheckStatus = 'active-recaptcha-enterprise';
        console.info(
          `[Nimo] Firebase App Check initialized (provider: ReCaptchaEnterpriseProvider, debugMode: ${Boolean(
            activePinnedDebugToken
          )}).`
        );
      } else if (explicitV3Key) {
        appCheckInstance = initializeAppCheck(app, {
          provider: new ReCaptchaV3Provider(explicitV3Key),
          isTokenAutoRefreshEnabled: true,
        });
        detectedAppCheckStatus = 'active-recaptcha-v3';
        console.info(
          `[Nimo] Firebase App Check initialized (provider: ReCaptchaV3Provider, debugMode: ${Boolean(
            activePinnedDebugToken
          )}).`
        );
      } else {
        detectedAppCheckStatus = 'unconfigured-site-key';
        console.info(
          '[Nimo] Firebase App Check not initialized (optional): set VITE_RECAPTCHA_SITE_KEY or VITE_RECAPTCHA_ENTERPRISE_KEY to enable App Check attestation.'
        );
      }
    }

    if (appCheckInstance) {
      onTokenChanged(
        appCheckInstance,
        (tokenResult) => {
          setAppCheckError(null);
          if (!loggedVerificationSuccess && tokenResult?.token) {
            loggedVerificationSuccess = true;
            console.info(
              `[Nimo] App Check verification status: verified (token active, debugMode: ${Boolean(
                activePinnedDebugToken
              )}).`
            );
          }
        },
        (err) => {
          void diagnoseDebugExchangeError(err).then((formatted) => {
            const finalErr =
              formatted ||
              (err instanceof Error ? err.message : String(err || 'App Check token error'));
            console.warn('[Nimo] App Check verification status: FAILED ->', finalErr);
            setAppCheckError(finalErr);
          });
        }
      );

      void getToken(appCheckInstance, false)
        .then((tokenResult) => {
          if (!loggedVerificationSuccess && tokenResult?.token) {
            loggedVerificationSuccess = true;
            console.info(
              `[Nimo] App Check verification status: verified (token active, debugMode: ${Boolean(
                activePinnedDebugToken
              )}).`
            );
          }
        })
        .catch((err) => {
          void diagnoseDebugExchangeError(err).then((formatted) => {
            const finalErr =
              formatted ||
              (err instanceof Error ? err.message : String(err || 'App Check authentication failed'));
            console.warn('[Nimo] App Check verification status: FAILED ->', finalErr);
            setAppCheckError(finalErr);
          });
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

// Firebase AI Logic SDK (must initialize after App Check so tokens attach automatically)
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
