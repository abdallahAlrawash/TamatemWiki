import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createStructuredResponse } from './openaiResponses.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.yaml', '.yml']);
const MAX_FILE_CHARS = 60_000;

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

function childrenOf(nodes, parentId, type) {
  return nodes.filter((node) => node.parentId === parentId && node.type === type);
}

function thoughtIsSelectable(thought) {
  return Boolean(clean(thought.content)) || (thought.files || []).length > 0;
}

function describeThought(thought) {
  const description = clean(thought.content) || '(no description)';
  const fileNames = (thought.files || []).map((file) => file.name).filter(Boolean);
  const files = fileNames.length ? ` (files: ${fileNames.join(', ')})` : ' (no files)';

  return `  - [${thought.id}] ${description}${files}`;
}

function buildMap(nodes, allowedSections = SECTION_ORDER) {
  const lines = [];
  const selectableIds = [];

  for (const sectionId of SECTION_ORDER) {
    if (!allowedSections.includes(sectionId)) {
      continue;
    }

    const groups = childrenOf(nodes, sectionId, 'group');
    const sectionThoughts = [];

    for (const group of groups) {
      const thoughts = childrenOf(nodes, group.id, 'thought').filter(thoughtIsSelectable);

      if (!thoughts.length && !clean(group.description)) {
        continue;
      }

      sectionThoughts.push({ group, thoughts });
    }

    if (!sectionThoughts.length) {
      continue;
    }

    lines.push(`## ${SECTION_TITLES[sectionId] || sectionId}`);

    for (const { group, thoughts } of sectionThoughts) {
      const groupDescription = clean(group.description);

      lines.push(`Group: "${group.label || 'Untitled'}"${groupDescription ? ` — ${groupDescription}` : ''}`);

      for (const thought of thoughts) {
        lines.push(describeThought(thought));
        selectableIds.push(thought.id);
      }
    }

    lines.push('');
  }

  return { mapText: lines.join('\n').trim(), selectableIds };
}

export async function selectBrainContext({ rootDir, brief, model, sections = SECTION_ORDER }) {
  const cleanBrief = clean(brief);

  if (!cleanBrief) {
    throw new Error('Write a run brief first (e.g. "competitive Baloot ad for Saudi players").');
  }

  let brain;

  try {
    brain = JSON.parse(await readFile(path.join(rootDir, 'storage', 'brain.json'), 'utf8'));
  } catch {
    throw new Error('No brain.json found yet. Add some groups, memories and files first.');
  }

  const nodes = Array.isArray(brain.nodes) ? brain.nodes : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const { mapText, selectableIds } = buildMap(nodes, sections);

  if (!selectableIds.length) {
    throw new Error('The brain has no memories or files to choose from yet.');
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['chosen', 'notes'],
    properties: {
      chosen: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'reason'],
          properties: {
            nodeId: { type: 'string', enum: selectableIds },
            reason: { type: 'string' },
          },
        },
      },
      notes: { type: 'string' },
    },
  };

  const result = await createStructuredResponse({
    model: model || process.env.OPENAI_BRAIN_SELECTOR_MODEL || 'gpt-4.1-mini',
    schemaName: 'brain_selection',
    schema,
    input: [
      {
        role: 'system',
        content: [
          'You are the retrieval planner for an ad-production "brain".',
          'You are given a run brief and a map of memory nodes, each with an id, a description, and attached file names.',
          'Choose ONLY the nodes whose content or files are genuinely relevant to producing this run.',
          'Prefer precision over recall — do not include weakly related nodes.',
          'Use only the node ids provided. Give a short, concrete reason for each pick.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Run brief:\n"${cleanBrief}"\n\nBrain map:\n${mapText}\n\nReturn the relevant node ids and why each matters.`,
      },
    ],
  });

  const chosen = (result.parsed.chosen || [])
    .map((pick) => {
      const node = nodeById.get(pick.nodeId);

      if (!node) {
        return null;
      }

      const group = nodeById.get(node.parentId);
      const sectionId = group?.parentId;

      return {
        nodeId: node.id,
        reason: pick.reason,
        description: clean(node.content),
        group: group?.label || '',
        section: SECTION_TITLES[sectionId] || sectionId || '',
        files: (node.files || []).map((file) => ({ name: file.name, path: file.path })),
      };
    })
    .filter(Boolean);

  const files = chosen.flatMap((pick) => pick.files).filter((file) => file.path);

  return {
    brief: cleanBrief,
    model: result.model,
    notes: result.parsed.notes || '',
    candidateCount: selectableIds.length,
    chosen,
    files,
  };
}

async function readBrainFile(rootDir, filePath) {
  const relativePath = String(filePath || '');
  const extension = path.extname(relativePath).toLowerCase();

  if (!TEXT_EXTENSIONS.has(extension)) {
    return '';
  }

  const absolutePath = path.resolve(rootDir, relativePath);
  const storageRoot = path.resolve(rootDir, 'storage');

  if (!absolutePath.startsWith(storageRoot)) {
    return '';
  }

  try {
    return (await readFile(absolutePath, 'utf8')).slice(0, MAX_FILE_CHARS);
  } catch {
    return '';
  }
}

export async function assembleBrainContext({ rootDir, brief, gameId, model, sections }) {
  const selection = await selectBrainContext({ rootDir, brief, model, sections });
  const blocks = [];

  for (const pick of selection.chosen) {
    const heading = clean(pick.description) || pick.group || pick.section || 'Memory';
    const fileTexts = [];

    for (const file of pick.files) {
      const text = await readBrainFile(rootDir, file.path);

      if (text) {
        fileTexts.push(text);
      }
    }

    if (fileTexts.length) {
      blocks.push(`${heading}:\n${fileTexts.join('\n\n')}`);
    } else if (clean(pick.description)) {
      blocks.push(clean(pick.description));
    }
  }

  return {
    ...selection,
    gameId,
    contextText: blocks.join('\n\n---\n\n'),
  };
}
