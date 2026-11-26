# R11 — provider usage visibility

## Scope and evidence
Post-R10 export, GitManager 0.1.22 -> 0.1.23 and GoogleDrive 0.1.23 -> 0.1.24 only. R10 completed 2/2 without retries in 657.176 s. The supplied 182-event general and 106-event activity reports pass filters; 80 Actions observations in the general report correlate with R10, covering all three runner workflow IDs. The 92 pending detail requests are preserved, not proof of loss. Regular usage backup verified at 2026-11-26 13:34:07.690 UTC. Download cancellation (4.609 s, 6,618,829 bytes) and subsequent success (13.869 s, 30,737,678 bytes) are present. Prior draft UI fixes require user/device confirmation.

TEL-07/08/11/14/16 and QA-01: add provider readings on Settings -> Usage, regardless of archive capture. Existing Regular usage remains separate; no full-capture side effects, no provider billing mutations, no changes to existing credentials, permissions, or capture controls. Usage snapshots are cached for 15 minutes in an independent serialized coordinator (Drive cache is scoped to account and authorization epoch). UTC day boundary invalidates the workspace cache. Exports include cached observations only, never initiate a new external provider query. Missing results, partial bucket inventory and optional configuration are explicit. Raw errors, keys, tokens, bucket object names and provider account IDs are not returned.

## Supported immediately
- GitHub installation REST `/rate_limit`: actual core API limit, remaining and reset; not Actions billing, secondary rate limits, artifact storage, or personal account allowances.
- GitManager R2 binding: one bounded metadata-only list of up to 1000 objects; sum current payload sizes, indicate partial listing. Only the package bucket, not account storage or GB-month. Listing consumes one Class A operation per actual refresh.
- Google Drive `about?fields=storageQuota` with the existing account grant: current user's storage usage/limit where available; this is NOT project API quota. Does not grant broader Drive access. Existing Drive request observations remain partial and separate.
- Google Translate / Azure Speech: retain existing observed characters, requests, cache/prefetch counters; they are application estimates and not provider billing.

## Optional Cloudflare setup (not required for installation)
Use Cloudflare dashboard -> My Profile -> API Tokens -> Create Token, custom read-only Account Analytics permission, restricted to the intended account. See https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token/ and the Workers/R2 metrics documentation below. Do not reuse deployment credentials or enter keys into GitManager UI or share them in diagnostic exports.

On Worker `pwa-git-api` only, Settings -> Variables and Secrets, set:
- `CF_USAGE_ACCOUNT_ID`: intended Cloudflare account ID (32 hex digits).
- `CF_USAGE_TOKEN`: secret, read-only analytics token.

Once configured, fixed GraphQL queries read account-wide Worker invocations for the UTC day and account-wide R2 operations since UTC month start. Analytics can be sampled, delayed, denied by plan or unavailable. Recognized Class A/B operation types are estimates of classification; other/unrecognized operations remain separate. No claim of billed totals or complete R2 storage. Refresh usage respects the 15-minute cache; wait for expiry after configuration changes. No background polling is introduced.

Optional ordinary Worker variables (positive integer strings): `USAGE_WORKERS_DAILY_LIMIT`, `USAGE_R2_CLASS_A_MONTHLY_LIMIT`, `USAGE_R2_CLASS_B_MONTHLY_LIMIT`, `USAGE_TRANSLATE_MONTHLY_CHAR_LIMIT`, `USAGE_SPEECH_MONTHLY_CHAR_LIMIT`. Use the actual allowance for your plan/account; no defaults, no assumed tier. They are explicitly labeled configured comparisons, not provider-confirmed limits or enforcement. Existing provider credentials are not needed for this configuration. If managed deployment overwrites dashboard variables, maintain these optional values via the approved deployment configuration; do not commit the token.

## Remaining provider work
- Cloudflare account-wide R2 storage GB-month and authoritative billing cycle; Worker CPU / Durable Objects / logs and billed usage. Current R2 bucket payload and operation analytics are not invoice estimates.
- GitHub Actions hosted runner minutes, included allowance, artifact storage, billing reports; use separate appropriate read-only billing authorization if supported. Current installation token does not imply billing authorization. Avoid summing workflow/job/step durations.
- Google Cloud Monitoring and Service Usage/Cloud Quotas APIs for Translation and Drive project quotas/consumption; separate project-level authorization and service identifiers needed. Google Drive request totals are not quota units.
- Azure Monitor resource metrics (Synthesized Characters where available); resource ID and separately authorized monitoring identity needed. Speech synthesis key is not an ARM monitoring credential.
- More Regular-mode estimates for providers when analytics access is not possible, quota alerts only once scope/plan/reset is established. Never add instrumented event totals to provider totals.

Official references:
https://docs.github.com/en/rest/rate-limit/rate-limit
https://docs.github.com/en/rest/billing/usage
https://developers.cloudflare.com/r2/platform/metrics-analytics/
https://developers.cloudflare.com/r2/pricing/
https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
https://developers.google.com/workspace/drive/api/reference/rest/v3/about
https://docs.cloud.google.com/apis/docs/monitoring
https://docs.cloud.google.com/translate/quotas
https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-cognitiveservices-accounts-metrics

Acceptance: in Regular mode open Settings -> Usage, verify GitHub API window, R2 bucket inventory and Drive storage; optional Cloudflare setup separately if desired. Share an ordinary time-range telemetry export after opening Usage. Do not generate separate status files. Live provider access, permissions, actual response shape and device layout require validation. All permanent roadmap IDs remain in WORKSPACE_ROADMAP.md.
