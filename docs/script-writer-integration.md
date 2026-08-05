# Script-writer → Asset Finder integration

How the **Tamatem Wiki / script-writer agent** calls the **AI Game Asset Finder** to source real
catalog art for the visual beats of an ad script.

Nothing in the asset finder needs to change to support this. It already exposes exactly one
Agent2Agent (A2A) skill — `search-assets` — over a single JSON-RPC endpoint. Everything below is
work on the *script-writer* side.

- Endpoint: `POST {ASSET_FINDER_URL}/a2a`, method `message/send` (JSON-RPC 2.0, synchronous)
- Agent card: `GET {ASSET_FINDER_URL}/.well-known/agent.json`
- Ready-made client: [`docs/a2a-client-example.ts`](./a2a-client-example.ts) — copy it into the
  script-writer's codebase; no SDK, no dependencies, Node 18+ `fetch` only.

---

## The flow

```
user prompt ──▶ wiki writes the script (SC1…SCn, human-readable — unchanged)
                        │
                        ├──▶ NEW: extract visual beats  ──▶ one brief per beat
                        │                                      │
                        │                          AssetFinderClient.sourceAssets()  (concurrent)
                        │                                      │
                        └──▶ NEW: emit script + beats JSON ◀── ranked shortlist per beat
                                        │
                                        ▼
                            downstream video/image generator
```

---

## 1. Plumbing (one-time)

1. Copy [`a2a-client-example.ts`](./a2a-client-example.ts) into the script-writer's codebase.
2. Add `ASSET_FINDER_URL` to its environment, e.g. `https://assets.internal:3000`.
3. Optionally call `client.discover()` once at startup — it reads the agent card and confirms the
   endpoint and the current example briefs. Not required; the client falls back to `{baseUrl}/a2a`.
4. If `/a2a` is later put behind a shared secret, pass it to the constructor:
   `new AssetFinderClient(url, { Authorization: 'Bearer <token>' })`.

## 2. Capture the game at intake

The script itself never states the game in a machine-readable way — in the Baloot example the game
name appears only inside Arabic VO. The script-writer must capture **which game the ad is for** from
the user prompt (or infer it and confirm with the user) and carry it as a field.

Resolve it through the shared shortcut table, [`config/game-aliases.json`](../config/game-aliases.json):

| Alias | Canonical catalog name | In this catalog? |
| ----- | ---------------------- | ---------------- |
| `wos` | `WAR OF SPARTA` | yes — 134 assets |
| `bal` | `VIP Baloot` | yes — 5 assets |
| `loh` | `LAND OF HEROES` | registered, **0 assets** |
| `coe` | `Castle of Empire` | not in catalog |
| `fq`  | `Fashion Queen` | not in catalog |
| `ath` | `Atheria` | not in catalog |
| `ce`  | `Castle Empire` | not in catalog |

Send either the alias or the canonical name — the finder resolves aliases itself, case-insensitively.
Only the first three exist in the catalog today; the rest are reserved shortcuts that will be
reported as unresolvable until those games are indexed.

**Word order matters:** the canonical form is `VIP Baloot`, not "Baloot VIP".

**Never invent a game string.** An unresolvable `game` is *dropped*, not rejected — the search then
runs unscoped across the whole catalog and returns confident-looking hits from whichever game
dominates it (here, 96% WAR OF SPARTA). Verify against `/api/search/options`, which returns the exact
set of filterable game names, and check `ignoredFilters` on every response (§6).

## 3. Add a beat block to the wiki's output

Keep the human-readable script exactly as it is today, then append a machine-readable block. This is
the piece that does not exist yet, and it is what makes the handoff automatable.

Emit **one entry per scene where `Screen:` is not `None`.** Scenes with `Screen: None` need no asset
and must not produce a call.

```json
{
  "gameAlias": "bal",
  "game": "VIP Baloot",
  "beats": [
    {
      "sceneId": "SC3",
      "durationSec": 7,
      "screen": "Leaderboard and player ranking page",
      "brief": "VIP Baloot leaderboard and player ranking screen, competitive energetic mood, in-game UI"
    },
    {
      "sceneId": "SC4",
      "durationSec": 7,
      "screen": "Live match lobby with voice chat indicator",
      "brief": "VIP Baloot live match lobby with voice chat indicator, social playful mood"
    },
    {
      "sceneId": "SC5",
      "durationSec": 7,
      "screen": "Baloot VIP main menu with play options",
      "brief": "VIP Baloot main menu with play options, bold confident branding"
    }
  ]
}
```

