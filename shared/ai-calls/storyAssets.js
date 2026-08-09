/**
 * Staged asset search for the storytelling ad.
 *
 * Order is deliberate and matches how a human would look: filter the game first, then decide what
 * KIND of asset the beat needs (characters, icons, banners, castles...), then the event, then anything
 * specific. One query per asset kind rather than one blended query, because a blended brief pulls
 * every kind toward whichever cluster dominates the catalog.
 *
 * Ranking then re-reads each candidate's own metadata -- folder name, folder description, and the
 * per-asset (Gemini) description -- and requires positive evidence for the requested kind. The
 * finder's score alone is not enough: it happily returns city buildings for "character portrait".
 *
 * This is intentionally slower than a single call. Accuracy over latency.
 */

import { createAssetFinderClient } from './assetFinderClient.js';
import { isGameFilterable } from './scriptBeats.js';

/**
 * Asset kinds, each mapped to the query wording the finder actually understands.
 *
 * Measured against the live catalog: "character" is rejected as an unknown category while "portrait"
 * lands on the HeadIcon folder, so the query word is not always the word a human would use.
 * `folderHints` are matched against folder name and description when scoring evidence.
 */
export const assetKinds = {
  character: {
    triggers: ['character', 'hero', 'heroes', 'warrior', 'knight', 'princess', 'commander', 'soldier', 'portrait', 'face', 'person', 'mascot'],
    queries: ['portrait', 'head icon', 'character art'],
    // No 'skin' here: it made every "Limited Skin" folder look like a character folder and buried
    // HeadIcon, which is the actual character art. Skin is its own kind below.
    folderHints: ['headicon', 'head icon', 'portrait', 'character', 'princess', 'knight', 'hero'],
  },
  icon: {
    triggers: ['icon', 'reward', 'coin', 'coins', 'chest', 'gift', 'item', 'currency', 'trophy'],
    queries: ['icon', 'reward icon'],
    folderHints: ['icon', 'reward', 'coin', 'gift', 'packet', 'daily', 'event'],
  },
  banner: {
    triggers: ['banner', 'poster', 'promo', 'splash', 'key art', 'header', 'cover'],
    queries: ['banner', 'promo banner'],
    folderHints: ['banner', 'promo', 'main event', 'poster'],
  },
  castle: {
    triggers: ['castle', 'fortress', 'city', 'building', 'buildings', 'tower', 'base', 'town', 'statue', 'market'],
    queries: ['castle', 'building', 'city'],
    folderHints: ['city', 'decoration', 'building', 'castle', 'stadium', 'town', 'statue'],
  },
  background: {
    triggers: ['background', 'backdrop', 'scene', 'environment', 'map', 'world map', 'table', 'landscape'],
    queries: ['background', 'scene background'],
    folderHints: ['background', 'table', 'bg', 'city', 'stadium', 'decoration'],
  },
  skin: {
    triggers: ['skin', 'outfit', 'costume', 'cosmetic', 'limited'],
    queries: ['skin', 'limited skin'],
    folderHints: ['skin', 'limited', 'cosmetic'],
  },
};

const eventWords = [
  'ramadan', 'eid', 'adha', 'national day', 'new year', 'anniversary', 'launch', 'summer', 'winter',
  'world cup', 'championship', 'tournament', 'halloween', 'christmas', 'black friday',
];

// Words that start sentences without being names. Needed because a proper noun can sit at position 0
// ("Leonidas leads the charge") and skipping every first word loses exactly the names worth searching.
const commonStarters = new Set([
  'a', 'after', 'an', 'and', 'as', 'at', 'before', 'but', 'close', 'create', 'during', 'each', 'every', 'facing',
  'for', 'he', 'her', 'his', 'holding', 'in', 'influencer', 'it', 'its', 'keep', 'medium', 'on', 'our',
  'phone', 'screen', 'she', 'show', 'so', 'strong', 'talking', 'that', 'the', 'their', 'then', 'these',
  'they', 'this', 'those', 'to', 'use', 'we', 'when', 'while', 'wide', 'with', 'write', 'you', 'your',
]);

