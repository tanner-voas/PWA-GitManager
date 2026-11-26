import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker,{JobCoordinator} from '../worker/index.js';
import {jobEvents,repoEvents,workflowEvent,TelemetryOutbox} from '../worker/telemetry.js';
import {sanitizeEvent} from '../worker/telemetry-schema.js';
import {unlockAdmin} from '../worker/admin.js';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', attempt='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', next='cccccccc-cccc-cccc-cccc-cccccccccccc', sha='1'.repeat(40), base='2'.repeat(40), now=Date.now();
const dt=new Date(now-1000).toISOString(),cap='secret-append-capability-canary';
const job={id,createdAt:dt,status:'draft',mode:'direct',plan:{title:'SECRET_TITLE',updates:[{repository:'Ciyan',toVersion:'0.9.23'}]},index:0,records:[]};
const running={...job,status:'running',attempt:{id:attempt,kind:'update',createdAt:now-500,runId:null},progress:{phase:'dispatch',note:'SECRET_NOTE'}};
const claimed={...running,attempt:{...running.attempt,runId:'123'},progress:{phase:'preparing',note:'PRIVATE SOURCE'}};
const pub={...claimed,attempt:{...claimed.attempt,candidate:{base,commit:sha,tree:'3'.repeat(40),version:'0.9.23'},writeIssued:true},records:[{index:0,repository:'Ciyan',commit:sha,version:'0.9.23',state:'published'}]};
class Storage{m=new Map();alarm=null;async get(k){return structuredClone(this.m.get(k));}async put(k,v){this.m.set(k,structuredClone(v));}async delete(k){this.m.delete(k);}async list({prefix}){return new Map([...this.m].filter(([k])=>k.startsWith(prefix)));}async setAlarm(at){this.alarm=at;}async getAlarm(){return this.alarm;}async deleteAlarm(){this.alarm=null;}}
const sample=()=>repoEvents({name:'Ciyan',head:sha,version:'0.9.23',tag:'v0.9.23.r1'},now);
const ok=async(c,events)=>({accepted:events.length,duplicates:0,rejected:0});
test('lifecycle, hashes, transitions and privacy; identical repeated progress does not emit',()=>{
 const events=[...jobEvents(null,job,now),...jobEvents(job,running,now),...jobEvents(running,claimed,now),...jobEvents(claimed,pub,now),...jobEvents(pub,{...pub,status:'completed',attempt:{...pub.attempt,outcome:'success'}},now)];
 for(const op of ['create','approve','lock','dispatch','claim','prepare','publish','finish'])assert.ok(events.some(e=>e.operation===op),op);
 assert.ok(events.some(e=>e.operation==='publish'&&e.outcome==='published'&&e.correlation.commit===sha&&e.correlation.repo==='Ciyan'));
 assert.ok(events.some(e=>e.source==='git-runner'&&e.operation==='claim'&&e.correlation.workflowRunId==='123'));
 assert.equal(jobEvents(claimed,claimed,now).length,0);assert.ok(events.every(e=>sanitizeEvent(e,{now})));
 assert.doesNotMatch(JSON.stringify(events),/SECRET|PRIVATE SOURCE|candidate|writeIssued/);
 assert.ok(jobEvents(claimed,{...claimed,status:'cancelled'},now).some(e=>e.operation==='cancel'));
 assert.ok(jobEvents(claimed,{...claimed,status:'failed'},now).some(e=>e.operation==='finish'&&e.severity==='error'));
 const switched={...pub,index:1,attempt:{id:next,kind:'settle',createdAt:now},attemptHistory:[{...pub.attempt,outcome:'success'}],progress:{phase:'dispatch'}};
 assert.ok(jobEvents(pub,switched,now).some(e=>e.source==='git-runner'&&e.operation==='finish'&&e.correlation.attemptId===attempt));
});
test('repo and workflow observations retain exact known hashes, run attempt and original time, not URLs or names',()=>{
 const events=sample();assert.equal(events.length,2);assert.equal(events[0].event.correlation.commit,sha);assert.equal(events[1].event.appVersion,'0.9.23.r1');
 const w=workflowEvent('PWA-GitRunner',{id:234,run_attempt:2,status:'completed',conclusion:'failure',head_sha:sha,created_at:dt,updated_at:new Date(now).toISOString(),name:'SECRET',html_url:'https://secret.test/token'},now);
 assert.equal(w.event.outcome,'failed');assert.equal(w.event.correlation.runAttempt,'2');assert.equal(w.event.metrics.durationMs,1000);assert.doesNotMatch(JSON.stringify(w),/SECRET|https:\/\//);
 assert.equal(workflowEvent('Ciyan',{id:1,status:'completed',updated_at:'2020-01-01'},now),null);
 assert.deepEqual(repoEvents({name:'not-in-workspace',head:sha},now),[]);
});
test('outbox survives reconstruction, deduplicates observations, acknowledges only complete receipt',async()=>{
 const s=new Storage();let calls=0;const box=new TelemetryOutbox(s,{telemetryAppend:async(c,e)=>{assert.equal(c,cap);assert.equal(e.length,2);calls++;return calls===1?{accepted:1,duplicates:0,rejected:1}:{accepted:1,duplicates:1,rejected:0};}});
 await box.enqueue(cap,sample(),now);await box.enqueue(cap,sample(),now+1);assert.equal((await box.status()).pending,2);assert.ok(s.alarm);
 await box.drain({now});assert.equal((await box.status()).pending,2);assert.equal((await box.status()).failures,1);
 const restored=new TelemetryOutbox(s,box.profiles);await restored.drain({now:now+200000});const status=await restored.status();assert.equal(status.pending,0);assert.equal(status.sent,2);assert.equal(s.alarm,null);assert.doesNotMatch(JSON.stringify(status),/secret-append/);
});
test('queue bound, terminal priority, authorization isolation and revocation',async()=>{
 const s=new Storage(),box=new TelemetryOutbox(s,{telemetryAppend:async()=>({error:'Telemetry capability revoked'})});
 for(let i=0;i<4;i++)await box.enqueue(cap,Array.from({length:32},()=>jobEvents(null,job,now)[0]),now);
 assert.equal((await box.status()).pending,96);assert.equal((await box.status()).dropped,32);
 await box.enqueue(cap,jobEvents(claimed,{...claimed,status:'failed'},now),now);assert.ok((await box.state()).queue.some(e=>e.operation==='finish'));assert.equal((await box.status()).pending,96);
 await box.enqueue('new-cap',sample(),now);assert.equal((await box.status()).pending,2);await box.clear(cap);assert.equal((await box.status()).pending,2);await box.drain({now});assert.equal((await box.status()).pending,0);assert.equal((await box.status()).configured,false);assert.equal((await box.status()).lastError,'authorization-revoked');assert.equal(s.alarm,null);
});
test('existing A2 authority captures real job transitions in independent collector; no added GitHub calls or job alarm coupling',async()=>{
 const instances=new Map(),pending=[];const env={GITHUB_OWNER:'owner',CONTROLLER_REPO:'PWA-GitRunner',PROFILES:{telemetryAppend:ok}};
 env.JOBS={idFromName:x=>x,get:n=>{if(!instances.has(n)){const ctx={storage:new Storage(),waitUntil:p=>pending.push(p)};const c=new JobCoordinator(ctx,env);c.dispatch=async()=>{};instances.set(n,c);}return instances.get(n);}};
 const jobs=env.JOBS.get('workspace-v1');await jobs.s.put('telemetry:authority',cap);
 const post=(path,data)=>jobs.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify(data)}));
 assert.equal((await post('/jobs',{id,mode:'export',plan:{updates:[]},exportSpec:{repositories:['Ciyan'],format:'lightweight'},start:true})).status,201);
 const j=await jobs.get(id);await post(`/runner/${id}/${j.attempt.id}/claim`,{runId:'123'});await post(`/runner/${id}/${j.attempt.id}/progress`,{runId:'123',phase:'preparing',done:1,total:1,note:'PRIVATE'});await post(`/runner/${id}/${j.attempt.id}/finish`,{runId:'123',state:'success'});await Promise.all(pending);
 const collector=instances.get('workspace-telemetry-b1');assert.ok(collector);assert.equal(await jobs.s.get('active'),undefined);assert.equal(jobs.s.alarm,null);assert.ok(collector.s.alarm);const box=new TelemetryOutbox(collector.s,env.PROFILES);assert.ok((await box.state()).queue.some(e=>e.operation==='finish'&&e.outcome==='completed'));await collector.alarm();assert.equal((await box.status()).pending,0);
});
test('public cannot read collector or authority endpoints; telemetry failure cannot fail a saved job',async()=>{
 const origin='https://launcher.test',env={ALLOWED_ORIGINS:origin,ADMIN_EMAIL:'admin@example.org',PROFILES:{fetch:async()=>Response.json({connected:true,email:'admin@example.org'})}};
 for(const path of ['/collector/status','/telemetry-authority'])assert.equal((await worker.fetch(new Request(origin+'/_git/v1'+path),env)).status,404);
 const pending=[],c=new JobCoordinator({storage:new Storage(),waitUntil:p=>pending.push(p)},env);await c.s.put('telemetry:authority',cap);await c.save(job);await Promise.all(pending);assert.equal((await c.get(id)).status,'draft');
});
test('generic workflow cannot suppress job-correlated observation',async()=>{
 const s=new Storage(),box=new TelemetryOutbox(s,{telemetryAppend:ok});const run={id:234,run_attempt:2,status:'completed',conclusion:'success',head_sha:sha,created_at:dt,updated_at:new Date(now).toISOString()};
 const generic=()=>workflowEvent('PWA-GitRunner',run,now),correlated=()=>workflowEvent('PWA-GitRunner',run,now,{jobId:id,attemptId:attempt});
 await box.enqueue(cap,[generic(),correlated(),generic(),correlated()],now);assert.equal((await box.status()).pending,2);assert.equal((await box.state()).queue[1].correlation.jobId,id);
 await box.drain({now});const a=(await box.status()).lastAcknowledgement;assert.equal(a.count,2);assert.deepEqual(a.runs,['PWA-GitRunner:234']);assert.deepEqual(a.sources,['github-actions']);assert.equal(a.accepted+a.duplicates,2);
});
test('terminal progress reflects outcome and preserves intermediate evidence',async()=>{
 const c=new JobCoordinator({storage:new Storage()},{});for(const status of ['completed','failed','cancelled']){const j={...structuredClone(claimed),status,index:status==='completed'?1:0,retryAt:123};await c.save(j);assert.equal(j.progress.phase,status);assert.equal(j.progress.done,j.index);assert.equal(j.progress.total,1);assert.equal(j.retryAt,null);assert.equal(j.lastIntermediateProgress.phase,'preparing');await c.save(j);assert.equal(j.lastIntermediateProgress.phase,'preparing');}
});
