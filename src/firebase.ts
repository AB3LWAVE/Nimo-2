import { initializeApp } from 'firebase/app';
import { getAI, GoogleAIBackend } from 'firebase/ai';
import {
  AppCheck,
  initializeAppCheck,
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

const app = initializeApp(firebaseConfig);

let appCheckInstance: AppCheck | null = null;
let detectedAppCheckStatus: AppCheckStatus = 'unconfigured-site-key';

if (typeof window !== 'undefined') {
  // Never bake or enable App Check debug tokens in production builds.
  // Vite statically eliminates `import.meta.env.DEV` branches during `vite build`.
  if (import.meta.env.DEV) {
    const rawDebugToken = (import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN || '').trim();
    if (
      rawDebugToken &&
      rawDebugToken.toLowerCase() !== 'false' &&
      rawDebugToken !== '0'
    ) {
      (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
        rawDebugToken.toLowerCase() === 'true' ? true : rawDebugToken;
      console.info('[Nimo] Firebase App Check debug token mode enabled for local/dev testing.');
    }
  }

  const explicitEnterpriseKey = (import.meta.env.VITE_RECAPTCHA_ENTERPRISE_KEY || '').trim();
  const explicitV3Key = (
    import.meta.env.VITE_RECAPTCHA_SITE_KEY ||
    firebaseConfig.recaptchaSiteKey ||
    ''
  ).trim();

  if (explicitEnterpriseKey && explicitV3Key) {
    console.warn(
      '[Nimo] Both VITE_RECAPTCHA_ENTERPRISE_KEY and VITE_RECAPTCHA_SITE_KEY are set. Using VITE_RECAPTCHA_ENTERPRISE_KEY; remove the unused key.'
    );
  }

  const enterpriseKey =
    explicitEnterpriseKey ||
    (!explicitV3Key ? DEFAULT_PUBLIC_RECAPTCHA_ENTERPRISE_KEY : '');

  try {
    if (enterpriseKey) {
      appCheckInstance = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(enterpriseKey),
        isTokenAutoRefreshEnabled: true,
      });
      detectedAppCheckStatus = 'active-recaptcha-enterprise';
    } else if (explicitV3Key) {
      appCheckInstance = initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(explicitV3Key),
        isTokenAutoRefreshEnabled: true,
      });
      detectedAppCheckStatus = 'active-recaptcha-v3';
    } else {
      detectedAppCheckStatus = 'unconfigured-site-key';
      console.info(
        '[Nimo] Firebase App Check not initialized (optional): set VITE_RECAPTCHA_ENTERPRISE_KEY or VITE_RECAPTCHA_SITE_KEY to enable App Check attestation.'
      );
    }
  } catch (err) {
    console.warn('[Nimo] Firebase App Check initialization warning:', err);
    detectedAppCheckStatus = 'error';
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
