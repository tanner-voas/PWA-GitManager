import test from 'node:test';import assert from 'node:assert/strict';
import {profileUsageSummary,profilePipelineReport,readProfileLocal} from '../src/profile-usage-summary.js';
const now=Date.parse('2026-11-28T01:00Z'),day='2026-11-28';
const row=(scope,profile,writer,n,acked=false)=>({scope,profile,writer,day,counts:{speechCharacters:n},acked});
const registry={active:'profile-private',profiles:[{id:'profile-private',name:'Private name'}]};
test('cloud, unsynchronized and unlinked totals remain separate and never double count',()=>{
 const remote={scope:'account-private',rows:[row('account-private','profile-private','writer-private',5)]};
 const rows=[row('account-private','profile-private','writer-private',7,true),row('account-private','profile-private','other',2),row('local-only','profile-private','writer-private',4),row('other-account','profile-private','writer-private',999)];
 const [p]=profileUsageSummary(remote,rows,registry,now);assert.equal(p.month.speechCharacters,9);assert.equal(p.cloud.speechCharacters,5);assert.equal(p.unsynced.speechCharacters,4);assert.equal(p.localOnly.speechCharacters,4);assert(p.pending);
 const r=profilePipelineReport(remote,{rows,invalid:0,storageAvailable:true},registry,{state:'up-to-date',uploaded:0,scope:'secret'},now);assert.equal(r.pendingLocalSnapshots,2);assert.equal(r.cloudSnapshots,1);assert.equal(r.unlinkedLocalSnapshots,1);assert(!/account-private|profile-private|writer-private|Private name|other-account|secret|999/.test(JSON.stringify(r)));
});
test('remote rows without scope from existing backend are counted; foreign local rows and failed cloud lookups are not',()=>{
 const cloud=row('account-private','profile-private','writer-private',5);delete cloud.scope;assert.equal(profileUsageSummary({scope:'account-private',rows:[cloud]},[],registry,now)[0].cloud.speechCharacters,5);const p=profileUsageSummary(null,[row('account-private','profile-private','writer-private',9)],registry,now)[0];assert.deepEqual(p.month,{});assert.deepEqual(p.cloud,{});
});
test('malformed local entries do not prevent other snapshots from being read',()=>{const m=new Map([['pwa.profile.usage.v1:bad','null'],['pwa.profile.usage.v1:good',JSON.stringify(row('a','p','w',3))]]);const local=readProfileLocal({getItem:k=>m.get(k)??null,get length(){return m.size;},key:i=>[...m.keys()][i]});assert.equal(local.invalid,1);assert.equal(local.rows.length,1);});
