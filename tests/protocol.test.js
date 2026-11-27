import test from 'node:test';import assert from 'node:assert/strict';import {bindInitialTarget,nextVersion,normalizePlan,pathOK,constantEqual} from '../worker/protocol.js';import {privateKey,appJWT} from '../worker/github.js';import {generateKeyPairSync,verify} from 'node:crypto';import {JobCoordinator} from '../worker/index.js';
const repos=['Core','App','PWA-GitRunner'];const sample={schema:1,title:'test',updates:[{repository:'Core',fromVersion:'1.2.3',toVersion:'1.2.4',patch:'core.patch'},{repository:'App',fromVersion:'0.9.19',toVersion:'0.9.20',patch:'app.patch',dependsOn:['Core'],submodulePins:{'shared/core':'Core'}}]};
test('only exactly one component can advance, and higher increments reset lower components',()=>{for(const v of ['1.2.4','1.3.0','2.0.0'])assert.equal(nextVersion('1.2.3',v),true);for(const v of ['1.2.3','1.2.5','1.3.1','1.4.0','2.2.0','3.0.0','01.2.4','1.2.4.r1','1.2','0.9.9'])assert.equal(nextVersion('1.2.3',v),false,v);});
test('dependency order, installed repository scope and pin validation',()=>{assert.deepEqual(normalizePlan(sample,repos).updates[1].submodulePins,{'shared/core':'Core'});assert.throws(()=>normalizePlan({...sample,updates:sample.updates.toReversed()},repos),/earlier/);assert.throws(()=>normalizePlan({...sample,updates:[{...sample.updates[0],repository:'unknown'}]},repos),/not installed/);assert.throws(()=>normalizePlan({...sample,updates:[sample.updates[0],{...sample.updates[1],submodulePins:{'../core':'Core'}}]},repos),/Invalid submodule/);assert.equal(pathOK('.git/config'),false);assert.equal(constantEqual('foo','fo'),false);assert.equal(constantEqual('foo','foo'),true);});
test('GitHub PKCS1 and PKCS8 private keys produce verifiable App JWTs',async()=>{const {privateKey:priv,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});for(const type of ['pkcs1','pkcs8']){const pem=priv.export({type,format:'pem'});const jwt=await appJWT({GITHUB_APP_ID:'123',GITHUB_APP_PRIVATE_KEY:pem});const [h,p,s]=jwt.split('.');assert.equal(JSON.parse(Buffer.from(p,'base64url')).iss,'123');assert.ok(verify('RSA-SHA256',Buffer.from(h+'.'+p),publicKey,Buffer.from(s,'base64url')));}});
class Storage{m=new Map();async get(k){return structuredClone(this.m.get(k));}async put(k,v){this.m.set(k,structuredClone(v));}async delete(k){this.m.delete(k);}async list({prefix}){return new Map([...this.m].filter(([k])=>k.startsWith(prefix)));}}
function coordinator(){const c=new JobCoordinator({storage:new Storage()},{GITHUB_OWNER:'owner',CONTROLLER_REPO:'PWA-GitRunner'});c.dispatched=[];c.dispatch=async(id,attempt)=>c.dispatched.push({id,attempt});return c;}
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',id2='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',sha='1'.repeat(40),base='2'.repeat(40),tree='3'.repeat(40);
async function req(c,path,body,method='POST'){const r=await c.fetch(new Request('https://internal'+path,{method,body:method==='GET'?undefined:JSON.stringify(body??{})}));return {status:r.status,data:await r.json()};}
async function draft(c,id,mode='direct'){return req(c,'/jobs',{id,mode,plan:normalizePlan(sample,repos),sha256:'4'.repeat(64),filename:'x.zip'});}
async function runner(c,j,op,body={}){return req(c,`/runner/${j.id}/${j.attempt.id}/${op}`,{runId:'123',...body});}
async function prepared(c,j){assert.equal((await runner(c,j,'claim')).status,200);assert.equal((await runner(c,j,'candidate',{base,commit:sha,tree,version:j.plan.updates[j.index].toVersion})).status,200);}
test('workspace lock, one writer token, ordered publication and final reconciliation',async()=>{const c=coordinator();await draft(c,id);await draft(c,id2);let j=(await req(c,`/jobs/${id}/start`)).data;assert.equal((await req(c,`/jobs/${id2}/start`)).status,409);await prepared(c,j);assert.equal((await runner(c,j,'token',{write:true,commit:base})).status,403);assert.equal((await runner(c,j,'token',{write:true,commit:sha})).status,200);assert.equal((await runner(c,j,'token',{write:true,commit:sha})).status,403);assert.equal((await runner(c,j,'published',{commit:sha,state:'published'})).status,200);const old=j;j=(await runner(c,j,'finish',{state:'success'})).data;assert.equal(j.index,1);assert.equal(j.records[0].commit,sha);assert.equal((await runner(c,old,'finish',{state:'success'})).status,409);await prepared(c,j);await runner(c,j,'token',{write:true,commit:sha});await runner(c,j,'published',{commit:sha,state:'published'});j=(await runner(c,j,'finish',{state:'success'})).data;assert.equal(j.attempt.kind,'settle');assert.equal(j.status,'running');await runner(c,j,'claim');j=(await runner(c,j,'finish',{state:'success'})).data;assert.equal(j.status,'completed');assert.equal((await req(c,`/jobs/${id2}/start`)).status,200);});
test('race retries same step, stale attempts and duplicate claims rejected',async()=>{const c=coordinator();await draft(c,id);let j=(await req(c,`/jobs/${id}/start`)).data;await prepared(c,j);assert.equal((await runner(c,j,'claim',{runId:'124'})).status,409);const prev=j;j=(await runner(c,j,'finish',{state:'race',message:'head moved'})).data;assert.equal(j.index,0);assert.equal(j.retries,1);assert.notEqual(j.attempt.id,prev.attempt.id);assert.equal((await runner(c,prev,'token',{write:true,commit:sha})).status,409);await prepared(c,j);j=(await runner(c,j,'finish',{state:'failed',message:'test failed'})).data;assert.equal(j.status,'failed');assert.equal(j.records.length,0);});
test('dry runs cannot request write credentials and PR publication pauses',async()=>{const c=coordinator();await draft(c,id,'dry');let j=(await req(c,`/jobs/${id}/start`)).data;await prepared(c,j);assert.equal((await runner(c,j,'token',{write:true,commit:sha})).status,403);j=(await runner(c,j,'finish',{state:'success'})).data;assert.equal(j.records[0].state,'validated');const c2=coordinator();await draft(c2,id,'pr');j=(await req(c2,`/jobs/${id}/start`)).data;await prepared(c2,j);await runner(c2,j,'token',{write:true,commit:sha});await runner(c2,j,'published',{commit:sha,state:'pr',pr:{number:1,url:'https://github.com/owner/Core/pull/1'}});j=(await runner(c2,j,'finish',{state:'success'})).data;assert.equal(j.status,'awaiting-pr');assert.equal(j.index,0);});
test('export has no write path',async()=>{const c=coordinator();await req(c,'/jobs',{id,mode:'export',plan:{title:'Export',updates:[]},exportSpec:{repositories:['Core'],format:'bundle'}});let j=(await req(c,`/jobs/${id}/start`)).data;assert.equal(j.attempt.kind,'export');assert.equal((await runner(c,j,'claim')).data.exportSpec.format,'bundle');assert.equal((await runner(c,j,'token',{write:true,commit:sha})).status,403);j=(await runner(c,j,'finish',{state:'success'})).data;assert.equal(j.status,'completed');});
import worker from '../worker/index.js';
import {zipMembers} from '../src/zip.js';
test('browser endpoints require authorized Google identity, CSRF and administrator unlock; runner routes require a separate secret',async()=>{const env={ALLOWED_ORIGINS:'https://launcher.test',ADMIN_EMAIL:'admin@example.org',ADMIN_UNLOCK:'012345678901234567890123456789',RUNNER_SECRET:'0'.repeat(32),PROFILES:{fetch:async req=>{assert.equal(new URL(req.url).pathname,'/_profiles/v1/status');return Response.json({connected:true,email:'admin@example.org'});}}};let r=await worker.fetch(new Request('https://evil.test/_git/v1/repos'),env);assert.equal(r.status,401);r=await worker.fetch(new Request('https://launcher.test/_git/v1/jobs',{method:'POST',headers:{Origin:'https://launcher.test','X-PWA-CSRF':'1'}}),env);assert.equal(r.status,403);r=await worker.fetch(new Request('https://launcher.test/_git-runner/v1/'+id+'/'+id2+'/claim',{method:'POST',body:'{}'}),env);assert.equal(r.status,401);});
test('ZIP manifest parser rejects invalid archives',async()=>{await assert.rejects(()=>zipMembers(new Blob(['invalid'])),/ZIP/);});

