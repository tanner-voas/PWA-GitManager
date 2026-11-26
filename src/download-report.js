// Terminal diagnostics are acknowledged before returning to the share UI.
// Same sequence on retry is idempotent. No diagnostic error blocks the archive.
export async function submitDownloadDiagnostic(send,{terminal=false,timeoutMs=4000}={}){
 for(let n=0;n<(terminal?2:1);n++){
  const c=new AbortController();let timer;
  try{const response=await Promise.race([Promise.resolve().then(()=>send(c.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{c.abort();reject(Error('diagnostic timeout'));},timeoutMs);})]);if(response?.ok)return true;if(response&&response.status>=400&&response.status<500&&response.status!==429)return false;}catch{}finally{clearTimeout(timer);}
 }return false;
}
