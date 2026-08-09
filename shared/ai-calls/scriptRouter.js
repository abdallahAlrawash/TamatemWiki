import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getGame } from './gameLibrary.js';
import { createStructuredResponse } from './openaiResponses.js';
import { getCatalogGame } from './scriptBeats.js';
import { createAssetFinderClient } from './assetFinderClient.js';
import { extractCatalogCharacterCandidates, extractNamedCharacterCandidates } from './storyAssets.js';
import { generateStorytellingScript } from './storytellingScriptWriter.js';
import { generateUgcScript } from './ugcScriptWriter.js';

const promptPath = path.join('storage', 'prompts', 'Script-Router.txt');

export const storytellingGameIds = new Set([
  'WarOfSparta',
  'LandOfHeros',
  'ClashOfEmpire',
  'Atheria',
]);

const routerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'confidence', 'reason', 'characters'],
  properties: {
    mode: { type: 'string', enum: ['ugc', 'storytelling'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
    characters: {
      type: 'array',
      items: { type: 'string', description: 'A game character the brief uses as a story actor.' },
    },
  },
};

const storytellingPatterns = [
  /\bstory[\s-]?telling\b/i,
  /\bstory[\s-]?driven\b/i,
  /\bstory[\s-]?based\b/i,
  /\bnarrative(?:\s+(?:ad|advert|advertisement|script|trailer))?\b/i,
  /\bcinematic\s+(?:ad|advert|advertisement|story|script|trailer)\b/i,
  /\b(?:write|create|make|tell)\s+(?:me\s+)?a\s+story\b/i,
];

const ugcPatterns = [
  /\bugc\b/i,
  /\binfluencer(?:\s+(?:ad|advert|advertisement|script|video))?\b/i,
  /\bcreator[\s-]?led\b/i,
  /\btalking[\s-]?head\b/i,
];

/**
 * Keyword fallback, used only when the router model is unavailable (missing key, provider error).
 * Deliberately conservative: it cannot read the character signal, so it routes on explicit words only.
 */
export function detectScriptMode(userBrief = '', gameId = '') {
  const brief = String(userBrief || '').trim();
  const explicitlyRejectsUgc = /\b(?:not|no|without)\s+(?:an?\s+)?ugc\b/i.test(brief);
  const wantsUgc = !explicitlyRejectsUgc && ugcPatterns.some((pattern) => pattern.test(brief));
  const wantsStorytelling = storytellingPatterns.some((pattern) => pattern.test(brief));

  // UGC is the default and is available for every game. On dual-mode games, saying UGC explicitly
  // wins even when the brief also uses narrative/story language.
  if (wantsUgc) {
    return 'ugc';
  }

  return wantsStorytelling && storytellingGameIds.has(gameId) ? 'storytelling' : 'ugc';
}

/** The game's catalog cast, plus the names the brief already matches against it. Never throws. */
async function readCharacterSignal(gameId, brief, gameName) {
  const exclude = [gameName || gameId];

  try {
    const catalog = await getCatalogGame(gameId);

    if (!catalog?.catalogGame) {
      return {
        cast: [],
        detected: extractNamedCharacterCandidates(brief, { exclude }),
        castSource: 'game-unmapped',
      };
    }

    const client = await createAssetFinderClient();
    const characters = await client.searchCharacters(catalog.catalogGame);
    const cast = characters
      .map((entry) => (typeof entry === 'string' ? entry : entry?.value))
      .filter(Boolean);

    return {
      cast,
      detected: extractCatalogCharacterCandidates(brief, characters, { exclude }),
      castSource: 'asset-finder',
    };
  } catch (error) {
    return {
      cast: [],
      detected: extractNamedCharacterCandidates(brief, { exclude }),
      castSource: `unavailable: ${error.message}`,
    };
  }
}

function buildRouterPrompt(template, { brief, gameName, gameId, storytellingAvailable, signal }) {
  return [
    template,
    '',
    '===== SELECTED GAME (START) =====',
    `Game: ${gameName} (${gameId})`,
    `Story-telling production available for this game: ${storytellingAvailable ? 'yes' : 'no'}`,
    '===== SELECTED GAME (END) =====',
    '',
    '===== CATALOG CAST (START) =====',
    signal.cast.length
      ? signal.cast.slice(0, 120).join(', ')
      : `No catalog cast is available (${signal.castSource}). Judge character mentions from the brief alone.`,
    '===== CATALOG CAST (END) =====',
    '',
    '===== CAST NAMES DETECTED IN THE BRIEF (START) =====',
    signal.detected.length
      ? signal.detected.join(', ')
      : 'None detected by name matching. This does not by itself mean the brief is UGC.',
    '===== CAST NAMES DETECTED IN THE BRIEF (END) =====',
    '',
    '===== USER BRIEF (START) =====',
    brief,
    '===== USER BRIEF (END) =====',
    '',
    'Return the routing JSON only.',
  ].join('\n');
}

/**
 * Ask the router prompt which writer the brief belongs to. Returns the decision plus the evidence it
 * used, so the caller can surface why a brief was routed the way it was.
 */
export async function classifyScriptMode({ gameId = '', userBrief = '' } = {}) {
  const brief = String(userBrief || '').trim();
  const game = await getGame(gameId).catch(() => null);
  const gameName = game?.name || gameId;
  const storytellingAvailable = storytellingGameIds.has(gameId);

  if (!brief) {
    return {
      mode: 'ugc',
      source: 'default',
      confidence: 0,
      reason: 'The brief is empty, so the default UGC writer is used.',
      characters: [],
      detectedCharacters: [],
    };
  }

  const signal = await readCharacterSignal(gameId, brief, gameName);

  try {
    const template = await readFile(promptPath, 'utf8');
    const result = await createStructuredResponse({
      model: process.env.OPENAI_ROUTER_MODEL || process.env.OPENAI_SCRIPT_MODEL || 'gpt-5.2',
      schemaName: 'script_route',
      schema: routerSchema,
      input: [
        {
          role: 'system',
          content: 'You route game-ad briefs to the correct script writer. Follow the supplied router prompt exactly and return valid JSON only.',
        },
        { role: 'user', content: buildRouterPrompt(template, { brief, gameName, gameId, storytellingAvailable, signal }) },
      ],
    });
    const parsed = result.parsed || {};

    return {
      mode: parsed.mode === 'storytelling' ? 'storytelling' : 'ugc',
      source: 'model',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      reason: parsed.reason || '',
      characters: Array.isArray(parsed.characters) ? parsed.characters : [],
      detectedCharacters: signal.detected,
      model: result.model,
      responseId: result.id,
    };
  } catch (error) {
    // A router outage must never block script writing: fall back to the keyword rules.
    return {
      mode: detectScriptMode(brief, gameId),
      source: 'keyword-fallback',
      confidence: null,
      reason: `The router model was unavailable (${error.message}); routed on keywords.`,
      characters: [],
      detectedCharacters: signal.detected,
    };
  }
}

/**
 * Resolve the writer for one request. An explicit scriptMode from the caller skips the router; "auto"
 * lets the router prompt decide. Story-telling stays clamped to the games it is produced for.
 */
export async function resolveScriptMode({ gameId = '', scriptMode = 'auto', userBrief = '' } = {}) {
  const routing = scriptMode === 'storytelling' || scriptMode === 'ugc'
    ? {
      mode: scriptMode,
      source: 'explicit',
      confidence: 1,
      reason: `The caller requested the ${scriptMode} writer.`,
      characters: [],
      detectedCharacters: [],
    }
    : await classifyScriptMode({ gameId, userBrief });

  if (routing.mode === 'storytelling' && !storytellingGameIds.has(gameId)) {
    return {
      ...routing,
      mode: 'ugc',
      requestedMode: 'storytelling',
      reason: `${routing.reason} Story-telling is not produced for this game, so the UGC writer was used.`.trim(),
    };
  }

  return { ...routing, requestedMode: routing.mode };
}

export async function generateScript({
  gameId,
  scriptMode = 'auto',
  sourceAssets = false,
  userBrief = '',
} = {}) {
  // Storytelling is intentionally unavailable for VIP Baloot, Fashion Queen, and unknown games.
  const routing = await resolveScriptMode({ gameId, scriptMode, userBrief });

  const script = routing.mode === 'storytelling'
    ? await generateStorytellingScript({ gameId, userBrief })
    : await generateUgcScript({ gameId, sourceAssets, userBrief });

  return { ...script, routing };
}
