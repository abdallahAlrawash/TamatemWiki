import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildSelectionFromAssets,
  buildSelectionFromPerCharacter,
  writeSelection,
} from './assetSelection.js';
import { writeHandoff } from './beatPicks.js';
import { assembleBrainContext } from './brainSelector.js';
import { logCost } from './costLedger.js';
import { getGame } from './gameLibrary.js';
import { createStructuredResponse } from './openaiResponses.js';
import { ensureRunOutputDir } from './runFolders.js';
import { getCatalogGame } from './scriptBeats.js';
import {
  extractNamedCharacterCandidates,
  findAssetsPerCharacter,
  findNamedCharacterAssets,
  findStoryAssets,
  listCastableCharacters,
  resolveNamedCharacterCandidates,
} from './storyAssets.js';

const defaultGameId = 'WarOfSparta';
const promptPath = path.join('storage', 'prompts', 'Story-Telling-Script-Writer.txt');

const storytellingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['characters', 'scenes'],
  properties: {
    characters: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'string',
        description: 'One character present in the story, including a physical and distinct description.',
      },
    },
    scenes: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scene_number', 'setting', 'scene_description', 'narration'],
        properties: {
          scene_number: { type: 'integer', minimum: 1, maximum: 5 },
          setting: { type: 'string' },
          scene_description: { type: 'string' },
          narration: { type: 'string' },
        },
      },
    },
  },
};

/**
 * The roster is the writer's casting list, not the Asset Finder's output. Without it the writer
 * invents role labels ("Spartan Leader") for characters the catalog holds by name (Leonidas), and
 * those entries can never resolve back to an asset.
 */
function castingBlock(roster) {
  if (!roster.length) {
    // The OUTPUT schema demands a name from this list, so an empty roster has to release that rule
    // explicitly. Left implicit, the writer satisfies it with the only name in sight -- the game's --
    // and every character comes back called "Land Of Heros ...".
    return [
      '===== CASTABLE CHARACTERS (START) =====',
      'No character roster is available for this game this run.',
      '',
      'Casting rules:',
      '- The OUTPUT schema asks for a name from this list. There is no list, so that rule is lifted.',
      '- Give each character a proper name of your own that suits the selected game, then " - ", then',
      '  the physical description. Draw names from the brain knowledge where it offers them.',
      '- Never use the game\'s own name, or any part of it, as a character name.',
      '- Prefer a real name over a role label, and never reuse a name across two entries.',
      '===== CASTABLE CHARACTERS (END) =====',
    ];
  }

  return [
    '===== CASTABLE CHARACTERS (START) =====',
    'These are the characters this game has art for. Build your cast from this list.',
    '',
    roster.join(', '),
    '',
    'Casting rules:',
    '- Every entry in "characters" must begin with one name from this list, then " - ", then the',
    '  physical description. Example: "Leonidas - a battle-worn Spartan commander in bronze armor...".',
    '- Spell the name exactly as it appears above, even when a different spelling is more familiar.',
    '- Two entries must never use the same name. Fold a crowd into the one entry that leads it',
    '  rather than listing a commander and their soldiers separately.',
    '- If the story genuinely needs a figure that is not on the list, cast the closest listed',
    '  character instead and write the description you wanted onto them.',
    '===== CASTABLE CHARACTERS (END) =====',
  ];
}

function buildPrompt(template, brainContext, game, gameId, userBrief, roster = []) {
  const gameName = game?.name || gameId;
  // This line replaces the prompt's own "The game is called ..." line, so it has to carry that line's
  // guidance too -- otherwise substituting the game name quietly drops the asset-text warning.
  const selectedGameRule = [
    `The selected game is called "${gameName}".`,
    'The selected game record supplied below is authoritative.',
    'Do not use a different game name found in examples or asset text.',
    'An asset whose artwork or filename carries another title is still an asset of the selected game.',
  ].join(' ');
  const adaptedTemplate = template.replace(/^The game is called .*$/m, selectedGameRule);

  return [
    adaptedTemplate,
    '',
    '===== SELECTED GAME RECORD (START) =====',
    JSON.stringify(game || { id: gameId, name: gameName }, null, 2),
    '===== SELECTED GAME RECORD (END) =====',
    '',
    ...castingBlock(roster),
    '',
    '===== USER BRIEF (START) =====',
    String(userBrief || '').trim(),
    '===== USER BRIEF (END) =====',
    '',
    '===== RELEVANT BRAIN KNOWLEDGE (START) =====',
    brainContext || 'No additional brain context was selected.',
    '===== RELEVANT BRAIN KNOWLEDGE (END) =====',
    '',
    'Production flow note: the Asset Finder is running independently from the original user brief while you write.',
    'Its results are not input to this script and you must not wait for or refer to its selections.',
    'Use only the selected game record, the castable character list, and brain knowledge for named game content.',
    'Return exactly the requested top-level characters and scenes JSON structure.',
  ].join('\n');
}