test('automation timeout schedules bounded background retries without advancing or republishing',async()=>{const c=coordinator();let alarm=null;c.s.setAlarm=async at=>{alarm=at;};c.s.deleteAlarm=async()=>{alarm=null;};c.runState=async()=>({status:'completed',conclusion:'failure'});await draft(c,id);let j=(await req(c,`/jobs/${id}/start`)).data;await runner(c,j,'claim');await runner(c,j,'progress',{phase:'settling',note:'Waiting for Ciyan'});j=(await runner(c,j,'finish',{state:'paused',message:'Automation timeout'})).data;assert.equal(j.index,0);assert.equal(j.status,'paused');assert.equal(j.records.length,0);assert.ok(alarm);assert.equal(j.progress.note,'Waiting for Ciyan');let old=j.attempt.id;j.retryAt=Date.now()-1;await c.save(j);await c.alarm();j=await c.get(id);assert.equal(j.status,'running');assert.equal(j.automationRetries,1);assert.notEqual(j.attempt.id,old);assert.equal(j.index,0);});
test('watchdog detects lost completion callback but never reissues an uncertain write',async()=>{const c=coordinator();c.runState=async()=>({status:'completed',conclusion:'failure'});await draft(c,id);let j=(await req(c,`/jobs/${id}/start`)).data;await prepared(c,j);await runner(c,j,'token',{write:true,commit:sha});await c.alarm();j=await c.get(id);assert.equal(j.status,'paused');assert.equal(j.attempt.writeIssued,true);assert.equal(c.dispatched.length,1);assert.match(j.error,/verify any publication/);});

