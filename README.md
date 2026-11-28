# Nimo

**Nimo** is a three-session AI learning, conversation, and creation workspace powered by **Firebase AI Logic Hybrid Inference** (`firebase/ai`), **Firebase Authentication**, **Cloud Firestore**, and **Firebase App Check**, with optional Express + WebSocket audio endpoints for speech synthesis, transcription, and live voice tutoring.

---

## Core Product Architecture

Nimo preserves a strict three-section primary navigation bar:

1. **Chat**
   - Multi-turn AI conversations synced to Firestore (`chatThreads/{threadId}/messages`).
   - Powered by `firebase/ai` Hybrid Inference (`PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`, `PREFER_IN_CLOUD`, `ONLY_IN_CLOUD`) with real `inferenceSource` (`Firebase On-device` vs `Firebase Cloud`) and latency badges on every reply.
   - Image attachments for multimodal analysis, Copy response, Regenerate last reply, message timestamps, mobile-accessible thread drawer, microphone dictation, audio playback, and Live Voice modal.

2. **Learn**
   - **Experience A — Language Learning**:
     - Interactive conversational tutor with translations and grammar tips (`generateHybridJson`).
     - Vocabulary deck generator with phonetics, contextual sentences, mastery tracking, and Firestore sync (`vocabItems`).
     - Listening comprehension generator with transcript toggle, speed control (`0.75x`–`1.5x`), and comprehension check.
     - Audio TTS/STT/Live Voice & acoustic pronunciation drill clearly separated onto Web Speech API and dedicated server Gemini audio endpoints.
   - **Experience B — General Learning & Quiz**:
     - Study notes and step-by-step explanations with follow-up Q&A and Firestore persistence (`studyNotes`).
     - Adaptive MCQ + short-answer Quiz generator with strict schema validation, AI short-answer grading, **"Retry Same Quiz"**, step-by-step question explanations, and Quiz History (`quizAttempts`).

3. **Create**
   - **Write & Rewrite**: Draft new documents or rewrite/condense/expand/proofread text in selectable tones, copy, and save to Firestore (`createDrafts`).
   - **Brainstorm & Plan**: Generate structured idea brainstorms or execution plans/checklists and save to Firestore (`createDrafts`).
   - **Code Studio**: Interactive code editor with JavaScript sandbox execution, sandboxed HTML live preview, AI execution tracing for TypeScript/Python/SQL/Go/Rust, Firestore persistence (`codeSnippets`), and Nimo Coding Assistant (Quick Fix, Explain, Debug Deeply, Refactor, Screenshot-to-Code) via Hybrid Inference.

---

## Tech Stack & Architecture Separation

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite 8
- **Firebase SDK (`^13.4.0`)**:
  - `firebase/app-check`: Initializes `ReCaptchaEnterpriseProvider` or `ReCaptchaV3Provider` (plus optional dev debug token) **before** `getAI`.
  - `firebase/ai`: Uses `getAI(app, { backend: new GoogleAIBackend() })` and `getGenerativeModel(ai, { mode, onDeviceParams, inCloudParams })` with `initializeDeviceModel` progress reporting.
  - `firebase/auth`: Google Sign-In (`signInWithPopup`) + account deletion workflow (`deleteAllUserData`).
  - `firebase/firestore`: Hardened user-isolated collections governed by ESLint-validated `firestore.rules` and `firebase-blueprint.json`.
- **Audio / Live Voice Backend (`server.ts`)**:
  - Dedicated Express + WebSocket endpoints (`/api/audio/tts`, `/api/audio/transcribe`, `/ws/live`, `/api/learn/language` pronunciation) using `@google/genai` for speech/audio modalities that Chrome on-device Gemini Nano (`LanguageModel`) does not natively provide.

---

## Local Setup & Configuration

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Environment variables** (see `.env.example`):
   - Server (`.env`):
     - `GEMINI_API_KEY`: Server-side key for `/api/audio/*` and `/ws/live` endpoints.
     - `APP_URL`: Optional hosted origin URL.
   - Client (`.env` or Vite env):
     - `VITE_RECAPTCHA_SITE_KEY` or `VITE_RECAPTCHA_ENTERPRISE_KEY`: Enables production Firebase App Check attestation.
     - `VITE_FIREBASE_APPCHECK_DEBUG_TOKEN`: Optional debug token for local development.
     - `VITE_HYBRID_CLOUD_MODEL`: Optional cloud fallback override (defaults to `gemini-3.5-flash-lite`).

3. **Enable On-Device Inference in Chrome Desktop (Optional)**:
   - Open Chrome 139+ on Desktop.
   - Navigate to `chrome://flags/#optimization-guide-on-device-model` and `chrome://flags/#prompt-api-for-gemini-nano`, enable both, and relaunch.
   - In Nimo, click **Hybrid Setup** in the header (or Chat toolbar) and click **Initialize On-Device Model** to trigger the user-activated local model download.

4. **Run Development Server**:
   ```bash
   npm run dev
   ```
   Opens on `http://localhost:3000`.

---

## Verification Commands

- **Unit tests**: `npm test`
- **TypeScript check**: `npm run lint`
- **Firestore Rules security lint**: `npm run rules:lint`
- **Production build**: `npm run build`

---

## Deployment Notes

- **Static SPA + Firestore Rules (Firebase Hosting)**:
  ```bash
  npm run build
  firebase deploy --only hosting,firestore:rules
  ```
  `firebase.json` serves `dist/` with SPA rewrites, security headers, and `Cross-Origin-Opener-Policy: same-origin-allow-popups` for Google Sign-In popups.
- **Full-Stack Deployment (with `/api/audio/*` and `/ws/live`)**:
  Deploy `server.ts` on Cloud Run / Node (`npm run build && NODE_ENV=production npm start`) or proxy `/api/*` and `/ws/live` from Firebase Hosting to Cloud Run. Even without the optional audio server, all Firebase AI Logic Hybrid Inference features (Chat, Language text lessons/conversation, General Learning & Quizzes, and Create Writing/Planning/Coding) and Browser Speech Synthesis work standalone.

---

## Security & Privacy

- Hardened Firestore rules (`firestore.rules`) enforce owner isolation (`ownerId == request.auth.uid`), email verification on writes, immutable `createdAt`, strict field allowlisting, and bounded payload sizes.
- Users can inspect runtime routing (On-device vs Cloud) on every message and delete all Firestore records and their Firebase Auth account from the **Privacy & Data Controls** modal (shield icon in the top bar).

---

## License

**NIMO AI** is distributed under the **Apache License 2.0**. See the root [`LICENSE`](./LICENSE) file for the full license text and terms.

Copyright 2026 [My Full Name]
