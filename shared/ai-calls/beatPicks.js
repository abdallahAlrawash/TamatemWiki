/**
 * Final asset selection and the downstream handoff artifact.
 *
 * asset-beats.json is what the finder returned. handoff.json is what the next agent consumes: the
 * script plus exactly one asset per beat, after any human correction. Keeping them separate means a
 * re-pick never loses the original shortlist.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAssetPublicBase } from './assetFinderClient.js';

const outputsDir = path.join('storage', 'outputs');

/**
 * Swap the finder's own origin for a routable one. The finder mints asset URLs against its own host
 * (localhost here), which a remote consumer cannot fetch. Only the origin changes; the path is the
 * finder's and must survive untouched.
 */
function toPublicUrl(url, publicBase) {
  if (!url || !publicBase) {
    return url ?? null;
  }

  try {
    const parsed = new URL(url);

    return `${publicBase}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Run ids are generated from an ISO timestamp; reject anything that is not that shape. */
export function resolveRunDir(runId, { cwd = process.cwd() } = {}) {
  const safeId = path.basename(String(runId || ''));

  if (!/^run-[\w.-]+$/.test(safeId)) {
    throw new Error('Invalid runId.');
  }

  return { safeId, dir: path.resolve(cwd, outputsDir, safeId) };
}

function assetForHandoff(asset, publicBase) {
  if (!asset) {
    return null;
  }

  return {
    assetId: asset.assetId,
    fileName: asset.fileName,
    imageUrl: toPublicUrl(asset.imageUrl, publicBase),
    previewUrl: toPublicUrl(asset.previewUrl, publicBase),
    downloadUrl: toPublicUrl(asset.downloadUrl, publicBase),
    folder: asset.folder ?? null,
    entity: asset.entity ?? null,
    game: asset.game ?? null,
    verification: asset.verification ?? null,
    score: asset.score ?? null,
  };
}

/**
 * Scenes carry the script; `assets` is the ad-level set the generator should use. Assets are no longer
 * bound to a scene -- whatever remains in the selection after the human removes or replaces entries is
 * what ships.
 */
export function buildHandoff({ runId, gameId, game, script, beats, selection = null, publicBase = null }) {
  const byScene = new Map((beats || []).map((beat) => [beat.sceneId, beat]));
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];

  return {
    runId,
    gameId,
    game: game ?? null,
    backgroundSfx: script?.background_sfx ?? [],
    assets: (selection?.selected ?? []).map((asset) => assetForHandoff(asset, publicBase)),
    scenes: scenes.map((scene) => {
      const sceneId = scene.scene_id || `SC${scene.scene_number || ''}`;
      const beat = byScene.get(sceneId);

      return {
        sceneId,
        durationSec: scene.duration_seconds ?? null,
        description: scene.description ?? '',
        image: scene.image ?? '',
        screen: scene.screen ?? null,
        vo: scene.vo ?? '',
        action: scene.action ?? '',
        assetBrief: beat?.brief ?? null,
      };
    }),
  };
}

export async function writeHandoff({
  runId, gameId, game, script, beats, selection = null, cwd = process.cwd(),
}) {
  const { dir } = resolveRunDir(runId, { cwd });
  const handoff = buildHandoff({
    runId,
    gameId,
    game,
    script,
    beats,
    selection,
    publicBase: await getAssetPublicBase(),
  });

  await writeFile(path.join(dir, 'handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

  return handoff;
}

export async function readHandoff(runId, { cwd = process.cwd() } = {}) {
  const { dir } = resolveRunDir(runId, { cwd });

  try {
    return JSON.parse(await readFile(path.join(dir, 'handoff.json'), 'utf8'));
  } catch {
    throw new Error('No handoff for that runId.');
  }
}
