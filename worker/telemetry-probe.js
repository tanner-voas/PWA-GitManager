import {createEvent,DAY} from './telemetry-schema.js';
import {workflowEvent} from './telemetry.js';
import {jobDetailEvents,stableId} from './workflow-collector.js';
// Foreground diagnostic independent of the workflow scheduler and producer queue.
// Never return credentials, raw errors, run names, log text, URLs or payloads.
const status=e=>{const m=/^GitHub (\d{3})\b/.exec(String(e?.message||''));return m?Number(m[1]):null;};
const safeError=e=>status(e)?'github-http-'+status(e):'unavailable';
const validId=v=>/^\d{1,20}$/.test(String(v??''));
export async function probeWorkflow(io,now=Date.now()){
 const report={schema:1,startedAt:new Date(now).toISOString(),repository:io.repo,stages:[],rows:0,submitted:0,accepted:0,duplicates:0,rejected:0,requests:0};
 const record=(stage,outcome,fields={})=>report.stages.push({stage,outcome,...fields});
 let token,rows,cap;
 async function send(stage,events){if(!events.length){record(stage,'empty');return true;}report.submitted+=events.length;
  let r;try{r=await io.append(cap,events);}catch{record(stage,'unavailable');return false;}
  if(!r||!Number.isInteger(r.accepted)||!Number.isInteger(r.duplicates)||!Number.isInteger(r.rejected)||[r.accepted,r.duplicates,r.rejected].some(n=>n<0)||r.accepted+r.duplicates+r.rejected!==events.length){record(stage,'unavailable',{code:r?.error==='Telemetry capability revoked'?'authorization-revoked':r?.error==='Telemetry capability expired or invalid'?'authorization-invalid':'invalid-append-receipt'});return false;}
  report.accepted+=r.accepted;report.duplicates+=r.duplicates;report.rejected+=r.rejected;record(stage,r.rejected?'partial':'acknowledged',{accepted:r.accepted,duplicates:r.duplicates,rejected:r.rejected});return r.rejected===0;
 }
 try{cap=await io.authority();record('authority',cap?'available':'missing');if(!cap)return report;}catch{record('authority','unavailable');return report;}
 try{report.requests++;token=await io.readToken();record('github-token','success');}catch(e){record('github-token','error',{code:safeError(e),httpStatus:status(e)});return report;}
 try{report.requests++;const data=await io.get(token,io.route+'/actions/runs?per_page=10');if(!Array.isArray(data?.workflow_runs))throw Error('invalid');rows=data.workflow_runs.slice(0,10);report.rows=rows.length;record('workflow-list','success',{count:rows.length});}catch(e){record('workflow-list','error',{code:safeError(e),httpStatus:status(e)});return report;}
 const recent=rows.filter(r=>Date.parse(r.updated_at||r.created_at)>=now-DAY);const events=[];
 for(const row of recent){const w=workflowEvent(io.repo,row,now);if(!w)continue;w.event.eventId=await stableId(w.key);events.push(w.event);}
 if(!await send('archive-workflows',events))return report;
 const run=recent.find(r=>r.status==='completed'&&validId(r.id)&&validId(r.run_attempt));
 if(run){const item={repo:io.repo,id:String(run.id),attempt:String(run.run_attempt),commit:run.head_sha,updatedAt:run.updated_at};
  try{report.requests++;const d=await io.get(token,io.route+`/actions/runs/${item.id}/attempts/${item.attempt}/jobs?per_page=20`);const detail=await jobDetailEvents(item,d,now);record('job-details','success',{count:detail.entries.length,truncated:detail.truncated});await send('archive-details',detail.entries.map(e=>e.event));}catch(e){record('job-details','error',{code:safeError(e),httpStatus:status(e)});if([401,403,429].includes(status(e)))return report;}
  // Optional additional provider metadata. No log/artifact download or signed URLs.
  try{report.requests++;const d=await io.get(token,io.route+`/actions/runs/${item.id}/artifacts?per_page=30`);if(!Array.isArray(d?.artifacts))throw Error('invalid');const artifacts=d.artifacts.slice(0,30);const bytes=artifacts.reduce((n,a)=>n+(Number.isSafeInteger(a.size_in_bytes)&&a.size_in_bytes>=0?a.size_in_bytes:0),0);const coverage=Number(d.total_count)>artifacts.length||artifacts.some(a=>!Number.isSafeInteger(a.size_in_bytes)||a.size_in_bytes<0)?'truncated':'partial';const a=createEvent('github-actions','artifact',{kind:'snapshot',provenance:'provider',coverage,observedAt:new Date(now).toISOString(),outcome:'success',eventId:await stableId(`artifact:${item.repo}:${item.id}:${artifacts.length}:${bytes}`),correlation:{repo:item.repo,workflowRunId:item.id,commit:item.commit},metrics:{count:artifacts.length,bytes}},now);record('artifact-metadata','success',{count:artifacts.length,bytes,coverage});if(a)await send('archive-artifacts',[a]);}catch(e){record('artifact-metadata','error',{code:safeError(e),httpStatus:status(e)});}
 }else record('job-details','no-completed-recent-run');
 try{const r=await io.flush();record('drive-flush',r&&!r.error?'returned':'unavailable',{pending:Number.isInteger(r?.pending)?r.pending:null,lastReceiptAt:typeof r?.lastReceipt?.verifiedAt==='string'?r.lastReceipt.verifiedAt:null,lastStage:['verified','spool','folder','lookup','write','verify'].includes(r?.lastStage)?r.lastStage:null});}catch{record('drive-flush','unavailable');}
 return report;
}
