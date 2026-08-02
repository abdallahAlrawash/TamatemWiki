import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createStructuredResponse } from './openaiResponses.js';

const promptPath = path.join('storage', 'prompts', 'brain-capture.txt');

const SECTION_TITLES = {
  'game-knowledge': 'Game Knowledge',
  'audience-personas': 'Audience Personas',
  'game-assets': 'Game Assets',
  'performance-learnings': 'Performance Learnings',
  'production-rules': 'Production Rules',
};

const SECTION_ORDER = [
  'game-knowledge',
  'audience-personas',
  'game-assets',
  'performance-learnings',
  'production-rules',
];

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function buildCaptureMap(nodes) {
  const groupIds = [];
  const thoughtIds = [];
  const lines = [];

  for (const sectionId of SECTION_ORDER) {
    lines.push(`## [${sectionId}] ${SECTION_TITLES[sectionId]}`);

    const groups = nodes.filter((node) => node.type === 'group' && node.parentId === sectionId);

    if (!groups.length) {
      lines.push('  (no groups yet)');
      continue;
    }

    for (const group of groups) {
      groupIds.push(group.id);

      const description = clean(group.description);

      lines.push(`  Group [${group.id}] "${group.label || 'Untitled'}"${description ? ` — ${description}` : ''}`);

      const thoughts = nodes.filter((node) => node.type === 'thought' && node.parentId === group.id);

      for (const thought of thoughts) {
        thoughtIds.push(thought.id);

        const summary = clean(thought.content) || thought.files?.[0]?.name || '(empty)';

        lines.push(`    - Thought [${thought.id}] ${summary}`);
      }
    }
  }

  return { mapText: lines.join('\n'), groupIds, thoughtIds };
}

export async function captureThought({ text, brain, model }) {
  const cleanText = clean(text);

  if (!cleanText) {
    throw new Error('Nothing to capture.');
  }

  const nodes = Array.isArray(brain?.nodes) ? brain.nodes : [];
  const { mapText, groupIds } = buildCaptureMap(nodes);

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['sectionId', 'targetGroupId', 'newGroupTitle', 'reason'],
    properties: {
      sectionId: {
        type: 'string',
        enum: SECTION_ORDER,
      },
      targetGroupId: {
        type: 'string',
        enum: [...groupIds, ''],
      },
      newGroupTitle: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
  };

  const systemPrompt = await readFile(promptPath, 'utf8');

  const result = await createStructuredResponse({
    model: model || process.env.OPENAI_BRAIN_SELECTOR_MODEL || 'gpt-4.1-mini',
    schemaName: 'brain_capture',
    schema,
    input: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: `New memory:\n"${cleanText}"\n\nBrain map:\n${mapText}\n\nDecide which section and group it belongs under.`,
      },
    ],
  });

  const route = result.parsed;
  const sectionId = SECTION_ORDER.includes(route.sectionId) ? route.sectionId : 'game-knowledge';

  return {
    sectionId,
    sectionTitle: SECTION_TITLES[sectionId],
    targetGroupId: route.targetGroupId || '',
    newGroupTitle: clean(route.newGroupTitle) || 'New group',
    reason: route.reason || '',
    model: result.model,
  };
}
