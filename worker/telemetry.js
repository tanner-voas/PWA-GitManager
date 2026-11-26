import {createEvent,sanitizeEvent,DAY} from './telemetry-schema.js';
// Separate instance of the existing SQLite DO class. No new binding/migration,
// no job watchdog alarm or active-job lock is shared with the telemetry spool.
const KEY='telemetry:outbox', LIMIT=96, BATCH=32, FIRST=60000, TTL=2*DAY;
const empty=()=>({capability:null,queue:[],observations:{},sent:0,dropped:0,failures:0,lastError:null,lastSent:null,lastAcknowledgement:null,lastManual:0});
const stamp=n=>new Date(n).toISOString();
// For queue continuity only: both inputs originate from trusted server RPC/storage.
// The Profiles service still verifies the signed capability on every append.
export function enrollmentIdentity(cap){try{const [body,signature,...rest]=cap.split('.');if(rest.length||!signature)return null;const x=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));if(x.type==='workspace-telemetry'&&/^\d+$/.test(x.sub)&&/^[a-f0-9-]{36}$/i.test(x.generation)&&(x.epoch==null||/^[a-f0-9-]{36}$/i.test(x.epoch)))return JSON.stringify([x.sub,x.generation,x.epoch??null]);}catch{}return null;}
export function sameEnrollment(a,b){if(!a||!b)return false;if(a===b)return true;const i=enrollmentIdentity(a);return !!i&&i===enrollmentIdentity(b);}
const phaseOp={preparing:'prepare',validating:'validate',publishing:'publish',settling:'settle'};
const terminal=new Set(['completed','cancelled','failed','paused']);
const jobCorrelation=(j,a=j.attempt)=>({jobId:j.id,attemptId:a?.id,workflowRunId:a?.runId,repo:a?.kind==='update'?j.plan?.updates?.[j.index]?.repository:undefined,commit:a?.candidate?.commit});
export function jobEvents(before,j,now=Date.now()){
 const events=[],a=j.attempt,b=before?.attempt,changed=a?.id!==b?.id;
 function add(source,operation,outcome,fields={}){const e=createEvent(source,operation,{app:source==='git-runner'?'gitrunner':'gitmanager',coverage:'partial',outcome,severity:['failed','error'].includes(outcome)?'error':outcome==='paused'?'warning':'info',correlation:jobCorrelation(j),...fields},now);if(e)events.push(e);}
 const manager=(...args)=>add('git-manager',...args),runner=(...args)=>add('git-runner',...args);
 if(!before)manager('create','success',{metrics:{count:j.plan?.updates?.length||j.exportSpec?.repositories?.length||0}});
 if(a&&changed){if(!b){manager('approve','success');manager('lock','success');}else if((j.retries||0)>(before?.retries||0)||(j.automationRetries||0)>(before?.automationRetries||0)||['paused','failed','awaiting-pr'].includes(before?.status))manager('retry','pending');
  const prior=j.attemptHistory?.at(-1);if(prior?.id===b?.id&&prior?.outcome&&!b.outcome)runner('finish',prior.outcome==='success'?'success':prior.outcome==='paused'||prior.outcome==='race'?'paused':'failed',{correlation:jobCorrelation(before,prior),metrics:{durationMs:Math.max(0,now-prior.createdAt)}});
  manager('dispatch','pending');}
 if(a?.runId&&(changed||a.runId!==b?.runId)){manager('claim','success');runner('claim','success',{metrics:{queueMs:Math.max(0,now-a.createdAt)}});}
 if(a&&j.progress?.phase!=='dispatch'&&phaseOp[j.progress?.phase]&&(changed||j.progress?.phase!==before?.progress?.phase||j.progress?.done!==before?.progress?.done))runner(a.kind==='export'?'export':phaseOp[j.progress.phase],'pending',{metrics:{count:j.progress.done,limit:j.progress.total}});
 if(a?.candidate&&(changed||!b?.candidate))manager('prepare','success',{metrics:{count:a.candidate.verifiedGitlinks}});
 if(a?.writeIssued&&(changed||!b?.writeIssued))manager('publish','pending');
 for(const r of j.records||[]){if((before?.records||[]).some(x=>x.index===r.index&&x.state===r.state&&x.commit===r.commit))continue;manager(r.state==='validated'?'validate':'publish',r.state==='published'?'published':'success',{correlation:{...jobCorrelation(j),attemptId:b?.id||a?.id,workflowRunId:b?.runId||a?.runId,repo:r.repository,commit:r.commit},appVersion:r.version});}
 if(a?.outcome&&!changed&&a.outcome!==b?.outcome)runner('finish',a.outcome==='success'?'success':a.outcome==='paused'?'paused':'failed',{metrics:{durationMs:Math.max(0,now-a.createdAt)}});
 if(terminal.has(j.status)&&j.status!==before?.status){if(j.status==='cancelled')manager('cancel','cancelled');manager('finish',j.status,{metrics:{count:j.mode==='export'?(j.progress?.done??(j.status==='completed'?j.exportSpec?.repositories?.length:0)):j.records?.length||0,limit:j.mode==='export'?j.exportSpec?.repositories?.length:j.plan?.updates?.length,durationMs:Math.max(0,now-Date.parse(j.createdAt))}});}
 return events;
}
export function releaseEvent(j,now=Date.now()){return createEvent('git-manager','release',{app:'gitmanager',coverage:'partial',outcome:'success',correlation:jobCorrelation(j)},now);}
export function repoEvents(r,now=Date.now()){
 const base={kind:'snapshot',provenance:'provider',coverage:'partial',observedAt:stamp(now)},events=[];
 function add(operation,commit,version){const e=createEvent('repository',operation,{...base,appVersion:version,outcome:commit?'success':'unknown',correlation:{repo:r.name,commit}},now);if(e?.correlation?.repo)events.push({event:e,key:'repo:'+r.name+':'+operation});}
 add('snapshot',r.head,r.version);if(r.tag)add('tag',r.head,r.tag.replace(/^v/,''));if(r.name==='AppLauncher')add('production',r.production);return events;
}
export function workflowEvent(repo,r,now=Date.now(),correlation={}){
 if(!/^\d+$/.test(String(r.id||'')))return null;
 const completed=r.status==='completed',outcome=completed?({success:'success',failure:'failed',cancelled:'cancelled',timed_out:'failed',skipped:'skipped',neutral:'completed',action_required:'failed',stale:'failed'}[r.conclusion]||'unknown'):'pending';
 const end=Date.parse(r.updated_at),start=Date.parse(r.run_started_at||r.created_at),at=completed?end:start;
 if(Number.isFinite(at)&&at<now-30*DAY)return null;
 const e=createEvent('github-actions','workflow',{kind:'snapshot',provenance:'provider',coverage:'partial',occurredAt:Number.isFinite(at)&&at<=now+300000&&at>=now-30*DAY?stamp(at):stamp(now),observedAt:stamp(now),outcome,severity:outcome==='failed'?'error':'info',correlation:{...correlation,repo,commit:r.head_sha,workflowRunId:String(r.id),runAttempt:r.run_attempt==null?undefined:String(r.run_attempt)},metrics:{durationMs:completed&&Number.isFinite(end)&&Number.isFinite(start)&&end>=start?end-start:undefined}},now);
 const scope=e?.correlation?.jobId?`:job:${e.correlation.jobId}:${e.correlation.attemptId||''}`:'';
 return e?.correlation?.repo?{event:e,key:`run:${repo}:${r.id}:${r.run_attempt||0}:${r.status}:${r.conclusion||''}${scope}`}:null;
}
const fingerprint=e=>JSON.stringify([e.source,e.operation,e.outcome,e.appVersion,e.correlation?.repo,e.correlation?.commit,e.correlation?.workflowRunId,e.correlation?.runAttempt,e.metrics]);
const priority=e=>e.severity==='error'||['finish','cancel'].includes(e.operation);
export class TelemetryOutbox{
 constructor(storage,profiles){this.s=storage;this.profiles=profiles;}
 async state(){return {...empty(),...await this.s.get(KEY)};}
 async status(){const m=await this.state();return {configured:!!m.capability,pending:m.queue.length,sent:m.sent,dropped:m.dropped,failures:m.failures,lastError:m.lastError,lastSent:m.lastSent,lastAcknowledgement:m.lastAcknowledgement,alarmAt:await this.s.getAlarm?.()??null};}
 async arm(m,delay=FIRST){if(!m.capability||!m.queue.length)return;const at=Date.now()+delay,old=await this.s.getAlarm?.();if(old==null||old>at)await this.s.setAlarm(at);}
 async clear(capability){const m=await this.state();if(!sameEnrollment(capability,m.capability))return;await this.s.put(KEY,{...empty(),sent:m.sent,dropped:m.dropped+m.queue.length});await this.s.deleteAlarm?.();}
 async enqueue(capability,items,now=Date.now()){
  if(typeof capability!=='string'||!capability||capability.length>4096||!Array.isArray(items)||items.length>64)return;
  let m=await this.state();if(m.capability!==capability){if(sameEnrollment(m.capability,capability)){m.capability=capability;}else m={...empty(),capability,sent:m.sent,dropped:m.dropped+m.queue.length};}
  for(const item of items){const event=sanitizeEvent(item.event||item,{now});if(!event){m.dropped++;continue;}const key=typeof item.key==='string'&&/^(repo|run):[A-Za-z0-9_.:-]{1,180}$/.test(item.key)?item.key:null,fp=fingerprint(event);if(key&&m.observations[key]?.fp===fp&&now-m.observations[key].at<(key.startsWith('run:')?30*DAY:DAY))continue;
   if(m.queue.some(x=>x.eventId===event.eventId))continue;
   if(m.queue.length>=LIMIT){const victim=m.queue.findIndex(x=>!priority(x));if(victim<0||!priority(event)){m.dropped++;continue;}m.queue.splice(victim,1);m.dropped++;}
   m.queue.push(event);if(key)m.observations[key]={fp,at:now};
  }
  m.observations=Object.fromEntries(Object.entries(m.observations).sort((a,b)=>b[1].at-a[1].at).slice(0,200));
  await this.s.put(KEY,m);await this.arm(m);return this.status();
 }
 async drain({manual=false,preservePending=false,now=Date.now()}={}){
  let m=await this.state();if(!m.capability||!m.queue.length)return this.status();
  if(manual&&m.lastManual&&now-m.lastManual<FIRST)return this.status();if(manual)m.lastManual=now;
  const stale=preservePending?[]:m.queue.filter(e=>Date.parse(e.occurredAt)<now-TTL&&Date.parse(e.observedAt||e.occurredAt)<now-TTL);m.dropped+=stale.length;m.queue=m.queue.filter(e=>!stale.includes(e));
  if(!m.queue.length){await this.s.put(KEY,m);await this.s.deleteAlarm?.();return this.status();}
  const batch=m.queue.slice(0,BATCH);let r;try{r=await this.profiles.telemetryAppend(m.capability,batch);}catch{}
  if(r&&Number.isInteger(r.accepted)&&Number.isInteger(r.duplicates)&&r.accepted>=0&&r.duplicates>=0&&r.accepted+r.duplicates===batch.length&&!r.rejected){m.queue.splice(0,batch.length);m.sent+=batch.length;m.failures=0;m.lastError=null;m.lastSent=now;m.lastAcknowledgement={at:stamp(now),count:batch.length,accepted:r.accepted,duplicates:r.duplicates,sources:[...new Set(batch.map(e=>e.source))].sort(),runs:[...new Set(batch.filter(e=>e.correlation?.workflowRunId).map(e=>`${e.correlation.repo||'unknown'}:${e.correlation.workflowRunId}`))].sort()};}
  else if(!preservePending&&(r?.error==='Telemetry capability revoked'||r?.error==='Telemetry capability expired or invalid')){m.dropped+=m.queue.length;m.queue=[];m.capability=null;m.lastError='authorization-revoked';m.failures++;m.observations={};}
  else{m.failures++;m.lastError='sink-unavailable-or-full';}
  await this.s.put(KEY,m);await this.s.deleteAlarm?.();await this.arm(m,m.failures?Math.min(15*FIRST,FIRST*2**Math.min(m.failures,4)):FIRST);return this.status();
 }
}
