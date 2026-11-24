# Patch package protocol — schema 1

Future ChatGPT sessions should use this interface instead of requiring iSH commands. Give the user a ZIP containing `manifest.json` at the root and native `git format-patch -1 --stdout` outputs (one versioned commit per repository). Use checksums and base commits from the actual remote. The app can also handle a raw file selected with an explicit plan. Do not hardcode unpublished Gitlink SHA values as final pins. Explicitly declare dependencies whose updates precede a consumer. Do not supply unnecessary patches for automation-owned changes.

## Example

```json
{
  "schema": 1,
  "title": "Reader translation fix",
  "updates": [
    {"repository":"PWA-Core", "branch":"main", "kind":"patch", "fromVersion":"0.1.2", "toVersion":"0.1.3", "patch":"PWA-Core_v0.1.3.patch"},
    {"repository":"Ciyan", "branch":"main", "kind":"patch", "fromVersion":"0.9.19", "toVersion":"0.9.20", "patch":"Ciyan_v0.9.20.patch", "dependsOn":["PWA-Core"], "submodulePins":{"shared/pwa-core":"PWA-Core"}}
  ]
}
```

Example versions are illustrative; always inspect current main first. Add `baseCommit` (40 lowercase hex chars; must be an ancestor of latest main) and `sha256` (64 lowercase hex chars of the patch member bytes) whenever known. The whole upload is also hashed by the Worker and verified by the runner. `updates` is ordered, up to 16 unique installed repository names. Only `main` is writable. `fromVersion` and `toVersion` are required bare A.B.C, with exactly the allowed one-step increment. An older base can be used if intervening automated commits preserve the expected source version; the native merge still must succeed. File paths are relative POSIX paths without `..`, `.git`, symlinks or backslashes. Only explicit `submodulePins` may override a patch Gitlink; the mapped repository must precede the consumer in `dependsOn`, and the path must match its actual `.gitmodules` URL. The runner chooses current upstream main only if it contains the previously published commit. This avoids downgrading a pin if automation advanced the upstream again. It never invents unrelated dependency updates. Each dynamic pin is rechecked before publication. Every Gitlink, including unchanged and nested pins, is fetched by its exact SHA from its actual committed same-owner HTTPS remote in a fresh empty bare repository both before testing and immediately before publishing. No candidate may rely on a locally available unpublished object.

| Field | Meaning |
|---|---|
| `kind` | `patch` (default, git am), `diff` (git apply --index --3way), `bundle` (exact refs/heads/main one-commit import), `files` (explicit put/delete operations), `revert` (one non-merge commit revert) |
| `patch` | ZIP member path or literal `upload` for raw uploaded bytes |
| `baseCommit` | Optional expected ancestral base, not a forced checkout |
| `sha256` | Optional per-patch/diff/bundle member digest |
| `dependsOn` | Ordered preceding repositories; also supplies publication dependencies |
| `submodulePins` | Object path → preceding dependency name |
| `versionFile` | Optional `package.json` or `VERSION`; if both contain valid versions they must agree |
| `files` | For `files`, array of `{ "path":"icons/example.png", "operation":"put", "member":"upload" }` or `{ "path":"old.txt", "operation":"delete" }`; ZIP members supported. Rename = put + delete. |
| `commit` | Full target SHA for `revert` |
| `message` | Optional file/diff/revert commit message, up to 300 chars |

A bundle cannot rebase or rewrite declared pins; it must already be exactly one commit ahead of latest main. In a patch, declared pin paths are excluded from native patch application, then reinserted at the actual published SHA. Do not use this feature for ordinary files or undeclared Gitlinks. Max upload 12 MiB initially (Cloudflare free Worker has 128 MB memory); larger exports use private GitHub artifacts. Multi-repository dry runs with dependencies are rejected; independently validate each patch or use PR mode. Creating a draft never writes GitHub. Direct mode is recommended for normal workflow. PR mode creates each PR in order, waits for external merge, then checks the actual merged version before moving on. If a conflict occurs, export report and runner logs, supply a corrected patch built on the current main and only include unapplied updates.