test('export progress records actual counts, rejects invalid counts, and is compatible with older runner',async()=>{const c=coordinator();await req(c,'/jobs',{id,mode:'export',plan:{title:'Export',updates:[]},exportSpec:{repositories:['Core','App'],format:'lightweight'}});let j=(await req(c,`/jobs/${id}/start`)).data;await runner(c,j,'claim');await runner(c,j,'progress',{phase:'preparing',note:'Prepared Core',done:1,total:2});j=await c.get(id);assert.equal(j.progress.done,1);assert.equal(j.progress.total,2);await runner(c,j,'progress',{phase:'preparing',note:'bad count',done:3,total:2});assert.equal((await c.get(id)).progress.done,undefined);});

test('safe cancellation releases active lock and rejects late runner callbacks',async()=>{const c=coordinator();await draft(c,id);await draft(c,id2);let j=(await req(c,`/jobs/${id}/start`)).data;await runner(c,j,'claim');const result=await req(c,`/jobs/${id}/cancel`);assert.equal(result.status,200);assert.equal(result.data.status,'cancelled');assert.equal(await c.s.get('active'),undefined);assert.equal((await runner(c,j,'progress',{phase:'preparing',note:'late'})).status,409);assert.equal((await req(c,`/jobs/${id2}/start`)).status,200);});
test('cancel refuses issued write credentials',async()=>{const c=coordinator();await draft(c,id);let j=(await req(c,`/jobs/${id}/start`)).data;await prepared(c,j);await runner(c,j,'token',{write:true,commit:sha});assert.equal((await req(c,`/jobs/${id}/cancel`)).status,409);assert.equal(await c.s.get('active'),id);});
test('retention removes old completed jobs but never active or unresolved jobs',async()=>{const c=coordinator();const old=new Date(Date.now()-40*86400000).toISOString();await c.s.put('job:'+id,{id,createdAt:old,updatedAt:old,status:'completed'});await c.s.put('job:'+id2,{id:id2,createdAt:old,updatedAt:old,status:'paused'});await c.s.put('active',id2);const kept=await c.history();assert.deepEqual(kept.map(j=>j.id),[id2]);assert.equal(await c.s.get('job:'+id),undefined);});