const nonCharacterNames = new Set([
  'ad', 'advert', 'advertisement', 'cinematic', 'commander', 'game', 'infantry', 'king', 'scene',
  'script', 'soldier', 'spartan', 'story', 'storytelling',
]);

// The WOS catalog registers this character with one L. Normalize the common mythological spelling
// before applying the hard character filter or the finder drops it and returns unrelated assets.
const characterAliases = new Map([
  ['apollo', 'Apolo'],
  ['apolo', 'Apolo'],
  ['cassandra', 'Cassandra'],
]);

function normalize(text) {
  return String(text || '').replace(/\[[^\]]*\]/g, ' ').toLowerCase();
}

function hasWord(haystack, word) {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack);
}

/** Named characters present in the intake brief, before the story has been generated. */
export function extractNamedCharacterCandidates(text, { exclude = [] } = {}) {
  const raw = String(text || '');
  const excluded = new Set(exclude.flatMap((value) => (
    String(value || '').toLowerCase().match(/[a-z']{3,}/g) || []
  )));
  const candidates = [];

  function add(name) {
    const lower = String(name || '').toLowerCase();
    const canonical = characterAliases.get(lower) || name;

    if (!lower || excluded.has(lower) || nonCharacterNames.has(lower)) {
      return;
    }

    if (!candidates.some((candidate) => candidate.toLowerCase() === String(canonical).toLowerCase())) {
      candidates.push(canonical);
    }
  }

  // Preserve the order in which names appear. Known aliases remain detectable in lowercase, while
  // other possible names must look like proper nouns and are verified by the finder before use.
  for (const match of raw.matchAll(/\b[A-Za-z][A-Za-z']{2,}\b/g)) {
    const token = match[0];

    if (characterAliases.has(token.toLowerCase()) || /^[A-Z]/.test(token)) {
      add(token);
    }
  }

  return candidates.slice(0, 8);
}

function normalizeCharacterName(value) {
  return String(value || '').trim().normalize('NFKC').toLowerCase();
}

function levenshteinDistance(first, second) {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);

  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    let diagonal = previous[0];
    previous[0] = firstIndex;

    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const above = previous[secondIndex];
      previous[secondIndex] = Math.min(
        previous[secondIndex] + 1,
        previous[secondIndex - 1] + 1,
        diagonal + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }

  return previous[second.length];
}

function catalogCharacterValue(entry) {
  return typeof entry === 'string' ? entry : entry?.value;
}

function looksLikeCharacterName(value) {
  // The endpoint also contains legacy filename-derived identities such as mc_building_10. Those are
  // filterable values, but not character names and must never be extracted from prose.
  return /^[\p{L}\p{M}][\p{L}\p{M}' -]{2,}$/u.test(String(value || '').trim());
}

/**
 * Match prose against the live game's character registry. Matching is case-insensitive and permits one
 * edit for ordinary names or two edits for names of eight+ letters, so a typo such as "odyssues" still
 * resolves uniquely to Odysseus. Ambiguous fuzzy matches are ignored instead of guessed.
 */
export function extractCatalogCharacterCandidates(text, catalogCharacters, { exclude = [] } = {}) {
  const raw = String(text || '');
  const normalizedText = normalizeCharacterName(raw);
  const excluded = new Set(exclude.flatMap((value) => (
    normalizeCharacterName(value).match(/[\p{L}\p{M}']{3,}/gu) || []
  )));
  const catalog = catalogCharacters
    .map((entry) => catalogCharacterValue(entry))
    .filter((value) => looksLikeCharacterName(value))
    .map((value) => ({ value, normalized: normalizeCharacterName(value) }));
  const matches = [];

  function add(value, index) {
    const normalized = normalizeCharacterName(value);

    if (excluded.has(normalized) || nonCharacterNames.has(normalized)) {
      return;
    }

    const existing = matches.find((match) => normalizeCharacterName(match.value) === normalized);
    if (!existing) {
      matches.push({ value, index });
    } else if (index < existing.index) {
      existing.index = index;
    }
  }

  // Explicit aliases are authoritative before fuzzy matching (Apollo -> catalog spelling Apolo).
  for (const [alias, canonical] of characterAliases) {
    const index = normalizedText.search(new RegExp(`\\b${alias}\\b`, 'u'));
    if (index >= 0 && catalog.some((entry) => entry.normalized === normalizeCharacterName(canonical))) {
      add(canonical, index);
    }
  }

  for (const entry of catalog) {
    const escaped = entry.normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const index = normalizedText.search(new RegExp(`\\b${escaped}\\b`, 'u'));
    if (index >= 0) {
      add(entry.value, index);
    }
  }

  const words = [...normalizedText.matchAll(/\b[\p{L}\p{M}']{4,}\b/gu)];
  for (const wordMatch of words) {
    const word = wordMatch[0];
    if (excluded.has(word) || commonStarters.has(word) || nonCharacterNames.has(word)) {
      continue;
    }

    const candidates = catalog
      .filter((entry) => !entry.normalized.includes(' '))
      .map((entry) => ({ ...entry, distance: levenshteinDistance(word, entry.normalized) }))
      .filter((entry) => entry.distance > 0 && entry.distance <= (entry.normalized.length >= 8 ? 2 : 1))
      .sort((first, second) => first.distance - second.distance);

    if (candidates.length > 0 && (candidates.length === 1 || candidates[0].distance < candidates[1].distance)) {
      add(candidates[0].value, wordMatch.index ?? 0);
    }
  }

  return matches
    .sort((first, second) => first.index - second.index)
    .map((match) => match.value)
    .slice(0, 8);
}

/** Resolve character intent from the live catalog, falling back to conservative proper-noun extraction. */
export async function resolveNamedCharacterCandidates(text, {
  catalogGame,
  exclude = [],
} = {}) {
  if (!catalogGame) {
    return extractNamedCharacterCandidates(text, { exclude });
  }

  try {
    const client = await createAssetFinderClient();
    const characters = await client.searchCharacters(catalogGame);
    const catalogMatches = extractCatalogCharacterCandidates(text, characters, { exclude });

    return catalogMatches.length
      ? catalogMatches
      : extractNamedCharacterCandidates(text, { exclude });
  } catch {
    return extractNamedCharacterCandidates(text, { exclude });
  }
}

/**
 * The characters the writer may cast, i.e. exactly the catalog values that could later be resolved
 * back out of the script. Filtered with the same predicates the matcher uses, so a name shown to the
 * writer is always a name the asset lookup can consume. Returns [] rather than throwing: a roster is
 * an improvement to the prompt, never a precondition for writing a script.
 */
export async function listCastableCharacters(catalogGame) {
  if (!catalogGame) {
    return [];
  }

  try {
    const client = await createAssetFinderClient();
    const characters = await client.searchCharacters(catalogGame);

    return characters
      .map((entry) => catalogCharacterValue(entry))
      .filter((value) => (
        looksLikeCharacterName(value) && !nonCharacterNames.has(normalizeCharacterName(value))
      ));
  } catch {
    return [];
  }
}

function nameVariants(name) {
  const lower = String(name || '').toLowerCase();

  return lower === 'apolo' || lower === 'apollo'
    ? ['apolo', 'apollo']
    : [lower];
}

function assetMatchesCharacter(asset, names) {
  const metadata = normalize([
    asset.fileName,
    asset.entity,
    asset.description,
    asset.folder,
  ].filter(Boolean).join(' '));

  return names.filter((name) => nameVariants(name).some((variant) => hasWord(metadata, variant)));
}

/**
 * Search each character independently and require both the finder filter and literal asset metadata.
 * Semantic similarity alone is never sufficient for a named-character request.
 */
export async function findNamedCharacterAssets({
  catalogGame,
  names,
  limit = 18,
  perCharacterLimit = 30,
}) {
  const client = await createAssetFinderClient();
  const gate = await isGameFilterable(catalogGame, client);

  if (!gate.filterable) {
    return {
      skipped: gate.reason,
      detail: gate.detail || null,
      need: null,
      queries: [],
      assets: [],
    };
  }

  const queries = [];
  const byAsset = new Map();

  await Promise.all(names.map(async (name) => {
    try {
      const result = await client.sourceAssets(name, {
        limit: perCharacterLimit,
        game: catalogGame,
        character: name,
        allowInferred: true,
      });
      const characterFilterDropped = result.ignoredFilters.includes('character');

      queries.push({
        kind: 'character',
        character: name,
        query: name,
        returned: result.count,
        ignoredFilters: result.ignoredFilters,
      });

      if (result.ignoredFilters.length || characterFilterDropped) {
        return;
      }

      for (const asset of result.assets) {
        const matchedCharacters = assetMatchesCharacter(asset, names);

        if (!matchedCharacters.length) {
          continue;
        }

        const ranked = {
          ...asset,
          kind: 'character',
          matchedCharacters,
          finderScore: asset.score ?? 0,
          evidence: matchedCharacters.length,
          evidenceReasons: matchedCharacters.map((character) => `asset metadata names ${character}`),
          kindConfirmed: true,
          combined: matchedCharacters.length * 2 + (asset.score ?? 0),
        };
        const existing = byAsset.get(asset.assetId);

        if (!existing || ranked.combined > existing.combined) {
          byAsset.set(asset.assetId, ranked);
        }
      }
    } catch (error) {
      queries.push({ kind: 'character', character: name, query: name, error: error.message });
    }
  }));

  return {
    skipped: null,
    need: { kinds: ['character'], event: null, specifics: names },
    queries,
    assets: [...byAsset.values()]
      .sort((first, second) => second.combined - first.combined)
      .slice(0, limit),
  };
}

/**
 * Split "Leonidas - a battle-worn Spartan commander..." into the catalog name and the description.
 *
 * The name is resolved against the live registry rather than read off the string, so an entry written
 * as "Athena (divine hero): ..." resolves just as well as the prefixed form, and a role label with no
 * catalog entry ("Spartan Phalanx Soldiers") correctly resolves to no name at all.
 */
export function splitCastEntry(entry, catalogCharacters = [], { exclude = [] } = {}) {
  const raw = String(entry || '').trim();
  const [name = null] = extractCatalogCharacterCandidates(raw, catalogCharacters, { exclude });
  const separator = raw.match(/^\s*([^\p{L}]*[\p{L}\p{M}' -]{2,40}?)\s*(?:\(([^)]*)\))?\s*[-–—:]\s*/u);
  // Drop a leading "Name - " / "Name: " / "Name (role):" so the description search is not dominated
  // by a name the semantic index does not know.
  const description = separator ? raw.slice(separator[0].length).trim() : raw;

  return {
    raw,
    name,
    // The role the writer gave this entry ("Spartan Leader"). Two or three nouns, which is the query
    // shape the finder actually answers -- a full descriptive sentence returns nothing at all.
    label: separator ? separator[1].trim() : '',
    description: description || raw,
  };
}

/**
 * Query ladder for an entry with no catalog name.
 *
 * Only character art can fill a cast slot, so the ladder leads with the role label plus explicit
 * character-type terms: the label alone ("Spartan Leader") ranks buildings above every hero, while
 * the same label asked as a character returns Lynceus, Gannicus and Belleroph. The bare label and the
 * description's first clause follow as backstops. The full description is never used -- the finder
 * reads its colors and materials as hard constraints and returns nothing at all.
 */
function describeQueries(entry) {
  const firstClause = entry.description.split(/[,;.]/)[0].trim();
  const subject = entry.label || firstClause;

  return [...new Set([
    subject ? `${subject} hero character portrait` : '',
    entry.label,
    firstClause,
  ].map((query) => query.trim()).filter((query) => query.length > 2))];
}

/** Keep only results the finder actually scoped to this game; an unscoped hit is another game's art. */
function usableResult(result) {
  return !result.ignoredFilters.includes('game');
}

function rankAsset(asset, { matchedBy, character }) {
  return {
    ...asset,
    kind: 'character',
    character,
    matchedBy,
    finderScore: asset.score ?? 0,
    // A literal metadata match outranks a semantic one, so a named character never loses its own art
    // to a better-scoring lookalike.
    combined: (matchedBy === 'name' ? 100 : 0) + (asset.score ?? 0),
  };
}

/**
 * One asset per cast entry, in cast order.
 *
 * Named entries are searched by character filter and must be confirmed by literal asset metadata.
 * Entries with no catalog name fall back to a semantic search over their description, and take the
 * best available result even when it scores poorly -- a weak match is reported, not dropped, so the
 * asset set always lines up one-to-one with the characters the script actually wrote.
 */
export async function findAssetsPerCharacter({
  catalogGame,
  cast = [],
  exclude = [],
  perCharacterLimit = 30,
}) {
  const client = await createAssetFinderClient();
  const gate = await isGameFilterable(catalogGame, client);

  if (!gate.filterable) {
    return {
      skipped: gate.reason,
      detail: gate.detail || null,
      need: null,
      queries: [],
      assets: [],
      perCharacter: [],
    };
  }

  let catalogCharacters = [];

  try {
    catalogCharacters = await client.searchCharacters(catalogGame);
  } catch {
    catalogCharacters = [];
  }

  const queries = [];
  const entries = cast.map((entry) => splitCastEntry(entry, catalogCharacters, { exclude }));

  const rosterNames = catalogCharacters
    .map((value) => catalogCharacterValue(value))
    .filter((value) => looksLikeCharacterName(value) && !nonCharacterNames.has(normalizeCharacterName(value)));

  async function search(entry, query, controls) {
    try {
      const result = await client.sourceAssets(query, controls);

      queries.push({
        kind: 'character',
        character: entry.name || entry.raw,
        matchedBy: entry.name ? 'name' : 'description',
        query,
        returned: result.count,
        ignoredFilters: result.ignoredFilters,
      });

      return usableResult(result) ? result : null;
    } catch (error) {
      queries.push({
        kind: 'character',
        character: entry.name || entry.raw,
        matchedBy: entry.name ? 'name' : 'description',
        query,
        error: error.message,
      });

      return null;
    }
  }

  // Search every cast entry concurrently, then assign in cast order so an earlier character keeps its
  // own art when two entries compete for the same asset.
  const searched = await Promise.all(entries.map(async (entry) => {
    if (entry.name) {
      const result = await search(entry, entry.name, {
        limit: perCharacterLimit,
        game: catalogGame,
        character: entry.name,
        allowInferred: true,
      });

      if (!result || result.ignoredFilters.includes('character')) {
        return { entry, candidates: [] };
      }

      return {
        entry,
        candidates: result.assets
          .filter((asset) => assetMatchesCharacter(asset, [entry.name]).length)
          .map((asset) => rankAsset(asset, { matchedBy: 'name', character: entry.name }))
          .sort((first, second) => second.combined - first.combined),
      };
    }

    // A role label with no catalog entry still needs a character to stand in for it. Walk the query
    // ladder until one returns something, and keep only assets that are themselves characters -- the
    // finder happily answers "Spartan commander" with a building, which is useless in a cast slot.
    for (const query of describeQueries(entry)) {
      const result = await search(entry, query, { limit: perCharacterLimit, game: catalogGame });

      if (!result) {
        continue;
      }

      const candidates = result.assets
        .filter((asset) => assetMatchesCharacter(asset, rosterNames).length)
        .map((asset) => rankAsset(asset, { matchedBy: 'description', character: entry.raw }))
        .sort((first, second) => second.combined - first.combined);

      if (candidates.length) {
        return { entry, candidates };
      }
    }

    return { entry, candidates: [] };
  }));

  const used = new Set();
  const perCharacter = searched.map(({ entry, candidates }) => {
    const fresh = candidates.find((asset) => !used.has(asset.assetId));
    // Reuse only when this entry has nothing of its own left. Two entries backed by the same catalog
    // character (a commander and their troops) then still both carry art.
    const chosen = fresh || candidates[0] || null;

    if (chosen) {
      used.add(chosen.assetId);
    }

    return {
      character: entry.raw,
      name: entry.name,
      description: entry.description,
      matchedBy: chosen ? chosen.matchedBy : null,
      reused: Boolean(chosen && !fresh),
      // Surfaced rather than filtered: the caller decides what to do with a poor description match.
      weak: Boolean(chosen && chosen.matchedBy === 'description' && (chosen.score ?? 0) < 0.5),
      asset: chosen,
      alternatives: candidates.filter((asset) => asset.assetId !== chosen?.assetId),
    };
  });

  return {
    skipped: null,
    need: {
      kinds: ['character'],
      event: null,
      specifics: entries.map((entry) => entry.name).filter(Boolean),
    },
    queries,
    assets: perCharacter.map((slot) => slot.asset).filter(Boolean),
    perCharacter,
  };
}

/**
 * What does this beat need? Kinds first, then the event, then specifics (named entities the catalog
 * might actually hold, like Leonidas or Sparta).
 */
export function classifyAssetNeeds(text, { fallbackKind = 'background' } = {}) {
  const haystack = normalize(text);
  const kinds = Object.entries(assetKinds)
    .filter(([, kind]) => kind.triggers.some((trigger) => hasWord(haystack, trigger)))
    .map(([name]) => name);

  const events = eventWords.filter((event) => hasWord(haystack, event));

  // Capitalised mid-sentence words: proper nouns worth searching for verbatim.
  const specifics = [];

  for (const sentence of String(text || '').split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/);

    for (const [index, word] of words.entries()) {
      const bare = word.split(/[-–—]/)[0].replace(/[^\w']/g, '');

      if (bare.length < 4 || !/^[A-Z][a-z]+$/.test(bare)) {
        continue;
      }

      const lower = bare.toLowerCase();

      if (index === 0 && commonStarters.has(lower)) {
        continue;
      }

      if (!eventWords.includes(lower) && !specifics.includes(bare)) {
        specifics.push(bare);
      }
    }
  }

  return {
    kinds: kinds.length ? kinds : [fallbackKind],
    event: events[0] || null,
    specifics: specifics.slice(0, 3),
  };
}

/**
 * Stage 2-4 in order: kind, then event, then specifics. Game stays the hard filter.
 *
 * Each kind runs several phrasings BARE plus one enriched with event and specifics. Bare queries are
 * what actually reach a folder ("portrait" finds HeadIcon; "character portrait head icon Leonidas"
 * does not), while the enriched one is what finds event-specific art. Merging both beats either.
 */
export function buildStagedQueries(kindName, need) {
  const kind = assetKinds[kindName];
  const queries = [...kind.queries];
  const extra = [need.event || '', need.specifics.join(' ')].filter(Boolean).join(' ').trim();

  if (extra) {
    queries.push(`${kind.queries[0]} ${extra}`);
  }

  return queries;
}

/**
 * Evidence from the asset's own metadata. The finder's score says how close the embedding was; this
 * says whether the folder a human organised it into actually matches what we asked for.
 */
export function scoreEvidence(asset, kindName, need) {
  const kind = assetKinds[kindName];
  const folderName = normalize(asset.folder);
  const folderDescription = normalize(asset.folderDescription);
  // The per-asset Gemini description. Mostly null in the catalog today, so it can only add.
  const assetDescription = normalize(asset.description);
  const reasons = [];

  const kindInFolderName = kind.folderHints.some((hint) => folderName.includes(hint));
  const kindInFolderDescription = kind.folderHints.some((hint) => folderDescription.includes(hint));
  const kindInDescription = kind.folderHints.some((hint) => assetDescription.includes(hint));

  if (kindInFolderName) {
    reasons.push(`folder name matches ${kindName}`);
  }

  if (kindInFolderDescription) {
    reasons.push(`folder description matches ${kindName}`);
  }

  if (kindInDescription) {
    reasons.push(`asset description matches ${kindName}`);
  }

  const eventHit = need.event
    && [folderName, folderDescription, assetDescription].some((text) => text.includes(need.event));

  if (eventHit) {
    reasons.push(`event "${need.event}"`);
  }

  const specificHits = need.specifics.filter((specific) => {
    const lower = specific.toLowerCase();

    return [folderName, folderDescription, assetDescription].some((text) => text.includes(lower));
  });

  for (const hit of specificHits) {
    reasons.push(`mentions ${hit}`);
  }

  // Folder name is the strongest signal: a human named that folder to define a set.
  const evidence = (kindInFolderName ? 0.35 : 0)
    + (kindInFolderDescription ? 0.2 : 0)
    + (kindInDescription ? 0.2 : 0)
    + (eventHit ? 0.15 : 0)
    + (specificHits.length ? 0.15 : 0);

  return {
    evidence,
    reasons,
    // A candidate with no kind evidence anywhere is the wrong kind of asset, whatever it scored.
    kindConfirmed: kindInFolderName || kindInFolderDescription || kindInDescription,
  };
}

/**
 * Run the staged search. One query per requested kind, results merged and re-ranked on combined
 * evidence. Returns ranked candidates plus the trace of what was asked, so a low-quality result can
 * be explained rather than guessed at.
 */
export async function findStoryAssets({
  catalogGame,
  diversifyKinds = false,
  text,
  limit = 6,
  perKindLimit = 20,
  requireKindEvidence = true,
}) {
  const client = await createAssetFinderClient();
  const gate = await isGameFilterable(catalogGame, client);

  if (!gate.filterable) {
    return {
      skipped: gate.reason,
      detail: gate.detail || null,
      need: null,
      queries: [],
      assets: [],
    };
  }

  const need = classifyAssetNeeds(text);
  const queries = [];
  const byAsset = new Map();

  for (const kindName of need.kinds) {
    for (const query of buildStagedQueries(kindName, need)) {
      let result;

      try {
        result = await client.sourceAssets(query, {
          limit: perKindLimit,
          game: catalogGame,
          allowInferred: true,
        });
      } catch (error) {
        queries.push({ kind: kindName, query, error: error.message });
        continue;
      }

      queries.push({
        kind: kindName,
        query,
        returned: result.count,
        ignoredFilters: result.ignoredFilters,
      });

      // A dropped filter means these are for the wrong game; never merge them in.
      if (result.ignoredFilters.length) {
        continue;
      }

      for (const asset of result.assets) {
        const scored = scoreEvidence(asset, kindName, need);
        const combined = (asset.score ?? 0) + scored.evidence;
        const existing = byAsset.get(asset.assetId);

        if (!existing || combined > existing.combined) {
          byAsset.set(asset.assetId, {
            ...asset,
            kind: kindName,
            finderScore: asset.score ?? 0,
            evidence: scored.evidence,
            evidenceReasons: scored.reasons,
            kindConfirmed: scored.kindConfirmed,
            combined,
          });
        }
      }
    }
  }

  let ranked = [...byAsset.values()].sort((a, b) => b.combined - a.combined);

  if (requireKindEvidence) {
    // Apply the fallback per kind. A confirmed castle must not erase every character candidate just
    // because the catalog's character folders have weaker metadata.
    ranked = need.kinds.flatMap((kindName) => {
      const candidates = ranked.filter((asset) => asset.kind === kindName);
      const confirmed = candidates.filter((asset) => asset.kindConfirmed);

      return confirmed.length
        ? confirmed
        : candidates.map((asset) => ({ ...asset, unconfirmed: true }));
    }).sort((a, b) => b.combined - a.combined);
  }

  if (diversifyKinds && need.kinds.length > 1) {
    const diverse = [];
    const seen = new Set();
    const queues = new Map(need.kinds.map((kindName) => [
      kindName,
      ranked.filter((asset) => asset.kind === kindName),
    ]));

    while (diverse.length < limit && [...queues.values()].some((queue) => queue.length)) {
      for (const kindName of need.kinds) {
        const queue = queues.get(kindName);
        let asset = queue.shift();

        while (asset && seen.has(asset.assetId)) {
          asset = queue.shift();
        }

        if (asset) {
          seen.add(asset.assetId);
          diverse.push(asset);
        }

        if (diverse.length >= limit) {
          break;
        }
      }
    }

    for (const asset of ranked) {
      if (diverse.length >= limit) {
        break;
      }

      if (!seen.has(asset.assetId)) {
        seen.add(asset.assetId);
        diverse.push(asset);
      }
    }

    ranked = diverse;
  }

  return {
    skipped: null,
    need,
    queries,
    assets: ranked.slice(0, limit),
  };
}