function assetFinderMessage(search) {
  if (search.skipped) {
    return search.detail || `Asset sourcing was skipped: ${search.skipped}.`;
  }

  if (!search.assets.length) {
    const failed = search.queries.find((query) => query.error);

    return failed?.error || 'The asset finder returned no matching catalog assets.';
  }

  return null;
}

/** Keep the downstream storyboard-agent contract exact even if a provider ever returns extra keys. */
export function toStorytellingContract(parsed = {}) {
  return {
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    scenes: (Array.isArray(parsed.scenes) ? parsed.scenes : []).map((scene) => ({
      scene_number: scene.scene_number,
      setting: scene.setting,
      scene_description: scene.scene_description,
      narration: scene.narration,
    })),
  };
}

export async function generateStorytellingScript({
  gameId = defaultGameId,
  userBrief = '',
} = {}) {
  const cleanBrief = String(userBrief || '').trim();

  if (!cleanBrief) {
    throw new Error('Write a storytelling brief first.');
  }

  const { outputDir, runId } = await ensureRunOutputDir();
  const [game, catalog] = await Promise.all([
    getGame(gameId),
    getCatalogGame(gameId),
  ]);
  const brief = game ? [game.name, game.brief].filter(Boolean).join(': ') : gameId;

  // Start strict intake-character sourcing while the writer runs. After the script is available, a
  // reconciliation pass adds any catalog-backed characters the writer introduced.
  const assetSearchText = [game?.name || gameId, cleanBrief].filter(Boolean).join('. ');
  const requestedCharacters = catalog?.catalogGame
    ? await resolveNamedCharacterCandidates(cleanBrief, {
      catalogGame: catalog.catalogGame,
      exclude: [game?.name || gameId],
    })
    : extractNamedCharacterCandidates(cleanBrief, {
      exclude: [game?.name || gameId],
    });
  const assetSearchPromise = catalog?.catalogGame
    ? (requestedCharacters.length
      ? findNamedCharacterAssets({
        catalogGame: catalog.catalogGame,
        names: requestedCharacters,
        limit: 18,
      })
      : findStoryAssets({
        catalogGame: catalog.catalogGame,
        diversifyKinds: true,
        text: assetSearchText,
        limit: 18,
        perKindLimit: 12,
      })).catch((error) => ({
      skipped: 'asset-finder-error',
      detail: error.message,
      need: null,
      queries: [],
      assets: [],
    }))
    : Promise.resolve({
      skipped: 'game-unmapped',
      detail: 'No asset catalog mapping exists for the selected game.',
      need: null,
      queries: [],
      assets: [],
    });

  const [promptTemplate, brain, roster] = await Promise.all([
    readFile(promptPath, 'utf8'),
    assembleBrainContext({
      rootDir: process.cwd(),
      brief,
      gameId,
      sections: ['game-knowledge', 'audience-personas', 'performance-learnings', 'production-rules'],
    }),
    // Blocks the writer on purpose: casting from the roster is what makes the script's characters
    // resolvable, so writing before it lands would defeat the point.
    listCastableCharacters(catalog?.catalogGame),
  ]);
  const prompt = buildPrompt(promptTemplate, brain.contextText, game, gameId, cleanBrief, roster);

  const resultPromise = createStructuredResponse({
    schemaName: 'storytelling_script',
    schema: storytellingSchema,
    input: [
      {
        role: 'system',
        content: 'You write cinematic storytelling game-ad scripts. Follow the supplied writer prompt exactly and return valid JSON only.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
  });
  const [result, intakeAssetSearch] = await Promise.all([resultPromise, assetSearchPromise]);
  const script = toStorytellingContract(result.parsed);
  const generatedCharacters = catalog?.catalogGame
    ? await resolveNamedCharacterCandidates(script.characters.join('\n'), {
      catalogGame: catalog.catalogGame,
      exclude: [game?.name || gameId],
    })
    : extractNamedCharacterCandidates(script.characters.join('\n'), {
      exclude: [game?.name || gameId],
    });
  // The handoff represents the finished script, not an abandoned intake concept. When the writer changes
  // the cast, only catalog-backed characters actually present in the final script should survive. Intake
  // matches remain a latency optimization/fallback for scripts with no resolvable character names.
  const finalAssetCharacters = generatedCharacters.length > 0 ? generatedCharacters : requestedCharacters;
  // The cast the writer produced drives sourcing: one asset per entry, named entries by character and
  // the rest by description. The intake search stays as the fallback for a script with no cast at all.
  let assetSearch = intakeAssetSearch;

  if (catalog?.catalogGame && script.characters.length > 0) {
    assetSearch = await findAssetsPerCharacter({
      catalogGame: catalog.catalogGame,
      cast: script.characters,
      exclude: [game?.name || gameId],
    });
  }
  const perCharacter = assetSearch.perCharacter || [];
  const unresolvedCharacters = perCharacter.filter((slot) => !slot.asset).map((slot) => slot.character);
  const weakCharacters = perCharacter.filter((slot) => slot.weak).map((slot) => slot.character);
  const outputPath = path.join(outputDir, 'storytelling-script.json');
  const brainContextPath = path.join(outputDir, 'brain-context.json');
  const assetKitPath = path.join(outputDir, 'story-asset-kit.json');
  const beatsPath = path.join(outputDir, 'asset-beats.json');

  await writeFile(outputPath, `${JSON.stringify(script, null, 2)}\n`, 'utf8');
  await logCost({
    kind: 'text',
    metadata: { response_id: result.id },
    model: result.model,
    outputDir,
    provider: 'openai',
    raw: result.raw,
    runId,
    step: 'storytelling_script_writer',
  });
  await writeFile(brainContextPath, `${JSON.stringify({
    gameId,
    brief: brain.brief,
    selectorModel: brain.model,
    candidateCount: brain.candidateCount,
    notes: brain.notes,
    chosen: brain.chosen,
    files: brain.files,
    contextText: brain.contextText,
  }, null, 2)}\n`, 'utf8');

  await writeFile(assetKitPath, `${JSON.stringify({
    source: 'user-brief-and-generated-script',
    brief: assetSearchText,
    // Kept so an unresolved cast member can be told apart from one the catalog never offered.
    roster,
    requestedCharacters,
    generatedCharacters,
    finalAssetCharacters,
    ...assetSearch,
  }, null, 2)}\n`, 'utf8');

  // Storytelling assets are an ad-level kit selected from the intake brief, not scene-level picks.
  const beats = [];
  const beatBlock = {
    gameId,
    gameAlias: catalog?.alias || null,
    game: catalog?.catalogGame || null,
    source: 'user-brief-and-generated-script',
    brief: assetSearchText,
    requestedCharacters,
    generatedCharacters,
    finalAssetCharacters,
    need: assetSearch.need,
    queries: assetSearch.queries,
    beats,
  };

  await writeFile(beatsPath, `${JSON.stringify(beatBlock, null, 2)}\n`, 'utf8');

  const selection = await writeSelection({
    runId,
    // One asset per cast entry, in cast order. Falls back to the pooled builder only when sourcing ran
    // from the intake brief because the script produced no cast to source against.
    selection: perCharacter.length
      ? buildSelectionFromPerCharacter(perCharacter)
      : buildSelectionFromAssets(assetSearch.assets, { selectedCount: finalAssetCharacters.length || 5 }),
  });
  const handoff = await writeHandoff({
    runId,
    gameId,
    game: catalog?.catalogGame || null,
    script,
    beats,
    selection,
  });

  return {
    mode: 'storytelling',
    writer: 'Story-Telling-Script-Writer',
    gameId,
    catalogGame: catalog?.catalogGame || null,
    runId,
    outputDir,
    outputPath,
    brainContextPath,
    assetKitPath,
    beatsPath,
    handoffPath: path.join(outputDir, 'handoff.json'),
    responseId: result.id,
    model: result.model,
    script,
    brainSelection: brain.chosen,
    assetBeats: beatBlock,
    assetSelection: selection,
    // Per-cast-entry sourcing detail, so a caller can say which character an asset stands in for and
    // which cast members are backed by a weak or missing match.
    perCharacter,
    unresolvedCharacters,
    weakCharacters,
    assetFinderError: assetFinderMessage(assetSearch),
    handoff,
  };
}
