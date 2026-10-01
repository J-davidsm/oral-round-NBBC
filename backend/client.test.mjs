import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../score-sync.js',import.meta.url),'utf8');
function client(records=[],url='',fetch=()=>{throw new Error('unexpected network request');}) {
  const storage=new Map([['oralRounds',JSON.stringify(records)]]);
  const window={SCORE_API_URL:url,addEventListener:()=>{}};
  vm.runInNewContext(source.split('// Opening the site')[0],{window,fetch,AbortSignal,crypto,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
  return window.ScoreSync;
}
test('unconfigured frontend filters local history by division',async()=>{
  const api=client([{division:'primary',score:100},{division:'junior',score:200}]);
  const result=await api.list('primary');
  assert.equal(result.shared,false); assert.equal(result.rounds.length,1);assert.equal(result.rounds[0].score,100);
});
test('configured frontend uses only remote history and follows pages',async()=>{
  const calls=[];
  const api=client([{division:'primary',score:300}],'https://scores.example',async url=>{
    calls.push(url);return {ok:true,json:async()=> calls.length===1?{rounds:[{date:'2026-01-01',score:100}],next:'next-id'}:{rounds:[{date:'2026-01-02',score:200}],next:null}};
  });
  const result=await api.list('primary');
  assert.equal(result.shared,true);assert.equal(result.rounds.length,2);
  assert.equal(calls.length,2);assert.match(calls[1],/division=primary&after=next-id/);
});
test('repeating an import reuses IDs; invalid divisions are skipped',async()=>{
  const sent=[];
  const api=client([{division:'primary',score:100},{score:50}],'https://scores.example',async(url,options)=>{
    sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({saved:true})};
  });
  assert.equal(await api.importLocal(),1);assert.equal(await api.importLocal(),0);
  assert.equal(sent.length,1);assert.equal(api.local()[0].id,sent[0].id);
});
test('network failures surface to the UI without changing local history',async()=>{
  const api=client([{division:'primary',score:100}],'https://scores.example',async()=>({ok:false}));
  await assert.rejects(api.list('primary'));assert.equal(api.local().length,1);
});

test('concurrent imports share one upload and failed uploads can retry',async()=>{
  let attempts=0;
  const api=client([{division:'primary',score:100}],'https://scores.example',async()=>{
    attempts++; if(attempts===1) throw new Error('Offline');
    return {ok:true,json:async()=>({saved:true})};
  });
  await assert.rejects(api.importLocal());
  const first=api.importLocal();const second=api.importLocal();
  assert.equal(first,second);await first;assert.equal(attempts,2);
  assert.equal(await api.importLocal(),0);
});
test('opening the page automatically imports existing rounds',async()=>{
  let stored=JSON.stringify([{division:'primary',score:100}]);let requests=0;
  const context={SCORE_API_URL:'https://scores.example',addEventListener:()=>{},AbortSignal,crypto,
    localStorage:{getItem:key=>key==='oralRounds'?stored:null,setItem:(key,value)=>{if(key==='oralRounds') stored=value;}},
    fetch:async()=>{requests++;return {ok:true,json:async()=>({saved:true})};}};
  context.window=context;
  vm.runInNewContext(source,context);
  await context.ScoreSync.importLocal();
  assert.equal(requests,1);
  assert.equal(JSON.parse(stored)[0].sharedScoreApi,'https://scores.example');
});

test('linking another device selects its history and imports to that history once',async()=>{
  const code='a'.repeat(32);const requests=[];
  const api=client([{id:'r'.repeat(32),division:'primary',sharedScoreApi:'https://scores.example'}],'https://scores.example',async(url,options)=>{
    requests.push({url,options});return {ok:true,json:async()=>({rounds:[],next:null,historyId:'example'})};
  });
  assert.equal(await api.importLocal(),0);
  await api.linkDevice(code);
  assert.equal(await api.importLocal(),1);
  assert.equal(await api.importLocal(),0);
  assert.equal(requests[1].options.headers['X-Score-Link'],code);
  const result=await api.list('primary');assert.equal(result.linked,true);
});
test('failed linking preserves the existing selected history',async()=>{
  const api=client([],'https://scores.example',async()=>({ok:false,status:403}));
  await assert.rejects(api.linkDevice('a'.repeat(32)));
  assert.equal(await api.importLocal(),0);
});
