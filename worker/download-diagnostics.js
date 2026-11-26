// Bounded job diagnostics, not detailed Regular-mode telemetry. Never retain
// arbitrary error strings, provider URLs, credentials or browser identifiers.
const stages=['locating','downloading','verifying','ready'];
const outcomes=['pending','success','error','cancelled'];
export function recordDownload(rows,input,now=Date.now()){
 if(!input||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.id)||!stages.includes(input.stage)||!outcomes.includes(input.outcome)||!Number.isSafeInteger(input.sequence)||input.sequence<1||input.sequence>10)return null;
 const number=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
 if(!number(input.durationMs,86400000)||!number(input.bytes,256*1024*1024)||input.expected!==null&&!number(input.expected,1024**4))return null;
 const row={id:input.id,sequence:input.sequence,stage:input.stage,outcome:input.outcome,durationMs:input.durationMs,bytes:input.bytes,expected:input.expected,at:new Date(now).toISOString()};
 const existing=(rows||[]).find(x=>x.id===row.id);if(existing&&(existing.sequence>=row.sequence||existing.outcome!=='pending'))return {rows,changed:false};
 return {rows:[...(rows||[]).filter(x=>x.id!==row.id),row].slice(-12),changed:true};
}
