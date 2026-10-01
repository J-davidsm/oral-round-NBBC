import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../score-sync.js',import.meta.url),'utf8');
const round=(id,division='primary',score=100)=>({id,date:'2026-10-01T12:00:00Z',division,score,possible:300,timeLeftSec:60,details:[]});
function server() {
  const histories=new Map();const links=new Map();let count=1234567;
  const history=key=>{if(!histories.has(key)) histories.set(key,new Map());return histories.get(key);};
  return {histories,fetchFor(network){return async(url,options={})=>{
    const parsed=new URL(url);const code=options.headers?.['X-Score-Link'];
    if(code&&!links.has(code))return {ok:false,status:403};
    const key=code?links.get(code):network;const rows=history(key);
    let body;
    if(parsed.pathname==='/device-link') {const code=String(count++).padStart(8,'0');links.set(code,key);body={code};}
    else if(options.method==='POST') {const r=JSON.parse(options.body);if(!rows.has(r.id))rows.set(r.id,r);body={saved:true};}
    else body={rounds:[...rows.values()].filter(r=>r.division===parsed.searchParams.get('division')),next:null};
    return {ok:true,json:async()=>JSON.parse(JSON.stringify(body))};
  };}};
}
function client(records,fetch,url='https://scores.example',startup=false) {
  const storage=new Map([['oralRounds',JSON.stringify(records)]]);let interval;
  const context={SCORE_API_URL:url,addEventListener:()=>{},dispatchEvent:()=>{},setInterval:fn=>{interval=fn;},Event,AbortSignal,crypto,fetch,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}};
  context.window=context;vm.runInNewContext(startup?source:source.split('// Opening the site')[0],context);
  return {api:context.ScoreSync,storage,tick:()=>interval?.()};
}
test('score display reads local storage even when the network is unavailable',async()=>{
  const {api}=client([round('a'),round('b','junior')],async()=>{throw new Error('offline');});
  assert.equal((await api.list('primary')).rounds.length,1);
  await assert.rejects(api.sync());assert.equal(api.local().length,2);
});
test('empty remote history never replaces saved local scores',async()=>{
  const {api}=client([round('a')],async(url,opt)=>({ok:true,json:async()=>opt.method==='POST'?{saved:true}:{rounds:[],next:null}}));
  await api.sync();assert.equal(api.local()[0].score,100);
});
test('two devices with different IPs merge both histories into both local stores',async()=>{
  const service=server();const a=client([round('a'),round('b','junior',285)],service.fetchFor('A'));
  const b=client([round('c','senior',225)],service.fetchFor('B'));
  const code=await a.api.createDeviceCode();assert.match(code,/^\d{8}$/);
  await b.api.linkDevice(code);await a.api.sync();
  for(const device of [a,b]) {
    assert.equal(device.api.local().length,3);
    assert.equal((await device.api.list('junior')).rounds[0].score,285);
    assert.ok(device.storage.get('oralRoundsBeforeMerge'));
  }
  await a.api.sync();await b.api.sync();assert.equal(a.api.local().length,3);assert.equal(b.api.local().length,3);
});
test('merge preserves original passage marks and rounds added while syncing',async()=>{
  const service=server();const {api,storage}=client([{...round('a'),details:[{ref:'John 1:1',wrongIndices:[2],points:20,errors:1}]}],service.fetchFor('A'));
  api.mergeRounds([{...round('a'),details:[]},round('b')]);
  assert.equal(api.local()[0].details[0].wrongIndices[0],2);
  const pending=api.sync();const current=JSON.parse(storage.get('oralRounds'));current.push(round('c'));storage.set('oralRounds',JSON.stringify(current));
  await pending;assert.equal(api.local().length,3);
});
test('invalid code does not change local scores or existing link',async()=>{
  const service=server();const {api,storage}=client([round('a')],service.fetchFor('A'));
  const code=await api.createDeviceCode();await assert.rejects(api.linkDevice('99999999'));
  assert.equal(storage.get('oralRoundDeviceCode'),code);assert.equal(api.local().length,1);
});
test('malformed storage is not overwritten by remote rounds',async()=>{
  const {api,storage}=client([],server().fetchFor('A'));storage.set('oralRounds','broken');
  assert.throws(()=>api.mergeRounds([round('a')]));await assert.rejects(api.sync());assert.equal(storage.get('oralRounds'),'broken');
});
test('startup and subsequent background sync copy remote history to local storage',async()=>{
  const service=server();const a=client([round('a')],service.fetchFor('A'));await a.api.sync();
  const b=client([],service.fetchFor('A'),'https://scores.example',true);await b.api.sync();
  assert.equal(b.api.local().length,1);
  a.api.mergeRounds([round('b','junior')]);await a.api.sync();b.tick();await b.api.sync();assert.equal(b.api.local().length,2);
});
test('no backend configured still displays local history',async()=>{
  const {api}=client([round('a')],()=>{throw new Error('unexpected request');},'');await api.sync();assert.equal((await api.list('primary')).rounds.length,1);
});
