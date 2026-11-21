import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  ThinkingLevel,
  Type,
} from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverAiClient: GoogleGenAI | null = null;

function hasConfiguredServerGeminiKey(): boolean {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY');
}

function getServerAi(): GoogleGenAI {
  if (!hasConfiguredServerGeminiKey()) {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Set GEMINI_API_KEY in AI Studio Secrets or .env to use server-side Audio TTS, Speech-to-Text, and Live Voice.'
    );
  }
  if (!serverAiClient) {
    serverAiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return serverAiClient;
}

const PAID_MODELS = new Set(['gemini-4-carbon', 'gemini-4-neon']);

function formatGeminiError(err: unknown, model: string) {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const lower = rawMessage.toLowerCase();
  const isBillingRequired =
    PAID_MODELS.has(model) &&
    (lower.includes('429') ||
      lower.includes('resource_exhausted') ||
      lower.includes('403') ||
      lower.includes('permission_denied') ||
      lower.includes('billing') ||
      lower.includes('quota'));

  let status = 500;
  if (lower.includes('api_key_invalid') || lower.includes('invalid api key')) {
    status = 400;
  } else if (lower.includes('permission_denied') || lower.includes('403')) {
    status = 403;
  } else if (lower.includes('not_found') || lower.includes('404')) {
    status = 404;
  } else if (lower.includes('resource_exhausted') || lower.includes('429')) {
    status = 429;
  }

  let message = rawMessage;
  if (isBillingRequired) {
    message = `Model "${model}" requires a billing-enabled Gemini API key in Settings > Secrets. Switch to Balanced (gemini-4-hydrogen) or Fast (gemini-3.1-flash-lite) mode, or attach a paid API key.`;
  } else if (status === 400 || lower.includes('api key')) {
    message = 'Gemini API key is missing or invalid. Check Settings > Secrets.';
  }

  return { status, message, model, isBillingRequired };
}

