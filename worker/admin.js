import {constantEqual} from './protocol.js';
const enc=new TextEncoder(),name='pwa_git_admin',seconds=1800;
const b64=a=>btoa(String.fromCharCode(...new Uint8Array(a))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const validEnv=e=>String(e.ADMIN_UNLOCK||'').length>=24&&String(e.RUNNER_SECRET||'').length>=32;
async function signature(env,origin,payload){const key=await crypto.subtle.importKey('raw',enc.encode(JSON.stringify([env.ADMIN_UNLOCK,env.RUNNER_SECRET])),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64(await crypto.subtle.sign('HMAC',key,enc.encode(JSON.stringify([origin,String(env.ADMIN_EMAIL||'').toLowerCase(),payload]))));}
export const sameOrigin=req=>req.headers.get('Origin')===new URL(req.url).origin&&req.headers.get('X-PWA-CSRF')==='1';
export async function adminStatus(req,env,now=Math.floor(Date.now()/1000)){
 if(!validEnv(env))return {unlocked:false};
 const value=(req.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
 const m=/^(\d{10})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);if(!m)return {unlocked:false};
 const expiry=Number(m[1]);if(expiry<=now||expiry>now+seconds)return {unlocked:false};
 if(!constantEqual(m[3],await signature(env,new URL(req.url).origin,m[1]+'.'+m[2])))return {unlocked:false};
 return {unlocked:true,expiresAt:new Date(expiry*1000).toISOString()};
}
const cookie=(value,age)=>`${name}=${value}; Path=/_git/v1/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;
export async function unlockAdmin(req,env){
 if(!validEnv(env))return null;
 let body;try{body=await req.json();}catch{return null;}
 if(typeof body?.password!=='string'||body.password.length>512||!constantEqual(body.password,env.ADMIN_UNLOCK))return null;
 const expiry=Math.floor(Date.now()/1000)+seconds,payload=expiry+'.'+crypto.randomUUID();
 return {cookie:cookie(payload+'.'+await signature(env,new URL(req.url).origin,payload),seconds),expiresAt:new Date(expiry*1000).toISOString()};
}
export const lockCookie=()=>cookie('',0);
