import {createEvent,DAY} from './telemetry-schema.js';
import {workflowEvent,repoEvents,enrollmentIdentity} from './telemetry.js';
import {gh,readToken,repoRoute} from './github.js';
// Independent read-only DO. At most one repo list and one completed-run detail
// per tick; no Actions dispatch, no publication lock, no raw provider payloads.
const KEY='telemetry:workflow-poller', TICK=5*60000, INITIAL=60000, MANUAL=60000, LOOKBACK=DAY, MAX_PENDING=160, MAX_SEEN=400, CATCHUP=2*60000, CATCHUP_AT=12, DETAIL_FIRST_AT=48;
const iso=t=>new Date(t).toISOString();
const fresh=()=>({enabled:false,authorityHash:null,ownerHash:null,pausedAt:null,resumes:0,detailOnlyTicks:0,repos:[],cursor:0,pending:[],seen:{},runsSeen:{},lastManual:0,lastScan:null,lastRepo:null,lastDetail:null,lastError:null,failures:0,requests:0,scans:0,details:0,truncated:0,backpressure:0,unavailableDetails:0,lastTick:null,lastStage:null,lastAttemptRepo:null,lastRows:0,lastNewRuns:0,enqueued:0,detailFailures:0,lastDetailError:null,lastStatus:null,retryAt:null,alarmTicks:0,manualTicks:0,lastTickTrigger:null,expiredDetails:0,lastDetailedRun:null,correlationFailures:0,lastCorrelationError:null,pendingOverflow:0,detailRecordLimits:0,workflowListLimits:0,repoListLimits:0,catchupTicks:0,dedupCacheEvictions:0});
const providerStatus=e=>{const m=/^GitHub (\d{3})\b/.exec(String(e?.message||''));return m?Number(m[1]):null;};
const failureCode=e=>e.message==='archive-backpressure'?'archive-backpressure':e.message==='authority-unavailable'?'authority-unavailable':e.message==='outbox-unavailable'?'outbox-unavailable':e.message==='invalid-provider-response'?'invalid-provider-response':[401,403,429].includes(providerStatus(e))?'github-auth-or-rate-limit':'provider-unavailable';
const retryDelay=(e,n)=>Math.max(Math.min(6*60*60000,TICK*2**Math.min(n,6)),Number(e.retryMs)||0);
const numericId=v=>/^\d{1,20}$/.test(String(v??''));
const outcome=x=>({success:'success',failure:'failed',cancelled:'cancelled',timed_out:'failed',skipped:'skipped',neutral:'completed',action_required:'failed',stale:'failed'}[x]||'unknown');
const hex=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
export const stableId=async s=>{const h=await hex(s);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const duration=(a,b)=>{a=Date.parse(a);b=Date.parse(b);return Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:undefined;};
const time=(v,now)=>{const n=Date.parse(v);return Number.isFinite(n)&&n>=now-30*DAY&&n<=now+300000?iso(n):iso(now);};
// The enrollment generation rotates on disable. Only the same verified account
// AND authorization epoch may resume. Never use this identity to authorize appends.
const ownerIdentity=cap=>{const x=enrollmentIdentity(cap);if(!x)return null;const [sub,,epoch]=JSON.parse(x);return JSON.stringify([sub,epoch]);};
const scope=r=>r.jobId?`:job:${r.jobId}:${r.attemptId||''}`:'';
const key=r=>`${r.repo}:${r.id}:${r.attempt}${scope(r)}`;
export async function jobDetailEvents(run,data,now=Date.now()){
 if(!Array.isArray(data?.jobs))throw Error('invalid-provider-response');const jobs=data.jobs;const entries=[];let cut=Number(data?.total_count)>jobs.length||jobs.length>12;
 for(const j of jobs.slice(0,12)){
  if(!numericId(j.id)){cut=true;continue;}
  const parent=await hex(`github-job:${run.repo}:${run.id}:${run.attempt}:${j.id}${scope(run)}`),steps=Array.isArray(j.steps)?j.steps:[];
  const fields={kind:'snapshot',provenance:'provider',coverage:'partial',observedAt:iso(now),correlation:{repo:run.repo,commit:run.commit,workflowRunId:run.id,runAttempt:run.attempt,requestId:parent.slice(0,32),jobId:run.jobId,attemptId:run.attemptId}};
  async function add(op,entry,ordinal){const done=entry.status==='completed',o=done?outcome(entry.conclusion):'pending';const e=createEvent('github-actions',op,{...fields,eventId:await stableId(`${parent}:${op}:${ordinal}:${entry.status}:${entry.conclusion||''}`),occurredAt:time(entry.completed_at||entry.started_at||run.updatedAt,now),outcome:o,severity:o==='failed'?'error':'info',metrics:{durationMs:duration(entry.started_at,entry.completed_at),count:ordinal}},now);if(e)entries.push({event:e,key:`run:${run.repo}:${run.id}:${run.attempt}:${parent.slice(0,16)}:${op}:${ordinal}:${o}`});}
  await add('job',j,steps.length);
  for(const step of steps){if(entries.length>=30){cut=true;break;}if(!Number.isInteger(step.number)||step.number<0){cut=true;continue;}await add('step',step,step.number);}
  if(entries.length>=30){if(j!==jobs.at(-1))cut=true;break;}
 }
 return {entries,truncated:cut};
}
export class WorkflowCollector{
 constructor(storage,io){this.s=storage;this.io=io;}
 async save(s){
  // Durable Objects single-value limit is 128 KiB. Keep pending requests; trim oldest dedup cache entries first.
  while(new TextEncoder().encode(JSON.stringify(s)).length>110000){const keys=[...Object.entries(s.seen).map(([k,v])=>['seen',k,v]),...Object.entries(s.runsSeen).map(([k,v])=>['runsSeen',k,v])].sort((a,b)=>a[2]-b[2]);if(!keys.length)throw Error('collector-state-too-large');for(const [field,k] of keys.slice(0,Math.max(1,Math.ceil(keys.length/8)))){delete s[field][k];s.dedupCacheEvictions++;}}
  await this.s.put(KEY,s);
 }
 async state(){return {...fresh(),...await this.s.get(KEY)};}
 async status(){const s=await this.state();if(s.pausedAt&&!s.enabled)return {enabled:false,paused:true,nextPoll:null};const {authorityHash,ownerHash,repos,pending,seen,runsSeen,...publicState}=s;return {...publicState,repositoryCount:repos.length,pendingDetails:pending.length,nextPoll:await this.s.getAlarm?.()??null,nextManual:s.lastManual?s.lastManual+MANUAL:null};}
 async pausedStatus(ownerHash,now=Date.now()){const s=await this.state();const base={enabled:false,paused:false,nextPoll:null};if(s.enabled||!s.pausedAt||!s.ownerHash||ownerHash!==s.ownerHash||now-s.pausedAt>2*DAY)return base;return {...base,paused:true,pausedAt:s.pausedAt,expiresAt:s.pausedAt+2*DAY,pendingDetails:s.pending.length,cursor:s.cursor,scans:s.scans,details:s.details,resumes:s.resumes,retryAt:s.retryAt};}
 async arm(delay,now=Date.now()){await this.s.setAlarm(now+delay);}
 async bind(s,cap){const identity=enrollmentIdentity(cap),hash=await hex(identity||cap),owner=ownerIdentity(cap),ownerHash=owner?await hex(owner):null;
  const same=s.authorityHash===hash||s.authorityHash===await hex(cap)||(ownerHash&&s.ownerHash===ownerHash);
  if(!same)s={...fresh(),enabled:true,lastManual:s.lastManual};
  s.authorityHash=hash;s.ownerHash=ownerHash;return s;
 }
 async ensure({manual=false,reset=false,repair=false,now=Date.now()}={}){let s=await this.state();
  if(reset){s=fresh();s.enabled=true;await this.s.deleteAlarm?.();}
  else if(repair||s.pausedAt){const cap=await this.io.authority();if(!cap)return {enabled:false,paused:!!s.pausedAt,nextPoll:null};if(s.pausedAt&&now-s.pausedAt>2*DAY)s=fresh();s=await this.bind(s,cap);if(s.pausedAt){s.resumes++;s.pausedAt=null;}s.enabled=true;if(s.lastError==='authorization-revoked'){s.lastError=null;s.failures=0;s.retryAt=null;}}
  else if(!s.enabled&&s.lastError!=='authorization-revoked')s.enabled=true;
  if(!s.enabled)return this.status();const old=await this.s.getAlarm?.();if(manual&&(!s.lastManual||now-s.lastManual>=MANUAL)&&!s.failures&&!(s.retryAt>now)){s.lastManual=now;await this.arm(1000,now);}else if(old==null)await this.arm(Math.max(INITIAL,(s.retryAt||0)-now),now);await this.save(s);return this.status();}
 async scanNow(now=Date.now()){
  await this.ensure({now});const s=await this.state();
  if(!s.enabled||(s.failures&&(s.retryAt||await this.s.getAlarm?.()||0)>now)||(s.lastManual&&now-s.lastManual<MANUAL))return this.status();
  s.lastManual=now;await this.save(s);return this.tick(now,'manual');
 }
 async stop({capability=null,now=Date.now()}={}){let s=await this.state();
  if(capability){const owner=ownerIdentity(capability),hash=await hex(enrollmentIdentity(capability)||capability);if(owner&&(s.authorityHash===hash||s.ownerHash===await hex(owner))){s.ownerHash=await hex(owner);s.enabled=false;s.pausedAt=s.pausedAt||now;await this.save(s);}else await this.save(fresh());}
  else if(!s.pausedAt||now-s.pausedAt>2*DAY)await this.save(fresh());
  await this.s.deleteAlarm?.();
  // A disabled status request has no archive capability: do not disclose old run IDs.
  return {enabled:false,paused:!!(await this.state()).pausedAt,nextPoll:null};
 }
 async tick(now=Date.now(),trigger='alarm'){
  let s=await this.state();if(!s.enabled)return this.status();if(s.retryAt>now){await this.arm(s.retryAt-now,now);return this.status();}let delay=TICK;
  // Arm a recovery tick before external work, so a terminated invocation does not silently stop collection.
  await this.arm(TICK,now);
  try{
   s.lastTick=now;s.lastStage='authority';s.lastStatus=null;await this.save(s);
   const cap=await this.io.authority();if(!cap){s={...fresh(),lastError:'authorization-revoked'};await this.save(s);await this.s.deleteAlarm?.();return this.status();}
   const priorHash=s.authorityHash;s=await this.bind(s,cap);const changed=priorHash!==s.authorityHash;
   s.lastTick=now;s.lastTickTrigger=trigger;if(trigger==='manual')s.manualTicks++;else s.alarmTicks++;s.lastStage='queue';await this.save(s);const q=await this.io.queueStatus();if(!changed&&q.lastError==='authorization-revoked'&&!q.configured){s={...fresh(),lastError:'authorization-revoked'};await this.save(s);await this.s.deleteAlarm?.();return this.status();}
   // Reserve room for the poller's bounded batch and for live job events.
   if(q.pending>32||(q.pending>0&&q.failures>0)){s.backpressure++;s.lastStage='backpressure';await this.save(s);await this.arm(delay,now);return this.status();}
   const beforeExpiry=s.pending.length;s.pending=s.pending.filter(x=>Date.parse(x.updatedAt)>=now-2*DAY);s.expiredDetails+=beforeExpiry-s.pending.length;
   const detailOnly=trigger==='alarm'&&s.alarmTicks%2===0&&s.pending.filter(x=>!x.retryAt||x.retryAt<=now).length>=DETAIL_FIRST_AT;if(detailOnly)s.detailOnlyTicks++;
   s.lastStage='token';s.requests++;await this.save(s);const t=await this.io.readToken();const get=async path=>{s.requests++;await this.save(s);return this.io.get(t,path);};
   if(!detailOnly&&(!s.repos.length||s.cursor>=s.repos.length)){s.lastStage='repositories';const list=await get('/installation/repositories?per_page=100&page=1');if(!Array.isArray(list?.repositories))throw Error('invalid-provider-response');if(Number(list.total_count)>list.repositories.length){s.truncated++;s.repoListLimits++;}
    s.repos=list.repositories.filter(r=>r.owner?.login?.toLowerCase()===this.io.owner.toLowerCase()&&!r.archived&&!r.disabled&&repoEvents({name:r.name},now).length).map(r=>r.name).sort((a,b)=>a==='PWA-GitRunner'?-1:b==='PWA-GitRunner'?1:a.localeCompare(b));s.cursor=0;}
   const repo=detailOnly?null:s.repos[s.cursor];s.lastAttemptRepo=repo||null;s.lastRows=0;s.lastNewRuns=0;let entries=[],observed=[];
   if(repo){s.lastStage='workflows';const data=await get(this.io.route(repo)+'/actions/runs?per_page=20');if(!Array.isArray(data?.workflow_runs))throw Error('invalid-provider-response');const rows=data.workflow_runs.slice(0,20);s.lastRows=rows.length;if(Number(data.total_count)>20&&rows.length===20&&Date.parse(rows.at(-1).updated_at)>=now-LOOKBACK){s.truncated++;s.workflowListLimits++;}
    let links={};if(repo===this.io.controller&&this.io.runLinks)try{links=await this.io.runLinks();s.lastCorrelationError=null;}catch{s.correlationFailures++;s.lastCorrelationError='job-correlation-unavailable';}
    for(const r of rows){if(Date.parse(r.updated_at||r.created_at)<now-LOOKBACK)continue;const correlation=links[String(r.id)]||{};const event=workflowEvent(repo,r,now,correlation);if(!event)continue;if(!s.runsSeen[event.key]){event.event.eventId=await stableId(event.key);entries.push(event);observed.push(event.key);}if(r.status!=='completed'||!numericId(r.run_attempt))continue;const item={repo,id:String(r.id),attempt:String(r.run_attempt),...correlation,commit:event.event.correlation.commit,updatedAt:r.updated_at,failed:r.conclusion==='failure'||r.conclusion==='timed_out'};if(!s.seen[key(item)]&&!s.pending.some(p=>key(p)===key(item)))s.pending.push(item);}
    const pendingBefore=s.pending.length;s.pending=s.pending.filter(x=>Date.parse(x.updatedAt)>=now-2*DAY);s.expiredDetails+=pendingBefore-s.pending.length;s.pending.sort((a,b)=>Number(!!b.jobId)-Number(!!a.jobId)||Number(b.failed)-Number(a.failed)||Date.parse(a.updatedAt)-Date.parse(b.updatedAt));if(s.pending.length>MAX_PENDING){s.truncated+=s.pending.length-MAX_PENDING;s.pendingOverflow+=s.pending.length-MAX_PENDING;s.pending=s.pending.slice(0,MAX_PENDING);} }
   // Commit discovered runs independently of optional job details. A single
   // denied/malformed detail response must not block the repository cursor.
   s.lastNewRuns=observed.length;
   if(entries.length){s.lastStage='enqueue-workflows';if(!await this.io.enqueue(cap,entries))throw Error('archive-backpressure');s.enqueued+=entries.length;}
   for(const k of observed)s.runsSeen[k]=now;
   s.runsSeen=Object.fromEntries(Object.entries(s.runsSeen).filter(([,at])=>now-at<2*DAY).sort((a,b)=>b[1]-a[1]).slice(0,MAX_SEEN));
   if(repo){s.cursor++;s.scans++;s.lastRepo=repo;s.lastScan=now;}
   await this.save(s);
   // A detail-only tick trades discovery for up to two lookups, not extra provider calls.
   // Failed details rotate independently;
   // auth/rate errors respect provider backoff for all collection.
   let detailError=null;
   for(let n=0;n<(detailOnly&&q.pending<=16?2:1);n++){let item=s.pending.find(x=>!x.retryAt||x.retryAt<=now),detail=null;if(!item)break;try{s.lastStage='job-details';const d=await get(this.io.route(item.repo)+`/actions/runs/${item.id}/attempts/${item.attempt}/jobs?per_page=20`);detail=await jobDetailEvents(item,d,now);
    const records=detail.entries.slice();if(detail.truncated){const event=createEvent('github-actions','job',{eventId:await stableId(`truncated:${key(item)}`),kind:'snapshot',provenance:'provider',severity:'warning',coverage:'truncated',outcome:'unknown',correlation:{repo:item.repo,workflowRunId:item.id,runAttempt:item.attempt,jobId:item.jobId,attemptId:item.attemptId},metrics:{count:detail.entries.length}},now);records.push({event,key:`run:${key(item)}:truncated`});}
    s.lastStage='enqueue-details';if(records.length&&!await this.io.enqueue(cap,records))throw Error('archive-backpressure');s.enqueued+=records.length;
    s.pending=s.pending.filter(x=>key(x)!==key(item));s.seen[key(item)]=now;s.details++;s.lastDetail=now;s.lastDetailedRun={repo:item.repo,id:item.id,attempt:item.attempt,records:records.length,truncated:detail.truncated};s.lastDetailError=null;if(detail.truncated){s.truncated++;s.detailRecordLimits++;}
   }catch(e){detailError=e;s.detailFailures++;s.lastDetailError=failureCode(e);s.lastStatus=providerStatus(e);item.failures=(item.failures||0)+(e.message==='archive-backpressure'?0:1);
    if(providerStatus(e)===404||item.failures>=4){s.pending=s.pending.filter(x=>key(x)!==key(item));s.truncated++;s.unavailableDetails++;s.seen[key(item)]=now;}
    else item.retryAt=now+retryDelay(e,Math.max(1,item.failures));
    if([401,403,429].includes(providerStatus(e))||Number(e.retryMs)>0||e.message==='archive-backpressure')throw e;
   }}
   s.lastStage=detailError?'details-deferred':detailOnly?'detail-catchup':repo?'scan-complete':'no-repositories';
   for(const field of ['seen','runsSeen'])s[field]=Object.fromEntries(Object.entries(s[field]).filter(([,at])=>now-at<2*DAY).sort((a,b)=>b[1]-a[1]).slice(0,MAX_SEEN));s.failures=0;s.lastError=null;s.retryAt=null;if(s.pending.filter(x=>!x.retryAt||x.retryAt<=now+CATCHUP).length>=CATCHUP_AT){delay=CATCHUP;s.catchupTicks++;}
  }catch(e){s.failures++;s.lastError=failureCode(e);s.lastStatus=providerStatus(e);delay=retryDelay(e,s.failures);s.retryAt=now+delay;}
  await this.save(s);await this.arm(delay,now);return this.status();
 }
}
export function workflowIO(env,authority,queueStatus,enqueue,runLinks){return {owner:env.GITHUB_OWNER,controller:env.CONTROLLER_REPO,authority,queueStatus,enqueue,runLinks,readToken:()=>readToken(env),get:gh,route:repo=>repoRoute(env,repo)};}
