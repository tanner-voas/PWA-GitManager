import {createEvent} from './telemetry-schema.js';
const MIN=60000, KEY='telemetry:capture-lifecycle-v1';
const empty=()=>({ownerHash:null,capability:null,controlCapability:null,bound:false,manual:false,jobs:{},lastSnapshot:0,error:null});
const done=new Set(['completed','cancelled']);
const validJob=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const ok=x=>x&&!x.error;
/** Independent durable coordinator. No browser session or administrator cookie
 * is stored. Only the current archive capability can close its generation. */
export class CaptureLifecycle{
 constructor(storage,io){this.s=storage;this.io=io;}
 async state(){return {...empty(),...await this.s.get(KEY)};}
 async save(s){await this.s.put(KEY,s);}
 async arm(s,delay=Object.keys(s.jobs).length||!s.manual?MIN:5*MIN){if(s.capability||Object.keys(s.jobs).length)await this.s.setAlarm(Date.now()+delay);else await this.s.deleteAlarm?.();}
 public(s,archive){return {enabled:archive?.enabled===true,manual:archive?.enabled===true&&(s.capability?s.manual:true),jobCount:Object.keys(s.jobs).length,periods:archive?.capturePeriods||[],error:s.error,regularUsage:archive?.regularUsage||{}};}
 async snapshot(s,archive,jobId=null){
  const producer=await this.io.producer(),collector=await this.io.collector();
  const event=createEvent('git-manager','status',{app:'gitmanager',kind:'snapshot',outcome:'success',correlation:{jobId:jobId||Object.keys(s.jobs)[0]},diagnostics:{archive,producer,collector,manual:s.manual,jobCount:Object.keys(s.jobs).length}});
  if(!event)throw Error('Invalid status snapshot');const result=await this.io.append(s.capability,[event]);if(result?.accepted+result?.duplicates!==1||result.rejected)throw Error('Status snapshot not accepted');s.lastSnapshot=Date.now();await this.save(s);
 }
 async activate(s,session){
  const archive=await this.io.session(session,'managed-enable');if(!ok(archive)||!archive.capability||!archive.controlCapability)throw Error('Telemetry authorization unavailable');
  s.capability=archive.capability;s.controlCapability=archive.controlCapability;s.bound=false;s.error=null;await this.save(s);await this.arm(s);
  await this.ensureBound(s);
  // A diagnostic failure must not prevent the capture from continuing.
  try{await this.snapshot(s,archive);}catch{s.error='status-snapshot-unavailable';await this.save(s);}
  return archive;
 }
 async ensureBound(s){if(!s.bound){await this.io.bind(s.capability);await this.io.ensure();s.bound=true;await this.save(s);}}
 async pruneJobs(s){let last=null;for(const [id,at] of Object.entries(s.jobs)){const j=await this.io.job(id);if(done.has(j?.status)||(!j&&Date.now()-at>2*MIN)||(j?.status==='draft'&&Date.now()-at>2*MIN)){delete s.jobs[id];last=id;s.lastJob=id;if(j?.terminalCaptureEvents?.length)s.terminalEvents=[...(s.terminalEvents||[]),...j.terminalCaptureEvents].slice(-32);}}await this.save(s);return last;}
 async drain(s,{disable=false,lastJob=s.lastJob||null}={}){
  const cap=s.capability,control=s.controlCapability;if(!cap||!control)return false;
  // Stop producer discovery before taking the shutdown gate; accepted records
  // are drained before the generation is revoked. Flush alone never pauses it.
  let gated=false,closed=false;
  try{
   await this.ensureBound(s);if(disable)await this.io.stop(cap);
   if(disable){await this.io.gate(true);gated=true;}
   const before=await this.io.control(control,'status');if(!ok(before))throw Error('Archive unavailable');
   // Snapshot before draining; if the archive is full, drain then retry it.
   let first=await this.io.control(control,'drain');if(!ok(first)||first.pending!==0||first.drainBlocked)throw Error('Archive upload incomplete');
   if(s.terminalEvents?.length){const r=await this.io.append(cap,s.terminalEvents);if(r?.accepted+r?.duplicates!==s.terminalEvents.length||r.rejected)throw Error('Terminal telemetry not accepted');s.terminalEvents=[];await this.save(s);}
   await this.snapshot(s,before,Object.keys(s.jobs)[0]||lastJob||s.lastJob);
   const producer=await this.io.drainProducer();if(producer.pending!==0)throw Error('Producer upload incomplete');
   const final=await this.io.control(control,disable?'disable':'drain');if(!ok(final)||final.pending!==0||final.drainBlocked||final.enabled!==!disable)throw Error('Archive upload incomplete');
   if(disable){closed=true;await this.io.clear(cap);s.capability=null;s.controlCapability=null;s.bound=false;}
   s.error=null;if(disable)s.lastJob=null;await this.save(s);return true;
  }catch{s.error='upload-incomplete';await this.save(s);return false;}
  finally{if(gated)try{await this.io.gate(false);}catch{}if(disable&&!closed)try{await this.io.ensure();}catch{}await this.arm(s);}
 }
 async request(action,session,id){
  const owner=await this.io.session(session,'checkpoint-owner');if(!/^[a-f0-9]{64}$/.test(owner?.ownerHash||''))throw Error('Connect Google Drive');
  let s=await this.state(),archive=await this.io.session(session,'status');if(!ok(archive))throw Error('Telemetry status unavailable');
  if(s.ownerHash!==owner.ownerHash){s=empty();s.ownerHash=owner.ownerHash;await this.save(s);}
  // Existing captures from R8 are manual until their owner explicitly disables.
  if(archive.enabled&&!s.capability){s.manual=true;await this.save(s);if(action!=='status')archive=await this.activate(s,session);else{try{archive=await this.activate(s,session);}catch{s.error='capture-adoption-unavailable';await this.save(s);}}}
  if(!archive.enabled&&s.capability){try{await this.io.stop(s.capability);await this.io.clear(s.capability);}catch{}s.capability=null;s.controlCapability=null;s.bound=false;s.manual=false;s.jobs={};await this.save(s);}
  if(action==='status')return this.public(s,archive);
  if(action==='job-start'){
   if(!validJob(id))throw Error('Invalid job');const last=await this.pruneJobs(s);
   // A new job following a completed auto-capture starts its own period, unless
   // an upload failure prevented the preceding capture from closing.
   if(s.capability&&!s.manual&&!Object.keys(s.jobs).length){await this.drain(s,{disable:true,lastJob:last});}
   s.jobs[id]=Date.now();await this.save(s);if(!s.capability)archive=await this.activate(s,session);await this.arm(s);return this.public(s,archive);
  }
  if(action==='enable'){s.manual=true;await this.save(s);if(!s.capability)archive=await this.activate(s,session);await this.arm(s);return this.public(s,archive);}
  if(action==='disable'){s.manual=false;await this.save(s);await this.pruneJobs(s);if(Object.keys(s.jobs).length){if(s.capability)await this.drain(s);return this.public(s,await this.io.session(session,'status'));}if(s.capability&&!await this.drain(s,{disable:true}))throw Error('Upload incomplete. Telemetry remains enabled; retry.');return this.public(s,await this.io.session(session,'status'));}
  if(action==='flush'){if(s.capability&&!await this.drain(s))throw Error('Upload incomplete. Retry force update.');return this.public(s,await this.io.session(session,'status'));}
  throw Error('Unknown telemetry control');
 }
 async tick(){const s=await this.state();if(!s.capability){await this.arm(s);return;}await this.arm(s);try{
   await this.ensureBound(s);const archive=await this.io.control(s.controlCapability,'status');if(!ok(archive)){if(archive?.error==='Telemetry capability revoked'||archive?.error==='Telemetry capability expired or invalid'){await this.io.stop(s.capability);await this.io.clear(s.capability);s.capability=null;s.controlCapability=null;s.bound=false;s.manual=false;s.jobs={};s.error='authorization-unavailable';await this.save(s);await this.arm(s);}return;}
   const last=await this.pruneJobs(s);if(!s.manual&&!Object.keys(s.jobs).length){await this.drain(s,{disable:true,lastJob:last});return;}
   if(Date.now()-s.lastSnapshot>=5*MIN)await this.snapshot(s,archive);
  }catch{s.error='status-snapshot-unavailable';await this.save(s);}}
}
