/**
 * A2A client for the AI Game Asset Finder — drop this into the SCRIPT WRITER agent's codebase.
 *
 * It speaks the Agent2Agent (A2A) protocol to the asset finder's `/a2a` endpoint: given a free-form
 * creative brief, it returns a ranked shortlist of best-fit source assets (fetchable image URLs +
 * metadata). No SDK, no dependencies — just Node 18+ `fetch`.
 *
 * The asset finder only interprets briefs and returns assets; it has no idea what the script writer or
 * the downstream generator do with them. This client is the whole surface the script writer needs.
 */

/* ----------------------------- Types the caller works with ----------------------------- */

export interface SourcedAsset {
  assetId: string;
  fileName: string;
  /** Absolute, fetchable image URL (renders inline). See caveat: 403 for Google-Drive-sourced assets. */
  imageUrl: string;
  /** Low-res cached thumbnail — works even for Drive assets. */
  previewUrl: string;
  /** Same bytes as imageUrl but as an attachment download. */
  downloadUrl: string;
  /** Relevance score; higher is better. */
  score: number;
  game: string | null;
  entity: string | null;
  /** Owner-authored note on the asset (helps the agent judge fit). Null if unset. */
  description: string | null;
  /** Name of the library folder the asset lives in. Null if unplaced. */
  folder: string | null;
  /** The containing folder's agent-facing description. Null if unset. */
  folderDescription: string | null;
  matchReasons: string[];
  source: string;
}

export interface SourceAssetsResult {
  /** true only when the finder cleared its strict relevance bar AND every requested filter was applied. */
  confident: boolean;
  count: number;
  assets: SourcedAsset[];
  /**
   * Requested filters the finder could not resolve and therefore DROPPED — e.g. ["game"] when the `game`
   * you passed matches no verified catalog value. The search then ran unscoped across the whole catalog,
   * so results will look plausible while ignoring your filter. Treat non-empty as a caller bug: fix the
   * value, don't use the results.
   */
  ignoredFilters: string[];
  /** Raw finder warnings (unknown game, ambiguous alias, below-threshold, …). Log these. */
  warnings: string[];
  /** Human-readable one-line summary the finder produced. */
  summary: string;
  /** How the finder interpreted the brief (parsed query) — useful for logging/debugging. */
  interpretedQuery: unknown;
}

export interface SourceAssetsControls {
  /** How many candidates to return. Default 5. */
  limit?: number;
  /** Filter to one game if you know it (exact catalog game name). */
  game?: string;
  /** Filter to a named character. */
  character?: string;
  /** Include non-verified identity matches. Default true — good for loose ad language. */
  allowInferred?: boolean;
}

/* --------------------------------- The client --------------------------------- */

export class AssetFinderClient {
  private endpoint: string | null = null;

  /**
   * @param baseUrl  Root of the asset finder service, e.g. "https://assets.internal:3000".
   * @param authHeader  Optional header value if you later put /a2a behind a shared secret,
   *                     e.g. { Authorization: "Bearer <token>" }.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly authHeader: Record<string, string> = {}
  ) {}

  /** Step 1 (optional): read the agent card once to discover the real endpoint + example briefs. */
  async discover(): Promise<{ endpoint: string; card: any }> {
    const res = await fetch(`${this.baseUrl}/.well-known/agent.json`, { headers: this.authHeader });
    if (!res.ok) throw new Error(`agent card fetch failed: ${res.status}`);
    const card = await res.json();
    const endpoint: string = typeof card.url === 'string' ? card.url : `${this.baseUrl}/a2a`;
    this.endpoint = endpoint;
    return { endpoint, card };
  }

  /** Step 2: send one brief, get the ranked shortlist back. This is the call the script writer makes. */
  async sourceAssets(brief: string, controls: SourceAssetsControls = {}): Promise<SourceAssetsResult> {
    if (!brief.trim()) throw new Error('brief must be a non-empty string');
    const endpoint = this.endpoint ?? `${this.baseUrl}/a2a`;

    // Build the JSON-RPC 2.0 envelope. The brief goes in a text part; controls go in a data part.
    const parts: any[] = [{ kind: 'text', text: brief }];
    if (Object.keys(controls).length > 0) parts.push({ kind: 'data', data: controls });

    const body = {
      jsonrpc: '2.0',
      id: cryptoRandomId(),
      method: 'message/send',
      params: { message: { role: 'user', messageId: cryptoRandomId(), parts } }
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`/a2a HTTP ${res.status}`);

    const rpc = await res.json();
    // JSON-RPC errors: -32602 empty/invalid brief, -32601 wrong method, -32603 internal.
    if (rpc.error) throw new Error(`A2A error ${rpc.error.code}: ${rpc.error.message}`);

    // Pull the one artifact and its data part — that carries the structured payload.
    const artifact = rpc.result?.artifacts?.[0];
    const dataPart = (artifact?.parts ?? []).find((p: any) => (p.kind ?? p.type) === 'data');
    const textPart = (artifact?.parts ?? []).find((p: any) => (p.kind ?? p.type) === 'text');
    const d = dataPart?.data ?? {};

    return {
      confident: Boolean(d.confident),
      count: typeof d.count === 'number' ? d.count : (d.assets?.length ?? 0),
      assets: Array.isArray(d.assets) ? d.assets : [],
      ignoredFilters: Array.isArray(d.ignoredFilters) ? d.ignoredFilters : [],
      warnings: Array.isArray(d.warnings) ? d.warnings : [],
      summary: textPart?.text ?? '',
      interpretedQuery: d.interpretedQuery
    };
  }
}

/** UUID without importing node:crypto explicitly — falls back for older runtimes. */
function cryptoRandomId(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = (globalThis as any).crypto;
  return c?.randomUUID ? c.randomUUID() : `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/* --------------------------------- Example usage --------------------------------- */
/* Uncomment to run: `tsx docs/a2a-client-example.ts`

async function main() {
  const client = new AssetFinderClient(process.env.ASSET_FINDER_URL ?? 'http://localhost:3000');

  // --- Where the script writer plugs in ---------------------------------------------------
  // After the LLM writes the ad script, it decomposes the script into one brief PER visual beat.
  // Each brief carries subject + game + mood + colors + season/event, like the card's examples.
  const scriptBeats = [
    { beat: 'hero-reveal', brief: 'Ramadan sale banner: heroic warrior in gold armor, warm epic tones', game: 'LAND OF HEROES' },
    { beat: 'boss-bg',     brief: 'Dark moody background for a boss-battle ad' }
  ];

  const handoff = [];
  for (const b of scriptBeats) {
    const result = await client.sourceAssets(b.brief, { limit: 5, game: b.game, allowInferred: true });

    // Branch on confidence: auto-pick when confident, otherwise flag for review / retry broader.
    const chosen = result.assets[0];
    handoff.push({
      beat: b.beat,
      brief: b.brief,
      confident: result.confident,
      needsHumanReview: !result.confident,
      chosen: chosen && {
        assetId: chosen.assetId,
        imageUrl: chosen.imageUrl,     // downstream generator fetches this
        previewUrl: chosen.previewUrl, // safe fallback for Drive-backed assets
        entity: chosen.entity,
        score: chosen.score
      },
      alternatives: result.assets.slice(1) // keep the rest of the shortlist for human selection
    });
  }

  // --- Hand this array to the downstream (video/image generation) agent -------------------
  console.log(JSON.stringify(handoff, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
*/
