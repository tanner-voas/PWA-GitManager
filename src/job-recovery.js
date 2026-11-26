// Parse the runner's bounded settlement reason, not arbitrary URLs from logs.
const REPOS=['AppLauncher','Ciyan','WorldGen','Ascendant','Chronicle','PWA-Core','PWA-GoogleDrive','PWA-GitManager','PWA-GitRunner','iSH-Scripts'];
export function recoveryInfo(job){
 if(!['running','paused'].includes(job.status)||job.progress?.phase!=='settling'&&job.status!=='paused')return null;
 const reason=String(job.error||job.progress?.note||'').split('Pending: ').at(-1);
 const failures=reason.split(';').map(s=>s.trim()).flatMap(s=>{const match=/^([\w.-]+) (.+): (failure|timed_out|cancelled|action_required|stale)$/.exec(s);return match&&REPOS.includes(match[1])?[{repo:match[1],workflow:match[2],conclusion:match[3]}]:[];});
 const label=failures.length?'Blocked by failed automation':job.retryAt?'Waiting to retry observation':job.status==='paused'?'Paused — action required':'Waiting for automation';
 return {label,failures,retriesRemaining:Math.max(0,2-(job.automationRetries||0)),manual:job.status==='paused'&&!job.retryAt};
}
