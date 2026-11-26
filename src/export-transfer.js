import {readExportResponse,unwrapWorkspaceExport,abortable} from './workspace-export.js';
// Both a stalled stream and a stalled header request are bounded. The deadline
// is reset only by actual progress, never by an animation or polling timer.
export async function prepareWorkspaceTransfer(fetchArchive,{signal,progress=()=>{},idleMs=60000,totalMs=300000}={}){
 const controller=new AbortController();let idle,total,stage='locating',bytes=0,expected=null;
 const stop=()=>controller.abort(signal.reason||new DOMException('Preparation cancelled','AbortError'));
 if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
 const timeout=()=>controller.abort(new Error(stage==='verifying'?'Archive verification timed out. Retry sharing or use Actions artifacts.':'Archive download timed out. Retry sharing or use Actions artifacts.'));
 const touch=()=>{clearTimeout(idle);idle=setTimeout(timeout,idleMs);};
 const update=(next,n=bytes,size=expected)=>{stage=next;bytes=n;expected=size;touch();progress({stage,bytes,expected});};
 try{
  total=setTimeout(timeout,totalMs);update('locating');controller.signal.throwIfAborted();
  const response=await abortable(fetchArchive(controller.signal),controller.signal);
  if(!response.ok)throw Error('Workspace archive unavailable (HTTP '+response.status+'). Retry sharing or use Actions artifacts.');
  const length=Number(response.headers.get('content-length'));update('downloading',0,Number.isSafeInteger(length)&&length>0?length:null);
  const zip=await readExportResponse(response,{signal:controller.signal,onProgress:n=>update('downloading',n)});
  update('verifying',zip.size);
  const archive=await abortable(unwrapWorkspaceExport(zip,{signal:controller.signal,onProgress:()=>touch()}),controller.signal);
  controller.signal.throwIfAborted();progress({stage:'ready',bytes,expected});return archive;
 }finally{clearTimeout(idle);clearTimeout(total);signal?.removeEventListener('abort',stop);}
}
