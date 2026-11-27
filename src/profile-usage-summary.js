const ID=/^[A-Za-z0-9_-]{1,80}$/;
export const fields=['translateRequests','translateCharacters','speechRequests','speechCharacters','speechCacheHits','driveCalls'];
// Merge local and synchronized snapshots by writer/profile/day, not by summing
// both copies. Local-only rows are shown separately and never cross accounts.
export function profileUsageSummary(remote,local=[],registry=null,now=Date.now()){
 const today=new Date(now).toISOString().slice(0,10),month=today.slice(0,7)+'-01',scope=remote?.scope,known=new Map((Array.isArray(registry?.profiles)?registry.profiles:[]).filter(p=>ID.test(p?.id||'')).map(p=>[p.id,p.name]));const map=new Map();
 function ingest(r,local){if(!ID.test(r?.profile||'')||!ID.test(r?.writer||'')||typeof r.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||r.day<month||r.day>today)return;if(local&&(r.scope!==scope&&!(r.scope==='local-only'&&known.has(r.profile))))return;if(local&&!scope&&r.scope!=='local-only')return;const only=local&&r.scope==='local-only',key=[only?'local':'cloud',r.profile,r.day,r.writer].join(':'),old=map.get(key)||{profile:r.profile,day:r.day,only,counts:{},pending:false};for(const f of fields){const v=r.counts?.[f];if(Number.isSafeInteger(v)&&v>=0&&v<=1e9){if(local&&v>(old.counts[f]||0))old.pending=true;old.counts[f]=Math.max(old.counts[f]||0,v);}}map.set(key,old);}
 if(scope&&Array.isArray(remote.rows))for(const r of remote.rows)ingest(r,false);for(const r of local)ingest(r,true);
 const profiles=new Map([...known].map(([id,name])=>[id,{id,name,today:{},month:{},localOnly:{},pending:false}]));
 for(const r of map.values()){const p=profiles.get(r.profile)||{id:r.profile,name:'Profile '+r.profile.slice(0,8),today:{},month:{},localOnly:{},pending:false};for(const [k,v] of Object.entries(r.counts)){if(r.only){p.localOnly[k]=(p.localOnly[k]||0)+v;continue;}p.month[k]=(p.month[k]||0)+v;if(r.day===today)p.today[k]=(p.today[k]||0)+v;}p.pending||=r.pending;profiles.set(r.profile,p);}
 return [...profiles.values()].sort((a,b)=>Number(b.id===registry?.active)-Number(a.id===registry?.active)||String(a.name).localeCompare(String(b.name)));
}
export function readProfileLocal(storage=globalThis.localStorage){const rows=[];let registry=null;try{registry=JSON.parse(storage.getItem('pwa.profiles.v1'));for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith('pwa.profile.usage.v1:'))continue;try{rows.push(JSON.parse(storage.getItem(key)));}catch{}}}catch{}return {rows,registry};}
