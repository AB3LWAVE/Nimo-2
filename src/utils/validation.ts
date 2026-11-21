import type {
  GeneratedQuiz,
  LanguageConversationReply,
  ListeningExercise,
  QuizQuestion,
  ShortAnswerGrade,
} from '../types';

export interface VocabLessonItemDraft {
  term: string;
  translation: string;
  phonetic: string;
  exampleSentence: string;
  exampleTranslation: string;
}

/**
 * Extracts and parses a JSON object or array from model output,
 * stripping optional markdown code fences or surrounding prose.
 */
export function extractAndParseJson<T = unknown>(rawText: string): T {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    throw new Error('The AI returned an empty response instead of structured JSON.');
  }

  // Try direct parse first
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Continue to fence / bracket extraction
  }

  // Strip ```json ... ``` fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // Fall through to bracket search
    }
  }

  // Locate outermost JSON object or array
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  let start = -1;
  let openChar = '{';
  let closeChar = '}';

  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    openChar = '[';
    closeChar = ']';
  } else if (firstObj !== -1) {
    start = firstObj;
  }

  if (start !== -1) {
    const end = trimmed.lastIndexOf(closeChar);
    if (end > start && trimmed[start] === openChar) {
      const candidate = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // Ignore and throw readable error below
      }
    }
  }

  throw new Error('NIMO AI returned malformed JSON. Please retry the generation.');
}