test('blocked immediate export does not leave an orphan draft',async()=>{const c=coordinator();await draft(c,id);await req(c,`/jobs/${id}/start`);const r=await req(c,'/jobs',{id:id2,mode:'export',plan:{title:'Export',updates:[]},exportSpec:{repositories:['Core'],format:'bundle'},start:true});assert.equal(r.status,409);assert.equal(await c.s.get('job:'+id2),undefined);});

// Repeated repositories are ordered steps, never independent alternatives.
test('successive repository entries require a continuous version chain and Direct mode',()=>{
 const second={...sample.updates[0],repository:'core',fromVersion:'1.2.4',toVersion:'1.2.5',patch:'core-second.patch'};
 const p={...sample,updates:[...sample.updates,second]};
 assert.deepEqual(normalizePlan(p,repos,'direct').updates.map(u=>[u.repository,u.fromVersion,u.toVersion]),[['Core','1.2.3','1.2.4'],['App','0.9.19','0.9.20'],['Core','1.2.4','1.2.5']]);
 for(const mode of ['dry','pr'])assert.throws(()=>normalizePlan(p,repos,mode),/Direct mode/);
 for(const u of [{...second,fromVersion:'1.2.5',toVersion:'1.2.6'},{...second,fromVersion:'1.2.3',toVersion:'1.2.4'}])assert.throws(()=>normalizePlan({...p,updates:[...sample.updates,u]},repos),/continuous version chain/);
 assert.throws(()=>normalizePlan({...p,updates:[...sample.updates,{...second,dependsOn:['Core']}]},repos),/itself/);
 assert.doesNotThrow(()=>normalizePlan(sample,repos,'pr'));
});
test('interleaved repeated repo steps publish independently and settle once at the end',async()=>{
 const c=coordinator();const plan=normalizePlan({...sample,updates:[...sample.updates,{...sample.updates[0],fromVersion:'1.2.4',toVersion:'1.2.5',patch:'core-second.patch'}]},repos,'direct');
 await req(c,'/jobs',{id,mode:'direct',plan,sha256:'4'.repeat(64),filename:'chain.zip'});
 let j=(await req(c,`/jobs/${id}/start`)).data;const commits=['5'.repeat(40),'6'.repeat(40),'7'.repeat(40)];
 for(let i=0;i<3;i++){
  assert.equal(j.index,i);const claim=await runner(c,j,'claim');assert.equal(claim.status,200);assert.equal(claim.data.update.toVersion,plan.updates[i].toVersion);assert.deepEqual(claim.data.records.map(r=>r.commit),commits.slice(0,i));
  assert.equal((await runner(c,j,'candidate',{base:i===2?commits[0]:base,commit:commits[i],tree,version:plan.updates[i].toVersion})).status,200);
  assert.equal((await runner(c,j,'token',{write:true,commit:commits[i]})).status,200);
  assert.equal((await runner(c,j,'published',{state:'published',commit:commits[i]})).status,200);
  assert.equal((await runner(c,j,'published',{state:'published',commit:commits[i]})).status,409);
  const previous=j;j=(await runner(c,j,'finish',{state:'success'})).data;
  assert.equal((await runner(c,previous,'finish',{state:'success'})).status,409);
 }
 assert.deepEqual(j.records.map(r=>[r.index,r.repository,r.version,r.commit]),[[0,'Core','1.2.4',commits[0]],[1,'App','0.9.20',commits[1]],[2,'Core','1.2.5',commits[2]]]);
 assert.equal(j.attempt.kind,'settle');await runner(c,j,'claim');j=(await runner(c,j,'finish',{state:'success'})).data;assert.equal(j.status,'completed');assert.equal(j.index,3);
});

