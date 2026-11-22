# Nimo — Firebase #BuildHybridAI 2026 Hackathon Submission Package

## A. Project Description

### Project Name
**Nimo**

### One-Line Tagline
A three-session hybrid AI workspace for Chat, Audio-Enabled Learning & Quizzes, and Creation (Writing, Planning & Coding), powered by Firebase AI Logic Hybrid Inference.

### Problem Statement
Learners, students, and builders switch constantly between fragmented AI chat tools, language apps, quiz generators, and coding editors—while paying a privacy, latency, and offline penalty whenever every keystroke must round-trip to cloud servers. Conversely, pure on-device browser models cannot handle heavy multimodal payloads or work across all browsers yet.

### Solution & Hybrid AI Architecture
**Nimo** unifies the entire workflow inside **three focused sessions—Chat, Learn, and Create—backed by `firebase/ai` Hybrid Inference**:

- **Real Firebase AI Logic Hybrid Inference (`src/services/hybridAi.ts`)**:
  - Initializes `getAI(app, { backend: new GoogleAIBackend() })` after Firebase App Check (`initializeAppCheck`).
  - Uses `getGenerativeModel(ai, { mode, onDeviceParams, inCloudParams })` across all four official `InferenceMode` strategies (`PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`, `PREFER_IN_CLOUD`, `ONLY_IN_CLOUD`).
  - Supports user-gesture `initializeDeviceModel(onDownloadProgress)` for Chrome's built-in Gemini Nano Prompt API, live capability detection via `LanguageModel.availability()`, and online/offline telemetry.
  - Displays transparent `InferenceBadge` tags (`Firebase On-device` vs `Firebase Cloud` + measured `latencyMs` + model identifier) on responses—never faking local execution when cloud fallback runs.
- **Chat**: Multi-turn threads synced to Cloud Firestore, Copy/Regenerate controls, image attachment multimodal analysis, voice dictation, and Live Voice modal.
- **Learn**:
  - *Language Learning*: AI conversation partner, vocabulary decks with mastery tracking, listening comprehension passages, adjustable audio playback speed (`0.75x`–`1.5x`), browser Web Speech fallback, and server Gemini audio pronunciation coaching.
  - *General Learning & Quiz*: Subject study notes, step-by-step tutoring with follow-up Q&A, schema-validated MCQ + short-answer quizzes, AI short-answer grading, **"Retry Same Quiz"**, and Firestore Quiz History.
- **Create**:
  - *Write & Rewrite*: Draft, rewrite, condense, expand, and proofread in multiple tones with Firestore `createDrafts` persistence.
  - *Brainstorm & Plan*: Generate structured execution plans and idea lists saved to `createDrafts`.
  - *Code Studio*: Multi-language editor with in-browser JS execution, sandboxed HTML preview, AI execution tracing, Firestore `codeSnippets` sync, and Nimo debugging/refactoring.
- **Security & Privacy**:
  - Strict owner-isolated `firestore.rules` validated with `@firebase/eslint-plugin-security-rules`.
  - In-app **Privacy & Data Controls** modal disclosing local vs cloud vs speech processing and enabling one-click deletion of all user Firestore records and Firebase Auth account.

---

## B. 3-Minute YouTube Demo Video Script & Shot Plan

**Target Duration**: 2:55 (max 3:00)

- **0:00 – 0:25 | Intro & Architecture Overview**
  - *Screen*: Nimo header (`Chat`, `Learn`, `Create`), click **Hybrid Setup** button.
  - *Voiceover*: "Hi, I'm presenting Nimo for #BuildHybridAI 2026. Nimo is a three-session AI learning and creation studio built on Firebase AI Logic Hybrid Inference, Auth, Firestore, and App Check."
  - *Action*: Show Chrome on-device capability check, `Prefer On-Device` / `On-Device Only` / `Cloud Only` selector, and click **Initialize On-Device Model** (showing progress bar when downloading in Chrome 139+ or capability status).
- **0:25 – 1:05 | Session 1: Chat (On-Device & Cloud Fallback)**
  - *Screen*: Switch to `Prefer On-Device` or `On-Device Only`, send a prompt in **Chat**.
  - *Voiceover*: "Every reply displays its true execution path—either `Firebase On-device` via Gemini Nano or `Firebase Cloud` fallback with real measured latency. Users can copy, regenerate, attach an image for cloud multimodal analysis, or open Live Voice."
  - *Action*: Point out `InferenceBadge` (`Firebase On-device` / `Firebase Cloud`, `ms`), demonstrate Copy & Regenerate, and open a synced thread in the sidebar.
