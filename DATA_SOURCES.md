# Free research connectors

The existing Node relay on `127.0.0.1:4178`, GNews/RSS reporting, and LM Studio integration remain in use. All new upstream calls run in the backend. No paid endpoint is enabled.

## Start the project

Use Node 22 or newer (verified here with Node 24).

```bash
npm install
cp -n .env.example .env
cp -n data-source-mappings.example.json data-source-mappings.local.json
```

Edit `.env` in VS Code. Do not put credentials into `sidepanel.html`, JavaScript used by the extension, or the mapping file.

| Variable | Value and behavior |
| --- | --- |
| `GNEWS_API_KEY` | Existing optional GNews credential. Without it, reporting falls back to Google News RSS. |
| `FRED_API_KEY` | Your free registered FRED key. Blank disables only FRED/ALFRED. Obtain from https://fred.stlouisfed.org/docs/api/api_key.html. |
| `BLS_API_KEY` | Optional free BLS registration key. Blank uses limited unregistered access. Register at https://data.bls.gov/registrationEngine/. |
| `DATA_SOURCE_CONTACT_EMAIL` | Your real contact email. Used in `Fieldnote research (email)` User-Agent for SEC and NWS. Blank disables SEC only; NWS uses an application-identifying User-Agent without contact details. |
| `SPORTSDB_API_KEY` | Optional `123`, the currently documented shared free development key. Blank disables SportsDB. Other keys are deliberately disabled in free-only mode. |

Then run:

```bash
npm run build:panel
npm run news:proxy
```

Leave the relay running. Start LM Studio with a loaded chat model and the local server at `127.0.0.1:1234`. Reload Fieldnote at `chrome://extensions`, or refresh the VS Code Live Preview. Saving analyses still requires Chrome extension storage. Restart the relay after changing `.env`.

`.env`, `.env.*` (except `.env.example`), and `data-source-mappings.local.json` are Git-ignored. The extension bundle imports neither backend configuration nor connector code. Upstream error bodies are not logged; backend responses redact configured private API keys. The relay never returns credential values.

## Exact market mappings

Copy the example mapping file, replace each placeholder key with the **exact Kalshi market ticker**, and remove example entries you do not use. Mappings are reread for each request; a relay restart is unnecessary for valid mapping edits. Placeholder examples do not match real markets automatically.

The backend only infers an economic mapping when the rules/question explicitly contain one supported series ID and one unambiguous year. Generic words such as “inflation” route to relevant providers but do not guess the series or seasonal adjustment. Otherwise supply these fields:

| Connector | Mapping key and required fields |
| --- | --- |
| Federal Reserve | `fed`: `kind: "monetary"` or `"speeches"`. Topic routing can choose these without configuration. |
| BLS | `bls`: `seriesIds`, `startYear`, `endYear`. Catalog: `CUUR0000SA0` (CPI-U NSA), `CUSR0000SA0` (CPI-U SA), `LNS14000000` (unemployment SA), `CES0000000001` (payroll level SA). Units and adjustments are explicit in `source-mappings.mjs`. |
| FRED/ALFRED | `fred`: `seriesId`, `start`, `end`; optional `firstRelease: true` **or** `vintage: "YYYY-MM-DD"`. Catalog: `CPIAUCSL`, `CPIAUCNS`, `UNRATE`, `PAYEMS`, `DFEDTARU`, `DFEDTARL`, `DFF`. |
| SEC | `sec`: verified `cik`, exact `company`, `form`, `reportDate`; optional `concepts` (US-GAAP names), `filingText` (default true). The returned issuer identity must match. |
| NWS | `nws`: exact `latitude`, `longitude`, `location`, `timeZone`, `measurement`, `units`, `kind`, `start`, `end`; `station` required for observations. Timestamps need explicit UTC offsets. |
| SportsDB | `sports`: verified numeric `eventId`, exact `sport`, `league`, `home`, `away`, `date`. All returned identities must match. |

Use the BLS adjustment and series specified by settlement rules. CPI index levels are not themselves percentage changes. BLS current values can include revisions; they cannot establish an initial-release figure without appropriate historical evidence. First-release wording in rules forces the FRED initial-release request and flags BLS as current-vintage context.

