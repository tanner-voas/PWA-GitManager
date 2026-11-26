// Summarize only observed account aggregates, never add detailed archive events.
const fields=['requests','characters','cacheHits','prefetchRequests','successes','errors','cancelled'];
export function usageSummary(status,now=Date.now()){
 const day=new Date(now).toISOString().slice(0,10),month=day.slice(0,7)+'-01';
 const days=Object.entries(status?.regularUsage||{}).filter(([k,v])=>/^\d{4}-\d{2}-\d{2}$/.test(k)&&v&&typeof v==='object'&&k<=day);
 function range(start){const rows=days.filter(([k])=>k>=start).map(([,v])=>v);const sum=(xs,keys)=>{const result={};for(const k of keys){const values=xs.map(x=>x?.[k]).filter(v=>Number.isFinite(v)&&v>=0);if(values.length)result[k]=values.reduce((a,b)=>a+b,0);}return Object.keys(result).length?result:null;};return {start,end:day,days:rows.length,translate:sum(rows.map(r=>r.providers?.['google-translate']),fields),speech:sum(rows.map(r=>r.providers?.['azure-speech']),fields),drive:sum(rows,['driveCalls','backupCount'])};}
 return {today:range(day),month:range(month)};
}
