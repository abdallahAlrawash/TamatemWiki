/**
 * Turns a written UGC script into asset-finder beats and sources art for each one.
 * Implements sections 3-6 of docs/script-writer-integration.md.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAssetFinderClient } from './assetFinderClient.js';

const aliasesPath = path.join('config', 'game-aliases.json');

// Mood / tone words worth carrying into a brief. Kept to a vocabulary rather than pasting the whole
// scene description, because the finder's brief parser is measurably unstable on noisy briefs.
const moodWords = [
  'aggressive', 'bold', 'calm', 'celebratory', 'chaotic', 'cheerful', 'competitive', 'confident',
  'cozy', 'dark', 'dramatic', 'elegant', 'emotional', 'energetic', 'epic', 'exciting', 'festive',
  'fun', 'heroic', 'intense', 'luxurious', 'moody', 'mysterious', 'nostalgic', 'playful', 'premium',
  'relaxed', 'social', 'vibrant',
];

const colorWords = [
  'black', 'blue', 'bronze', 'gold', 'golden', 'green', 'neon', 'orange', 'pastel', 'pink',
  'purple', 'red', 'silver', 'teal', 'turquoise', 'white', 'yellow',
];

const eventWords = [
  'anniversary', 'back to school', 'black friday', 'championship', 'christmas', 'eid', 'halloween',
  'launch', 'national day', 'new year', 'ramadan', 'summer', 'tournament', 'winter',
];

// Concrete things game art actually depicts. Pulled from the scene description so each beat asks for
// its own subject -- without this every talking-head beat degenerates to "character portrait" and the
// finder quite reasonably returns the same asset for all of them.
const subjectWords = [
  'alliance', 'arena', 'armour', 'army', 'avatar', 'banner', 'battle', 'boss', 'card', 'cards',
  'castle', 'chest', 'city', 'coins', 'commander', 'crown', 'deck', 'dragon', 'emote', 'flag',
  'fortress', 'gameplay', 'hero', 'heroes', 'knight', 'lantern', 'leaderboard', 'lobby', 'logo',
  'map', 'menu', 'ranking', 'reward', 'roster', 'shield', 'skin', 'soldier', 'spear', 'stadium',
  'store', 'strategy', 'sword', 'table', 'throne', 'tournament', 'treasure', 'troops', 'trophy', 'war',
  'warrior', 'world map',
];

// Words that look like names but are language/event/brand noise rather than a visual subject.
const namedEntityStoplist = new Set([
  'arabic', 'english', 'gulf', 'influencer', 'ramadan', 'eid', 'iftar', 'saudi', 'screen', 'phone',
  'vip', 'ugc', 'cta', 'action', 'the', 'they', 'he', 'she', 'strong', 'talking', 'facing', 'holding',
]);

// A palette when the script does not name one. The finder scores colour, so a beat with no colour at
// all competes on shape alone; an event- or mood-appropriate palette is better than silence.
// Ad-wide context (season, inferred palette) is deliberately NOT appended to every beat. Measured:
// adding "warm gold and purple tones, ramadan" to each brief collapsed the candidate pool from 10
// distinct assets per beat to the SAME 3 for all five beats. Shared terms dominate retrieval, so they
// only earn their place when the scene has no subject of its own to search on.
const palettes = [
  [(text) => /\bramadan\b/.test(text), 'warm gold and purple tones'],
  [(text) => /\beid\b/.test(text), 'gold and green tones'],
  [(text) => /\bnational day\b/.test(text), 'green and white tones'],
  [(text) => /\b(epic|heroic|dramatic)\b/.test(text), 'deep gold and dark tones'],
  [(text) => /\b(festive|celebratory)\b/.test(text), 'gold and red festive tones'],
  [(text) => /\b(premium|luxurious)\b/.test(text), 'gold and black premium tones'],
  [(text) => /\b(playful|social|cheerful|fun)\b/.test(text), 'bright vibrant tones'],
];

function pickPalette(haystack) {
  const match = palettes.find(([test]) => test(haystack));

  return match ? match[1] : '';
}

/** Capitalised words mid-sentence -- character and place names like Sparta, Leonidas. */
function namedEntities(text) {
  const cleaned = stripDeliveryMarkers(text);
  const found = [];

  for (const sentence of cleaned.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/);

    for (const [index, word] of words.entries()) {
      // Split hyphenated compounds first: "Ramadan-first" must yield "Ramadan" (stoplisted), not
      // the nonsense token "Ramadanfirst" that slips past it.
      const bare = word.split(/[-\u2013\u2014]/)[0].replace(/[^\w']/g, '');

      if (index === 0 || bare.length < 4 || !/^[A-Z][a-z]+$/.test(bare)) {
        continue;
      }

      if (!namedEntityStoplist.has(bare.toLowerCase()) && !found.includes(bare)) {
        found.push(bare);
      }
    }
  }

  return found;
}

/** What this specific scene shows: named entities first, then concrete subject nouns. */
function sceneSubjects(scene, limit = 3) {
  const description = String(scene?.description || '');
  const nouns = findWords(subjectWords, normalize(description))
    // "world map" already covers "map"; prefer the longer phrase.
    .filter((word, _, all) => !all.some((other) => other !== word && other.includes(word)));

  return [...namedEntities(description), ...nouns].slice(0, limit);
}

/** Strip ElevenLabs-style delivery markers such as [excited] / [laughs]. */
function stripDeliveryMarkers(text) {
  return String(text || '').replace(/\[[^\]]*\]/g, ' ');
}

