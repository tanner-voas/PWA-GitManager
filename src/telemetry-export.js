export const SOURCES=['google-drive','git-manager','git-runner','github-actions','repository','cloudflare-worker','r2','google-translate','azure-speech'];
export const MAX_PAGES=20,MAX_EVENTS=10240,MAX_BYTES=8*1024*1024;
const DAY=86400000;
export function localInput(ms,utc=false){const d=new Date(ms);return new Date(ms-(utc?0:d.getTimezoneOffset()*60000)).toISOString().slice(0,19);}
export function parseInput(value,utc=false){
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value))throw Error('Enter a valid date and time.');
 if(value.length===16)value+=':00';
 const d=new Date(value+(utc?'Z':'')),ms=d.getTime();if(!Number.isFinite(ms)||localInput(ms,utc)!==value)throw Error('Invalid or nonexistent time. Choose UTC if this is a clock change.');
 if(!utc)for(let m=-180;m<=180;m+=15)if(m&&localInput(ms+m*60000)===value)throw Error('Ambiguous local time at a clock change. Select UTC and enter the intended time.');
 return d.toISOString();
}
export function activityQuery(job,now=Date.now()){
 const created=Date.parse(job.createdAt);if(!Number.isFinite(created)||created>now)throw Error('Activity creation time unavailable');
 return {start:new Date(Math.max(created-300000,now-31*DAY)).toISOString(),end:new Date(now).toISOString(),sources:[...SOURCES],jobId:job.id};
}
export async function prepareArchive(query,{readPage,status=null,activity=null,zone='UTC',progress=()=>{},now=Date.now(),maxPages=MAX_PAGES,maxBytes=MAX_BYTES}={}){
 const byId=new Map(),chunks=[],issues=new Set(['archive-only: unarchived or uncollected records are not included','provider coverage is not guaranteed']),counts={},seenCursors=new Set();let after=null,duplicates=0,conflicts=0,bytes=0,pages=0,complete=false;
 if(!status||status.error)issues.add('status-unavailable');else {if(status.pending||status.producer?.pending)issues.add('pending-upload');if(!status.enabled)issues.add('collection-disabled');if(status.droppedEvents||status.producer?.dropped)issues.add('historical-drop-counters-nonzero');if(status.workflowCollector?.pendingDetails)issues.add('pending-workflow-details');if(status.workflowCollector?.truncated)issues.add('collector-coverage-limit');}
 if(activity&&Date.parse(activity.createdAt)<Date.parse(query.start))issues.add('activity-start-outside-query');
 for(;pages<maxPages;){let page;try{page=await readPage({...query,after});if(!page||!Array.isArray(page.events)||!Array.isArray(page.chunks)||!Array.isArray(page.issues))throw Error('bad response');}catch{issues.add('archive-read-unavailable');break;}
  pages++;for(const i of page.issues)issues.add(i);if(page.expiredRange)issues.add('requested-range-before-retention-window');if(!page.listedComplete)issues.add('archive-list-limit');
  // Do not claim the page was included when the output cap would cut it.
  const size=new TextEncoder().encode(JSON.stringify({events:page.events,chunks:page.chunks})).length;
  if(bytes+size>maxBytes||byId.size+page.events.length>MAX_EVENTS){issues.add('output-size-limit');break;}bytes+=size;
  chunks.push(...page.chunks);for(const event of page.events){const old=byId.get(event.eventId);if(old){duplicates++;const comparable=({ingestedAt,observedAt,...rest})=>JSON.stringify(rest);if(comparable(old)!==comparable(event))conflicts++;continue;}byId.set(event.eventId,event);}
  progress(pages,byId.size);if(!page.next){complete=true;break;}if(seenCursors.has(page.next)){issues.add('repeated-page-cursor');break;}seenCursors.add(page.next);after=page.next;
 }
 if(!complete&&pages>=maxPages)issues.add('page-limit');if(conflicts)issues.add('conflicting-event-ids-first-record-kept');
 const events=[...byId.values()].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId));for(const event of events){counts[event.source]=(counts[event.source]||0)+1;if(['partial','unavailable','truncated','stale','estimated'].includes(event.coverage))issues.add('source-records-have-limited-coverage');}
 if(!events.length)issues.add('no-matching-archived-events');for(const source of query.sources)if(!counts[source])issues.add('no-matching-events:'+source);if(chunks.some(c=>c.droppedEvents))issues.add('archive-chunks-report-drops');
 return {schema:1,kind:'workspace-telemetry-export',generatedAt:new Date(now).toISOString(),query:{...query,zone,semantics:'occurredAt >= start and occurredAt < end; interval records use recorded timestamp; job filter is exact jobId'},coverage:{partial:true,archiveScanComplete:complete&&!Array.from(issues).some(i=>/archive-list-limit|archive-not-found|chunk-unavailable|duplicate-chunk/.test(i)),pages,verifiedChunks:chunks.length,events:events.length,duplicates,conflicts,countsBySource:counts,issues:[...issues],note:'Live archive may change during paged reads; rerun to include late arrivals.'},status,activity,activityRelation:query.jobId?'direct jobId matches only':null,chunks,events};
}