## 4. Writing the brief — what to include and what to strip

The finder parses free-form English creative language: subject, game, mood, colors, season/event.

**Include**

- the `Screen:` line — that is the actual visual ask
- the game (canonical name)
- mood / tone, drawn from the scene's one-line description
- colors, if the prompt or script implies them
- season or event from the user prompt (Ramadan, summer, launch, …)
- any named character, mascot, or creator persona

**Strip**

- the Arabic `VO:` text — dialogue is not a visual description and only adds match noise
- delivery markers such as `[excited]`, `[laughs]`, `[surprised]`
- the `Action:` line — that is talent direction, not an asset
- the `7s` duration — keep it as a JSON field, never inside the brief string
- the whole Background SFX block

## 5. Making the calls

One call per beat, run concurrently — each is an independent synchronous task.

```ts
const results = await Promise.all(
  beats.map((beat) =>
    client.sourceAssets(beat.brief, {
      limit: 5,
      game: 'VIP Baloot',   // canonical name or alias
      allowInferred: true,  // default; good for loose ad language
    }),
  ),
);
```

Available controls: `limit` (default 5), `game`, `character`, `allowInferred`. Only set `character`
when the script actually names one.

## 6. Handling the response

Each result carries `confident`, `count`, `assets[]`, `ignoredFilters`, `warnings`, `summary`, and
`interpretedQuery`.

**Check `ignoredFilters` first.** It lists requested filters the finder could not resolve and
therefore dropped — `["game"]` means your `game` value matched nothing and the search ran across the
whole catalog. The results will look fine and be for the wrong game. Treat it as a caller bug: fix
the value and re-run; never use those assets. `confident` is forced to `false` whenever it is
non-empty.

Then branch on `confident`:

- `confident: true` — the finder cleared its relevance bar and every filter applied; auto-picking
  `assets[0]` is reasonable.
- `confident: false` — best-effort candidates below the bar. Do **not** auto-pick. Set
  `needsHumanReview` and pass the whole shortlist through for selection.

`warnings` carries the finder's raw notes (unknown game, ambiguous alias, below-threshold, unknown
asset type). Log it — it is the fastest way to see why a brief behaved oddly.

**Calibration caveat:** with a valid `game` filter set, the relevance-threshold check is bypassed by
design, so `confident: true` can fire on a brief that matches nothing meaningful. Do not read
`confident` as "this asset is a good fit for the beat" — read it as "the search was well-formed and
returned its best candidates." Keep a human in the loop on final selection.

Per asset you get `assetId`, `imageUrl`, `previewUrl`, `downloadUrl`, `score`, `game`, `entity`,
`description`, `folder`, `folderDescription`, `matchReasons`, `source`. Use `previewUrl` as the
fallback thumbnail — `imageUrl` can 403 for Google-Drive-sourced assets.

JSON-RPC error codes surfaced by the client: `-32602` empty or invalid brief, `-32601` wrong method,
`-32603` internal error.

## Known caveats

1. **UI screens vs. source art.** The `Screen:` fields in these scripts are UI captures (leaderboard,
   lobby, main menu). The finder sources *source art* from the studio catalog. If the catalog holds
   no UI captures for the game, those beats will legitimately come back low-confidence — that is
   correct behavior, not a failure. Character and key-art beats match far better than UI beats.
2. **Catalog coverage.** 139 indexed images, and they are lopsided: WAR OF SPARTA 134, VIP Baloot 5,
   LAND OF HEROES 0. A LAND OF HEROES beat correctly returns nothing — that is an empty catalog, not
   a broken integration. Expect thin results for anything that isn't Sparta.
3. **Probe correctly.** When testing game filters, assert on
   `interpretedQuery.filters.game` being present and `ignoredFilters` being empty — never on
   `count > 0`. A dropped filter still returns assets, so a count-based check passes for every
   string you throw at it, including nonsense.