const initial={repository:'Core',owner:'owner',repositoryId:123,private:true,policy:'documentation',kind:'bootstrap',branch:'main',toVersion:'0.1.0',commit:sha,tree,sha256:'4'.repeat(64),patch:'initial.bundle'};
const initialPlan={schema:1,title:'Initial publication',updates:[initial]};
test('bootstrap manifest is explicit, single-target, private, and independent of version increments',()=>{
 const p=normalizePlan(initialPlan,repos);assert.equal(p.updates[0].baseCommit,null);assert.equal(p.updates[0].fromVersion,null);assert.equal(p.updates[0].commit,sha);assert.equal(p.updates[0].repositoryId,123);assert.doesNotThrow(()=>normalizePlan(initialPlan,repos,'dry'));
 assert.throws(()=>normalizePlan(initialPlan,repos,'pr'),/Direct or Dry/);assert.throws(()=>normalizePlan({...initialPlan,updates:[initial,sample.updates[0]]},repos),/single repository/);
 for(const change of [{private:false},{owner:''},{repositoryId:0},{commit:'short'},{tree:null},{sha256:null},{baseCommit:base},{fromVersion:'0.0.0'},{patch:'x.patch'},{policy:'executable'},{dependsOn:['App']},{submodulePins:{x:'App'}}])assert.throws(()=>normalizePlan({...initialPlan,updates:[{...initial,...change}]},repos),/Invalid initial publication/);
});
test('bootstrap coordinator binds exact commit/tree with null base and denies dry-run writes',async()=>{
 for(const mode of ['direct','dry']){const c=coordinator();await req(c,'/jobs',{id,mode,plan:normalizePlan(initialPlan,repos,mode),sha256:'5'.repeat(64),filename:'initial.zip'});let j=(await req(c,`/jobs/${id}/start`)).data;await runner(c,j,'claim');
 for(const bad of [{base,commit:sha,tree},{base:null,commit:base,tree},{base:null,commit:sha,tree:base}])assert.equal((await runner(c,j,'candidate',{...bad,version:'0.1.0'})).status,409);
 assert.equal((await runner(c,j,'candidate',{base:null,commit:sha,tree,version:'0.1.0'})).status,200);
 const token=await runner(c,j,'token',{write:true,commit:sha});assert.equal(token.status,mode==='dry'?403:200);if(mode==='direct'){assert.equal(token.data.bootstrap,true);assert.equal((await runner(c,j,'published',{state:'published',commit:sha})).status,200);}
 j=(await runner(c,j,'finish',{state:'success'})).data;assert.equal(j.records[0].base,null);assert.equal(j.records[0].state,mode==='dry'?'validated':'published');if(mode==='direct'){await runner(c,j,'claim');j=(await runner(c,j,'finish',{state:'success'})).data;}assert.equal(j.status,'completed');}
});


test('portable bootstrap target resolves at review and explicit identity remains bound',()=>{
 const target={name:'Core',id:123,owner:'owner',private:true,defaultBranch:'main',head:null};
 for(const repositoryId of [undefined,null,0,123]){
  const raw={...initialPlan,updates:[{...initial,repositoryId}]};
  const bound=bindInitialTarget(raw,[target]);
  assert.equal(normalizePlan(bound,repos).updates[0].repositoryId,123);
  assert.equal(raw.updates[0].repositoryId,repositoryId);
 }
 for(const change of [{id:456},{owner:'other'},{private:false},{defaultBranch:'master'},{head:sha},{id:null}])assert.throws(()=>bindInitialTarget(initialPlan,[{...target,...change}]),/Initial publication|matching empty/);
 assert.throws(()=>bindInitialTarget(initialPlan,[]),/matching empty/);
 const reviewed=bindInitialTarget({...initialPlan,updates:[{...initial,repositoryId:0}]},[target]);
 assert.throws(()=>bindInitialTarget(reviewed,[{...target,id:456}]),/identity changed/);
 assert.deepEqual(bindInitialTarget(sample,[target]),sample);
});