function normalize(text) {
  return stripDeliveryMarkers(text).toLowerCase();
}

function findWords(vocabulary, haystack) {
  return vocabulary.filter((word) => new RegExp(`\\b${word}\\b`).test(haystack));
}

function cleanScreen(screen) {
  return stripDeliveryMarkers(screen).replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

/** A scene needs an asset only when it actually shows a phone screen. */
export function hasScreen(scene) {
  const screen = cleanScreen(scene?.screen);

  return Boolean(screen) && !/^none$/i.test(screen) && !/^null$/i.test(screen);
}

export async function getCatalogGame(gameId) {
  try {
    const table = JSON.parse(await readFile(aliasesPath, 'utf8'));
    const entry = table.games?.[gameId];

    return entry
      ? { catalogGame: entry.catalogGame, alias: entry.alias, inCatalog: entry.inCatalog !== false }
      : null;
  } catch {
    return null;
  }
}

/**
 * Is this game actually filterable? Checked against /api/search/options rather than trusted from the
 * table, because sending an unresolvable `game` does not error -- the finder drops the filter and
 * returns whole-catalog results that look correct and are for the wrong game.
 */
export async function isGameFilterable(catalogGame, client) {
  if (!catalogGame) {
    return { filterable: false, reason: 'game-unmapped' };
  }

  let games;

  try {
    ({ games } = await client.searchOptions());
  } catch (error) {
    // An unreachable finder is not the same as an unlisted game. Reporting it as
    // "game-not-in-catalog" sent me chasing a catalog problem during an outage.
    return { filterable: false, reason: 'asset-finder-unreachable', detail: error.message };
  }

  const filterable = games.some((game) => game.toLowerCase() === String(catalogGame).toLowerCase());

  return filterable
    ? { filterable: true }
    : { filterable: false, reason: 'game-not-in-catalog' };
}

/**
 * Build one brief per the doc's section 4 rules.
 * Includes: game, the Screen line, mood/tone, colors, season/event.
 * Strips: the Arabic VO, delivery markers, the Action line, duration, background SFX.
 */
/** Lowercase a leading capital so the screen reads as a clause, unless it is an acronym. */
function asClause(text) {
  return /^[A-Z]{2,}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** The Screen line often already names the game ("Baloot VIP main menu") -- don't say it twice. */
function screenNamesGame(screen, catalogGame) {
  const tokens = String(catalogGame || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 3);

  return tokens.length > 0 && tokens.every((token) => screen.toLowerCase().includes(token));
}

export function buildBrief({ catalogGame, scene, userBrief = '' }) {
  const screen = cleanScreen(scene?.screen);
  // description is the mood and subject source; the VO and action fields are never read by design.
  const moodSource = `${normalize(scene?.description)} ${normalize(userBrief)}`;
  const moods = findWords(moodWords, moodSource).slice(0, 2);
  const colors = findWords(colorWords, moodSource).slice(0, 2);
  const events = findWords(eventWords, normalize(userBrief)).slice(0, 1);

  const head = screenNamesGame(screen, catalogGame)
    ? screen
    : [catalogGame, screen ? asClause(screen) : ''].filter(Boolean).join(' ');

  // Subjects the Screen line does not already mention -- Leonidas, alliance, city, and so on.
  const extras = sceneSubjects(scene, 2)
    .filter((subject) => !head.toLowerCase().includes(subject.toLowerCase()));

  const thin = extras.length === 0 && !screen;
  const tail = [
    extras.length ? `showing ${extras.join(' and ')}` : '',
    moods.length ? `${moods.join(' ')} mood` : '',
    colors.length ? `${colors.join(' and ')} tones` : (thin ? pickPalette(moodSource) : ''),
    thin ? (events[0] || '') : '',
  ].filter(Boolean);

  return [head, ...tail].filter(Boolean).join(', ');
}

/**
 * Brief for a scene with no phone screen. The doc's section 3 says these produce no call, but a
 * talking-head scene still needs a visual, and character/key art is the catalog's strongest content.
 * So we source it as a separate beat kind, oriented at character art rather than a UI screen.
 *
 * The `image` field is the first-frame visual description, but the script prompt forbids describing
 * how the creator looks, so it carries framing ("medium shot", "holding a mobile phone") rather than
 * a subject. That makes it noise for retrieval, so only its mood/colour words are used.
 */
export function buildCharacterBrief({ catalogGame, scene, userBrief = '' }) {
  const moodSource = `${normalize(scene?.description)} ${normalize(userBrief)}`;
  const moods = findWords(moodWords, moodSource).slice(0, 2);
  const colors = findWords(colorWords, moodSource).slice(0, 2);
  const events = findWords(eventWords, normalize(scene?.description)).slice(0, 1);
  const subjects = sceneSubjects(scene, 3);

  // Lead with what this scene is actually about. Only fall back to the generic phrasing when the
  // description offered no concrete subject at all -- otherwise every talking-head beat is identical.
  const head = subjects.length
    ? [catalogGame, subjects.join(' '), 'key art'].filter(Boolean).join(' ')
    : [catalogGame, 'character key art'].filter(Boolean).join(' ');

  return [
    head,
    moods.length ? `${moods.join(' ')} mood` : '',
    colors.length ? `${colors.join(' and ')} tones` : (subjects.length ? '' : pickPalette(moodSource)),
    subjects.length ? '' : (events[0] || ''),
  ].filter(Boolean).join(', ');
}

/**
 * `includeCharacterBeats` covers scenes with no phone screen by sourcing character art. It is a
 * deliberate deviation from the doc's "must not produce a call" rule for screen-null scenes; set it
 * false to get strictly doc-conformant behaviour.
 */
export function extractBeats({
  script,
  gameId,
  catalogGame,
  alias,
  userBrief = '',
  includeCharacterBeats = true,
}) {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  const beats = [];

  for (const scene of scenes) {
    const sceneId = scene.scene_id || `SC${scene.scene_number || ''}`;
    const base = { sceneId, durationSec: scene.duration_seconds ?? null };

    if (hasScreen(scene)) {
      beats.push({
        ...base,
        kind: 'screen',
        screen: cleanScreen(scene.screen),
        brief: buildBrief({ catalogGame, scene, userBrief }),
      });
    } else if (includeCharacterBeats) {
      beats.push({
        ...base,
        kind: 'character',
        screen: null,
        brief: buildCharacterBrief({ catalogGame, scene, userBrief }),
      });
    }
  }

  return {
    gameId,
    gameAlias: alias || null,
    game: catalogGame || null,
    beats,
  };
}

/**
 * One call per beat, concurrent. `confident: false` never auto-picks -- it flags for review and
 * hands the whole shortlist through, per the doc's section 6.
 *
 * A single retry runs when a beat comes back empty: the finder's brief parser was measured
 * returning 0 then 3 assets for byte-identical requests, so one empty result is not conclusive.
 */
/**
 * The finder does not report per-asset verification, so derive it from matchReasons. Needed because
 * `allowInferred: false` still returns pending-review matches -- tagging them lets a caller that
 * wants verified-only actually get it, and lets the downstream see what it is looking at.
 */
export function verificationOf(asset) {
  const reasons = (asset?.matchReasons || []).join(' ').toLowerCase();

  if (reasons.includes('pending-review')) {
    return 'pending-review';
  }

  if (reasons.includes('verified')) {
    return 'verified';
  }

  return 'inferred';
}

/**
 * `confident: true` is bypassed by the finder's own threshold whenever a game filter applies, so it
 * fires on briefs that match nothing meaningful. A score floor is the only client-side signal left:
 * below it, flag for review regardless of what `confident` said. Tune with ASSET_REVIEW_SCORE_FLOOR.
 */
function reviewScoreFloor() {
  const raw = Number(process.env.ASSET_REVIEW_SCORE_FLOOR);

  return Number.isFinite(raw) ? raw : 0.55;
}

/** The trimmed asset shape carried as a beat's pick. */
function toChosen(asset) {
  return {
    assetId: asset.assetId,
    fileName: asset.fileName,
    imageUrl: asset.imageUrl,
    previewUrl: asset.previewUrl,
    downloadUrl: asset.downloadUrl,
    entity: asset.entity,
    game: asset.game,
    folder: asset.folder,
    folderDescription: asset.folderDescription,
    verification: asset.verification,
    score: asset.score,
  };
}

/**
 * No two scenes get the same asset while any beat still has an unused candidate.
 *
 * The finder ranks each beat independently, so a catalog with a dominant theme (a Ramadan-heavy
 * library, an ad brief that says "ramadan" in every scene) hands the same top asset to all five
 * beats. That is defensible ranking and a useless ad. Strongest beat picks first so the single best
 * match is never displaced by a weaker beat, then each remaining beat takes its own highest-scoring
 * candidate that nobody has claimed.
 */
function assignDistinctAssets(beats) {
  const used = new Set();
  const byStrength = beats
    .filter((beat) => beat.chosen)
    .sort((a, b) => (b.chosen.score ?? 0) - (a.chosen.score ?? 0));

  for (const beat of byStrength) {
    const candidates = [beat.chosen, ...(beat.alternatives || [])];
    const pick = candidates.find((asset) => !used.has(asset.assetId));

    if (!pick) {
      // Every candidate is spoken for -- keep the top pick and say so rather than blanking the scene.
      beat.reusedAsset = true;
      used.add(beat.chosen.assetId);
      continue;
    }

    if (pick.assetId !== beat.chosen.assetId) {
      beat.autoDiversified = { from: beat.chosen.fileName, to: pick.fileName };
      beat.alternatives = candidates.filter((asset) => asset.assetId !== pick.assetId);
      beat.chosen = toChosen(pick);
    }

    used.add(pick.assetId);
  }

  // Trim the shortlist for review after diversifying -- 11 thumbnails per scene is noise.
  for (const beat of beats) {
    if (beat.alternatives?.length > 5) {
      beat.alternatives = beat.alternatives.slice(0, 5);
    }
  }

  return beats;
}

export async function sourceBeatAssets({
  beats,
  catalogGame,
  limit = 12,
  retryEmpty = true,
  verifiedOnly = false,
}) {
  if (!beats.length) {
    return [];
  }

  const client = await createAssetFinderClient();

  // Guard before spending any calls. Both an unmapped game and an unfilterable one would produce
  // whole-catalog results for the wrong game, which is worse than no results at all.
  const gate = await isGameFilterable(catalogGame, client);

  if (!gate.filterable) {
    const detail = {
      'game-unmapped': 'No catalog game is mapped for this game id in config/game-aliases.json, so no assets were sourced. Searching anyway would run unscoped and return whole-catalog results for the wrong game.',
      'game-not-in-catalog': `"${catalogGame}" is not a filterable game in the asset catalog, so no assets were sourced. Searching anyway would run unscoped and return whole-catalog results for the wrong game.`,
      'asset-finder-unreachable': `The asset finder could not be reached (${gate.detail}), so no assets were sourced. This is an outage, not a catalog or game-name problem.`,
    }[gate.reason];

    return beats.map((beat) => ({
      ...beat,
      confident: false,
      needsHumanReview: true,
      skipped: gate.reason,
      warnings: [detail],
      chosen: null,
      alternatives: [],
    }));
  }

  const controls = { limit, allowInferred: true };

  if (catalogGame) {
    controls.game = catalogGame;
  }

  const sourced = await Promise.all(beats.map(async (beat) => {
    try {
      let result = await client.sourceAssets(beat.brief, controls);
      const filterDropped = result.ignoredFilters.length > 0;

      // Retry only a well-formed empty result: the finder's brief parser was measured returning 0
      // then 5 assets for byte-identical requests. Retrying a dropped filter would just re-drop it.
      if (retryEmpty && !filterDropped && result.count === 0) {
        const retried = await client.sourceAssets(beat.brief, controls);

        if (retried.count > 0 && retried.ignoredFilters.length === 0) {
          result = retried;
        }
      }

      // A dropped filter means these assets are for whichever game dominates the catalog. Never pick
      // from them, and never pass them on as alternatives either.
      if (result.ignoredFilters.length > 0) {
        return {
          ...beat,
          confident: false,
          needsHumanReview: true,
          ignoredFilters: result.ignoredFilters,
          warnings: result.warnings,
          summary: result.summary,
          interpretedQuery: result.interpretedQuery,
          unusableResults: result.count,
          chosen: null,
          alternatives: [],
        };
      }

      const tagged = result.assets.map((asset) => ({ ...asset, verification: verificationOf(asset) }));
      const usable = verifiedOnly ? tagged.filter((asset) => asset.verification === 'verified') : tagged;

      // confident means "the search was well-formed", not "this asset fits the beat" -- so the
      // shortlist is always carried through for a human to check.
      const chosen = result.confident ? usable[0] : null;
      const floor = reviewScoreFloor();
      const weak = chosen ? Number(chosen.score) < floor : false;
      const droppedUnverified = tagged.length - usable.length;

      return {
        ...beat,
        confident: result.confident,
        // Weak scores override confident -- see reviewScoreFloor.
        needsHumanReview: !result.confident || weak || !chosen,
        lowScore: weak ? { score: chosen.score, floor } : null,
        droppedUnverified: droppedUnverified || undefined,
        ignoredFilters: result.ignoredFilters,
        warnings: result.warnings,
        appliedGameFilter: result.appliedGameFilter,
        summary: result.summary,
        interpretedQuery: result.interpretedQuery,
        chosen: chosen ? toChosen(chosen) : null,
        alternatives: chosen ? usable.slice(1) : usable,
      };
    } catch (error) {
      return {
        ...beat,
        confident: false,
        needsHumanReview: true,
        error: error.message,
        chosen: null,
        alternatives: [],
      };
    }
  }));

  return assignDistinctAssets(sourced);
}
