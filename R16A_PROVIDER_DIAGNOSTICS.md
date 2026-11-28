# R16A — Provider connection diagnostics (v0.1.28)

Base: deployed v0.1.27.r1, a2cf44c195b364288fb01538d937a1134fa71e6d, from the November 27 workspace export. R15 initial publication was live-verified. This patch changes only GitManager; no changes to credentials, scopes, provider accounts, profile observations, GitRunner, or Cíyán. Architecture reference maintenance remains R16D.

## Changes

- GitHub: detailed and summary reports keep separate outcomes; an unsuccessful detailed report is not silently discarded. Successful report skips fallback, and fallback results are never added to detailed results. Empty Actions/Packages rows are not evidence of zero billing. Personal account/plan lookup has its own diagnostic status. Current documented API version and Plan token remain unchanged.
- Azure: validate configuration, authenticate with Entra, query resource-specific metric definitions, and query `SynthesizedCharacters` and `TotalCalls` independently. Metric definition discovery is advisory: unsupported or failed discovery does not suppress an otherwise valid metric. A successful metric is retained when another fails; zero is distinct from missing. No new billing permissions. Definitions use documented 2018-01-01 API and metrics use 2023-10-01 API.
- Cloudflare: distinguish HTTP failures, invalid responses, permission indications and GraphQL query/schema failures without exporting provider error strings. All existing queries remain isolated; restricted billing or unavailable storage does not suppress other analytics. R2 latest-per-bucket observation time range is visible next to the separate package listing. Daily-peak GB-month estimate remains incomplete and uses the existing 30-day reference divisor; no billing total is inferred.
- Usage screen: per-provider timestamps, independent endpoint/metric states and HTTP status where known; Google refresh eligibility time from existing server-side lease/cooldown. The normal 15-minute and forced 60-second snapshot reuse guard remain in place. Cache key changes from v2 to v3 to avoid reusing pre-diagnostic snapshots on first visit; Google workflow state remains intact.
- Share provider diagnostics: exports the existing authorized cached provider/Drive snapshot, plus app/worker versions and export time, without a new provider query, without archive collection, and without the profile counter dataset. Uses existing file-only sharing behavior. Report contains usage/account configuration measurements and timestamps, not secret values. Treat it as private operational information.

## Interpreting results

`available` means valid returned measurement (or a successful diagnostic stage); `no-data` means no relevant measurement; `not-attempted` means fallback not needed. HTTP 401 suggests authentication failure, 403 insufficient access or provider restriction, 404 endpoint/resource not found, 429 rate limiting, 400/422 rejected request, 5xx service error. These are evidence, not definitive diagnoses. GraphQL schema/query and permission indications are deliberately coarse. Errors with unknown shapes become invalid response; timeouts and transport failures are distinct where detected. Diagnostic metadata is bounded to fixed stage names, fixed error codes/messages, numeric status and a boolean for advertised Azure metrics. Never include raw responses, URLs with account identifiers, access tokens, or credential values. Existing aggregated billing SKU/unit labels remain unchanged.

## Live acceptance

1. Apply the package in Direct mode (or dry run then Direct); wait for GitManager 0.1.28 and AppLauncher reconciliation.
2. Open Settings > Usage and press Refresh usage. If a reading is reused, wait until the 60-second guard expires before retrying once. Google continues to use its own six-hour successful refresh interval.
3. Expand GitHub Actions billing and API details, Azure Speech details, and Cloudflare storage/compute/billing details. Verify known working analytics remain available. Record exact new stage results.
4. Press Share provider diagnostics and share the JSON for further review. No need to enable full telemetry or replace any tokens. Do not share credentials.
5. Any live provider failures remain open until actual responses establish the next action. No profile-counter fix or historical attribution is attempted in this release (R16B). Long quota labels and broad UI acceptance remain R16C; reference-register closeout R16D.

## Provider references

- https://docs.github.com/en/rest/billing/usage?apiVersion=2026-03-10
- https://learn.microsoft.com/en-us/rest/api/monitor/metric-definitions/list
- https://learn.microsoft.com/en-us/rest/api/monitor/metrics/list
- https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-cognitiveservices-accounts-metrics
- https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/

Tests use simulated API responses; no production provider credentials or live provider calls are used by the test suite.

## R16A.1 — Workers transport compatibility (v0.1.29)

The live v0.1.28 diagnostic export showed every external monitoring fetch returning `network`, while the App API, direct R2 listing and Drive worked. Cloudflare Workers does not implement Fetch `redirect: "error"`; it throws before the outbound request. Both monitoring HTTP paths now use `manual` and reject non-2xx responses, reporting 3xx as `redirect` with only status (never Location or body). No credential or scope change. Provider snapshot cache advances to v4 to force a fresh measurement; Google workflow cache remains intact. The shareable diagnostic feature is retained permanently. See https://developers.cloudflare.com/workers/runtime-apis/request/. Live provider authorization and data availability remain to be verified.