export function validateQuizPayload(raw: unknown, fallbackTitle: string): GeneratedQuiz {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Generated quiz did not match expected object schema.');
  }
  const obj = raw as Record<string, unknown>;
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  if (rawQuestions.length === 0) {
    throw new Error('Generated quiz contained zero questions. Please try again.');
  }

  const validQuestions: QuizQuestion[] = [];
  rawQuestions.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const q = item as Record<string, unknown>;
    const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : '';
    const explanation =
      typeof q.explanation === 'string' && q.explanation.trim()
        ? q.explanation.trim()
        : 'Review the core concept above.';
    const rawType = q.type === 'short' ? 'short' : 'mcq';
    const id =
      typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q-${index + 1}`;

    if (!prompt) return;

    if (rawType === 'mcq') {
      const options = Array.isArray(q.options)
        ? q.options
            .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            .map((o) => o.trim())
        : [];
      const correctIdx =
        typeof q.correctIndex === 'number' && Number.isInteger(q.correctIndex)
          ? q.correctIndex
          : -1;

      if (options.length < 2 || correctIdx < 0 || correctIdx >= options.length) {
        return; // Reject malformed MCQ question
      }
      validQuestions.push({
        id,
        type: 'mcq',
        prompt,
        options,
        correctIndex: correctIdx,
        explanation,
      });
    } else {
      const sampleAnswer =
        typeof q.sampleAnswer === 'string' && q.sampleAnswer.trim()
          ? q.sampleAnswer.trim()
          : explanation;
      validQuestions.push({
        id,
        type: 'short',
        prompt,
        sampleAnswer,
        explanation,
      });
    }
  });

  if (validQuestions.length === 0) {
    throw new Error('Generated quiz failed validation (missing valid options or answer keys).');
  }

  const title =
    typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim().slice(0, 140)
      : fallbackTitle.slice(0, 140);

  return { title, questions: validQuestions };
}

export function validateVocabItems(raw: unknown): VocabLessonItemDraft[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : null;

  if (!arr || arr.length === 0) {
    throw new Error('Vocabulary generation returned no items.');
  }

  const valid: VocabLessonItemDraft[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const term = typeof e.term === 'string' ? e.term.trim() : '';
    const translation = typeof e.translation === 'string' ? e.translation.trim() : '';
    if (!term || !translation) continue;
    valid.push({
      term: term.slice(0, 160),
      translation: translation.slice(0, 200),
      phonetic: typeof e.phonetic === 'string' ? e.phonetic.trim().slice(0, 200) : '',
      exampleSentence:
        typeof e.exampleSentence === 'string' ? e.exampleSentence.trim().slice(0, 400) : '',
      exampleTranslation:
        typeof e.exampleTranslation === 'string' ? e.exampleTranslation.trim().slice(0, 400) : '',
    });
  }

  if (valid.length === 0) {
    throw new Error('Vocabulary items were incomplete. Please retry.');
  }
  return valid;
}

export function validateListeningExercise(
  raw: unknown,
  fallbackTitle: string
): ListeningExercise {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Listening exercise did not match expected format.');
  }
  const obj = raw as Record<string, unknown>;
  const passageText = typeof obj.passageText === 'string' ? obj.passageText.trim() : '';
  if (!passageText) {
    throw new Error('Listening passage was empty. Please regenerate.');
  }

  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  const questions = rawQuestions
    .map((q) => {
      if (!q || typeof q !== 'object') return null;
      const item = q as Record<string, unknown>;
      const question = typeof item.question === 'string' ? item.question.trim() : '';
      const options = Array.isArray(item.options)
        ? item.options
            .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            .map((o) => o.trim())
        : [];
      const correctIndex =
        typeof item.correctIndex === 'number' && Number.isInteger(item.correctIndex)
          ? item.correctIndex
          : -1;
      const explanation =
        typeof item.explanation === 'string' && item.explanation.trim()
          ? item.explanation.trim()
          : 'Listen closely to the key details in the passage.';
      if (!question || options.length < 2 || correctIndex < 0 || correctIndex >= options.length) {
        return null;
      }
      return { question, options, correctIndex, explanation };
    })
    .filter((q): q is NonNullable<typeof q> => q !== null);

  if (questions.length === 0) {
    throw new Error('Listening comprehension questions failed validation.');
  }

  const title =
    typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim()
      : fallbackTitle;

  return { title, passageText, questions };
}

export function validateLanguageConversationReply(raw: unknown): LanguageConversationReply {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Conversation response was invalid.');
  }
  const obj = raw as Record<string, unknown>;
  const replyTargetLanguage =
    typeof obj.replyTargetLanguage === 'string' ? obj.replyTargetLanguage.trim() : '';
  if (!replyTargetLanguage) {
    throw new Error('Language tutor returned an empty reply.');
  }
  return {
    replyTargetLanguage,
    replyEnglishTranslation:
      typeof obj.replyEnglishTranslation === 'string' ? obj.replyEnglishTranslation.trim() : '',
    gentleCorrection:
      typeof obj.gentleCorrection === 'string' ? obj.gentleCorrection.trim() : '',
    followUpPrompt:
      typeof obj.followUpPrompt === 'string' ? obj.followUpPrompt.trim() : '',
  };
}

export function validateShortAnswerGrade(raw: unknown): ShortAnswerGrade {
  if (!raw || typeof raw !== 'object') {
    return { isCorrect: false, feedback: 'Could not verify answer structure.' };
  }
  const obj = raw as Record<string, unknown>;
  return {
    isCorrect: Boolean(obj.isCorrect),
    feedback:
      typeof obj.feedback === 'string' && obj.feedback.trim()
        ? obj.feedback.trim()
        : 'Answer evaluated.',
  };
}

export function scoreMcqQuestions(
  questions: QuizQuestion[],
  selections: Record<string, number>
): { mcqScore: number; mcqTotal: number } {
  let mcqScore = 0;
  let mcqTotal = 0;
  for (const q of questions) {
    if (q.type === 'mcq') {
      mcqTotal += 1;
      if (selections[q.id] === q.correctIndex) {
        mcqScore += 1;
      }
    }
  }
  return { mcqScore, mcqTotal };
}

export function truncateConversationHistory<T extends { role: string; content: string }>(
  history: T[],
  maxTurns = 10,
  maxTotalChars = 8000
): T[] {
  const recent = history.slice(-maxTurns);
  const kept: T[] = [];
  let charCount = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i];
    const len = item.content.length;
    if (kept.length > 0 && charCount + len > maxTotalChars) {
      break;
    }
    kept.unshift(item);
    charCount += len;
  }
  return kept;
}