NWS observations support `temperature`, `precipitationLastHour`, `precipitationLast3Hours`, `precipitationLast6Hours`, `windSpeed`, and `barometricPressure`. Forecast support is currently temperature only. Use returned native unit codes for observations (e.g. `wmoUnit:degC`) and `F` or `C` for forecasts. No implicit unit conversion, nearest-station substitution, certified daily extrema, or unsupported settlement-product substitution occurs. Forecasts and observations are separate evidence types.

SEC searches the submissions response’s **recent filings**, matching exact form and reporting date. It does not silently choose another period or search historical submission shards. An absent/ambiguous filing is reported. Retrieved text is an 18,000-character excerpt, not the complete filing; XBRL facts are matched to the selected accession and period. SportsDB supplies only returned event/background information; no live-score, injury or detailed tennis coverage is assumed.

## Test from the panel

1. Select a market. The **Sources** section checks backend configuration and exact mappings without requesting upstream evidence. It shows the full directory, including sources unrelated to the selected market and sources with missing configuration. Only relevant, configured, resolved sources are queried. Google News RSS remains visible alongside GNews as the free fallback.
2. For each relevant provider, resolve any mapping message in `data-source-mappings.local.json`, then reselect the market to see **Ready**.
3. Click **Analyze this market**. Ready sources show **Fetching**, then **Retrieved**, **No relevant data**, or **Error** independently. Relevant sources that require missing credentials stay **Not configured**. A configured source with an unresolved identifier instead shows **No relevant data**, with its mapping requirement.
4. Check each last-retrieved timestamp and the cited evidence. A failed source must not appear as a consulted source in the conclusion.
5. Analyze again within its cache lifetime: successful repeated queries show **Cached** with the original retrieval timestamp. Cached empty responses remain **No relevant data**.
6. **Load More Sources** expands already-retrieved evidence, explicitly says it makes no network request, and does not retry failed connectors. A new Analyze action initiates retrieval, using valid cache entries where possible.

| Panel market to test | Setup |
| --- | --- |
| Fed rate decision | Relevant question/rules; no key required. Speeches are explicitly labeled as opinions rather than committee decisions. |
| CPI or employment | Exact ticker mapping to a BLS series and years; add corresponding FRED mapping and key to compare vintages. |
| Company results | Exact CIK/company/form/period mapping plus contact email. Inspect retrieved filing excerpt and facts. |
| US weather | Exact station/location/time/measurement mapping (contact email optional). Test forecast separately from observations. |
| Sports | Free key `123` plus an exact, independently verified event mapping. Missing tennis coverage must remain empty rather than substituting soccer. |

## Caching, limits and failure handling

Backend cache lifetimes: Fed 5 minutes, BLS/FRED 1 hour, SEC/SportsDB 10 minutes, NWS 1 minute. Expired cached records are not served when refresh fails. Cache and in-flight deduplication are process-local; restarting the relay clears them. Requests are bounded to 12 seconds and 12 MB. Providers are queued independently; SEC starts are spaced by at least 250 ms, SportsDB by 2.1 seconds, others by 1.1 seconds. HTTP 429/503 respects Retry-After with a cooldown and no retry storm. BLS has a per-process daily request budget of 25 without registration or 500 with registration; upstream limits still apply across restarts and other apps.

Returned records carry exact source URLs, IDs, text/observations, units, time fields and limitations. Unknown values stay null. Model input is bounded (up to 16 deduplicated records, up to 120 observations per record); truncation is disclosed, while additional retrieved records remain expandable in the panel. Publication, data/reference period, retrieval, and vintage are distinct. Source failures and unresolved mappings are supplied separately from evidence. The model must identify only material gaps and cite retrieved IDs. Saved analyses retain source status and metadata.

## Verification

```bash
npm test
npm run build:panel
npm run verify:sources
```

`verify:sources` makes real, read-only upstream requests for configured providers, prints only status/counts/public source URLs, and marks missing configuration instead of using fixtures. Its SEC and SportsDB checks use explicit historical examples; the NWS check requests the preceding 24 hours. To test the documented free SportsDB key without enabling it persistently:

```bash
SPORTSDB_API_KEY=123 npm run verify:sources
```

Actual live verification on **2026-10-05**:

