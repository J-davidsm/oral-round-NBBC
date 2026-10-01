import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../score-sync.js',import.meta.url),'utf8');
function client(records=[],url='',fetch=()=>{throw new Error('unexpected network request');}) {
  let stored=JSON.stringify(records);
  const window={SCORE_API_URL:url};
  vm.runInNewContext(source,{window,fetch,AbortSignal,crypto,localStorage:{getItem:()=>stored,setItem:(key,value)=>{stored=value;}}});
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
  assert.equal(await api.importLocal(),1);assert.equal(await api.importLocal(),1);
  assert.equal(sent[0].id,sent[1].id);assert.equal(api.local()[0].id,sent[0].id);
});
test('network failures surface to the UI without changing local history',async()=>{
  const api=client([{division:'primary',score:100}],'https://scores.example',async()=>({ok:false}));
  await assert.rejects(api.list('primary'));assert.equal(api.local().length,1);
});
