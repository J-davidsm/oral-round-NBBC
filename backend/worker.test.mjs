import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {networkKey, validateRecord} from './worker.js';
const record={id:'a'.repeat(32),date:'2026-10-01T12:00:00Z',division:'primary',score:250,possible:300,timeLeftSec:60,details:[{ref:'John 1:1',errors:1,points:20}]};
function environment() {
  const rows=[];
  return {rows, NETWORK_SECRET:'test-secret-not-for-deployment',ALLOWED_ORIGIN:'https://j-davidsm.github.io', DB:{prepare(sql){ return {bind(...args){ return {
    async run(){const [network,id,division,record]=args; if(!rows.some(r=>r.network===network&&r.id===id)) rows.push({network,id,division,record});},
    async all(){const [network,division,after]=args;return {results:rows.filter(r=>r.network===network&&r.division===division&&r.id>after).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,201)};}
  };}};}}};
}
const request=(ip,method='GET',body,query='division=primary')=>new Request('https://scores.example/rounds?'+query,{method,headers:{'CF-Connecting-IP':ip,Origin:'https://j-davidsm.github.io','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
test('network keys are stable, separated, and contain no raw IP',async()=>{
  const a=await networkKey('192.0.2.1','secret');
  assert.equal(a,await networkKey('192.0.2.1','secret'));
  assert.notEqual(a,await networkKey('192.0.2.2','secret'));
  assert.notEqual(a,await networkKey('192.0.2.1','other'));
  assert.match(a,/^[a-f0-9]{64}$/);
});
test('two devices on same IP share rounds; other networks and divisions do not',async()=>{
  const env=environment();
  assert.equal((await worker.fetch(request('192.0.2.1','POST',record),env)).status,200);
  assert.equal((await (await worker.fetch(request('192.0.2.1'),env)).json()).rounds.length,1);
  assert.equal((await (await worker.fetch(request('192.0.2.2'),env)).json()).rounds.length,0);
  assert.equal((await (await worker.fetch(request('192.0.2.1','GET',null,'division=junior'),env)).json()).rounds.length,0);
  await worker.fetch(request('192.0.2.1','POST',record),env);
  assert.equal(env.rows.length,1);
});
test('invalid scores, divisions, and passage details are rejected',async()=>{
  for(const patch of [{score:301},{division:'unknown'},{details:[{ref:'x',errors:-1,points:25}]},{id:'x'}]) {
    assert.throws(()=>validateRecord({...record,...patch}));
    assert.equal((await worker.fetch(request('192.0.2.1','POST',{...record,...patch}),environment())).status,400);
  }
});
test('history pagination preserves every record',async()=>{
  const env=environment();
  for(let n=0;n<205;n++) await worker.fetch(request('192.0.2.1','POST',{...record,id:String(n).padStart(32,'0')}),env);
  const first=await (await worker.fetch(request('192.0.2.1'),env)).json();
  assert.equal(first.rounds.length,200);
  const second=await (await worker.fetch(request('192.0.2.1','GET',null,'division=primary&after='+first.next),env)).json();
  assert.equal(second.rounds.length,5);assert.equal(second.next,null);
});
test('missing server identity/config and disallowed origins are rejected',async()=>{
  const env=environment();
  assert.equal((await worker.fetch(new Request('https://scores.example/rounds?division=primary'),env)).status,503);
  const bad=request('192.0.2.1');bad.headers.set('Origin','https://other.example');
  assert.equal((await worker.fetch(bad,env)).status,403);
  delete env.NETWORK_SECRET;
  assert.equal((await worker.fetch(request('192.0.2.1'),env)).status,503);
});
