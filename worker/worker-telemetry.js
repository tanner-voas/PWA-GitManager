import pkg from '../package.json' with {type:'json'};
import {createEvent} from './telemetry-schema.js';
// Only selected, authenticated administrative POST operations. Never observe
// archive queries, telemetry control, static assets, polling, or credential routes.
export function workerRequestEvent(path,status,started,now=Date.now(),jobId=null){
 if(typeof path!=='string'||!Number.isInteger(status)||status<100||status>599)return null;
 const job=/^\/jobs\/([0-9a-f-]{36})\/(start|resume|cancel)$/.exec(path);
 if(!job&&!['/jobs','/exports'].includes(path))return null;
 return createEvent('cloudflare-worker','request',{app:'gitmanager',appVersion:pkg.version,coverage:'partial',status,outcome:status>=400?'error':'success',severity:status>=500?'error':status>=400?'warning':'info',metrics:{durationMs:Math.max(0,now-started),requests:1},correlation:{jobId:job?.[1]||jobId}},now);
}
