/**
 * Streams asset bytes from the finder through the wiki server.
 *
 * The finder's /api/assets/:id/file and /preview are gated by ASSET_ACCESS_TOKEN. The browser must
 * never hold that token, so <img> tags and the Open/Download links point here instead and the token
 * is attached server-side. The handoff for the remote agent still carries the finder's own public
 * URLs -- that consumer gets its own token.
 */

import { getAssetFinderUrl } from './assetFinderClient.js';
import { loadEnv } from './loadEnv.js';

const variants = new Set(['file', 'preview']);

async function assetAuthHeaders() {
  await loadEnv();

  const token = process.env.ASSET_ACCESS_TOKEN;

  // X-Asset-Token is the finder's documented header; Bearer is accepted too.
  return token ? { 'X-Asset-Token': token, Authorization: `Bearer ${token}` } : {};
}

export function parseAssetProxyPath(pathname) {
  const match = /^\/api\/asset-proxy\/([\w-]{6,64})\/(file|preview)$/.exec(pathname);

  if (!match || !variants.has(match[2])) {
    return null;
  }

  return { assetId: match[1], variant: match[2] };
}

/**
 * Fetch one asset variant. Returns the raw bytes plus the upstream content type so the caller can
 * pass both straight through -- no re-encoding, no buffering to disk.
 */
export async function fetchAsset({ assetId, variant, download = false }) {
  const base = await getAssetFinderUrl();
  const query = download ? '?download=1' : '';
  const url = `${base}/api/assets/${encodeURIComponent(assetId)}/${variant}${query}`;

  const response = await fetch(url, {
    headers: await assetAuthHeaders(),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const error = new Error(`asset ${assetId}/${variant} -> ${response.status}`);

    error.statusCode = response.status;
    throw error;
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    contentDisposition: response.headers.get('content-disposition'),
  };
}
