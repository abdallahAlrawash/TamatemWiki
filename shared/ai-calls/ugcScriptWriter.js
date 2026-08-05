import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStructuredResponse } from './openaiResponses.js';
import { assembleBrainContext } from './brainSelector.js';
import { logCost } from './costLedger.js';
import { getGame } from './gameLibrary.js';
import { ensureRunOutputDir } from './runFolders.js';
import { extractBeats, getCatalogGame, sourceBeatAssets } from './scriptBeats.js';
import { writeHandoff } from './beatPicks.js';
import { buildSelection, writeSelection } from './assetSelection.js';

const defaultGameId = 'VIPBaloot';
const promptPath = path.join('storage', 'prompts', 'ugc-script-writer.txt');

const ugcScriptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['background_sfx', 'scenes'],
  properties: {
    background_sfx: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: {
        type: 'string',
      },
    },
    scenes: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'scene_number',
          'scene_id',
          'description',
          'image',
          'screen',
          'vo',
          'action',
          'duration_seconds',
        ],
        properties: {
          scene_number: {
            type: 'integer',
            minimum: 1,
            maximum: 6,
          },
          scene_id: {
            type: 'string',
            pattern: '^SC[1-6]$',
          },
          description: {
            type: 'string',
          },
          image: {
            type: 'string',
          },
          screen: {
            type: ['string', 'null'],
          },
          vo: {
            type: 'string',
          },
          action: {
            type: 'string',
          },
          duration_seconds: {
            type: 'integer',
            minimum: 6,
            maximum: 8,
          },
        },
      },
    },
  },
};

function buildPrompt(template, brainContext, sceneSetupDirection, userBrief) {
  return template
    .replace('{{BRAIN_CONTEXT}}', brainContext)
    .replace('{{SCENE_SETUP_DIRECTION}}', sceneSetupDirection || 'Use the routed place or user prompt context if available.')
    .replace('{{USER_BRIEF}}', userBrief?.trim() || '(none — write freely)');
}

export async function generateUgcScript({
  gameId = defaultGameId,
  sceneSetupDirection = '',
  userBrief = '',
  // The UGC ad is script-only. Asset sourcing belongs to the storytelling ad, so it is opt-in.
  sourceAssets = false,
} = {}) {
  const { outputDir, runId } = await ensureRunOutputDir();
  const game = await getGame(gameId);
  const brief = game ? [game.name, game.brief].filter(Boolean).join(': ') : gameId;

  const [promptTemplate, brain] = await Promise.all([
    readFile(promptPath, 'utf8'),
    assembleBrainContext({
      rootDir: process.cwd(),
      brief,
      gameId,
      sections: ['game-knowledge', 'audience-personas', 'performance-learnings', 'production-rules'],
    }),
  ]);

  const prompt = buildPrompt(promptTemplate, brain.contextText, sceneSetupDirection, userBrief);

  const result = await createStructuredResponse({
    schemaName: 'ugc_script',
    schema: ugcScriptSchema,
    input: [
      {
        role: 'system',
        content:
          'You write concise UGC ad scripts. Follow the user prompt exactly and return valid JSON only.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const orderedScript = {
    scenes: result.parsed.scenes,
    background_sfx: result.parsed.background_sfx,
  };
  const outputPath = path.join(outputDir, 'ugc-script.json');

  await writeFile(outputPath, `${JSON.stringify(orderedScript, null, 2)}\n`, 'utf8');
  await logCost({
    kind: 'text',
    metadata: {
      response_id: result.id,
    },
    model: result.model,
    outputDir,
    provider: 'openai',
    raw: result.raw,
    runId,
    step: 'ugc_script_writer',
  });

  const brainContextPath = path.join(outputDir, 'brain-context.json');

  await writeFile(
    brainContextPath,
    `${JSON.stringify(
      {
        gameId,
        brief: brain.brief,
        selectorModel: brain.model,
        candidateCount: brain.candidateCount,
        notes: brain.notes,
        chosen: brain.chosen,
        files: brain.files,
        contextText: brain.contextText,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // Asset-finder handoff (docs/script-writer-integration.md). The human-readable script above is
  // unchanged; this only appends the machine-readable beat block. A finder outage must never fail
  // script writing, so every failure mode degrades to beats-without-assets.
  let beatBlock = null;
  let beatsPath = null;
  let selection = null;

  if (sourceAssets) {
    const catalog = await getCatalogGame(gameId);

    beatBlock = extractBeats({
      script: orderedScript,
      gameId,
      // Only the mapped catalog value -- never fall back to the wiki's own display name, which the
      // finder cannot resolve and would silently drop.
      catalogGame: catalog?.catalogGame || null,
      alias: catalog?.alias,
      userBrief,
    });

    try {
      beatBlock.beats = await sourceBeatAssets({
        beats: beatBlock.beats,
        catalogGame: beatBlock.game,
      });
    } catch (error) {
      beatBlock.assetFinderError = error.message;
    }

    beatsPath = path.join(outputDir, 'asset-beats.json');

    await writeFile(beatsPath, `${JSON.stringify(beatBlock, null, 2)}\n`, 'utf8');

    // Flatten the per-beat results into the ad-level pool the UI edits.
    selection = await writeSelection({ runId, selection: buildSelection(beatBlock.beats) });
  }

  // handoff.json is the downstream contract: script + exactly one asset per scene.
  const handoff = await writeHandoff({
    runId,
    gameId,
    game: beatBlock?.game ?? null,
    script: orderedScript,
    beats: beatBlock?.beats ?? [],
    selection,
  });

  return {
    gameId,
    runId,
    outputDir,
    outputPath,
    brainContextPath,
    beatsPath,
    handoffPath: path.join(outputDir, 'handoff.json'),
    responseId: result.id,
    model: result.model,
    script: orderedScript,
    brainSelection: brain.chosen,
    assetBeats: beatBlock,
    assetSelection: selection,
    handoff,
  };
}
