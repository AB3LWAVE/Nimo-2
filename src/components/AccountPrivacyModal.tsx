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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-xs p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-privacy-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl overflow-hidden">
        {/* Sticky Header with X close button */}
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#161C24] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Shield className="w-4 h-4 text-orange-600 dark:text-amber-400 shrink-0" />
            <h2
              id="account-privacy-title"
              className="text-base font-semibold font-display text-slate-900 dark:text-white truncate"
            >
              Account &amp; Privacy Controls
            </h2>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close account and privacy dialog"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Smoothly scrollable body */}
        <div className="flex-1 overflow-y-auto scroll-smooth p-4 sm:p-5 space-y-4 text-sm">
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
                <strong>Firestore Storage:</strong> When signed in, your threads, notes, vocabulary, quiz scores, snippets, and Create drafts are stored in user-isolated Cloud Firestore collections.
              </li>
            </ul>
          </div>

          {user ? (
            <div className="space-y-4">
              <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 text-xs text-slate-600 dark:text-slate-400 space-y-1">
                <p className="break-words">
                  Signed in as{' '}
                  <strong className="text-slate-900 dark:text-white">
                    {user.displayName || 'Learner'}
                  </strong>{' '}
                  ({user.email})
                </p>
                <p className="font-mono break-all text-[11px]">UID: {user.uid}</p>
              </div>

              <div className="p-4 rounded-xl border border-red-200 dark:border-red-900/70 bg-red-50/60 dark:bg-red-950/20 space-y-3">
                <div className="flex items-start gap-2 text-red-700 dark:text-red-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-xs font-semibold">
                      Permanent Deletion — Cloud Data &amp; Account
                    </p>
                    <p className="text-xs opacity-90 leading-relaxed">
                      This action cannot be undone. It permanently removes all your Firestore chat threads, messages, vocabulary cards, study notes, quiz history, code snippets, and Create drafts.
                    </p>
                  </div>
                </div>

                <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={alsoDeleteAuth}
                    onChange={(e) => setAlsoDeleteAuth(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 text-red-600 focus:ring-red-500"
                  />
                  <span>Also delete my Firebase Auth user record after wiping Firestore data</span>
                </label>

                <div className="space-y-2">
                  <label
                    htmlFor="delete-account-confirm"
                    className="block text-xs text-slate-700 dark:text-slate-300"
                  >
                    Type <code className="font-mono font-semibold">DELETE</code> to enable permanent deletion:
                  </label>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <input
                      id="delete-account-confirm"
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="DELETE"
                      className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-red-200 dark:border-red-900 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting || confirmText.trim().toUpperCase() !== 'DELETE'}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
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
            <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 text-xs text-slate-600 dark:text-slate-400">
              You are currently using guest mode. No personal data is persisted to Firestore until you sign in with Google.
            </div>
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
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 text-slate-900 dark:text-white"
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
