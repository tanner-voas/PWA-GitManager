# One-time deployment

Use the included bootstrap repositories, not a GitManager job for the initial installation. Both repos contain `.git`, initial version 0.1.0, main and origin set to tanner-voas. Preserve their exact commit hashes; AppLauncher pins the manager commit. Create GitHub repos without an initial README or license: **PWA-GitManager (public)**, **PWA-GitRunner (private)**. Public manager source has no secrets; the private runner stores temporary sensitive artifacts. Push each main with your existing iSH setup or another Git client. No manual tags needed; reusable `tag-main.yml` uses iSH-Scripts v0.1.0.

## GitHub App

1. GitHub Settings → Developer settings → GitHub Apps → New GitHub App. Name e.g. `Tanner PWA Git Manager` (globally unique); homepage `https://pwa-git-api.tannervoas.workers.dev`; disable webhook Active; no user OAuth callback required. Only this account installation, not public installation.
2. Repository permissions: Metadata read, Contents read/write, Pull requests read/write, Actions read/write, Workflows write. No repository administration or organization permissions. Checks/status permissions optional; not used by initial API. Workflows write is required when patches modify `.github/workflows/`.
3. Create App, note numerical **App ID** (not Client ID), Generate a private key and save the downloaded PEM securely. Install on all repositories you want to manage, including both new repos. Choose All repositories if you want newly created repositories automatically accessible. Note the numeric **installation ID** from the installed app settings URL (`.../settings/installations/123...`).
4. Keep PWA-GitRunner private. The Worker checks this before every dispatch. Ensure Actions are enabled and actions/checkout, setup-node and upload/download-artifact are allowed. Configure an Actions budget/spending controls appropriate to your plan; the private runner consumes included private Actions minutes. Do not put the App private key in repository secrets or files.

## Cloudflare

1. R2 Object Storage → enable R2 (billing account may be required). Create Standard private bucket `pwa-git-jobs`; no public access or custom public domain. Add object lifecycle rule expiring uploads after 7 days. No R2 API credentials necessary; the binding accesses it internally.
2. Workers & Pages → Create application from GitHub → PWA-GitManager, Worker name `pwa-git-api`, production branch main, root `/`, build command `python3 package.py`, deploy command `npx --yes wrangler@4 deploy`. Authorize Cloudflare Git integration for the new repo. The included wrangler.jsonc creates the SQLite Durable Object binding and binds the existing `pwa-profiles-api` and R2 bucket. Standalone public URL must remain enabled for runner callback and recovery; preview URLs disabled. If the account subdomain differs, update both Wrangler ALLOWED_ORIGINS and Google profile origin settings using a versioned patch.
3. Settings → Variables and Secrets → Add. Configure the following at runtime (not Build variables):

| Name | Type | Value |
|---|---|---|
| `GITHUB_APP_ID` | Text or secret | Numeric App ID |
| `GITHUB_INSTALLATION_ID` | Text or secret | Numeric installation ID |
| `GITHUB_APP_PRIVATE_KEY` | Secret | Entire downloaded PEM, including header/footer and line breaks |
| `ADMIN_EMAIL` | Secret | Exact Google account email you already use for PWA profiles |
| `ADMIN_UNLOCK` | Secret | Random password at least 24 characters; store in password manager; entered in UI |
| `RUNNER_SECRET` | Secret | Separate random token at least 32 characters; copy to runner Actions secret |

No secret in Ciyan, PWA-Core, AppLauncher, GitHub commits or backups. Do not share keys in ChatGPT. `GITHUB_OWNER`, `CONTROLLER_REPO`, `CONTROLLER_REF` and `ALLOWED_ORIGINS` are configured in Wrangler. Verify Worker deployment after saving variables. Keep the backend public HTTPS route but do not expose runner endpoint through launcher; it requires the separate runner secret.

## Private runner

GitHub → PWA-GitRunner → Settings → Secrets and variables → Actions:
* Variable `GIT_MANAGER_URL` = `https://pwa-git-api.tannervoas.workers.dev` (no trailing path).
* Secret `GIT_JOB_RUNNER_SECRET` = exact Worker `RUNNER_SECRET`.

No GitHub App key here. Do not invoke execute-git-job manually; the backend creates and claims persistent attempts. The public PWA-GitManager is the UI/Worker code repo; PWA-GitRunner owns the trusted execution policies. Existing hosted-app push workflows and version tagging are retained. The Worker explicitly dispatches AppLauncher after a manager self-update; AppLauncher's existing scheduled reconciliation also picks up external changes.

## Standalone sign-in (recommended before AppLauncher integration)

Apply the included **PWA-GoogleDrive v0.1.12** patch to add the standalone origin to its tracked Wrangler ALLOWED_ORIGINS. This triggers the existing Ciyan/launcher dependency update. Wait for Ciyan and AppLauncher automation to settle before applying the launcher patch: Ciyan main must point to the new Drive commit, launcher main/production must match and its Ciyan and Drive Gitlinks must be correct, and relevant Actions must have succeeded. The launcher integration package can accept these intervening automation commits without losing them. In Google Cloud Console → APIs & Services → Credentials → existing OAuth Web client, add the authorized redirect URI exactly:

`https://pwa-git-api.tannervoas.workers.dev/_profiles/v1/auth/callback`

Preserve existing redirect URIs. If the existing OAuth setup also lists authorized JavaScript origins, add `https://pwa-git-api.tannervoas.workers.dev`. No new scopes or Google project needed. The profile Worker must be redeployed with the new origin. Open standalone URL, Connect Google Drive, sign in to same account, then Settings → unlock. This cookie is origin-specific; the launcher uses its own existing Google session. The separate standalone origin is the recovery path if the launcher breaks. If standalone configuration is deferred, hosted Git Manager will use the existing launcher auth but recovery access will be unavailable.

## First safe smoke test and launcher integration

Open standalone. Check Repositories lists all intended repos, versions and tags. Open Settings and unlock. Export one lightweight repo (read-only). Then upload a harmless genuine one-version patch in Dry run mode: create draft, start and inspect the private Actions run. It must validate without changing remote main. Test a PR-mode update before relying on direct mode; do not merge unless the version is correct. For a production test, prefer a disposable versioned repository with a test script installed in the GitHub App; configure its policy in the runner if necessary. Never test on a repository containing secrets. The new manager can apply the AppLauncher integration patch after its standalone dry run succeeds. Alternatively, use your last iSH git am. The patch is AppLauncher 0.1.18 → 0.1.19 and adds a gitmanager submodule pinned to the exact bootstrap commit. Existing automatic commits with the same source version are preserved. Publish only after pwa-git-api exists, then observe normal production promotion and Cloudflare deployment. Do not push the production branch manually. See bootstrap instructions included alongside ZIPs.
