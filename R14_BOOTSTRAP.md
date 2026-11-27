# R14 — Initial publication (JOB-07)

Scope: explicit initial publication of initialized **private documentation** repositories, primarily the planned PWA-Architecture inventory. No repository is created by GitManager. No new provider permissions, GitHub App permission grants, or application deployment changes are required; include the remote in the existing installation if it uses selected repositories. R13 usage readings remain unchanged in this release. GitManager v0.1.27 and GitRunner v0.1.6 support automatic repository identity resolution.

## User flow

1. Create the target on GitHub as private, with default branch `main`, without README, license, gitignore or any initial commit. Grant the existing GitManager GitHub App access to that remote if not already included. Refresh Repos. The repository is listed with no main branch; it is not selectable for workspace exports until published.
2. Prepare the complete initialized source repo locally, clean and committed on `main`, with a root `VERSION` containing the chosen three-part version. Review all history for sensitive values before uploading (including deleted files). A bundle made with `git bundle create initial.bundle refs/heads/main` preserves all history reachable from main. Other branches and tags are deliberately excluded. Do not package `.git/config`, hooks, untracked files, or raw `.git` archives.
3. Put `manifest.json` and `initial.bundle` in a ZIP, no larger than the existing 12 MiB upload cap. Example manifest (placeholder hashes/identity; use real data):

```json
{
  "schema": 1,
  "title": "Initial private architecture repository",
  "updates": [{
    "repository": "PWA-Architecture",
    "owner": "YOUR_GITHUB_OWNER",
    "private": true,
    "policy": "documentation",
    "kind": "bootstrap",
    "branch": "main",
    "toVersion": "0.1.0",
    "commit": "<40 lowercase hex characters>",
    "tree": "<40 lowercase hex characters>",
    "patch": "initial.bundle",
    "sha256": "<64 lowercase hex characters>"
  }]
}
```

GitManager resolves the numeric repository ID from installed GitHub metadata during review and checks it again when creating the draft. Omit repositoryId from portable manifests; legacy zero placeholders also work. An explicit nonzero ID must match and is never overwritten. The runner receives the resolved ID and independently verifies it before writing. `git rev-parse main` and `git rev-parse main^{tree}` give the commit/tree; SHA-256 is the digest of the bundle bytes. Do not invent an old version or base commit.

4. Updates → select ZIP → Dry run or Direct mode → review exact repository identity, version, commit/tree and checksum → Create draft → Activity → Start approved job. Dry run validates but cannot get a write token. Direct publication atomically creates `refs/heads/main`, lightweight `vVERSION` and `vVERSION.r1` tags. The runner confirms all three point at the approved commit. No AppLauncher submodule or deployment is created. If uncertain, recover in Activity; the coordinator checks exact main and both tags and never overwrites a different commit.

## Security and limitations

- New import is single-repository, direct or dry run only. Existing update kinds retain version/parent checks. Remote identity includes numeric ID, owner/name, private visibility and main default branch. Runner checks all advertised refs before writes, twice including with the target-scoped writer credential. Atomic Git push uses empty expected-value leases for each of the three refs, so a competing creation cannot overwrite those refs. Git does not offer a transaction covering visibility/identity or unrelated refs; do not concurrently edit the remote or settings during publication. No fallback to unguarded/non-atomic push.
- Only plain UTF-8 documentation/data files (Markdown, text, JSON other than package manifests, YAML, CSV, TSV, RST, root VERSION/LICENSE/README/NOTICE and .gitignore). No hidden directories, scripts, executable modes, symlinks, submodules, workflows, package manifests or arbitrary binary files. Up to 500 reachable commits, 50,000 tree entries, 10,000 unique blobs, 2 MiB per text object, 64 MiB aggregate unique blob content. The bundle must contain only the declared main head, with no missing prerequisites. Git fsck and an all-history credential-pattern scan are mandatory; these are not proof of secret absence. The ZIP is stored before runner validation, so never upload actual credentials even if a scanner might reject them later. Do not upload password-manager exports.
- The trusted runner never executes imported documentation. Private runner artifacts are retained by existing policy. Bootstrap uses content write and metadata read only on the selected repository. Ordinary direct PWA-Architecture updates use the same documentation policy and atomically add version tags along with the normal one-commit update. Other unknown documentation names need a reviewed follow-up maintenance policy before ordinary updates; arbitrary new executable repos need a separate trusted validation policy. The proposed architecture name is not a commitment to create it yet.
- Live GitHub empty-remote atomic push compatibility, permission behavior, and real initial publication are acceptance tests, not established by local bare-Git fixtures.

## R13 evidence retained

User screenshots (2026-11-27 18:57 local): GitManager v0.1.25, refresh timestamp and cache feedback, GitHub API 177/5000, Worker requests 685/100000, R2 Class A 75 and B 174, R2 observed GB-month 0.000064 with 3/27 days, Durable Object requests 987, duration 26.551 GB-s, SQLite reads 7443 and writes 2002, Drive 10.248/15 GiB. GitHub billing and Azure still unavailable, Cloudflare billing unavailable, Google workflow pending, both profiles unmeasured. Need actual activity in Ciyan and a fresh telemetry report / Google workflow result to distinguish no new activity from sync/auth errors. R16 retains these as open acceptance items; no forecasts, extra permissions or paid tiers added.
