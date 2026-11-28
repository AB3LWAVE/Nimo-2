export type SessionTab = 'chat' | 'learn' | 'create';
export type LearnSubMode = 'language' | 'general';
export type CreateSubMode = 'write' | 'brainstorm' | 'code';
export type CreateDraftCategory = 'writing' | 'rewrite' | 'brainstorm' | 'plan';
export type ProficiencyLevel = 'Beginner' | 'Intermediate' | 'Advanced';

export type InferenceModePreference =
  | 'prefer_on_device'
  | 'only_on_device'
  | 'prefer_in_cloud'
  | 'only_in_cloud';

export type LegacyChatModelMode = 'fast' | 'balanced' | 'thinking' | 'vision';
export type ChatModelMode = InferenceModePreference | LegacyChatModelMode;

export type HybridInferenceSource = 'on_device' | 'in_cloud';
export type SdkInferenceSource = 'ON_DEVICE' | 'IN_CLOUD';
export type MessageInferenceSource = HybridInferenceSource | 'server_multimodal' | 'user';

export type OnDeviceAvailabilityState =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported';

export type AppCheckStatus =
  | 'active-recaptcha-v3'
  | 'active-recaptcha-enterprise'
  | 'unconfigured-site-key'
  | 'error';

export interface HybridRuntimeStatus {
  browserSupported: boolean;
  onDeviceAvailability: OnDeviceAvailabilityState;
  online: boolean;
  downloadProgress: number | null;
  isDownloading: boolean;
  deviceModelReady: boolean;
  appCheckStatus: AppCheckStatus;
  appCheckError?: string | null;
  cloudModel: string;
  lastInferenceSource: SdkInferenceSource | null;
  lastModelUsed: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
}

export interface HybridGenerationResult {
  text: string;
  inferenceSource: HybridInferenceSource;
  sdkInferenceSource: SdkInferenceSource;
  modelUsed: string;
  latencyMs: number;
  modeUsed: InferenceModePreference;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  photoURL?: string;
  preferredTheme: 'light' | 'dark';
  targetLanguage: string;
  proficiencyLevel: ProficiencyLevel;
}

export interface ChatThread {
  id: string;
  ownerId: string;
  title: string;
  modelMode: ChatModelMode;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ChatMessage {
  id: string;
  ownerId: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  modelUsed: string;
  inferenceSource?: MessageInferenceSource;
  latencyMs?: number;
  hasImage: boolean;
  imagePreview?: string;
  createdAt?: unknown;
}

export interface VocabItem {
  id: string;
  ownerId: string;
  language: string;
  level: ProficiencyLevel;
  term: string;
  translation: string;
  phonetic: string;
  exampleSentence: string;
  exampleTranslation: string;
  mastered: boolean;
  createdAt?: unknown;
}

export interface ListeningQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface ListeningExercise {
  title: string;
  passageText: string;
  questions: ListeningQuestion[];
}

export interface LanguageConversationReply {
  replyTargetLanguage: string;
  replyEnglishTranslation: string;
  gentleCorrection: string;
  followUpPrompt: string;
}

export interface PronunciationEvaluation {
  transcriptObserved: string;
  accuracyScore: number;
  pronunciationFeedback: string;
  phoneticGuide: string;
  corrections: string[];
  practiceTip: string;
  modelUsed?: string;
}

export interface StudyNote {
  id: string;
  ownerId: string;
  subject: string;
  title: string;
  summaryMarkdown: string;
  createdAt?: unknown;
}

export interface QuizQuestion {
  id: string;
  type: 'mcq' | 'short';
  prompt: string;
  options?: string[];
  correctIndex?: number;
  sampleAnswer?: string;
  explanation: string;
}

export interface GeneratedQuiz {
  title: string;
  questions: QuizQuestion[];
}

export interface ShortAnswerGrade {
  isCorrect: boolean;
  feedback: string;
}

export interface QuizAttempt {
  id: string;
  ownerId: string;
  topic: string;
  difficulty: ProficiencyLevel;
  score: number;
  totalQuestions: number;
  summaryText: string;
  questions?: QuizQuestion[];
  mcqSelections?: Record<string, number>;
  shortAnswers?: Record<string, string>;
  shortGrades?: Record<string, ShortAnswerGrade>;
  createdAt?: unknown;
}

export interface CodeSnippet {
  id: string;
  ownerId: string;
  title: string;
  language: string;
  code: string;
  lastOutput: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CreateDraft {
  id: string;
  ownerId: string;
  category: CreateDraftCategory;
  title: string;
  content: string;
  inferenceSource?: HybridInferenceSource;
  createdAt?: unknown;
  updatedAt?: unknown;
}
