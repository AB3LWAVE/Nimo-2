export type SessionTab = 'chat' | 'learn' | 'coding';
export type LearnSubMode = 'language' | 'general';
export type ProficiencyLevel = 'Beginner' | 'Intermediate' | 'Advanced';
export type ChatModelMode = 'fast' | 'balanced' | 'thinking' | 'vision';

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

export interface QuizAttempt {
  id: string;
  ownerId: string;
  topic: string;
  difficulty: ProficiencyLevel;
  score: number;
  totalQuestions: number;
  summaryText: string;
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
