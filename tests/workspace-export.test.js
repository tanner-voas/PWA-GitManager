import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,deflateRawSync,crc32} from 'node:zlib';
import {readExportResponse,unwrapWorkspaceExport,MAX_WORKSPACE_BYTES} from '../src/workspace-export.js';
const payload=gzipSync(Buffer.from('synthetic workspace tar payload'));
function zip(entries,{comment='',disk=0}={}){
 let offset=0;const local=[],central=[];
 for(const entry of entries){
  const name=Buffer.from(entry.name??'workspace.tar.gz'),raw=entry.data??payload,method=entry.method??0,flags=entry.flags??0,compressed=method===8?deflateRawSync(raw):raw;
  const crc=entry.crc??crc32(raw),size=entry.size??raw.length;
  const h=Buffer.alloc(30),c=Buffer.alloc(46);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(flags,6);h.writeUInt16LE(method,8);h.writeUInt16LE(name.length,26);
  if(!(flags&8)){h.writeUInt32LE(crc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(size,22);}
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(flags,8);c.writeUInt16LE(method,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(size,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
  const descriptor=Buffer.alloc(flags&8?16:0);if(flags&8){descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(compressed.length,8);descriptor.writeUInt32LE(size,12);}
  local.push(h,name,compressed,descriptor);central.push(c,name);offset+=h.length+name.length+compressed.length+descriptor.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22),suffix=Buffer.from(comment);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(disk,4);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(suffix.length,20);return Buffer.concat([...local,directory,end,suffix]);
}
for(const [method,flags] of [[0,0],[8,0],[8,8]])test(`unwrap exact original gzip bytes (method ${method}, flags ${flags})`,async()=>{const b=zip([{name:'export.json',data:Buffer.from('{}')},{method,flags}],{comment:'archive comment'});const out=await unwrapWorkspaceExport(await readExportResponse(new Response(b)));assert.equal(out.type,'application/gzip');assert.deepEqual(Buffer.from(await out.arrayBuffer()),payload);});
test('reject missing, duplicate, encrypted, split, wrong format and corrupt members',async()=>{for(const b of [zip([{name:'../workspace.tar.gz'}]),zip([{},{}]),zip([{flags:1}]),zip([{}],{disk:1}),zip([{data:Buffer.from('not a gzip archive')}]),zip([{crc:42}]),zip([{method:8,size:payload.length+1}]),zip([{method:8,size:payload.length-1}]),Buffer.from('not a ZIP')])await assert.rejects(unwrapWorkspaceExport(new Blob([b])),/Invalid or unsupported/);});
test('reject mismatched local file name and corrupt directory offsets',async()=>{const b=zip([{}]);b[30]=0x78;await assert.rejects(unwrapWorkspaceExport(new Blob([b])),/Invalid or unsupported/);const c=zip([{}]);c.writeUInt32LE(0xffffffff,c.length-22+16);await assert.rejects(unwrapWorkspaceExport(new Blob([c])),/Invalid or unsupported/);});
test('size guard rejects oversized declaration and cancels oversized HTTP response',async()=>{await assert.rejects(unwrapWorkspaceExport(new Blob([zip([{size:MAX_WORKSPACE_BYTES+1}])])),/256 MiB/);let cancelled=false;const stream=new ReadableStream({cancel(){cancelled=true;}});await assert.rejects(readExportResponse(new Response(stream,{headers:{'content-length':String(MAX_WORKSPACE_BYTES+1)}})),/256 MiB/);assert.equal(cancelled,true);});
test('streaming size guard works without Content-Length',async()=>{const piece=new Uint8Array(1024*1024);let remaining=257,cancelled=false;const stream=new ReadableStream({pull(c){if(remaining--)c.enqueue(piece);else c.close();},cancel(){cancelled=true;}});await assert.rejects(readExportResponse(new Response(stream)),/256 MiB/);assert.equal(cancelled,true);});
