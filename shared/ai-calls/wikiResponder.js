import { createStructuredResponse } from './openaiResponses.js';
import { assembleBrainContext } from './brainSelector.js';
import { getGame } from './gameLibrary.js';

const answerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'answer', 'used_memory'],
  properties: {
    title: { type: 'string' },
    answer: { type: 'string' },
    used_memory: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'group', 'reason'],
        properties: {
          section: { type: 'string' },
          group: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

export async function answerWikiQuestion({ gameId = 'VIPBaloot', question = '' } = {}) {
  const cleanQuestion = String(question || '').trim();

  if (!cleanQuestion) {
    throw new Error('Ask the wiki something first.');
  }

  const game = await getGame(gameId);
  const brief = game ? `${game.name}: ${cleanQuestion}` : cleanQuestion;
  const brain = await assembleBrainContext({
    brief,
    gameId,
    rootDir: process.cwd(),
  });

  const result = await createStructuredResponse({
    schemaName: 'wiki_answer',
    schema: answerSchema,
    input: [
      {
        role: 'system',
        content: [
          'You are Tamatem Wiki, a practical creative knowledge assistant for game ads.',
          'Answer from the provided brain context.',
          'If the context is missing something, say what is missing and give the safest useful answer from what exists.',
          'Be clear, direct, and useful for a creative team.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Question:\n${cleanQuestion}\n\nBrain context:\n${brain.contextText || 'No selected memory text.'}`,
      },
    ],
  });

  return {
    answer: result.parsed,
    brainSelection: brain.chosen,
    gameId,
    model: result.model,
    responseId: result.id,
  };
}
