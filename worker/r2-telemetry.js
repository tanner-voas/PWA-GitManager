import {createEvent} from './telemetry-schema.js';
// Measure attempted operations on GitManager's package bucket. Not billed usage,
// not a storage inventory; deletes do not infer bytes. Do not read object bodies.
export async function measuredR2(bucket,operation,args,capture,now=Date.now()){
 const started=Date.now();let value,failed=false;
 try{value=await bucket[{read:'get',write:'put',delete:'delete'}[operation]](...args);return value;}
 catch(e){failed=true;throw e;}
 finally{try{const input=args[1];const bytes=operation==='write'?(input instanceof ArrayBuffer||ArrayBuffer.isView(input)?input.byteLength:undefined):operation==='read'&&Number.isSafeInteger(value?.size)?value.size:undefined;
 const id=typeof args[0]==='string'?/^([a-f0-9-]{36})\/upload$/.exec(args[0])?.[1]:undefined;
 const event=createEvent('r2',operation,{app:'gitmanager',kind:'interval',coverage:'partial',outcome:failed?'error':operation==='read'&&!value?'unknown':'success',severity:failed?'error':'info',metrics:{requests:1,durationMs:Math.max(0,Date.now()-started),bytes},correlation:{jobId:id}},now);if(event)capture(event);}catch{}}
 }
