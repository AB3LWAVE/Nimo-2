import { CreateDraftCategory } from '../types';

export const TONE_SUGGESTIONS = [
  'professional',
  'friendly',
  'conversational',
  'persuasive',
  'academic',
  'concise',
  'creative',
  'formal',
  'empathetic',
] as const;

export const ACTION_SUGGESTIONS = [
  'rewrite',
  'summarize',
  'expand',
  'simplify',
  'improve',
  'translate',
  'explain',
  'brainstorm',
  'proofread',
  'generate',
] as const;

export function filterComboboxSuggestions(
  suggestions: readonly string[],
  query: string
): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...suggestions];
  }
  return suggestions.filter((item) => item.toLowerCase().includes(normalized));
}

export interface WritingPromptInput {
  action: string;
  tone: string;
  instructions: string;
  sourceText: string;
}

export interface WritingPromptOutput {
  category: CreateDraftCategory;
  prompt: string;
  isRewriteMode: boolean;
}

export function buildWritingStudioPrompt({
  action,
  tone,
  instructions,
  sourceText,
}: WritingPromptInput): WritingPromptOutput {
  const safeAction = action.trim() || 'rewrite';
  const normalizedAction = safeAction.toLowerCase();
  const safeTone = tone.trim() || 'professional';
  const normalizedTone = safeTone.toLowerCase();
  const trimmedInstructions = instructions.trim();
  const trimmedSource = sourceText.trim();

  const isGenerateOnly =
    normalizedAction === 'generate' || normalizedAction === 'draft';
  const isRewriteMode = !isGenerateOnly && trimmedSource.length > 0;
  const category: CreateDraftCategory = isRewriteMode ? 'rewrite' : 'writing';

  const knownDirectives: Record<string, { rewrite: string; fresh: string }> = {
    generate: {
      rewrite: `Write a polished, original ${normalizedTone} draft based on the user's request.`,
      fresh: `Write a polished, original ${normalizedTone} draft based on the user's request.`,
    },
    draft: {
      rewrite: `Write a polished, original ${normalizedTone} draft based on the user's request.`,
      fresh: `Write a polished, original ${normalizedTone} draft based on the user's request.`,
    },
    rewrite: {
      rewrite: `Rewrite the provided text in a ${normalizedTone} tone while preserving key meaning.`,
      fresh: `Write a clear, original piece in a ${normalizedTone} tone based on the prompt.`,
    },
    summarize: {
      rewrite: `Summarize the provided text concisely in a ${normalizedTone} tone, highlighting the main points.`,
      fresh: `Provide a concise ${normalizedTone} summary addressing the topic below.`,
    },
    condense: {
      rewrite: `Condense the provided text into a crisp, high-impact ${normalizedTone} version.`,
      fresh: `Write a crisp, condensed ${normalizedTone} overview based on the topic below.`,
    },
    expand: {
      rewrite: `Expand the provided text with clear examples, transitions, and detail in a ${normalizedTone} tone.`,
      fresh: `Write an expanded, detailed ${normalizedTone} piece with examples based on the prompt below.`,
    },
    simplify: {
      rewrite: `Simplify the provided text so it is easy to read and understand, using a ${normalizedTone} tone.`,
      fresh: `Explain the topic below in simple, accessible language with a ${normalizedTone} tone.`,
    },
    improve: {
      rewrite: `Improve the clarity, structure, word choice, and flow of the provided text in a ${normalizedTone} tone.`,
      fresh: `Write a refined, well-structured ${normalizedTone} piece based on the prompt below.`,
    },
    polish: {
      rewrite: `Proofread and polish the provided text for grammar, flow, clarity, and impact (${normalizedTone} tone).`,
      fresh: `Write a polished ${normalizedTone} draft based on the prompt below.`,
    },
    translate: {
      rewrite: `Translate the provided text accurately while preserving a ${normalizedTone} tone (follow any target language noted in the instructions).`,
      fresh: `Translate or write the requested content in a ${normalizedTone} tone according to the instructions below.`,
    },
    explain: {
      rewrite: `Explain the provided text clearly in a ${normalizedTone} tone.`,
      fresh: `Explain the topic below clearly in a ${normalizedTone} tone.`,
    },
    brainstorm: {
      rewrite: `Brainstorm practical ideas, angles, and variations based on the provided text in a ${normalizedTone} tone.`,
      fresh: `Brainstorm distinct, practical ideas for the topic below in a ${normalizedTone} tone.`,
    },
    proofread: {
      rewrite: `Proofread the provided text for spelling, grammar, punctuation, and clarity while keeping a ${normalizedTone} tone.`,
      fresh: `Proofread and refine the text in the prompt below while keeping a ${normalizedTone} tone.`,
    },
  };

  const directiveSet = knownDirectives[normalizedAction];

  if (isRewriteMode) {
    const directive = directiveSet
      ? directiveSet.rewrite
      : `Perform the "${safeAction}" action on the provided text using a ${normalizedTone} tone.`;
    return {
      category,
      isRewriteMode: true,
      prompt: `${directive}\n\nAction: ${safeAction}\nTone: ${safeTone}\nAdditional instruction: ${trimmedInstructions || 'None'}\n\nSource text:\n${trimmedSource}`,
    };
  }

  const directive = directiveSet
    ? directiveSet.fresh
    : `Perform the "${safeAction}" action in a ${normalizedTone} tone based on the user's topic/brief below.`;

  return {
    category,
    isRewriteMode: false,
    prompt: `${directive}\n\nAction: ${safeAction}\nTone: ${safeTone}\nTopic / Brief:\n${trimmedInstructions || trimmedSource}`,
  };
}
