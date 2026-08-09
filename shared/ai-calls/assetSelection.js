/**
 * The ad's asset set, as a flat pool rather than one asset per scene.
 *
 * UGC sourcing can run per beat while storytelling sourcing runs once from the intake brief. Both
 * paths end here as one de-duplicated list for the whole ad. Whatever stays in `selected` is what the
 * downstream generator receives. `spare` holds the rest of the shortlist so Replace has somewhere
 * to draw from, and a replaced asset goes back there rather than being lost.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveRunDir } from './beatPicks.js';

const selectionFile = 'assets.json';

function trim(asset) {
  return {
    assetId: asset.assetId,
    // Which cast member this asset stands in for. Null on the UGC path, which sources per beat.
    character: asset.character ?? null,
    fileName: asset.fileName,
    imageUrl: asset.imageUrl,
    previewUrl: asset.previewUrl,
    downloadUrl: asset.downloadUrl,
    folder: asset.folder ?? null,
    entity: asset.entity ?? null,
    game: asset.game ?? null,
    verification: asset.verification ?? null,
    score: asset.score ?? null,
  };
}

/** Flatten per-beat results into one ad-level pool, keeping first-seen order and dropping repeats. */
export function buildSelection(beats = []) {
  const seen = new Set();
  const selected = [];
  const spare = [];

  for (const beat of beats) {
    if (beat.chosen && !seen.has(beat.chosen.assetId)) {
      seen.add(beat.chosen.assetId);
      selected.push(trim(beat.chosen));
    }
  }

  for (const beat of beats) {
    for (const asset of beat.alternatives || []) {
      if (!seen.has(asset.assetId)) {
        seen.add(asset.assetId);
        spare.push(trim(asset));
      }
    }
  }

  return { selected, spare };
}

/**
 * Build an ad-level selection from one brief-driven search.
 *
 * Storytelling sourcing starts before the script exists, so there are deliberately no scene beats
 * to flatten. Preserve the finder's ranking, choose the first few assets for the ad, and keep the
 * rest available to Replace in the UI.
 */
export function buildSelectionFromAssets(assets = [], { selectedCount = 5 } = {}) {
  const unique = [];
  const seen = new Set();

  for (const asset of assets) {
    if (!asset?.assetId || seen.has(asset.assetId)) {
      continue;
    }

    seen.add(asset.assetId);
    unique.push(trim(asset));
  }

  return {
    selected: unique.slice(0, selectedCount),
    spare: unique.slice(selectedCount),
  };
}

/**
 * One selected asset per cast entry, in cast order.
 *
 * Unlike the pooled builder this never truncates to a count: the cast decides how many assets the ad
 * has. An entry the finder could not fill is simply absent from `selected`, and every other entry's
 * runner-up stays in `spare` for Replace.
 */
export function buildSelectionFromPerCharacter(perCharacter = []) {
  const seen = new Set();
  const selected = [];
  const spare = [];

  for (const slot of perCharacter) {
    if (slot?.asset) {
      selected.push(trim(slot.asset));
    }
  }

  for (const slot of perCharacter) {
    for (const asset of slot?.alternatives || []) {
      if (!asset?.assetId || seen.has(asset.assetId)) {
        continue;
      }

      seen.add(asset.assetId);
      spare.push(trim(asset));
    }
  }

  return { selected, spare };
}

export async function writeSelection({ runId, selection, cwd = process.cwd() }) {
  const { dir } = resolveRunDir(runId, { cwd });

  await writeFile(
    path.join(dir, selectionFile),
    `${JSON.stringify(selection, null, 2)}\n`,
    'utf8',
  );

  return selection;
}

export async function readSelection(runId, { cwd = process.cwd() } = {}) {
  const { dir } = resolveRunDir(runId, { cwd });

  try {
    const data = JSON.parse(await readFile(path.join(dir, selectionFile), 'utf8'));

    return {
      selected: Array.isArray(data.selected) ? data.selected : [],
      spare: Array.isArray(data.spare) ? data.spare : [],
    };
  } catch {
    return { selected: [], spare: [] };
  }
}

/** Drop an asset from the ad. It moves to spare so Replace can still reach it later. */
export async function removeAsset({ runId, assetId, cwd = process.cwd() }) {
  const selection = await readSelection(runId, { cwd });
  const index = selection.selected.findIndex((asset) => asset.assetId === assetId);

  if (index === -1) {
    throw new Error('That asset is not in the selection.');
  }

  const [dropped] = selection.selected.splice(index, 1);

  selection.spare.push(dropped);

  return { selection: await writeSelection({ runId, selection, cwd }), removed: dropped };
}

/** Swap an asset for the next spare candidate, in place, so scene order is preserved. */
export async function replaceAsset({ runId, assetId, cwd = process.cwd() }) {
  const selection = await readSelection(runId, { cwd });
  const index = selection.selected.findIndex((asset) => asset.assetId === assetId);

  if (index === -1) {
    throw new Error('That asset is not in the selection.');
  }

  if (!selection.spare.length) {
    throw new Error('No other candidates left to swap in.');
  }

  const outgoing = selection.selected[index];
  // A slot stands in for one cast member, so prefer a runner-up found for that same character and
  // carry the binding onto whatever swaps in. Otherwise Replace would relabel the slot.
  const preferred = outgoing.character
    ? selection.spare.findIndex((asset) => asset.character === outgoing.character)
    : -1;
  const [incoming] = selection.spare.splice(preferred === -1 ? 0 : preferred, 1);

  selection.selected[index] = { ...incoming, character: outgoing.character ?? incoming.character ?? null };
  selection.spare.push(outgoing);

  return {
    selection: await writeSelection({ runId, selection, cwd }),
    replaced: outgoing,
    with: incoming,
  };
}
