import React, { useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { LogIn, LogOut, Moon, Sun } from 'lucide-react';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from './firebase';
import { SessionTab } from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ChatSession } from './components/ChatSession';
import { LearnSession } from './components/LearnSession';
import { CodingSession } from './components/CodingSession';

const SESSIONS: Array<{ id: SessionTab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'learn', label: 'Learn' },
  { id: 'coding', label: 'Coding' },
];

export default function App() {
  const [activeSession, setActiveSession] = useState<SessionTab>('chat');
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add('dark');
    else root.classList.remove('dark');
  }, [darkMode]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      setAuthReady(true);

      if (firebaseUser && firebaseUser.emailVerified) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const privateRef = doc(db, 'users', firebaseUser.uid, 'private', 'info');
        try {
          const snap = await getDoc(userRef);
          const safeName = (firebaseUser.displayName || 'Learner').slice(0, 100);
          const safePhoto = (firebaseUser.photoURL || '').slice(0, 500);
          if (!snap.exists()) {
            await setDoc(userRef, {
              uid: firebaseUser.uid,
              displayName: safeName,
              ...(safePhoto ? { photoURL: safePhoto } : {}),
              preferredTheme: darkMode ? 'dark' : 'light',
              targetLanguage: 'Spanish',
              proficiencyLevel: 'Beginner',
              updatedAt: serverTimestamp(),
            });
          } else {
            const existingData = snap.data();
            if (existingData?.preferredTheme === 'dark') {
              setDarkMode(true);
            }
            await updateDoc(userRef, {
              displayName: safeName,
              ...(safePhoto ? { photoURL: safePhoto } : {}),
              updatedAt: serverTimestamp(),
            });
          }

          const privSnap = await getDoc(privateRef);
          const safeEmail = (firebaseUser.email || 'user@example.com').slice(0, 320);
          if (!privSnap.exists()) {
            await setDoc(privateRef, {
              uid: firebaseUser.uid,
              email: safeEmail,
              updatedAt: serverTimestamp(),
            });
          } else {
            await updateDoc(privateRef, {
              email: safeEmail,
              updatedAt: serverTimestamp(),
            });
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${firebaseUser.uid}`);
        }
      }
    });

    return () => unsub();
  }, []);

  const handleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Google Sign-In was cancelled or blocked.'
      );
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to sign out.');
    }
  };

  const toggleTheme = async () => {
    const next = !darkMode;
    setDarkMode(next);
    if (user && user.emailVerified) {
      try {
        await updateDoc(doc(db, 'users', user.uid), {
          preferredTheme: next ? 'dark' : 'light',
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Non-blocking theme preference sync
      }
    }
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        {/* Three-Zone Top Bar Contract */}
        <header className="h-16 px-4 sm:px-8 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-8 sticky top-0 z-30">
          {/* Zone 1: Single-line Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveSession('chat')}
            className="text-xl font-bold font-display tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0"
          >
            Nimo
          </button>

          {/* Zone 2: Exactly 3 Main Sessions (Chat, Learn, Coding) */}
          <nav aria-label="Primary sessions" className="flex items-center gap-6 sm:gap-8 h-full">
            {SESSIONS.map((tab) => {
              const active = activeSession === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSession(tab.id)}
                  className={`relative h-full inline-flex items-center text-sm font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    active
                      ? 'border-sky-600 text-slate-900 dark:text-white'
                      : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Theme & Account Action */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            {!authReady ? (
              <span className="text-xs text-slate-400 whitespace-nowrap">Loading...</span>
            ) : user ? (
              <div className="flex items-center gap-2.5">
                {user.photoURL && (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || 'User avatar'}
                    referrerPolicy="no-referrer"
                    className="w-7 h-7 rounded-full object-cover border border-slate-200 dark:border-slate-700"
                  />
                )}
                <span className="hidden sm:inline text-xs font-medium text-slate-700 dark:text-slate-200 max-w-[120px] truncate">
                  {user.displayName || 'Learner'}
                </span>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSignIn}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-slate-900 dark:bg-sky-600 hover:bg-slate-800 dark:hover:bg-sky-700 text-white transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="w-3.5 h-3.5" />
                Sign in with Google
              </button>
            )}
          </div>
        </header>

        {authError && (
          <div className="px-6 py-2.5 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300 flex items-center justify-between">
            <span>{authError}</span>
            <button
              type="button"
              onClick={() => setAuthError(null)}
              className="underline ml-4"
            >
              Dismiss
            </button>
          </div>
        )}

        <main className="flex-1 flex flex-col">
          {activeSession === 'chat' && (
            <ChatSession user={user} onRequireSignIn={handleSignIn} />
          )}
          {activeSession === 'learn' && (
            <LearnSession user={user} onRequireSignIn={handleSignIn} />
          )}
          {activeSession === 'coding' && (
            <CodingSession user={user} onRequireSignIn={handleSignIn} />
          )}
        </main>
      </div>
    </ErrorBoundary>
  );
}
