const divisions = ['primary', 'junior', 'senior'];
const idPattern = /^[a-zA-Z0-9-]{16,80}$/;
export function validateRecord(r) {
  if (!r || !idPattern.test(r.id || '') || !divisions.includes(r.division) ||
      !Number.isInteger(r.score) || r.score < 0 || r.score > 300 || r.possible !== 300 ||
      !Number.isInteger(r.timeLeftSec) || r.timeLeftSec < 0 || r.timeLeftSec > 86400 ||
      typeof r.date !== 'string' || !Number.isFinite(Date.parse(r.date)) ||
      !Array.isArray(r.details) || r.details.length > 12) throw new Error('Invalid round');
  const details = r.details.map(d => {
    if (d === null) return null;
    if (!d || typeof d.ref !== 'string' || d.ref.length > 120 ||
        !Number.isInteger(d.errors) || d.errors < 0 || d.errors > 10000 ||
        !Number.isInteger(d.points) || d.points < 0 || d.points > 25) throw new Error('Invalid passage');
    const detail={ref:d.ref, errors:d.errors, points:d.points};
    for (const key of ['wrongIndices','insertIndices']) {
      if (d[key]!==undefined) {
        if (!Array.isArray(d[key]) || d[key].length>1000 || d[key].some(n=>!Number.isInteger(n)||n<0||n>10000)) throw new Error('Invalid marks');
        detail[key]=d[key];
      }
    }
    for (const key of ['refErrorTop','refErrorBottom','refError','passed','autoZero','reached']) {
      if (typeof d[key]==='boolean') detail[key]=d[key];
    }
    return detail;
  });
  return {id:r.id, date:new Date(r.date).toISOString(), score:r.score, possible:300,
    timeLeftSec:r.timeLeftSec, division:r.division, details};
}
export async function networkKey(ip, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2,'0')).join('');
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = {'Content-Type':'application/json', 'Cache-Control':'no-store', 'Vary':'Origin'};
    if (origin === env.ALLOWED_ORIGIN) Object.assign(headers, {
      'Access-Control-Allow-Origin':origin,
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, X-Score-Link'
    });
    const reply = (body, status=200) => new Response(JSON.stringify(body), {status, headers});
    if (origin && origin !== env.ALLOWED_ORIGIN) return reply({error:'Origin not allowed'},403);
    if (request.method === 'OPTIONS') return new Response(null, {status:204,headers});
    const url = new URL(request.url);
    if (!['/rounds','/device-link'].includes(url.pathname)) return reply({error:'Not found'},404);
    if (!['GET','POST'].includes(request.method)) return reply({error:'Method not allowed'},405);
    // Trust only the IP supplied by Cloudflare, never a browser-supplied identifier.
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || !env.NETWORK_SECRET || !env.DB) return reply({error:'Score service is not configured'},503);
    try {
      let network = await networkKey(ip, env.NETWORK_SECRET);
      const link = request.headers.get('X-Score-Link');
      if (link) {
        if (!/^(?:[0-9]{8}|[a-f0-9]{32})$/.test(link)) return reply({error:'Invalid device code'},400);
        const codeHash = await networkKey('device-link:'+link, env.NETWORK_SECRET);
        const row = await env.DB.prepare('SELECT network FROM device_links WHERE code_hash = ?').bind(codeHash).first();
        if (!row) return reply({error:'Device code not found'},403);
        network = row.network;
      }
      if (url.pathname === '/device-link') {
        if (request.method !== 'POST') return reply({error:'Method not allowed'},405);
        for (let attempt=0; attempt<10; attempt++) {
          let random;
          do { random=crypto.getRandomValues(new Uint32Array(1))[0]; } while(random>=4200000000);
          const code=String(random % 100000000).padStart(8,'0');
          const codeHash=await networkKey('device-link:'+code,env.NETWORK_SECRET);
          const result=await env.DB.prepare('INSERT INTO device_links (code_hash, network) VALUES (?, ?) ON CONFLICT(code_hash) DO NOTHING').bind(codeHash,network).run();
          if (result.meta.changes===1) return reply({code,historyId:network.slice(0,12)});
        }
        return reply({error:'Could not create a code. Please try again.'},503);
      }
      if (request.method === 'GET') {
        const division = url.searchParams.get('division');
        const after = url.searchParams.get('after') || '';
        if (!divisions.includes(division) || (after && !idPattern.test(after))) return reply({error:'Invalid query'},400);
        const {results} = await env.DB.prepare('SELECT id, record FROM rounds WHERE network = ? AND division = ? AND id > ? ORDER BY id LIMIT 201').bind(network, division, after).all();
        const page = results.slice(0,200);
        return reply({rounds:page.map(row=>JSON.parse(row.record)), next:results.length>200?page[199].id:null,historyId:network.slice(0,12)});
      }
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({error:'JSON required'},415);
      // Read a bounded stream so a client cannot submit an unbounded request body.
      const reader = request.body?.getReader();
      if (!reader) return reply({error:'Missing body'},400);
      let size=0; const chunks=[];
      while (true) {
        const {done,value}=await reader.read(); if (done) break;
        size+=value.byteLength;
        if (size>32768) { await reader.cancel(); return reply({error:'Round too large'},413); }
        chunks.push(value);
      }
      const bytes=new Uint8Array(size); let offset=0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
      let record;
      try { record=validateRecord(JSON.parse(new TextDecoder().decode(bytes))); }
      catch { return reply({error:'Invalid round'},400); }
      await env.DB.prepare('INSERT INTO rounds (network, id, division, record) VALUES (?, ?, ?, ?) ON CONFLICT(network, id) DO NOTHING').bind(network, record.id, record.division, JSON.stringify(record)).run();
      return reply({saved:true,id:record.id});
    } catch {
      return reply({error:'Scores temporarily unavailable'},503);
    }
  }
};
