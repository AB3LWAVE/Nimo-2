import React, { useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { AlertTriangle, CheckCircle2, Loader2, Shield, Trash2, X } from 'lucide-react';
import { deleteAllUserData } from '../firebase';

interface AccountPrivacyModalProps {
  open: boolean;
  onClose: () => void;
  user: User | null;
  onRequireReauth?: () => Promise<void>;
}

export function AccountPrivacyModal({
  open,
  onClose,
  user,
  onRequireReauth,
}: AccountPrivacyModalProps) {
  const [confirmText, setConfirmText] = useState('');
  const [alsoDeleteAuth, setAlsoDeleteAuth] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirmText('');
      setStatusMessage(null);
      setErrorMsg(null);
      setNeedsReauth(false);
      return;
    }
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleDelete = async () => {
    if (!user || confirmText.trim().toUpperCase() !== 'DELETE') return;
    setDeleting(true);
    setErrorMsg(null);
    setStatusMessage(null);
    setNeedsReauth(false);
    try {
      const result = await deleteAllUserData(user, { deleteAuthAccount: alsoDeleteAuth });
      if (result.requiresRecentLogin) {
        setNeedsReauth(true);
        setStatusMessage(
          `Deleted ${result.deletedCount} Firestore records. Firebase requires a recent Google sign-in before deleting the authentication account itself.`
        );
      } else {
        setStatusMessage(
          result.authDeleted
            ? `Deleted ${result.deletedCount} Firestore records and permanently deleted your Firebase account.`
            : `Deleted ${result.deletedCount} Firestore records. Your Google sign-in remains active.`
        );
        setConfirmText('');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to delete account data.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-privacy-title"
    >
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            <h2
              id="account-privacy-title"
              className="text-base font-semibold font-display text-slate-900 dark:text-white"
            >
              Privacy, Data &amp; Account Controls
            </h2>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close privacy dialog"
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 space-y-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            <p className="font-semibold text-slate-800 dark:text-slate-100">
              How Nimo processes your data
            </p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <strong>On-Device Mode:</strong> Prompts run locally inside Chrome&apos;s Gemini Nano model without leaving your device.
              </li>
              <li>
                <strong>Cloud Fallback / Cloud Mode:</strong> Prompts are transmitted via Firebase AI Logic (protected by App Check when configured).
              </li>
              <li>
                <strong>Voice &amp; Audio Features:</strong> Microphone recordings for transcription, TTS playback, pronunciation scoring, and Live Voice are sent to server Gemini audio endpoints or processed by browser Speech Synthesis.
              </li>
              <li>
                <strong>Firestore Storage:</strong> When signed in, your threads, notes, vocabulary, quiz scores, snippets, and drafts are stored in user-isolated Cloud Firestore collections.
              </li>
            </ul>
          </div>

          {user ? (
            <div className="space-y-4">
              <div className="text-xs text-slate-600 dark:text-slate-400 space-y-0.5">
                <p>
                  Signed in as <strong className="text-slate-900 dark:text-white">{user.displayName || 'Learner'}</strong> ({user.email})
                </p>
                <p className="font-mono">UID: {user.uid}</p>
              </div>

              <div className="p-4 rounded-xl border border-red-200 dark:border-red-900/70 bg-red-50/60 dark:bg-red-950/20 space-y-3">
                <div className="flex items-start gap-2 text-red-700 dark:text-red-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold">Delete Cloud Data &amp; Account</p>
                    <p className="text-xs opacity-90 mt-0.5">
                      Permanently deletes all your Firestore chat threads, messages, vocabulary cards, study notes, quiz history, code snippets, and Create drafts.
                    </p>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={alsoDeleteAuth}
                    onChange={(e) => setAlsoDeleteAuth(e.target.checked)}
                    className="rounded border-slate-300 text-red-600 focus:ring-red-500"
                  />
                  Also delete my Firebase Auth user record after wiping Firestore data
                </label>

                <div className="space-y-2">
                  <label className="block text-xs text-slate-700 dark:text-slate-300">
                    Type <code className="font-mono font-semibold">DELETE</code> to confirm:
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="DELETE"
                      className="flex-1 px-3 py-1.5 text-xs font-mono rounded-lg border border-red-200 dark:border-red-900 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                    />
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting || confirmText.trim().toUpperCase() !== 'DELETE'}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white whitespace-nowrap"
                    >
                      {deleting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      Delete Forever
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              You are currently using guest mode. No personal data is persisted to Firestore until you sign in with Google.
            </p>
          )}

          {statusMessage && (
            <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 space-y-2">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{statusMessage}</span>
              </div>
              {needsReauth && onRequireReauth && (
                <button
                  type="button"
                  onClick={onRequireReauth}
                  className="px-3 py-1 text-xs font-medium rounded-md bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 text-slate-900 dark:text-white"
                >
                  Re-authenticate with Google &amp; Retry
                </button>
              )}
            </div>
          )}

          {errorMsg && (
            <p className="text-xs text-red-600 dark:text-red-400">{errorMsg}</p>
          )}
        </div>
      </div>
    </div>
  );
}
