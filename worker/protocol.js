export const MAX_UPLOAD=12*1024*1024;
export const SHA=/^[0-9a-f]{40}$/;
export const HEX=/^[0-9a-f]{64}$/;
export const REPO=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function nextVersion(a,b){if(!VERSION.test(a)||!VERSION.test(b))return false;const [x,y,z]=a.split('.').map(BigInt),[i,j,k]=b.split('.').map(BigInt);return i===x&&j===y&&k===z+1n||i===x&&j===y+1n&&k===0n||i===x+1n&&j===0n&&k===0n;}
export function pathOK(p){return typeof p==='string'&&p.length<=512&&!p.includes('\\')&&!/[\x00-\x1f]/.test(p)&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&s.toLowerCase()!=='.git');}
// Bind a portable initial-publication manifest to the installed remote. The
// reviewed/stored plan retains the numeric ID; an explicit ID is never silently replaced.
export function bindInitialTarget(plan,repos){
 if(!Array.isArray(plan?.updates))return plan;
 return {...plan,updates:plan.updates.map(u=>{
  if(u?.kind!=='bootstrap')return u;
  const r=repos.find(r=>typeof u.repository==='string'&&r.name.toLowerCase()===u.repository.toLowerCase());
  if(!r||!Number.isSafeInteger(r.id)||r.id<=0||r.owner!==u.owner||r.private!==true||r.defaultBranch!=='main'||r.head)throw Error('Choose the matching empty private repository with default branch main. Refresh Repos if newly created.');
  if(u.repositoryId!=null&&u.repositoryId!==0&&u.repositoryId!==r.id)throw Error('Initial publication target identity changed; refresh and review the package.');
  return {...u,repository:r.name,repositoryId:r.id};
 })};
}
export function normalizePlan(plan,allowed,mode='direct'){
 if(plan?.schema!==1||!Array.isArray(plan.updates)||!plan.updates.length||plan.updates.length>16)throw Error('Manifest schema 1: 1–16 updates required');
 const seen=new Map(), names=new Map(allowed.map(n=>[n.toLowerCase(),n]));
 const repoName=n=>{if(typeof n!=='string'||!REPO.test(n)||!names.has(n.toLowerCase()))throw Error('Repository is not installed: '+String(n).slice(0,100));return names.get(n.toLowerCase());};
 const updates=plan.updates.map(u=>{
  const repository=repoName(u.repository);if(seen.has(repository)){if(mode!=='direct')throw Error('Successive repository updates require Direct mode');if(seen.get(repository)!==u.fromVersion)throw Error(repository+': successive updates require a continuous version chain');}
  if(u.branch&&u.branch!=='main')throw Error('Managed updates target main only');
  if(u.kind==='bootstrap'){
   if(plan.updates.length!==1||!['direct','dry'].includes(mode))throw Error('Initial publication requires a single repository in Direct or Dry run mode');
   if(u.fromVersion!=null||u.baseCommit!=null||!VERSION.test(u.toVersion||'')||!SHA.test(u.commit||'')||!SHA.test(u.tree||'')||!HEX.test(u.sha256||'')||!REPO.test(u.owner||'')||!Number.isSafeInteger(u.repositoryId)||u.repositoryId<=0||u.private!==true||u.policy!=='documentation'||!pathOK(u.patch)||!u.patch.endsWith('.bundle')||u.dependsOn?.length||Object.keys(u.submodulePins||{}).length||u.files?.length)throw Error('Invalid initial publication manifest: private documentation target, exact commit/tree, bundle checksum and repository identity required');
   return {repository,branch:'main',kind:'bootstrap',patch:u.patch,fromVersion:null,toVersion:u.toVersion,baseCommit:null,sha256:u.sha256,dependsOn:[],submodulePins:{},files:[],commit:u.commit,tree:u.tree,owner:u.owner,repositoryId:u.repositoryId,private:true,policy:'documentation',versionFile:'VERSION',message:''};
  }
  if(repository==='PWA-Architecture'&&mode==='pr')throw Error('Architecture updates use Direct or Dry run mode');
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