async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (retries > 0 && (msg.includes('503') || msg.includes('unavailable') || msg.includes('timeout'))) {
      await new Promise((r) => setTimeout(r, 600));
      return withRetry(fn, retries - 1);
    }
    throw err;
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, assistant: 'Nimo' });
  });

  // 1. Multi-turn Chat & Image Analysis
  app.post('/api/chat', async (req, res) => {
    const {
      history = [],
      prompt = '',
      mode = 'balanced',
      image,
      fallbackToStandard = false,
    } = req.body as {
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      prompt: string;
      mode?: 'fast' | 'balanced' | 'thinking' | 'vision';
      image?: { data: string; mimeType: string };
      fallbackToStandard?: boolean;
    };

    if (!prompt.trim() && !image) {
      res.status(400).json({ error: 'Prompt or image is required.' });
      return;
    }

    let model = 'gemini-4-hydrogen';
    if (!fallbackToStandard) {
      if (image || mode === 'vision') {
        model = 'gemini-4-neon';
      } else if (mode === 'thinking') {
        model = 'gemini-4-carbon';
      } else if (mode === 'fast') {
        model = 'gemini-3.1-flash-lite';
      }
    }

    const systemInstruction =
      'You are Nimo, a sharp, encouraging AI tutor, language mentor, and software engineering companion. Give clear, accurate, well-structured answers tailored to the user. Use markdown with fenced code blocks where helpful.';

    const contents = [
      ...history.slice(-16).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      {
        role: 'user',
        parts: [
          ...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.data } }] : []),
          { text: prompt.trim() || 'Analyze this image in detail.' },
        ],
      },
    ];

    const config: Record<string, unknown> = {
      systemInstruction,
    };

    if (model === 'gemini-4-carbon') {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
    } else if (model === 'gemini-3.1-flash-lite') {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
    }

    try {
      const response = await withRetry(() =>
        getServerAi().models.generateContent({
          model,
          contents,
          config,
        })
      );
      res.json({
        text: response.text ?? '',
        modelUsed: model,
      });
    } catch (err) {
      const formatted = formatGeminiError(err, model);
      res.status(formatted.status).json(formatted);
    }
  });

  // 1b. Server Hybrid Fallback (used only when client firebase/ai cloud API is unavailable, e.g. Google-hosted Starter Tier projects)
  app.post('/api/hybrid/fallback', async (req, res) => {
    const {
      prompt = '',
      systemInstruction,
      history = [],
      temperature,
      image,
      jsonMode = false,
    } = req.body as {
      prompt?: string;
      systemInstruction?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      temperature?: number;
      image?: { base64: string; mimeType: string };
      jsonMode?: boolean;
    };

    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!trimmedPrompt && !image) {
      res.status(400).json({ error: 'Prompt or image input is required.' });
      return;
    }

    const safeHistory = Array.isArray(history) ? history.slice(-12) : [];
    const contents = [
      ...safeHistory.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content || '').slice(0, 8000) }],
      })),
      {
        role: 'user',
        parts: [
          ...(image?.base64 && image?.mimeType
            ? [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }]
            : []),
          { text: trimmedPrompt || 'Analyze this attached image.' },
        ],
      },
    ];

    const config: Record<string, unknown> = {
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    };

    const candidateModels = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];
    let lastErr: unknown = null;

    for (const model of candidateModels) {
      try {
        const response = await withRetry(() =>
          getServerAi().models.generateContent({
            model,
            contents,
            config,
          })
        );
        res.json({
          text: response.text ?? '',
          modelUsed: model,
        });
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
        if (msg.includes('503') || msg.includes('unavailable') || msg.includes('not_found')) {
          continue;
        }
        const formatted = formatGeminiError(err, model);
        res.status(formatted.status).json(formatted);
        return;
      }
    }

    const formatted = formatGeminiError(lastErr, candidateModels[0]);
    res.status(formatted.status).json(formatted);
  });

  // 2. Audio Transcription (gemini-3.5-transcribe)
  app.post('/api/audio/transcribe', async (req, res) => {
    const { audioBase64, mimeType = 'audio/webm', languageHint } = req.body as {
      audioBase64: string;
      mimeType?: string;
      languageHint?: string;
    };

    if (!audioBase64) {
      res.status(400).json({ error: 'Audio data is required for transcription.' });
      return;
    }

    const model = 'gemini-3.5-transcribe';
    try {
      const promptText = languageHint
        ? `Transcribe the spoken audio faithfully. Expected language: ${languageHint}. Return only the spoken transcript without extra commentary.`
        : 'Transcribe the spoken audio faithfully. Return only the spoken transcript without extra commentary.';

      const response = await withRetry(() =>
        getServerAi().models.generateContent({
          model,
          contents: {
            parts: [
              { inlineData: { mimeType, data: audioBase64 } },
              { text: promptText },
            ],
          },
        })
      );

      res.json({
        transcript: (response.text ?? '').trim(),
        modelUsed: model,
      });
    } catch (err) {
      const formatted = formatGeminiError(err, model);
      res.status(formatted.status).json(formatted);
    }
  });

  // 3. Text-to-Speech (gemini-3.8-flash-tts)
  app.post('/api/audio/tts', async (req, res) => {
    const {
      text,
      language = 'English',
      voiceName = 'Kore',
      style,
    } = req.body as {
      text: string;
      language?: string;
      voiceName?: string;
      style?: string;
    };

    if (!text || !text.trim()) {
      res.status(400).json({ error: 'Text is required for speech synthesis.' });
      return;
    }

    const model = 'gemini-3.8-flash-tts';
    const cleanText = text.replace(/```[\s\S]*?```/g, 'code snippet').slice(0, 2500);
    const speechStyle =
      style || `Clear, natural native ${language} tutor speaking at an articulate, steady pace`;

    try {
      const response = await withRetry(() =>
        getServerAi().models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: cleanText,
                  speechMetadata: {
                    style: speechStyle,
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        })
      );

      const audioBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioBase64) {
        res.status(502).json({ error: 'Speech service returned no audio data.', model });
        return;
      }

      res.json({
        audioBase64,
        mimeType: 'audio/wav',
        modelUsed: model,
      });
    } catch (err) {
      const formatted = formatGeminiError(err, model);
      res.status(formatted.status).json(formatted);
    }
  });

  // 4. Language Learning Actions
  app.post('/api/learn/language', async (req, res) => {
    const {
      action,
      targetLanguage = 'Spanish',
      level = 'Beginner',
      topic = 'Everyday Essentials',
      history = [],
      userMessage = '',
      targetPhrase = '',
      spokenTranscript = '',
      audioBase64,
      audioMimeType = 'audio/webm',
      fallbackToStandard = false,
    } = req.body as {
      action: 'vocab' | 'listening' | 'conversation' | 'pronunciation';
      targetLanguage?: string;
      level?: string;
      topic?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      userMessage?: string;
      targetPhrase?: string;
      spokenTranscript?: string;
      audioBase64?: string;
      audioMimeType?: string;
      fallbackToStandard?: boolean;
    };

    try {
      if (action === 'vocab') {
        const model = 'gemini-4-hydrogen';
        const response = await withRetry(() =>
          getServerAi().models.generateContent({
            model,
            contents: `Create 6 practical ${level}-level ${targetLanguage} vocabulary lessons on the topic "${topic}". Include accurate translations, learner-friendly phonetic pronunciation guides, and a natural contextual example sentence with its English translation.`,
            config: {
              systemInstruction: 'You are Nimo, an expert multilingual language tutor.',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    term: { type: Type.STRING },
                    translation: { type: Type.STRING },
                    phonetic: { type: Type.STRING },
                    exampleSentence: { type: Type.STRING },
                    exampleTranslation: { type: Type.STRING },
                  },
                  required: ['term', 'translation', 'phonetic', 'exampleSentence', 'exampleTranslation'],
                },
              },
            },
          })
        );
        res.json({ items: JSON.parse(response.text || '[]'), modelUsed: model });
        return;
      }

      if (action === 'listening') {
        const model = 'gemini-4-hydrogen';
        const response = await withRetry(() =>
          getServerAi().models.generateContent({
            model,
            contents: `Generate a ${level}-level ${targetLanguage} listening comprehension exercise about "${topic}". Provide a short spoken passage (4 to 6 natural sentences in ${targetLanguage}) and 3 multiple-choice comprehension questions in English testing details from the passage, each with 4 options and an explanation.`,
            config: {
              systemInstruction: 'You are Nimo, a language curriculum designer.',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  passageText: { type: Type.STRING },
                  questions: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        question: { type: Type.STRING },
                        options: { type: Type.ARRAY, items: { type: Type.STRING } },
                        correctIndex: { type: Type.INTEGER },
                        explanation: { type: Type.STRING },
                      },
                      required: ['question', 'options', 'correctIndex', 'explanation'],
                    },
                  },
                },
                required: ['title', 'passageText', 'questions'],
              },
            },
          })
        );
        res.json({ exercise: JSON.parse(response.text || '{}'), modelUsed: model });
        return;
      }

      if (action === 'conversation') {
        const model = 'gemini-4-hydrogen';
        const recentHistory = history
          .slice(-8)
          .map((m) => `${m.role === 'user' ? 'Learner' : 'Nimo'}: ${m.content}`)
          .join('\n');

        const response = await withRetry(() =>
          getServerAi().models.generateContent({
            model,
            contents: `Target language: ${targetLanguage}\nLearner level: ${level}\nConversation so far:\n${recentHistory || '(New conversation)'}\n\nLearner's latest message: "${userMessage}"\n\nRespond naturally in ${targetLanguage} appropriate for ${level} level, provide an English translation, give a gentle grammar or phrasing tip if helpful (empty string if spotless), and ask one engaging follow-up question in ${targetLanguage}.`,
            config: {
              systemInstruction: 'You are Nimo, a supportive conversational language tutor.',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  replyTargetLanguage: { type: Type.STRING },
                  replyEnglishTranslation: { type: Type.STRING },
                  gentleCorrection: { type: Type.STRING },
                  followUpPrompt: { type: Type.STRING },
                },
                required: [
                  'replyTargetLanguage',
                  'replyEnglishTranslation',
                  'gentleCorrection',
                  'followUpPrompt',
                ],
              },
            },
          })
        );
        res.json({ ...JSON.parse(response.text || '{}'), modelUsed: model });
        return;
      }

      if (action === 'pronunciation') {
        const model = fallbackToStandard ? 'gemini-4-hydrogen' : 'gemini-4-neon';
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
        if (audioBase64) {
          parts.push({ inlineData: { mimeType: audioMimeType, data: audioBase64 } });
        }
        parts.push({
          text: `Evaluate the learner's ${level}-level ${targetLanguage} spoken attempt.\nTarget phrase: "${targetPhrase}"\nTranscribed speech: "${spokenTranscript}"\nProvide: (1) transcriptObserved, (2) accuracyScore from 0 to 100, (3) clear pronunciationFeedback, (4) phoneticGuide for the target phrase, (5) specific corrections array (stress, vowels, consonants, pacing), and (6) an actionable practiceTip.`,
        });

        try {
          const response = await withRetry(() =>
            getServerAi().models.generateContent({
              model,
              contents: { parts },
              config: {
                systemInstruction:
                  'You are Nimo, an encouraging phonetics and pronunciation coach. Be specific and honest about what was heard versus the target phrase.',
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    transcriptObserved: { type: Type.STRING },
                    accuracyScore: { type: Type.INTEGER },
                    pronunciationFeedback: { type: Type.STRING },
                    phoneticGuide: { type: Type.STRING },
                    corrections: { type: Type.ARRAY, items: { type: Type.STRING } },
                    practiceTip: { type: Type.STRING },
                  },
                  required: [
                    'transcriptObserved',
                    'accuracyScore',
                    'pronunciationFeedback',
                    'phoneticGuide',
                    'corrections',
                    'practiceTip',
                  ],
                },
              },
            })
          );
          res.json({ ...JSON.parse(response.text || '{}'), modelUsed: model });
        } catch (err) {
          const formatted = formatGeminiError(err, model);
          res.status(formatted.status).json(formatted);
        }
        return;
      }

      res.status(400).json({ error: 'Unsupported language learning action.' });
    } catch (err) {
      const formatted = formatGeminiError(err, 'gemini-4-hydrogen');
      res.status(formatted.status).json(formatted);
    }
  });

  // 5. General Learning & Quiz Studio
  app.post('/api/learn/general', async (req, res) => {
    const {
      action,
      subject = 'General Science',
      topic = '',
      difficulty = 'Intermediate',
      questionCount = 5,
      questionPrompt = '',
      userAnswer = '',
      sampleAnswer = '',
      deepMode = false,
      fallbackToStandard = false,
    } = req.body as {
      action: 'study_notes' | 'explain_step_by_step' | 'generate_quiz' | 'grade_short_answer';
      subject?: string;
      topic?: string;
      difficulty?: string;
      questionCount?: number;
      questionPrompt?: string;
      userAnswer?: string;
      sampleAnswer?: string;
      deepMode?: boolean;
      fallbackToStandard?: boolean;
    };

    if (action === 'study_notes') {
      const model = deepMode && !fallbackToStandard ? 'gemini-4-carbon' : 'gemini-4-hydrogen';
      const config: Record<string, unknown> = {
        systemInstruction:
          'You are Nimo, a master academic tutor. Produce crisp, well-organized study notes using markdown headings, bulleted key concepts, worked examples, and a concise summary.',
      };
      if (model === 'gemini-4-carbon') {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
      }

      try {
        const response = await withRetry(() =>
          getServerAi().models.generateContent({
            model,
            contents: `Create comprehensive ${difficulty}-level study notes and a structured summary for:\nSubject: ${subject}\nTopic: ${topic}`,
            config,
          })
        );
        res.json({ title: `${subject}: ${topic}`, summaryMarkdown: response.text ?? '', modelUsed: model });
      } catch (err) {
        const formatted = formatGeminiError(err, model);
        res.status(formatted.status).json(formatted);
      }
      return;
    }

    if (action === 'explain_step_by_step') {
      const model = fallbackToStandard ? 'gemini-4-hydrogen' : 'gemini-4-carbon';
      const config: Record<string, unknown> = {
        systemInstruction:
          'You are Nimo, a patient step-by-step teacher. Break down complex problems into numbered logical steps, checking intuition and edge cases.',
      };
      if (model === 'gemini-4-carbon') {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
      }

      try {
        const response = await withRetry(() =>
          getServerAi().models.generateContent({
            model,
            contents: `Teach me step by step (${difficulty} level, subject: ${subject}):\n${topic}`,
            config,
          })
        );
        res.json({ explanation: response.text ?? '', modelUsed: model });
      } catch (err) {
        const formatted = formatGeminiError(err, model);
        res.status(formatted.status).json(formatted);
      }
      return;
    }

    if (action === 'generate_quiz') {
      const model = 'gemini-4-hydrogen';
      const safeCount = Math.min(Math.max(Number(questionCount) || 5, 2), 10);
      try {
        const response = await withRetry(() =>
          getServerAi().models.generateContent({
            model,
            contents: `Generate a ${safeCount}-question ${difficulty}-level quiz on "${topic}" (subject: ${subject}). Mix multiple-choice ("mcq", 4 options) and 1-2 short-answer ("short") practice questions. Provide clear step-by-step explanations for each question.`,
            config: {
              systemInstruction: 'You are Nimo, an educational assessment designer.',
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  questions: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        type: { type: Type.STRING, enum: ['mcq', 'short'] },
                        prompt: { type: Type.STRING },
                        options: { type: Type.ARRAY, items: { type: Type.STRING } },
                        correctIndex: { type: Type.INTEGER },
                        sampleAnswer: { type: Type.STRING },
                        explanation: { type: Type.STRING },
                      },
                      required: ['id', 'type', 'prompt', 'explanation'],
                    },
                  },
                },
                required: ['title', 'questions'],
              },
            },
          })
        );
        res.json({ ...JSON.parse(response.text || '{}'), modelUsed: model });
      } catch (err) {
        const formatted = formatGeminiError(err, model);
        res.status(formatted.status).json(formatted);
      }
      return;
    }

    if (action === 'grade_short_answer') {
      const model = 'gemini-3.1-flash-lite';
      try {
        const response = await withRetry(() =>
          getServerAi().models.generateContent({
            model,
            contents: `Question: ${questionPrompt}\nReference answer: ${sampleAnswer}\nStudent answer: ${userAnswer}\nGrade whether the student answer demonstrates understanding. Return JSON.`,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  isCorrect: { type: Type.BOOLEAN },
                  feedback: { type: Type.STRING },
                },
                required: ['isCorrect', 'feedback'],
              },
            },
          })
        );
        res.json({ ...JSON.parse(response.text || '{}'), modelUsed: model });
      } catch (err) {
        const formatted = formatGeminiError(err, model);
        res.status(formatted.status).json(formatted);
      }
      return;
    }

    res.status(400).json({ error: 'Unsupported general learning action.' });
  });

  // 6. Coding Session Assistant
  app.post('/api/coding/assist', async (req, res) => {
    const {
      action = 'explain',
      language = 'javascript',
      code = '',
      prompt = '',
      runtimeOutput = '',
      image,
      fallbackToStandard = false,
    } = req.body as {
      action: 'quick_fix' | 'explain' | 'debug_deep' | 'refactor' | 'image_to_code' | 'custom';
      language?: string;
      code?: string;
      prompt?: string;
      runtimeOutput?: string;
      image?: { data: string; mimeType: string };
      fallbackToStandard?: boolean;
    };

    let model = 'gemini-4-hydrogen';
    if (!fallbackToStandard) {
      if (image || action === 'image_to_code') {
        model = 'gemini-4-neon';
      } else if (action === 'debug_deep') {
        model = 'gemini-4-carbon';
      } else if (action === 'quick_fix') {
        model = 'gemini-3.1-flash-lite';
      }
    }

    const actionPrompts: Record<string, string> = {
      quick_fix: `Provide a concise, fast fix for any syntax or logic bugs in this ${language} code. Show the corrected code clearly.`,
      explain: `Explain how this ${language} code works step by step, highlighting key patterns and complexity.`,
      debug_deep: `Perform a thorough root-cause debugging and edge-case audit on this ${language} code. Identify subtle bugs, race conditions, or failure modes and provide a clean fixed version.`,
      refactor: `Refactor this ${language} code for clarity, maintainability, and best practices without changing behavior.`,
      image_to_code: `Analyze the attached screenshot or diagram and write clean ${language} code (or diagnose the error shown) accordingly.`,
      custom: prompt || `Help me with this ${language} code.`,
    };

    const instruction = actionPrompts[action] || actionPrompts.custom;
    const textContent = `${instruction}\n\n${prompt ? `User note: ${prompt}\n\n` : ''}Language: ${language}\n${
      runtimeOutput ? `Latest Output / Error:\n${runtimeOutput}\n\n` : ''
    }Code:\n\`\`\`${language}\n${code}\n\`\`\``;

    const config: Record<string, unknown> = {
      systemInstruction:
        'You are Nimo, a senior staff software engineer and coding mentor. Be precise, practical, and highlight exact fixes with clean code blocks.',
    };

    if (model === 'gemini-4-carbon') {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
    } else if (model === 'gemini-3.1-flash-lite') {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
    }

    try {
      const response = await withRetry(() =>
        getServerAi().models.generateContent({
          model,
          contents: {
            parts: [
              ...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.data } }] : []),
              { text: textContent },
            ],
          },
          config,
        })
      );

      res.json({
        reply: response.text ?? '',
        modelUsed: model,
      });
    } catch (err) {
      const formatted = formatGeminiError(err, model);
      res.status(formatted.status).json(formatted);
    }
  });

  // HTTP server + WebSocket bridge for Gemini Live API (gemini-3.8-live)
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws/live' });

  wss.on('connection', async (clientWs: WebSocket, req) => {
    const url = new URL(req.url || '/ws/live', 'http://localhost');
    const mode = url.searchParams.get('mode') || 'chat';
    const targetLanguage = url.searchParams.get('language') || 'Spanish';
    const level = url.searchParams.get('level') || 'Beginner';

    const systemInstruction =
      mode === 'language'
        ? `You are Nimo, an encouraging live ${targetLanguage} speaking tutor for a ${level}-level learner. Converse naturally in ${targetLanguage}, keep replies concise (2-3 sentences), gently correct pronunciation or grammar when needed, and invite the learner to respond.`
        : 'You are Nimo, a friendly, concise real-time voice AI assistant. Answer clearly and naturally.';

    let liveSession: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;

    try {
      liveSession = await getServerAi().live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction,
        },
        callbacks: {
          onopen: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ ready: true }));
            }
          },
          onmessage: (message: LiveServerMessage) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;
            const content = message.serverContent;
            if (content?.inputTranscription?.text) {
              clientWs.send(JSON.stringify({ inputTranscript: content.inputTranscription.text }));
            }
            if (content?.outputTranscription?.text) {
              clientWs.send(JSON.stringify({ outputTranscript: content.outputTranscription.text }));
            }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
              }
            }
            if (content?.interrupted) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
            if (content?.turnComplete) {
              clientWs.send(JSON.stringify({ turnComplete: true }));
            }
          },
          onerror: (err: unknown) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  error: err instanceof Error ? err.message : 'Live session error occurred.',
                })
              );
            }
          },
          onclose: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.close();
            }
          },
        },
      });
    } catch (err) {
      if (clientWs.readyState === WebSocket.OPEN) {
        const formatted = formatGeminiError(err, 'gemini-3.8-live');
        clientWs.send(JSON.stringify({ error: formatted.message }));
        clientWs.close();
      }
      return;
    }

    clientWs.on('message', (raw) => {
      if (!liveSession) return;
      try {
        const parsed = JSON.parse(raw.toString()) as { audio?: string; text?: string };
        if (parsed.audio) {
          liveSession.sendRealtimeInput({
            audio: { data: parsed.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (parsed.text) {
          liveSession.sendRealtimeInput({ text: parsed.text });
        }
      } catch {
        // Ignore malformed client frames
      }
    });

    clientWs.on('close', () => {
      try {
        liveSession?.close();
      } catch {
        // Ignore close errors
      }
      liveSession = null;
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    if (!hasConfiguredServerGeminiKey()) {
      console.warn(
        '[NIMO AI] GEMINI_API_KEY is not configured; server audio TTS/STT and Live Voice endpoints will return a setup error while Firebase AI Logic Hybrid Inference runs via client SDK.'
      );
    }
    console.log(`Nimo server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Nimo server:', err);
  process.exit(1);
});