| Provider | Result |
| --- | --- |
| Federal Reserve | Successful directory discovery + monetary-policy RSS; 3 announcements retrieved. |
| BLS | Successful v2 POST, unregistered, `CUUR0000SA0`, 2025; series returned. |
| SportsDB | Successful free v1 event lookup `441613`; Liverpool vs Swansea, English Premier League, 2014-12-29 matched. This verifies event lookup, not tennis/live coverage. |
| FRED/ALFRED | Not live-verified: no key configured. Labeled fixtures verify metadata, observations, first-release/as-of parameters, and credential omission from evidence. |
| SEC | Not live-verified: no contact configured. Labeled fixtures verify identity, accession/period facts and filing text. |
| NWS | Not live-verified: no contact configured. Labeled fixtures verify discovery, station, units/time zone, forecast versus observations, nulls and stale data. |
| GNews / LM Studio | Existing integrations retained; no new live model/GNews verification claimed. |

The fixture suite also covers missing configuration, ambiguous/wrong mappings, empty results, invalid JSON, HTTP errors, timeout isolation, rate-limit cooldown, cache expiry, panel statuses, and no-network expansion copy. Fixtures are labeled in their test files and are never used by the runtime.

Official references: [Fed feeds](https://www.federalreserve.gov/feeds/feeds.htm), [BLS v2](https://www.bls.gov/developers/api_signature_v2.htm), [FRED observations/vintages](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), [SEC APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [NWS](https://www.weather.gov/documentation/services-web-api), [SportsDB free endpoints](https://www.thesportsdb.com/documentation).

## Files changed for these connections

- `.env.example`, `.gitignore`, `backend-config.mjs`: backend environment loading, ignored local files and response redaction.
- `data-sources.mjs`, `source-mappings.mjs`, `data-source-mappings.example.json`: six connectors, validation, explicit mappings, limits, caching and normalized evidence.
- `news-proxy.mjs`: configuration/status and per-provider `/research` requests on the existing relay.
- `integrations.js`, `research-directory.js`, `analysis-contract.js`: independent source collection, model evidence/provenance, citation policy and record limits.
- `flow.js`, `sidepanel.css`: Sources states/timestamps and explicit local expansion of additional evidence; existing analysis/history/purchase actions preserved.
- `tests/data-sources.test.mjs`, `tests/source-integration.test.mjs`, `tests/research.test.mjs`, `tests/analysis.test.mjs`: connector fixtures and integration/panel regression checks.
- `verify-sources.mjs`, `package.json`: repeatable live smoke-check command.
- `README.md`, `DATA_SOURCES.md`: setup, testing and handover. `panel.bundle.js` regenerated locally (already Git-ignored).

## Free-access setup update (2026-10-06)

NWS no longer requires an email in this application. Its official documentation requires an identifying User-Agent and makes contact information optional: https://www.weather.gov/documentation/services-web-api . Exact location, station, time and measurement mappings remain required. SEC still requires a real configured contact.

GNews has a Free plan for development/testing and non-commercial projects: 100 requests/day, up to 10 articles/request, a 12-hour delay and 30 days of history. Choose Free, not a paid-plan trial: https://gnews.io/pricing . Place your own key in GNEWS_API_KEY in .env. Google News RSS remains available without that key.

Request a FRED key at https://fred.stlouisfed.org/docs/api/api_key.html and store it in FRED_API_KEY in .env. No key values should be pasted into chat. BLS registration is optional. TheSportsDB shared development key is already configured locally; an exact supported event mapping is still required. Bluesky needs no paid credential, but needs selected accounts and exact market scope in social-monitoring.local.json. X remains disabled for free-only operation.

To finish market-specific setup, supply the current Kalshi URL/ticker and settlement rules, a real SEC contact email, and Bluesky accounts (or request account research). The historical smoke-test mappings are verification only and are not attached to a current market.

Live checks during this update succeeded for Fed RSS (3 records), unregistered BLS (1 series), SportsDB (1 historical event) and NWS without contact (36 KNYC observations). These checks verify connectivity, not relevance to an unspecified current market. All 66 tests passed. FRED/GNews/SEC remain unverified without the missing credentials/contact; no X request was made.