- **1:05 – 2:00 | Session 2: Learn (Language Audio + General Learning & Quiz)**
  - *Screen*: Click **Learn** tab.
  - *Voiceover*: "In Learn, Nimo combines hybrid text generation with genuine browser & server speech APIs."
  - *Action*:
    1. In *Language Learning*, generate a Spanish Vocabulary deck, toggle playback speed (`0.75x`), click speaker icon to play pronunciation, and mark a card Mastered.
    2. Switch to *General Learning & Quiz*, generate a 4-question quiz, answer questions, submit to see AI short-answer grading, click **Teach Step-by-Step**, and highlight **Retry Same Quiz** + Firestore Quiz History.
- **2:00 – 2:40 | Session 3: Create (Writing, Planning & Code Studio)**
  - *Screen*: Click **Create** tab.
  - *Voiceover*: "Create unifies content drafting, project planning, and coding assistance without adding a fourth navigation tab."
  - *Action*: Generate a short launch brief in *Write & Rewrite*, save to Firestore `createDrafts`, switch to *Code Studio*, click **Run** on JavaScript binary search, and run **Explain** via Hybrid Inference.
- **2:40 – 3:00 | Privacy, Security & Wrap-Up**
  - *Screen*: Click Shield icon (**Privacy & Data Controls**) -> close -> show `firestore.rules` / `npm test`.
  - *Voiceover*: "Every collection is guarded by ESLint-verified Firestore security rules, App Check integration, and one-click user data deletion. Thanks for watching!"

---

## C. Judge Testing Instructions

1. **Standard Browser Test (Cloud Fallback Path)**:
   - Open the deployed/preview URL or run `npm run dev` locally.
   - Sign in with Google (or test immediately in Guest Mode; sign in to verify Firestore persistence across page reloads).
   - Open **Hybrid Setup** in the header: observe live browser capability, App Check status, and online/offline detection.
   - Run prompts in **Chat**, generate Vocabulary & Quiz in **Learn**, and generate a Draft + run JavaScript in **Create**. Confirm every AI card displays `Firebase Cloud · gemini-3.5-flash-lite · <latency> ms`.
2. **Testing Chrome On-Device Gemini Nano Execution**:
   - Use **Chrome Desktop 139+** with:
     - `chrome://flags/#optimization-guide-on-device-model` -> Enabled
     - `chrome://flags/#prompt-api-for-gemini-nano` -> Enabled
   - Relaunch Chrome, open **Hybrid Setup**, and click **Initialize On-Device Model** (triggers `model.initializeDeviceModel()`).
   - Select **On-Device Only** (`only_on_device`) or **Prefer On-Device** (`prefer_on_device`), optionally toggle DevTools Network -> Offline, and send a text prompt in **Chat** or **Create**. Confirm the response badge reads **`Firebase On-device · gemini-nano (on-device)`**.
3. **Testing Audio & Speech Edge Cases**:
   - In **Learn -> Language Learning**, test adjustable speeds (`0.75x`, `1.0x`, `1.25x`, `1.5x`).
   - Block microphone permission in browser settings and click **Speak** -> verify clear permission error message while text input and audio playback remain usable.
4. **Testing Account Privacy & Deletion**:
   - Create a chat thread or draft while signed in, open **Privacy & Data Controls** (Shield icon), type `DELETE`, and verify Firestore records are deleted cleanly.

---

## D. Firebase #BuildHybridAI 2026 Devpost Official Rules Checklist

| Requirement | Status in Nimo | Notes |
| --- | --- | --- |
| Uses Firebase AI Logic Hybrid Inference SDK (`firebase/ai`) | Implemented | `getAI`, `GoogleAIBackend`, `getGenerativeModel`, `InferenceMode`, `InferenceSource`, `initializeDeviceModel` in `src/services/hybridAi.ts` |
| Genuine Hybrid Routing (`on_device` + `in_cloud` fallback) | Implemented | Transparent `InferenceBadge` reports actual `result.response.inferenceSource` |
| Firebase Services Integration | Implemented & Provisioned | Firebase Auth (Google), Cloud Firestore (`ai-studio-8ae82617-89b0-435d-82c5-b913ca2816fd`), App Check (`src/firebase.ts`), Hosting config (`firebase.json`) |
| Hardened Security Rules | Implemented, Linted & Deployed | `firestore.rules` verified with `eslint` + `@firebase/eslint-plugin-security-rules` and deployed via `DeployRules` |
| Open-Source License | Included | `LICENSE` (Apache-2.0) |
| Publicly Accessible Live App / Repo + 3-min Demo Video | Ready for Final Submission | Deploy static hosting with `firebase deploy --only hosting` and record the 3-minute script in Section B |
| Automated Tests & Build Checks | Included | `tests/*.test.ts`, `npm run lint`, `npm run rules:lint`, `npm run build` |
