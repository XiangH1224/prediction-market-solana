# Background social evidence

Run the existing backend with `npm run news:proxy` (Node 22+ with native WebSocket), build the extension with `npm run build:panel`, then reload the extension. No UI settings or automatic analysis triggers were added.

Copy `social-monitoring.example.json` to `social-monitoring.local.json`. Both collectors remain off until scoped configuration is supplied. Restart the backend after changing configuration.

## Bluesky (public access, no key)

Set `bluesky.accounts` to specific handles or DIDs and `bluesky.terms` to collection keywords. Handles resolve through the public identity endpoint before subscription. Each `markets` entry must use the exact Kalshi ticker, question and `settlementRules` text. Specify unambiguous participant alias groups, event aliases, settlement-condition aliases, publication window, and date/location phrases where needed. A post must match every participant group and at least one phrase from each other nonempty group. Ambiguous or unmapped markets return no social evidence; broad topic mentions alone do not qualify. Dates/location may be empty only when not applicable. Keywords and account inclusion do not establish credibility.

The backend subscribes only to those DIDs and `app.bsky.feed.post`, using the documented JSON WebSocket protocol. Maximum 100 accounts, 500 cached posts, 10,000 characters per post, 72-hour retention, six relevant results per request and four social items in the existing 16-item model input. Storage is memory-only for post content. `.social-state.json` retains a scope fingerprint, sequence cursor and X budget counters, with owner-only permissions. A changed scope resets the cursor. Reconnection uses the inclusive sequence cursor, deduplicates sequences and handles commit updates/deletes, identity changes and account deactivation. Collection gaps are tracked internally; disconnects discard cached claims. Cursor expiry resets to the live tail with a recorded gap; no complete historical coverage is claimed.

Every selected post is looked up again through the provider before analysis and immediately before the model request. Missing, edited, stale, disconnected or unverifiable posts are withheld. Existing saved analyses remain historical snapshots. There is still a possible change after the final lookup; this is time-stamped evidence, not a guarantee of present availability. Claims sharing a linked origin are deduplicated, including against news URLs. Paraphrases without a shared link cannot always be recognized mechanically; the unchanged model contract also requires grouping repeated underlying reports.

## X (disabled by default; paid only)

The extension never receives tokens. Enter credentials in backend `.env`, which is ignored by Git. All of the following must be explicitly set before any X request occurs:

- `X_STREAM_ENABLED=true`, `X_PAID_ACCESS_ENABLED=true`, `X_PLATFORM_SPEND_LIMIT_CONFIRMED=true`
- `X_BEARER_TOKEN`
- Positive finite `X_USAGE_BUDGET_USD`, `X_MAX_POSTS_PER_DAY`, `X_MAX_REQUESTS_PER_DAY`, `X_POST_COST_CEILING_USD`, `X_REQUEST_COST_CEILING_USD`
- Exact `x.authorIds` and `x.rules` in the local monitoring file, plus market scopes

Provision narrowly scoped filtered-stream rules in your X project using its official API/tools first. This connector reads and verifies the complete rule set, and refuses a mismatch; it does not overwrite project rules. Configure X's own spending controls, confirm access/terms and choose conservative cost ceilings for your contract. Local counters are estimates, not billing enforcement: the service cannot guarantee an upstream dollar cap, especially for delivered/buffered stream posts. The platform spend-limit confirmation is mandatory. Do not delete state to reset the budget. Requests and delivered/revalidated posts consume the persistent daily UTC budget; exhaustion disconnects the stream. No automatic backfill or compliance-stream entitlement is assumed. Edits remove older IDs; fresh lookups withhold deleted or superseded posts.

## Evidence and diagnostics

Social evidence uses the existing citation IDs and source-list rendering. Author, post identifier, provenance, relevance, timestamps and conservative claim classification travel internally with the evidence. Configured accounts are never automatically labeled official/reliable; official attribution needs corroboration. Likes, repost counts and badges are neither fetched nor used as probabilities. The analysis prompt, schema, UI and simulated DFlow route are unchanged.

`GET http://127.0.0.1:4178/social?input=...` accepts JSON `{ "event": { "marketTicker": "...", "title": "...", "rules": "..." } }`, optionally `ids` for revalidation. It returns articles and internal connection/gap diagnostics, without tokens. Analyze continues with existing sources when social sources fail. No social status panels are added. Loading additional sources expands already retrieved records using the existing mechanism.

Run `npm test` for explicitly synthetic fixtures. These do not indicate live collection. With configuration active, inspect backend diagnostics and the existing model request/source list for actual retrieved social IDs. Empty caches are normal when no new relevant posts arrive; nothing is fabricated.

Official protocol references: https://bsky.network/docs/jetstream-sdk/ , https://bsky.network/docs/jetstream/ , https://github.com/bluesky-social/jetstream , https://docs.x.com/x-api/posts/filtered-stream/introduction .

## Verification for this implementation

- Live public checks succeeded: `bsky.app` handle resolution (HTTP 200), a DID/collection-filtered Jetstream WebSocket handshake, and one public post lookup (HTTP 200). No posts from these checks were stored or supplied as market evidence.
- X was not contacted. Paid functionality is fixture-tested only.
- Synthetic tests cover scoped matching, duplicate origins, stale posts, edits/deletions, account deactivation, cursor persistence, disconnection invalidation, 429 lookup failure, disabled-X zero requests, budget exhaustion, model evidence input, unchanged system prompt/schema shape and source failure isolation.
- Full existing test suite and browser bundle build passed. UI, analysis prompt/contract and purchase-flow source hashes matched their pre-change versions. No manual wallet/transaction interaction was performed.
- No monitoring accounts or market scopes were enabled on your behalf. Configure the local file to begin continuous collection.
