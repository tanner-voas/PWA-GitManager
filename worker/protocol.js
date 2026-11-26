export const MAX_UPLOAD=12*1024*1024;
export const SHA=/^[0-9a-f]{40}$/;
export const HEX=/^[0-9a-f]{64}$/;
export const REPO=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function nextVersion(a,b){if(!VERSION.test(a)||!VERSION.test(b))return false;const [x,y,z]=a.split('.').map(BigInt),[i,j,k]=b.split('.').map(BigInt);return i===x&&j===y&&k===z+1n||i===x&&j===y+1n&&k===0n||i===x+1n&&j===0n&&k===0n;}
export function pathOK(p){return typeof p==='string'&&p.length<=512&&!p.includes('\\')&&!/[\x00-\x1f]/.test(p)&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&s.toLowerCase()!=='.git');}
export function normalizePlan(plan,allowed,mode='direct'){
 if(plan?.schema!==1||!Array.isArray(plan.updates)||!plan.updates.length||plan.updates.length>16)throw Error('Manifest schema 1: 1–16 updates required');
 const seen=new Map(), names=new Map(allowed.map(n=>[n.toLowerCase(),n]));
 const repoName=n=>{if(typeof n!=='string'||!REPO.test(n)||!names.has(n.toLowerCase()))throw Error('Repository is not installed: '+String(n).slice(0,100));return names.get(n.toLowerCase());};
 const updates=plan.updates.map(u=>{
  const repository=repoName(u.repository);if(seen.has(repository)){if(mode!=='direct')throw Error('Successive repository updates require Direct mode');if(seen.get(repository)!==u.fromVersion)throw Error(repository+': successive updates require a continuous version chain');}
  if(u.branch&&u.branch!=='main')throw Error('Managed updates target main only');
  if(!nextVersion(u.fromVersion,u.toVersion))throw Error(repository+': invalid version increment');
  const kind=u.kind||'patch';if(!['patch','diff','files','revert','bundle'].includes(kind))throw Error('Unsupported update kind');
  const dependsOn=(u.dependsOn||[]).map(repoName);if(dependsOn.includes(repository))throw Error('A repository cannot depend on itself; successive steps are implicit');if(dependsOn.some(d=>!seen.has(d)))throw Error('Dependencies must appear earlier in the package');
  const submodulePins={};for(const [path,raw] of Object.entries(u.submodulePins||{})){if(!pathOK(path))throw Error('Invalid submodule path');const n=repoName(raw);if(n===repository||!dependsOn.includes(n))throw Error('Pins must name a preceding dependency');submodulePins[path]=n;}
  if(u.baseCommit&&!SHA.test(u.baseCommit))throw Error('Invalid baseCommit');
  if(u.sha256&&!HEX.test(u.sha256))throw Error('Invalid patch checksum');
  const patch=u.patch??'upload';if(!pathOK(patch))throw Error('Invalid archive member');
  const files=(u.files||[]).map(f=>{if(!pathOK(f.path)||!['put','delete'].includes(f.operation)||f.operation==='put'&&!pathOK(f.member))throw Error('Invalid file operation');return {path:f.path,operation:f.operation,member:f.member};});
  if(kind==='files'&&(!files.length||files.length>100))throw Error('1–100 file operations required');
  if(kind==='revert'&&!SHA.test(u.commit||''))throw Error('Full revert commit SHA required');
  const versionFile=u.versionFile||null;if(versionFile&&!['VERSION','package.json'].includes(versionFile))throw Error('Unsupported versionFile');
  seen.set(repository,u.toVersion);return {repository,branch:'main',kind,patch,fromVersion:u.fromVersion,toVersion:u.toVersion,baseCommit:u.baseCommit||null,sha256:u.sha256||null,dependsOn,submodulePins,files,commit:u.commit||null,versionFile,message:String(u.message||'').slice(0,300)};
 });
 return {schema:1,title:String(plan.title||'Repository update').slice(0,150),updates};
}
export function json(data,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
export const fail=(message,status=400)=>json({error:message},status);
export async function digest(buf){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buf)),b=>b.toString(16).padStart(2,'0')).join('');}
export function constantEqual(a,b){if(!a||!b)return false;let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0;}
