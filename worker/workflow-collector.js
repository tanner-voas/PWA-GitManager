import {createEvent,DAY} from './telemetry-schema.js';
import {workflowEvent,repoEvents} from './telemetry.js';
import {gh,token,repoRoute} from './github.js';
// Independent read-only DO. At most one repo list and one completed-run detail
// per tick; no Actions dispatch, no publication lock, no raw provider payloads.
const KEY='telemetry:workflow-poller', TICK=5*60000, INITIAL=60000, MANUAL=60000, LOOKBACK=DAY, MAX_PENDING=60, MAX_SEEN=400;
const iso=t=>new Date(t).toISOString();
const fresh=()=>({enabled:false,authorityHash:null,repos:[],cursor:0,pending:[],seen:{},runsSeen:{},lastManual:0,lastScan:null,lastRepo:null,lastDetail:null,lastError:null,failures:0,requests:0,scans:0,details:0,truncated:0,backpressure:0,unavailableDetails:0});
const numericId=v=>/^\d{1,20}$/.test(String(v??''));
const outcome=x=>({success:'success',failure:'failed',cancelled:'cancelled',timed_out:'failed',skipped:'skipped',neutral:'completed',action_required:'failed',stale:'failed'}[x]||'unknown');
const hex=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const stableId=async s=>{const h=await hex(s);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const duration=(a,b)=>{a=Date.parse(a);b=Date.parse(b);return Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:undefined;};
const time=(v,now)=>{const n=Date.parse(v);return Number.isFinite(n)&&n>=now-30*DAY&&n<=now+300000?iso(n):iso(now);};
const key=r=>`${r.repo}:${r.id}:${r.attempt}`;
export async function jobDetailEvents(run,data,now=Date.now()){
 const jobs=Array.isArray(data?.jobs)?data.jobs:[];const entries=[];let cut=Number(data?.total_count)>jobs.length||jobs.length>12;
 for(const j of jobs.slice(0,12)){
  if(!numericId(j.id)){cut=true;continue;}
  const parent=await hex(`github-job:${run.repo}:${run.id}:${run.attempt}:${j.id}`),steps=Array.isArray(j.steps)?j.steps:[];
  const fields={kind:'snapshot',provenance:'provider',coverage:'partial',observedAt:iso(now),correlation:{repo:run.repo,commit:run.commit,workflowRunId:run.id,runAttempt:run.attempt,requestId:parent.slice(0,32)}};
  async function add(op,entry,ordinal){const done=entry.status==='completed',o=done?outcome(entry.conclusion):'pending';const e=createEvent('github-actions',op,{...fields,eventId:await stableId(`${parent}:${op}:${ordinal}:${entry.status}:${entry.conclusion||''}`),occurredAt:time(entry.completed_at||entry.started_at||run.updatedAt,now),outcome:o,severity:o==='failed'?'error':'info',metrics:{durationMs:duration(entry.started_at,entry.completed_at),count:ordinal}},now);if(e)entries.push({event:e,key:`run:${run.repo}:${run.id}:${run.attempt}:${parent.slice(0,16)}:${op}:${ordinal}:${o}`});}
  await add('job',j,steps.length);
  for(const step of steps){if(entries.length>=30){cut=true;break;}if(!Number.isInteger(step.number)||step.number<0){cut=true;continue;}await add('step',step,step.number);}
  if(entries.length>=30){if(j!==jobs.at(-1))cut=true;break;}
 }
 return {entries,truncated:cut};
}
export class WorkflowCollector{
 constructor(storage,io){this.s=storage;this.io=io;}
 async state(){return {...fresh(),...await this.s.get(KEY)};}
 async status(){const s=await this.state();const {authorityHash,repos,pending,seen,runsSeen,...publicState}=s;return {...publicState,repositoryCount:repos.length,pendingDetails:pending.length,nextPoll:await this.s.getAlarm?.()??null,nextManual:s.lastManual?s.lastManual+MANUAL:null};}
 async arm(delay,now=Date.now()){await this.s.setAlarm(now+delay);}
 async ensure({manual=false,reset=false,now=Date.now()}={}){let s=await this.state();if(reset){s=fresh();s.enabled=true;await this.s.deleteAlarm?.();}else if(!s.enabled&&s.lastError!=='authorization-revoked')s.enabled=true;
  if(!s.enabled)return this.status();const old=await this.s.getAlarm?.();if(manual&&(!s.lastManual||now-s.lastManual>=MANUAL)&&!s.failures){s.lastManual=now;await this.arm(1000,now);}else if(old==null)await this.arm(INITIAL,now);await this.s.put(KEY,s);return this.status();}
 async stop(){await this.s.put(KEY,fresh());await this.s.deleteAlarm?.();return this.status();}
 async tick(now=Date.now()){
  let s=await this.state();if(!s.enabled)return this.status();let delay=TICK;
  try{
   const cap=await this.io.authority();if(!cap){s.enabled=false;s.lastError='authorization-revoked';await this.s.put(KEY,s);await this.s.deleteAlarm?.();return this.status();}
   const hash=await hex(cap);const changed=hash!==s.authorityHash;if(changed){s={...fresh(),enabled:true,authorityHash:hash,lastManual:s.lastManual};}
   const q=await this.io.queueStatus();if(!changed&&q.lastError==='authorization-revoked'&&!q.configured){s.enabled=false;s.lastError='authorization-revoked';await this.s.put(KEY,s);await this.s.deleteAlarm?.();return this.status();}
   // Reserve room for the poller's bounded batch and for live job events.
   if(q.pending>32||(q.pending>0&&q.failures>0)){s.backpressure++;await this.s.put(KEY,s);await this.arm(delay,now);return this.status();}
   s.requests++;const t=await this.io.readToken();const get=async path=>{s.requests++;return this.io.get(t,path);};
   if(!s.repos.length||s.cursor>=s.repos.length){const list=await get('/installation/repositories?per_page=100&page=1');if(!Array.isArray(list?.repositories))throw Error('invalid-provider-response');if(Number(list.total_count)>list.repositories.length)s.truncated++;
    s.repos=list.repositories.filter(r=>r.owner?.login?.toLowerCase()===this.io.owner.toLowerCase()&&!r.archived&&!r.disabled&&repoEvents({name:r.name},now).length).map(r=>r.name).sort((a,b)=>a==='PWA-GitRunner'?-1:b==='PWA-GitRunner'?1:a.localeCompare(b));s.cursor=0;}
   const repo=s.repos[s.cursor];let entries=[],observed=[];
   if(repo){const data=await get(this.io.route(repo)+'/actions/runs?per_page=20');if(!Array.isArray(data?.workflow_runs))throw Error('invalid-provider-response');const rows=data.workflow_runs.slice(0,20);if(Number(data.total_count)>20&&rows.length===20&&Date.parse(rows.at(-1).updated_at)>=now-LOOKBACK)s.truncated++;
    for(const r of rows){if(Date.parse(r.updated_at||r.created_at)<now-LOOKBACK)continue;const event=workflowEvent(repo,r,now);if(!event)continue;if(!s.runsSeen[event.key]){event.event.eventId=await stableId(event.key);entries.push(event);observed.push(event.key);}if(r.status!=='completed'||!numericId(r.run_attempt))continue;const item={repo,id:String(r.id),attempt:String(r.run_attempt),commit:event.event.correlation.commit,updatedAt:r.updated_at,failed:r.conclusion==='failure'||r.conclusion==='timed_out'};if(!s.seen[key(item)]&&!s.pending.some(p=>key(p)===key(item)))s.pending.push(item);}
    s.pending=s.pending.filter(x=>Date.parse(x.updatedAt)>=now-2*DAY);s.pending.sort((a,b)=>Number(b.failed)-Number(a.failed)||Date.parse(b.updatedAt)-Date.parse(a.updatedAt));if(s.pending.length>MAX_PENDING){s.truncated+=s.pending.length-MAX_PENDING;s.pending=s.pending.slice(0,MAX_PENDING);} }
   // One completed run per tick. Only metadata; no job names, logs or URLs.
   let item=s.pending[0],detail=null;if(item){try{const d=await get(this.io.route(item.repo)+`/actions/runs/${item.id}/attempts/${item.attempt}/jobs?per_page=20`);detail=await jobDetailEvents(item,d,now);entries.push(...detail.entries);if(detail.truncated){const event=createEvent('github-actions','job',{eventId:await stableId(`truncated:${key(item)}`),kind:'snapshot',provenance:'provider',severity:'warning',coverage:'truncated',outcome:'unknown',correlation:{repo:item.repo,workflowRunId:item.id,runAttempt:item.attempt},metrics:{count:detail.entries.length}},now);entries.push({event,key:`run:${key(item)}:truncated`});}}catch(e){if(/^GitHub 404\b/.test(e.message)){s.pending.shift();s.truncated++;s.unavailableDetails++;s.seen[key(item)]=now;item=null;}else throw e;}}
   if(entries.length){const accepted=await this.io.enqueue(cap,entries);if(!accepted)throw Error('archive-backpressure');}
   for(const k of observed)s.runsSeen[k]=now;
   if(repo){s.cursor++;s.scans++;s.lastRepo=repo;s.lastScan=now;}
   if(item&&detail){s.pending.shift();s.seen[key(item)]=now;s.details++;s.lastDetail=now;if(detail.truncated)s.truncated++;}
   for(const field of ['seen','runsSeen'])s[field]=Object.fromEntries(Object.entries(s[field]).filter(([,at])=>now-at<2*DAY).sort((a,b)=>b[1]-a[1]).slice(0,MAX_SEEN));s.failures=0;s.lastError=null;
  }catch(e){s.failures++;s.lastError=e.message==='archive-backpressure'?'archive-backpressure':/^GitHub (401|403|429)\b/.test(e.message)?'github-auth-or-rate-limit':'provider-unavailable';delay=Math.max(Math.min(6*60*60000,TICK*2**Math.min(s.failures,6)),Number(e.retryMs)||0);}
  await this.s.put(KEY,s);await this.arm(delay,now);return this.status();
 }
}
export function workflowIO(env,authority,queueStatus,enqueue){return {owner:env.GITHUB_OWNER,authority,queueStatus,enqueue,readToken:()=>token(env,{actions:'read',metadata:'read'}),get:gh,route:repo=>repoRoute(env,repo)};}
