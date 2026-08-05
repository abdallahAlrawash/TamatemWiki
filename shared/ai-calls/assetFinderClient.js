/**
 * A2A client for the AI Game Asset Finder.
 *
 * Port of docs/a2a-client-example.ts to plain Node ESM, because the wiki server runs raw
 * `node server.js` with no TypeScript step. Same surface: discover() + sourceAssets().
 * See docs/script-writer-integration.md for the protocol contract.
 *
 * >>> THIS FILE IS THE ONE THAT ACTUALLY RUNS. docs/a2a-client-example.ts is reference only. <<<
 * Dropping in a new copy of the .ts changes nothing at runtime. Whenever the asset-finder side
 * ships a new client, diff it against this file and hand-carry the changes, or the new response
 * fields simply will not exist here. Fields carried over so far:
 *   - ignoredFilters  (dropped filters -- non-empty means the assets are for the wrong game)
 *   - warnings        (unknown game / ambiguous alias / below-threshold notes)
 *   - searchOptions() (GET /api/search/options -- the only authority on filterable game names)
 */

import { loadEnv } from './loadEnv.js';

const defaultBaseUrl = 'http://localhost:3000';

function randomId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export async function getAssetFinderUrl() {
  await loadEnv();

  return (process.env.ASSET_FINDER_URL || defaultBaseUrl).replace(/\/+$/, '');
}

/**
 * Public, routable base for asset URLs. The finder mints them against its own host, which is
 * localhost here -- unreachable for a remote consumer. Set ASSET_PUBLIC_BASE to the tunnel hostname
 * and the handoff carries fetchable URLs. Unset, URLs pass through untouched.
 */
export async function getAssetPublicBase() {
  await loadEnv();

  const base = process.env.ASSET_PUBLIC_BASE;

  return base ? base.replace(/\/+$/, '') : null;
}

/** Bearer token for the finder, once /a2a or the asset routes sit behind one. */
export async function getAssetFinderAuthHeader() {
  await loadEnv();

  const token = process.env.ASSET_FINDER_TOKEN;

  return token ? { Authorization: `Bearer ${token}` } : {};
}

// The finder accepts 1..100 and throws an opaque -32602 outside it; clamp rather than fail a beat.
export const minLimit = 1;
export const maxLimit = 100;

export function clampLimit(limit) {
  const value = Number.isFinite(limit) ? Math.trunc(limit) : 5;

  return Math.min(maxLimit, Math.max(minLimit, value));
}

export class AssetFinderClient {
  #endpoint = null;
  #options = null;

  constructor(baseUrl, authHeader = {}) {
    this.baseUrl = String(baseUrl || defaultBaseUrl).replace(/\/+$/, '');
    this.authHeader = authHeader;
  }

  /** Read the agent card once to discover the real endpoint. Optional -- falls back to {baseUrl}/a2a. */
  async discover() {
    const response = await fetch(`${this.baseUrl}/.well-known/agent.json`, {
      headers: this.authHeader,
    });

    if (!response.ok) {
      throw new Error(`agent card fetch failed: ${response.status}`);
    }

    const card = await response.json();

    this.#endpoint = typeof card.url === 'string' ? card.url : `${this.baseUrl}/a2a`;

    return { endpoint: this.#endpoint, card };
  }

  /** Send one brief, get the ranked shortlist back. */
  async sourceAssets(brief, controls = {}, { timeoutMs = 60000 } = {}) {
    if (!String(brief || '').trim()) {
      throw new Error('brief must be a non-empty string');
    }

    const endpoint = this.#endpoint ?? `${this.baseUrl}/a2a`;
    const parts = [{ kind: 'text', text: brief }];
    const safeControls = { ...controls };

    if (safeControls.limit !== undefined) {
      safeControls.limit = clampLimit(safeControls.limit);
    }

    if (Object.keys(safeControls).length > 0) {
      parts.push({ kind: 'data', data: safeControls });
    }

    const body = {
      jsonrpc: '2.0',
      id: randomId(),
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          messageId: randomId(),
          parts,
        },
      },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`/a2a HTTP ${response.status}`);
    }

    const rpc = await response.json();

    // -32602 empty/invalid brief, -32601 wrong method, -32603 internal.
    if (rpc.error) {
      throw new Error(`A2A error ${rpc.error.code}: ${rpc.error.message}`);
    }

    const artifact = rpc.result?.artifacts?.[0];
    const artifactParts = artifact?.parts ?? [];
    const dataPart = artifactParts.find((part) => (part.kind ?? part.type) === 'data');
    const textPart = artifactParts.find((part) => (part.kind ?? part.type) === 'text');
    const data = dataPart?.data ?? {};

    return {
      confident: Boolean(data.confident),
      count: typeof data.count === 'number' ? data.count : (data.assets?.length ?? 0),
      assets: Array.isArray(data.assets) ? data.assets : [],
      // Filters the finder DROPPED because it could not resolve them. Non-empty means the search ran
      // unscoped and the assets are for the wrong game -- a caller bug, never usable results.
      ignoredFilters: Array.isArray(data.ignoredFilters) ? data.ignoredFilters : [],
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      summary: textPart?.text ?? '',
      interpretedQuery: data.interpretedQuery,
      // Presence of the parsed game filter is the reliable "was my filter applied" signal.
      appliedGameFilter: data.interpretedQuery?.filters?.game ?? null,
    };
  }

  /** Exact set of filterable game names. Cached -- the catalog does not change mid-run. */
  async searchOptions() {
    if (this.#options) {
      return this.#options;
    }

    const response = await fetch(`${this.baseUrl}/api/search/options`, {
      headers: this.authHeader,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`/api/search/options HTTP ${response.status}`);
    }

    const data = await response.json();

    this.#options = {
      games: Array.isArray(data.games) ? data.games : [],
      // Not exposed today (/api/search/characters etc. all 404). When the finder adds it, the
      // character filter becomes usable without guessing -- until then this stays empty.
      characters: Array.isArray(data.characters) ? data.characters : [],
    };

    return this.#options;
  }
}

export async function createAssetFinderClient(authHeader = null) {
  return new AssetFinderClient(
    await getAssetFinderUrl(),
    authHeader ?? await getAssetFinderAuthHeader(),
  );
}
