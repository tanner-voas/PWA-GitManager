import {adminStatus,unlockAdmin,lockCookie,sameOrigin} from './admin.js';
import {MAX_UPLOAD,normalizePlan,json,fail,digest,constantEqual,SHA,REPO,pathOK} from './protocol.js';
import {gh,token,readToken,installed,repoRoute,dispatch} from './github.js';
const PREFIX='/_git/v1', RUN='/_git-runner/v1';
const originOK=(env,url)=>String(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).includes(url.origin);
async function identity(req,env){const url=new URL(req.url);if(!originOK(env,url)||!env.PROFILES)return false;const r=await env.PROFILES.fetch(new Request(url.origin+'/_profiles/v1/status',{headers:{Cookie:req.headers.get('Cookie')||''}}));if(!r.ok)return false;const s=await r.json();return s.connected===true&&typeof s.email==='string'&&String(env.ADMIN_EMAIL||'').toLowerCase()===s.email.toLowerCase()&&!!env.ADMIN_EMAIL;}
const runnerOK=(req,env)=>constantEqual(req.headers.get('Authorization'),'Bearer '+env.RUNNER_SECRET)&&String(env.RUNNER_SECRET||'').length>=32;
const DO=e=>e.JOBS.get(e.JOBS.idFromName('workspace-v1'));
const internal=(e,path,method='GET',body)=>DO(e).fetch(new Request('https://internal'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}));
function decodeContent(c){return new TextDecoder().decode(Uint8Array.from(atob(c.content.replace(/\s/g,'')),x=>x.charCodeAt(0)));}
async function repoSummary(env,t,r){const base=repoRoute(env,r.name);let version=null,head=null,tag=null,production=null;try{head=(await gh(t,base+'/git/ref/heads/main')).object.sha;}catch{};if(head){for(const f of ['package.json','VERSION']){try{const v=decodeContent(await gh(t,base+'/contents/'+f+'?ref='+head));version=f==='VERSION'?v.trim():JSON.parse(v).version;if(version)break;}catch{}}try{const refs=await gh(t,base+'/git/matching-refs/tags/v'+encodeURIComponent(version||''));tag=refs.filter(x=>x.object.sha===head).map(x=>x.ref.slice(10)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1)||null;}catch{}if(r.name==='AppLauncher')try{production=(await gh(t,base+'/git/ref/heads/production')).object.sha;}catch{}}return {name:r.name,private:r.private,defaultBranch:r.default_branch,head,version,tag,production,url:r.html_url};}
async function repositoryView(req,env,url,path){const t=await readToken(env),repos=await installed(env,t);if(path==='/repos'){const page=Math.max(1,Number(url.searchParams.get('page'))||1),part=repos.slice((page-1)*7,page*7);return json({repos:await Promise.all(part.map(r=>repoSummary(env,t,r))),next:page*7<repos.length?page+1:null});}
 const m=/^\/repos\/([A-Za-z0-9_.-]+)\/(commits|tags|branches|files|runs|pulls|pins|source|export)$/.exec(path);if(!m||!repos.some(r=>r.name===m[1]))return fail('Unknown or uninstalled repository',404);const [,name,view]=m,b=repoRoute(env,name),ref=url.searchParams.get('ref')||'main';if(!/^[A-Za-z0-9_.\/-]{1,120}$/.test(ref)||ref.includes('..'))return fail('Invalid ref');const q=encodeURIComponent(ref),page=Math.max(1,Math.min(100,Number(url.searchParams.get('page'))||1));
 if(view==='commits')return json((await gh(t,b+`/commits?sha=${q}&per_page=30&page=${page}`)).map(c=>({sha:c.sha,message:c.commit.message,date:c.commit.author?.date,url:c.html_url})));
 if(view==='tags'||view==='branches')return json(await gh(t,b+`/${view}?per_page=50&page=${page}`));
 if(view==='pulls')return json((await gh(t,b+'/pulls?state=open&per_page=50')).map(p=>({number:p.number,title:p.title,url:p.html_url,head:p.head.sha,base:p.base.ref})));
 if(view==='runs')return json((await gh(t,b+'/actions/runs?per_page=30')).workflow_runs.map(r=>({id:r.id,name:r.name,status:r.status,conclusion:r.conclusion,url:r.html_url,head:r.head_sha,created:r.created_at})));
 if(view==='pins'){const tree=await gh(t,b+`/git/trees/${q}?recursive=1`);const links=tree.tree.filter(e=>e.mode==='160000').map(e=>({path:e.path,sha:e.sha}));let modules='';try{modules=decodeContent(await gh(t,b+'/contents/.gitmodules?ref='+q));}catch{}return json({links,modules,truncated:tree.truncated});}
 if(view==='files'){const p=url.searchParams.get('path')||'';if(p&&!pathOK(p))return fail('Invalid file path');const c=await gh(t,b+'/contents/'+p.split('/').map(encodeURIComponent).join('/')+'?ref='+q);if(Array.isArray(c))return json({entries:c.map(x=>({name:x.name,path:x.path,type:x.type,size:x.size,sha:x.sha}))});return json({path:c.path,type:c.type,size:c.size,sha:c.sha,content:c.encoding==='base64'?c.content:null});}
 if(view==='source'){const r=await fetch('https://api.github.com'+b+'/zipball/'+q,{headers:{Authorization:'Bearer '+t,'User-Agent':'PWA-GitManager',Accept:'application/vnd.github+json'},redirect:'manual'});const loc=r.headers.get('Location');if(![301,302,303,307,308].includes(r.status)||!loc||new URL(loc).origin!=='https://codeload.github.com')return fail('GitHub source archive unavailable',502);const a=await fetch(loc,{redirect:'manual'});if(!a.ok)return fail('Archive download failed',502);return new Response(a.body,{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${name}-source.zip"`,'Cache-Control':'no-store'}});}
 return fail('Unknown repository operation',404);
}
export default {async fetch(req,env){try{const url=new URL(req.url),p=url.pathname;
 if(p.startsWith('/_profiles/'))return await env.PROFILES.fetch(req);
 if(p.startsWith(RUN+'/')){if(!runnerOK(req,env))return fail('Runner unauthorized',401);const m=new RegExp('^'+RUN+'/([0-9a-f-]{36})/([0-9a-f-]{36})/(claim|package|token|candidate|published|progress|finish)$').exec(p);if(!m)return fail('Unknown runner route',404);const [,id,attempt,op]=m;const data=req.method==='POST'?await req.json():{};const check=await internal(env,`/runner/${id}/${attempt}/${op}`,req.method,data);if(!check.ok||op!=='package'&&op!=='token')return check;const assignment=await check.json();if(op==='package'){const object=await env.PACKAGES.get(id+'/upload');return object?new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}}):fail('Package expired',404);}const perms=data.write?{contents:'write',pull_requests:'write',workflows:'write',metadata:'read'}:{contents:'read',actions:'read',pull_requests:'read',metadata:'read'};return json({token:await token(env,perms,data.write?[assignment.repository]:undefined)});}
 if(!p.startsWith(PREFIX+'/'))return await env.ASSETS.fetch(req);
 if(!await identity(req,env))return fail('Connect the authorized Google account to use Git Manager',401);
 const path=p.slice(PREFIX.length);
 if(path==='/admin/status'&&req.method==='GET')return json(await adminStatus(req,env));
 if((path==='/admin/unlock'||path==='/admin/lock')&&req.method==='POST'){
  if(!sameOrigin(req))return fail('Same-origin CSRF header required',403);
  if(path==='/admin/lock')return new Response(JSON.stringify({unlocked:false}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':lockCookie()}});
  const session=await unlockAdmin(req,env);if(!session)return fail('Administrator password incorrect or unavailable',403);
  return new Response(JSON.stringify({unlocked:true,expiresAt:session.expiresAt}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':session.cookie}});
 }
 if(req.method==='GET'){
  const download=/^\/jobs\/([0-9a-f-]{36})\/download$/.exec(path);
  if(download){
   if(!(await adminStatus(req,env)).unlocked)return fail('Unlock administrator access before downloading',403);
   const jr=await internal(env,'/jobs/'+download[1]);if(!jr.ok)return jr;const j=await jr.json();
   if(j.mode!=='export'||j.status!=='completed'||!/^\d+$/.test(String(j.attempt?.runId||'')))return fail('Export is not ready',409);
   const t=await token(env,{actions:'read',metadata:'read'},[env.CONTROLLER_REPO]),b=repoRoute(env,env.CONTROLLER_REPO);
   const list=await gh(t,b+'/actions/runs/'+j.attempt.runId+'/artifacts?per_page=100');
   const a=list.artifacts.filter(x=>!x.expired&&/^prepared-\d+$/.test(x.name)).sort((a,b)=>b.id-a.id)[0];if(!a)return fail('Export artifact unavailable or expired',404);
   const r=await fetch('https://api.github.com'+b+'/actions/artifacts/'+a.id+'/zip',{headers:{Authorization:'Bearer '+t,Accept:'application/vnd.github+json','User-Agent':'PWA-GitManager'},redirect:'manual'});
   const href=r.headers.get('Location');let destination;try{destination=new URL(href);}catch{return fail('Artifact download unavailable',502);}
   // GitHub returns a short-lived signed storage URL. Never forward the installation token.
   if(![301,302,303,307,308].includes(r.status)||destination.protocol!=='https:'||destination.username||destination.password)return fail('Artifact redirect refused',502);
   const archive=await fetch(destination.href,{redirect:'manual'});if(!archive.ok)return fail('Export artifact unavailable or expired',502);return new Response(archive.body,{headers:{'Content-Type':'application/zip','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
  if(path==='/jobs')return await internal(env,'/jobs');if(/^\/jobs\/[0-9a-f-]{36}$/.test(path))return await internal(env,path);if(path==='/repos'||path.startsWith('/repos/'))return await repositoryView(req,env,url,path);return fail('Unknown API route',404);
 }
 if(!sameOrigin(req)||!(await adminStatus(req,env)).unlocked)return fail('Administrator unlock and same-origin CSRF header required',403);
 if(req.method==='POST'&&/^\/repos\/[A-Za-z0-9_.-]+\/workflows\/(tags|reconcile)$/.test(path)){
  const [, ,name,,action]=path.split('/');const rt=await readToken(env);if(!(await installed(env,rt)).some(r=>r.name===name))return fail('Repository not installed',404);if(action==='reconcile'&&name!=='AppLauncher')return fail('Only AppLauncher has the central reconciliation workflow');const t=await token(env,{actions:'write',metadata:'read'},[name]);const workflow=action==='tags'?'tag-main.yml':'validate-production.yml';await gh(t,repoRoute(env,name)+'/actions/workflows/'+workflow+'/dispatches',{method:'POST',body:{ref:'main'}});return json({accepted:true});
 }
 if(req.method==='POST'&&path==='/exports'){
  const spec=await req.json(),t=await readToken(env),repos=await installed(env,t),names=[...new Set(spec.repositories||[])];if(!names.length||names.length>16||names.some(n=>!repos.some(r=>r.name===n))||!['lightweight','recursive','bundle'].includes(spec.format))return fail('Invalid export request');const id=crypto.randomUUID();return await internal(env,'/jobs','POST',{id,mode:'export',plan:{schema:1,title:'Repository export',updates:[]},exportSpec:{repositories:names,format:spec.format},start:spec.start===true});
 }
 if(req.method==='POST'&&path==='/jobs'){
  const n=Number(req.headers.get('Content-Length')||0);if(n>MAX_UPLOAD+128*1024)return fail('Upload exceeds 12 MiB',413);const form=await req.formData(),file=form.get('upload');if(!file||typeof file.arrayBuffer!=='function'||file.size>MAX_UPLOAD)return fail('Upload missing or exceeds 12 MiB',413);const t=await readToken(env),repos=await installed(env,t);const mode=String(form.get('mode'));if(!['direct','pr','dry'].includes(mode))return fail('Invalid publish mode');const plan=normalizePlan(JSON.parse(String(form.get('plan'))),repos.map(r=>r.name));if(mode==='dry'&&plan.updates.some(u=>u.dependsOn.length))return fail('Dry runs with unpublished inter-repository pins are not supported; use single-repository dry runs');const id=crypto.randomUUID(),bytes=await file.arrayBuffer(),sha256=await digest(bytes);await env.PACKAGES.put(id+'/upload',bytes);const r=await internal(env,'/jobs','POST',{id,plan,mode,sha256,filename:String(file.name||'upload').slice(0,200)});if(!r.ok)await env.PACKAGES.delete(id+'/upload');return r;
 }
 if(req.method==='POST'&&/^\/jobs\/[0-9a-f-]{36}\/(start|resume|cancel)$/.test(path))return await internal(env,path,'POST',{});
 return fail('Unknown mutation',404);
 }catch(e){console.error('git-manager',String(e.message).slice(0,200));return fail(String(e.message||e).slice(0,300),502);}}};

// One durable coordinator serializes writes for the complete installation. No
// in-memory lock is the source of truth: active job + attempt are persisted.
export class JobCoordinator {
 constructor(ctx,env){this.s=ctx.storage;this.env=env;this.queue=Promise.resolve();this.dispatch=(id,attempt)=>dispatch(env,id,attempt);}
 fetch(req){const p=this.queue.then(()=>this.route(req)).catch(e=>fail(String(e.message||e).slice(0,300),409));this.queue=p.then(()=>{},()=>{});return p;}
 async get(id){const j=await this.s.get('job:'+id);if(!j)throw Error('Job not found');return j;}
 async save(j){j.updatedAt=new Date().toISOString();await this.s.put('job:'+j.id,j);}
 async release(j){if(await this.s.get('active')===j.id){await this.s.delete('active');if(this.s.deleteAlarm)await this.s.deleteAlarm();}}
 async watch(delay=120000){if(this.s.setAlarm)await this.s.setAlarm(Date.now()+delay);}
 // Alarms are independent of browser connections. Retry ONLY an explicitly
 // reported automation timeout. Never redispatch an ambiguous write/dispatch.
 alarm(){const p=this.queue.then(()=>this.observe()).catch(async e=>{console.warn('Git Manager watchdog',String(e.message).slice(0,200));await this.watch();});this.queue=p.then(()=>{},()=>{});return p;}
 async runState(a){const t=await readToken(this.env);return gh(t,repoRoute(this.env,this.env.CONTROLLER_REPO)+'/actions/runs/'+a.runId);}
 async observe(){const active=await this.s.get('active');if(!active)return;const j=await this.get(active),a=j.attempt;
  if(j.status==='paused'&&j.retryAt){
   if(Date.now()<j.retryAt){await this.watch(Math.max(1000,j.retryAt-Date.now()));return;}
   if(!a?.runId){j.retryAt=null;await this.save(j);return;}
   if((await this.runState(a)).status!=='completed'){await this.watch(60000);return;}
   j.automationRetries=(j.automationRetries||0)+1;j.retryAt=null;await this.save(j);return this.begin(j,a.kind);
  }
  if(j.status!=='running')return;
  if(!a?.runId){if(Date.now()-a.createdAt<10*60000){await this.watch();return;}j.status='paused';j.error='Runner never claimed its attempt; inspect GitHub Actions before recovering.';await this.save(j);return;}
  const run=await this.runState(a);if(run.status!=='completed'){await this.watch();return;}
  j.status='paused';j.error='Runner completed without a final callback ('+(run.conclusion||'unknown')+'); recover to verify any publication before retrying.';await this.save(j);
 }
 async begin(j,kind=j.mode==='export'?'export':'update'){
  const active=await this.s.get('active');if(active&&active!==j.id){const previous=await this.get(active);if(['completed','cancelled'].includes(previous.status)){await this.release(previous);}else throw Error('Another workspace job is active. Open Activity to finish or cancel it.');}await this.s.put('active',j.id);
  if(j.attempt){j.attemptHistory=[...(j.attemptHistory||[]),j.attempt].slice(-64);}j.attempt={id:crypto.randomUUID(),kind,createdAt:Date.now(),runId:null,candidate:null,writeIssued:false};j.status='running';j.error=null;j.retryAt=null;j.progress={phase:'dispatch',note:'Starting remote runner'};await this.save(j);await this.watch();
  try{await this.dispatch(j.id,j.attempt.id);}catch(e){j.status='paused';j.error='Dispatch not confirmed; inspect workflow before retrying: '+e.message;await this.save(j);}
  return j;
 }
 async history(){
  const rows=[];let startAfter;for(;;){const page=await this.s.list({prefix:'job:',limit:256,...(startAfter?{startAfter}:{})});if(!page.size)break;rows.push(...page.values());const last=[...page.keys()].at(-1);if(page.size<256||last===startAfter)break;startAfter=last;}
  const active=await this.s.get('active'),now=Date.now(),day=86400000;let terminal=0;const kept=[];
  for(const j of rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))){const age=now-Date.parse(j.updatedAt||j.createdAt);const finished=['completed','cancelled'].includes(j.status);if(finished)terminal++;const expired=j.id!==active&&((finished&&(age>30*day||terminal>100))||(j.status==='draft'&&age>7*day));if(expired){await this.s.delete('job:'+j.id);if(this.env.PACKAGES)await this.env.PACKAGES.delete(j.id+'/upload');}else kept.push(j);}
  return kept;
 }
 async route(req){const path=new URL(req.url).pathname,method=req.method;
  if(path==='/jobs'&&method==='GET'){return json(await this.history());}
  if(path==='/jobs'&&method==='POST'){const {start,...data}=await req.json();const j={...data,controller:this.env.CONTROLLER_REPO,status:'draft',index:0,records:[],retries:0,createdAt:new Date().toISOString()};if(start===true&&j.mode==='export')return json(await this.begin(j),201);await this.save(j);return json(j,201);}
  let m=/^\/jobs\/([0-9a-f-]{36})(?:\/(start|resume|cancel))?$/.exec(path);if(m){const j=await this.get(m[1]);if(method==='GET'&&!m[2])return json(j);if(method!=='POST')return fail('Method not allowed',405);
   if(m[2]==='start'){if(j.status!=='draft')throw Error('Only draft jobs may be started');return json(await this.begin(j));}
   if(m[2]==='cancel'){if(!['draft','failed','paused','awaiting-pr','running'].includes(j.status))throw Error('Cannot cancel a completed job');if(j.status==='running'&&j.attempt?.writeIssued)throw Error('Publication credentials were issued. Wait for the runner to finish, then recover if necessary.');if(j.attempt?.writeIssued&&!j.records.some(r=>r.index===j.index))throw Error('Publication is uncertain; recover before cancelling');j.status='cancelled';j.retryAt=null;await this.save(j);await this.release(j);return json(j);}
   if(m[2]==='resume')return json(await this.resume(j));
  }
  m=/^\/runner\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/(claim|package|token|candidate|published|progress|finish)$/.exec(path);if(!m)return fail('Unknown job operation',404);const j=await this.get(m[1]),a=j.attempt,op=m[3];if(!a||a.id!==m[2]||j.status!=='running'||await this.s.get('active')!==j.id)return fail('Stale or inactive attempt',409);const data=method==='POST'?await req.json():{},runId=String(data.runId||req.headers.get('X-Run-ID')||'');
  if(!/^\d+$/.test(runId))return fail('Run ID required');if(op==='claim'){if(a.runId&&a.runId!==runId)return fail('Attempt already claimed',409);a.runId=runId;if(j.progress?.phase==='dispatch')j.progress={phase:'preparing',note:a.kind==='export'?'Runner connected; preparing archive':'Runner connected',at:new Date().toISOString()};await this.save(j);return json({id:j.id,attempt:a.id,kind:a.kind,index:j.index,mode:j.mode,update:j.plan.updates[j.index]||null,records:j.records,remaining:j.plan.updates.slice(j.index).map(u=>u.repository),exportSpec:j.exportSpec,sha256:j.sha256,filename:j.filename,owner:this.env.GITHUB_OWNER,controller:this.env.CONTROLLER_REPO});}
  if(a.runId!==runId)return fail('Run is not the owner of this attempt',409);
  if(op==='package')return json({ok:true});
  if(op==='progress'){if(!['settling','preparing','validating','publishing'].includes(data.phase))return fail('Invalid phase');j.progress={phase:data.phase,note:String(data.note||'').slice(0,700),at:new Date().toISOString()};if(a.kind==='export'&&Number.isSafeInteger(data.done)&&data.total===j.exportSpec.repositories.length&&data.done>=0&&data.done<=data.total){j.progress.done=data.done;j.progress.total=data.total;}await this.save(j);return json({ok:true});}
  if(op==='token'){if(data.write){if(a.kind!=='update'||j.mode==='dry'||!a.candidate||data.commit!==a.candidate.commit||a.writeIssued)return fail('Write token not authorized',403);a.writeIssued=true;a.publishStartedAt=new Date().toISOString();await this.save(j);}return json({repository:j.plan.updates[j.index]?.repository});}
  if(op==='candidate'){if(a.kind!=='update'||a.candidate||!SHA.test(data.base)||!SHA.test(data.commit)||!SHA.test(data.tree)||data.version!==j.plan.updates[j.index].toVersion)return fail('Invalid candidate',409);a.candidate={base:data.base,commit:data.commit,tree:data.tree,version:data.version,verifiedGitlinks:Number.isSafeInteger(data.verifiedGitlinks)?data.verifiedGitlinks:null};await this.save(j);return json({ok:true});}
  if(op==='published'){if(!a.writeIssued||data.commit!==a.candidate?.commit||!['published','pr'].includes(data.state)||j.mode==='direct'&&data.state!=='published'||j.mode==='pr'&&data.state!=='pr')return fail('Invalid publication report',409);if(j.records.some(r=>r.index===j.index))return fail('Already recorded',409);j.records.push({index:j.index,repository:j.plan.updates[j.index].repository,commit:data.commit,base:a.candidate.base,version:a.candidate.version,state:data.state,pr:data.pr||null,startedAt:a.publishStartedAt,at:new Date().toISOString()});await this.save(j);return json({ok:true,repository:j.plan.updates[j.index].repository});}
  if(op==='finish')return this.finish(j,data);
 }
 async finish(j,data){const a=j.attempt;const note=String(data.message||'').slice(0,500);a.outcome=data.state;a.note=note;j.lastRun=a.runId;
  if(data.state==='race'&&!j.records.some(r=>r.index===j.index)&&j.retries<3){j.retries++;return json(await this.begin(j));}
  if(data.state==='success'){
   if(a.kind==='settle'||a.kind==='export'){j.status='completed';await this.save(j);await this.release(j);return json(j);}
   if(j.mode==='dry'){if(!a.candidate)throw Error('No validated candidate');j.records.push({index:j.index,repository:j.plan.updates[j.index].repository,commit:a.candidate.commit,base:a.candidate.base,version:a.candidate.version,state:'validated'});}
   const record=j.records.find(r=>r.index===j.index);if(!record)throw Error('No confirmed publication');if(record.state==='pr'){j.status='awaiting-pr';await this.save(j);return json(j);}
   j.index++;j.retries=0;j.automationRetries=0;if(j.index<j.plan.updates.length)return json(await this.begin(j));if(j.mode==='dry'){j.status='completed';await this.save(j);await this.release(j);return json(j);}return json(await this.begin(j,'settle'));
  }
  j.status=data.state==='paused'?'paused':'failed';j.error=note||'Execution failed; inspect the GitHub Actions run';
  // Bounded extra observation periods for delayed Actions. No repeat writes:
  // this outcome originates only from the runner's pre-write settlement loop.
  if(data.state==='paused'&&!a.writeIssued&&(j.automationRetries||0)<2){j.retryAt=Date.now()+90000;await this.watch(90000);}else j.retryAt=null;
  await this.save(j);return json(j);
 }
 async resume(j){if(!['paused','failed','awaiting-pr','running'].includes(j.status))throw Error('Job cannot be resumed');const a=j.attempt,t=await readToken(this.env);
  if(a?.runId){const run=await gh(t,repoRoute(this.env,this.env.CONTROLLER_REPO)+'/actions/runs/'+a.runId);if(run.status!=='completed')throw Error('The runner is still active');}else if(a&&Date.now()-a.createdAt<10*60000)throw Error('Dispatch may still be pending; wait until the ten-minute claim window expires');
  let r=j.records.find(x=>x.index===j.index);
  if(!r&&a?.writeIssued&&a.candidate){const repo=j.plan.updates[j.index].repository,b=repoRoute(this.env,repo);if(j.mode==='direct'){try{const c=await gh(t,b+'/compare/'+a.candidate.commit+'...main');if(['identical','ahead'].includes(c.status)){r={index:j.index,repository:repo,commit:a.candidate.commit,base:a.candidate.base,version:a.candidate.version,state:'published',startedAt:a.publishStartedAt,at:new Date().toISOString()};j.records.push(r);}}catch(e){if(!e.message.startsWith('GitHub 404 GET '))throw Error('Publication outcome cannot be verified. Do not retry blindly: '+e.message);await gh(t,b+'/git/ref/heads/main');}}else{const prs=await gh(t,b+'/pulls?state=all&head='+encodeURIComponent(this.env.GITHUB_OWNER+':gitmanager/'+j.id+'/'+j.index));const p=prs.find(x=>x.head.sha===a.candidate.commit);if(p){r={index:j.index,repository:repo,commit:a.candidate.commit,base:a.candidate.base,version:a.candidate.version,state:'pr',startedAt:a.publishStartedAt,at:new Date().toISOString(),pr:{number:p.number,url:p.html_url}};j.records.push(r);}else throw Error('PR publication uncertain; inspect gitmanager branch and run logs');}}
  if(r?.state==='pr'){const p=await gh(t,repoRoute(this.env,r.repository)+'/pulls/'+r.pr.number);if(!p.merged||!SHA.test(p.merge_commit_sha||''))throw Error('Merge the pull request on GitHub before resuming');const b=repoRoute(this.env,r.repository);let v=null;for(const file of ['package.json','VERSION']){try{const raw=decodeContent(await gh(t,b+'/contents/'+file+'?ref='+p.merge_commit_sha));v=file==='VERSION'?raw.trim():JSON.parse(raw).version;if(v)break;}catch{}}if(v!==r.version)throw Error('Merged PR has unexpected version; inspect manually');r.state='published';r.commit=p.merge_commit_sha;r.startedAt=p.merged_at;r.at=p.merged_at;}
  if(r?.state==='published'||r?.state==='validated'){j.index++;j.retries=0;await this.save(j);}j.automationRetries=0;
  return this.begin(j,j.mode==='export'?'export':j.index>=j.plan.updates.length?'settle':'update');
 }
}
