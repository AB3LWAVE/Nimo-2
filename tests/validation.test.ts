import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractAndParseJson,
  scoreMcqQuestions,
  truncateConversationHistory,
  validateLanguageConversationReply,
  validateListeningExercise,
  validateQuizPayload,
  validateShortAnswerGrade,
  validateVocabItems,
} from '../src/utils/validation.ts';

test('extractAndParseJson strips markdown code fences and surrounding prose', () => {
  const raw = `Here is the JSON result:\n\`\`\`json\n{"title":"Physics","count":3}\n\`\`\`\nHope that helps!`;
  const parsed = extractAndParseJson<{ title: string; count: number }>(raw);
  assert.equal(parsed.title, 'Physics');
  assert.equal(parsed.count, 3);
});

test('extractAndParseJson throws on empty or non-JSON text', () => {
  assert.throws(() => extractAndParseJson(''), /empty response/i);
  assert.throws(() => extractAndParseJson('Not JSON at all'), /malformed JSON/i);
});

test('validateQuizPayload validates valid MCQs + short questions and drops malformed MCQs', () => {
  const raw = {
    title: 'Algorithms Check',
    questions: [
      {
        id: 'q1',
        type: 'mcq',
        prompt: 'What is binary search complexity?',
        options: ['O(1)', 'O(log n)', 'O(n)', 'O(n^2)'],
        correctIndex: 1,
        explanation: 'Halves search space each step.',
      },
      {
        id: 'q-bad',
        type: 'mcq',
        prompt: 'Invalid out-of-range index',
        options: ['A', 'B'],
        correctIndex: 5,
        explanation: 'Bad question',
      },
      {
        id: 'q2',
        type: 'short',
        prompt: 'Explain memoization.',
        sampleAnswer: 'Caching function results.',
        explanation: 'Avoids recomputing overlapping subproblems.',
      },
    ],
  };

  const validated = validateQuizPayload(raw, 'Fallback');
  assert.equal(validated.title, 'Algorithms Check');
  assert.equal(validated.questions.length, 2);
  assert.equal(validated.questions[0].id, 'q1');
  assert.equal(validated.questions[1].type, 'short');
});

test('validateQuizPayload rejects empty or completely invalid question sets', () => {
  assert.throws(() => validateQuizPayload({ title: 'Empty', questions: [] }, 'Fallback'));
  assert.throws(() =>
    validateQuizPayload(
      {
        title: 'All invalid',
        questions: [{ id: '1', type: 'mcq', prompt: 'Bad', options: ['OnlyOne'], correctIndex: 0 }],
      },
      'Fallback'
    )
  );
});

test('validateVocabItems handles array or { items } wrapper and truncates safely', () => {
  const result = validateVocabItems({
    items: [
      {
        term: 'Buenos días',
        translation: 'Good morning',
        phonetic: 'BWEH-nohs DEE-ahs',
        exampleSentence: 'Buenos días, ¿cómo está?',
        exampleTranslation: 'Good morning, how are you?',
      },
      { term: '', translation: 'Missing term should be skipped' },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].term, 'Buenos días');
});

test('validateListeningExercise enforces passage and valid questions', () => {
  const ex = validateListeningExercise(
    {
      title: 'Market Dialogue',
      passageText: 'Hola, quiero dos manzanas por favor.',
      questions: [
        {
          question: 'What does the speaker want?',
          options: ['Two apples', 'Three oranges', 'Water', 'Bread'],
          correctIndex: 0,
          explanation: 'Dos manzanas means two apples.',
        },
      ],
    },
    'Fallback'
  );
  assert.equal(ex.questions.length, 1);
  assert.throws(() => validateListeningExercise({ title: 'No passage', questions: [] }, 'F'));
});

test('validateLanguageConversationReply & validateShortAnswerGrade handle clean shapes', () => {
  const reply = validateLanguageConversationReply({
    replyTargetLanguage: '¡Muy bien!',
    replyEnglishTranslation: 'Very good!',
    gentleCorrection: '',
    followUpPrompt: '¿Qué hiciste hoy?',
  });
  assert.equal(reply.replyTargetLanguage, '¡Muy bien!');

  const grade = validateShortAnswerGrade({ isCorrect: true, feedback: 'Accurate summary.' });
  assert.equal(grade.isCorrect, true);
  assert.equal(grade.feedback, 'Accurate summary.');
});

test('scoreMcqQuestions computes exact MCQ score', () => {
  const { mcqScore, mcqTotal } = scoreMcqQuestions(
    [
      { id: '1', type: 'mcq', prompt: 'P1', options: ['A', 'B'], correctIndex: 0, explanation: 'E1' },
      { id: '2', type: 'mcq', prompt: 'P2', options: ['A', 'B'], correctIndex: 1, explanation: 'E2' },
      { id: '3', type: 'short', prompt: 'P3', sampleAnswer: 'S', explanation: 'E3' },
    ],
    { '1': 0, '2': 0 }
  );
  assert.equal(mcqTotal, 2);
  assert.equal(mcqScore, 1);
});

test('truncateConversationHistory respects maxTurns and maxTotalChars', () => {
  const history = Array.from({ length: 12 }, (_, idx) => ({
    role: idx % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${idx}-${'x'.repeat(100)}`,
  }));
  const truncated = truncateConversationHistory(history, 6, 350);
  assert.ok(truncated.length <= 3);
  assert.equal(truncated[truncated.length - 1].content.startsWith('msg-11'), true);
});
