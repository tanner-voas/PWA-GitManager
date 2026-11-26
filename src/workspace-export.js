export function abortable(promise,signal){if(!signal)return promise;if(signal.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(signal.reason);}return new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));});}

// GitHub Actions transports the runner's tar.gz inside a ZIP. Unwrap only that
// exact member; never extract paths or recompress repository contents.
export const MAX_WORKSPACE_BYTES=256*1024*1024;
const MAX_DIRECTORY_BYTES=1024*1024;
const MEMBER='workspace.tar.gz';
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
function crcUpdate(crc,bytes){for(const b of bytes)crc=(crc>>>8)^crcTable[(crc^b)&255];return crc;}
const invalid=()=>new Error('Invalid or unsupported Actions export ZIP. The original artifact is still available via the Actions artifacts button.');
const tooLarge=()=>new Error('Export exceeds the 256 MiB in-app preparation limit. Export fewer repositories at a time or use the Actions artifacts button.');
async function readBlob(stream,limit,type,{crc=false,retain=true,signal,onProgress=()=>{}}={}){
 const reader=stream.getReader();let size=0,sum=0xffffffff;const chunks=[];
 try{for(;;){const {done,value}=await abortable(reader.read(),signal);if(done)break;size+=value.byteLength;if(size>limit)throw tooLarge();if(crc)sum=crcUpdate(sum,value);if(retain)chunks.push(value);onProgress(size);}}
 catch(err){try{void reader.cancel().catch(()=>{});}catch{}throw err;}finally{reader.releaseLock();}
 return {blob:retain?new Blob(chunks,{type}):null,size,crc:(sum^0xffffffff)>>>0};
}
export async function readExportResponse(response,options={}){
 const length=Number(response.headers.get('content-length'));if(length>MAX_WORKSPACE_BYTES){try{void response.body?.cancel().catch(()=>{});}catch{}throw tooLarge();}
 if(!response.body)throw invalid();
 return (await readBlob(response.body,MAX_WORKSPACE_BYTES,'application/zip',options)).blob;
}
async function bytesAt(blob,start,size){if(!Number.isSafeInteger(start)||!Number.isSafeInteger(size)||start<0||size<0||start+size>blob.size)throw invalid();return new Uint8Array(await blob.slice(start,start+size).arrayBuffer());}
const view=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const u16=(v,p)=>v.getUint16(p,true),u32=(v,p)=>v.getUint32(p,true);
const decoder=new TextDecoder('utf-8',{fatal:true});
function nameAt(b,start,size){try{return decoder.decode(b.subarray(start,start+size));}catch{throw invalid();}}
export async function unwrapWorkspaceExport(blob,options={}){
 if(blob.size>MAX_WORKSPACE_BYTES)throw tooLarge();if(blob.size<22)throw invalid();
 const tailStart=Math.max(0,blob.size-65557),tail=await bytesAt(blob,tailStart,blob.size-tailStart),tv=view(tail);let end=-1;
 for(let i=tail.length-22;i>=0;i--)if(u32(tv,i)===0x06054b50&&i+22+u16(tv,i+20)===tail.length){end=i;break;}
 if(end<0)throw invalid();
 const count=u16(tv,end+10),dirSize=u32(tv,end+12),dirOffset=u32(tv,end+16),eocd=tailStart+end;
 // Bounded ordinary ZIP. Explicitly reject split and ZIP64 containers rather than guessing offsets.
 if(u16(tv,end+4)||u16(tv,end+6)||u16(tv,end+8)!==count||!count||count>64||dirSize>MAX_DIRECTORY_BYTES||dirOffset+dirSize!==eocd)throw invalid();
 const dir=await bytesAt(blob,dirOffset,dirSize),dv=view(dir);let p=0,entry=null;
 for(let i=0;i<count;i++){
  if(p+46>dir.length||u32(dv,p)!==0x02014b50)throw invalid();
  const n=u16(dv,p+28),x=u16(dv,p+30),c=u16(dv,p+32),next=p+46+n+x+c;
  if(next>dir.length||u16(dv,p+34))throw invalid();
  const name=nameAt(dir,p+46,n);
  if(name===MEMBER){if(entry)throw invalid();entry={flags:u16(dv,p+8),method:u16(dv,p+10),crc:u32(dv,p+16),compressed:u32(dv,p+20),size:u32(dv,p+24),offset:u32(dv,p+42)};}
  p=next;
 }
 if(p!==dir.length||!entry)throw invalid();
 if(entry.size>MAX_WORKSPACE_BYTES||entry.compressed>MAX_WORKSPACE_BYTES)throw tooLarge();
 if(entry.size<18||(entry.flags&~0x080e)||![0,8].includes(entry.method)||entry.offset+30>dirOffset)throw invalid();
 const local=await bytesAt(blob,entry.offset,30),lv=view(local);
 if(u32(lv,0)!==0x04034b50||u16(lv,6)!==entry.flags||u16(lv,8)!==entry.method)throw invalid();
 const nameLength=u16(lv,26),extra=u16(lv,28),start=entry.offset+30+nameLength+extra;
 if(start+entry.compressed>dirOffset||nameLength!==MEMBER.length||nameAt(await bytesAt(blob,entry.offset+30,nameLength),0,nameLength)!==MEMBER)throw invalid();
 if(!(entry.flags&8)&&(u32(lv,14)!==entry.crc||u32(lv,18)!==entry.compressed||u32(lv,22)!==entry.size))throw invalid();
 const member=blob.slice(start,start+entry.compressed,'application/gzip');let payload,check;
 if(entry.method===0){if(entry.compressed!==entry.size)throw invalid();payload=member;check=await readBlob(member.stream(),entry.size,'application/gzip',{...options,crc:true,retain:false});}
 else{
  if(typeof DecompressionStream!=='function')throw Error('This browser cannot unwrap a compressed Actions artifact. Use Actions artifacts or a supported browser.');
  try{check=await readBlob(member.stream().pipeThrough(new DecompressionStream('deflate-raw')),entry.size,'application/gzip',{...options,crc:true});}catch(err){if(options.signal?.aborted)throw options.signal.reason;throw invalid();}payload=check.blob;
 }
 if(check.size!==entry.size||check.crc!==entry.crc)throw invalid();
 const magic=await bytesAt(payload,0,3);if(magic[0]!==0x1f||magic[1]!==0x8b||magic[2]!==8)throw invalid();
 return payload;
}
