/**
 * The ad's asset set, as a flat pool rather than one asset per scene.
 *
 * Sourcing still runs per beat (that is how briefs are built), but the result is flattened into one
 * de-duplicated list for the whole ad. Whatever stays in `selected` is what the downstream generator
 * receives. `spare` holds the rest of the shortlist so Replace has somewhere to draw from, and a
 * replaced asset goes back there rather than being lost.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveRunDir } from './beatPicks.js';

const selectionFile = 'assets.json';

function trim(asset) {
  return {
    assetId: asset.assetId,
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

  const incoming = selection.spare.shift();
  const outgoing = selection.selected[index];

  selection.selected[index] = incoming;
  selection.spare.push(outgoing);

  return {
    selection: await writeSelection({ runId, selection, cwd }),
    replaced: outgoing,
    with: incoming,
  };
}