## Public same-origin API (v1)

All `/_git/v1/*` routes require authorized Google session. Non-GET also requires header `X-PWA-CSRF: 1`, exact same-origin `Origin`, and `X-Git-Unlock` (administrator phrase, never log/store). Responses no-store. API is intentionally not an arbitrary GitHub proxy.

| Method/path | Request/response |
|---|---|
| GET `/repos?page=1` | `{repos:[{name,private,defaultBranch,head,version,tag,production,url}],next}`; pagination |
| GET `/repos/{repo}/{commits,tags,branches,files,pins,runs,pulls,source}` | `ref`, `path`, `page` as applicable; metadata, base64 file data, or source ZIP |
| POST `/jobs` | Multipart `upload` (File), `plan` JSON string, `mode` `direct/pr/dry`; returns draft |
| POST `/exports` | JSON `{repositories:[...],format:"lightweight"|"recursive"|"bundle"}`; returns draft |
| GET `/jobs` | Latest job records |
| GET `/jobs/{id}` | Full job metadata, attempts, publication records |
| POST `/jobs/{id}/start` | Explicitly approve draft |
| POST `/jobs/{id}/resume` | Recover after workflow completion, PR merge, pause or failure; does not force-push |
| POST `/jobs/{id}/cancel` | Stop remaining work only when no uncertain publication; does not revert published commits |
| POST `/repos/{repo}/workflows/tags` | Dispatch current main's `tag-main.yml` |
| POST `/repos/AppLauncher/workflows/reconcile` | Dispatch current main's validation workflow |

All paths above are relative to `/_git/v1`. States: draft, running, paused, failed, awaiting-pr, completed, cancelled. `progress` contains phase/note/time; `retryAt` identifies a scheduled automatic observation retry. The durable watchdog observes lost callbacks without redispatching ambiguous writes. `index` counts completed update steps; final settlement can still be running at full count. A failed job retains the global write lock until resumed or explicitly cancelled. A final settlement failure means publication can be complete but automation is pending. Use logs and the records to distinguish this. For an export, open the linked private Actions run → Artifacts → `prepared-*` → extract `workspace.tar.gz`.

## Private runner interface

`POST /_git-runner/v1/{jobId}/{attemptId}/{claim,package,token,candidate,published,progress,finish}` with `Authorization: Bearer RUNNER_SECRET` and JSON `runId` (actual GitHub run ID). This path is not forwarded by AppLauncher. A claim binds the current durable attempt to one run. `package` returns raw bytes. `token` with `{write:false}` gives read-only installation access; `write:true` additionally requires exact registered candidate SHA and consumes one scoped write-token grant. `candidate` registers base/commit/tree/version. `published` records a confirmed exact commit or PR. `progress` accepts a bounded phase and note for live Activity status. `candidate` additionally carries `verifiedGitlinks`. `finish` reports success/race/paused/failed. Only trusted PWA-GitRunner workflow jobs use these endpoints. Preparation and publishing use a pinned controller checkout; candidate validation is an isolated job with no write token or runner secret. Never call runner endpoints from the browser or expose tokens. Contract changes must be coordinated across both repos. The runner repo must remain private; Worker refuses to dispatch to a public controller.

## Automation barrier

After each successful push, the next runner attempt must settle the previously published repositories and their known downstream automation before applying its patch. Even a downstream target with a pending patch is not exempt. `runner/policies.json` defines the transitive automation graph, expected exact-commit push workflows, and automatic pins. Observe successful workflows, revision tag, exact pins, and launcher main/production; pause on missing or failed evidence, with up to two automatic observation retries. Future cross-repository workflow additions require updating the runner policy. GitHub and Cloudflare are separate: the manager does not claim that a successful GitHub production promotion proves Cloudflare deployed it.
