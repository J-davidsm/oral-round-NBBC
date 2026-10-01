/* Local rounds are authoritative. Sync only adds missing rounds to local storage. */
window.ScoreSync = (() => {
  const base = () => (window.SCORE_API_URL || '').replace(/\/$/,'');
  function storedRounds() {
    const raw=localStorage.getItem('oralRounds');
    const records=JSON.parse(raw || '[]');
    if (!Array.isArray(records)) throw new Error('Saved round data is invalid; it has not been changed.');
    return records;
  }
  function writeRounds(records) {
    const raw=localStorage.getItem('oralRounds');
    if (raw && !localStorage.getItem('oralRoundsBeforeMerge')) localStorage.setItem('oralRoundsBeforeMerge',raw);
    localStorage.setItem('oralRounds',JSON.stringify(records));
  }
  function local() {
    try {
      return storedRounds();
    } catch { return []; }
  }
  function deviceCode() {
    try { return localStorage.getItem('oralRoundDeviceCode') || ''; } catch { return ''; }
  }
  async function api(path, options={}, code=deviceCode()) {
    options={...options,headers:{...options.headers,...(code?{'X-Score-Link':code}:{})}};
    const response = await fetch(base()+path, {...options, signal:AbortSignal.timeout(15000)});
    if (!response.ok) { const error = new Error('Score service unavailable'); error.status = response.status; throw error; }
    return response.json();
  }
  async function save(record) {
    if (!base()) return false;
    const code=deviceCode();
    await api('/rounds', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)},code);
    // Read fresh storage: another round may have finished while this upload ran.
    try {
      const records=storedRounds();
      const saved=records.find(r=>r.id===record.id);
      if (saved) { saved.sharedScoreApi=base(); saved.sharedScoreLink=code; writeRounds(records); }
    } catch { /* A retry is safe because the server deduplicates by round ID. */ }
    return true;
  }
  async function remoteList(division, code=deviceCode()) {
    if (!base()) return {rounds:local().filter(r=>r.division===division), shared:false};
    const rounds=[]; let after=''; let historyId='';
    do {
      const page=await api('/rounds?division='+encodeURIComponent(division)+'&after='+encodeURIComponent(after),{},code);
      historyId=page.historyId;
      rounds.push(...page.rounds); after=page.next;
    } while (after);
    rounds.sort((a,b)=>new Date(a.date)-new Date(b.date));
    return {rounds,shared:true,historyId,linked:Boolean(code)};
  }
  function mergeRounds(incoming) {
    const records=storedRounds();
    const ids=new Set(records.filter(r=>r.id).map(r=>r.id));
    let added=0;
    for (const record of incoming) {
      if (!record.id || !['primary','junior','senior'].includes(record.division) || ids.has(record.id)) continue;
      records.push(record); ids.add(record.id); added++;
    }
    if (added) writeRounds(records);
    return added;
  }
  async function list(division) {
    return {rounds:local().filter(r=>r.division===division),shared:false};
  }
  let syncInFlight=null;
  function sync() {
    if (!base()) return Promise.resolve({added:0});
    if (!syncInFlight) syncInFlight=mergeSync().finally(()=>{syncInFlight=null;});
    return syncInFlight;
  }
  async function mergeSync() {
    const code=deviceCode();
    let failure=null;
    try { await importLocal(); } catch(error) { failure=error; }
    let added=0;
    for (const division of ['primary','junior','senior']) {
      try {
        const result=await remoteList(division,code);
        added+=mergeRounds(result.rounds);
      } catch(error) { failure=error; }
    }
    if (failure) throw failure;
    return {added};
  }
  let importInFlight = null;
  function importLocal() {
    if (!base()) return Promise.resolve(0);
    if (!importInFlight) importInFlight = importPending().finally(()=>{ importInFlight=null; });
    return importInFlight;
  }
  async function importPending() {
    const records=storedRounds();
    // Persist IDs before sending: retrying an interrupted import cannot duplicate rounds.
    let changed=false;
    records.forEach(r=>{ if (!r.id) { r.id=crypto.randomUUID(); changed=true; } });
    if (changed) writeRounds(records);
    let count=0; let invalid=false;
    for (const r of records) {
      if (!['primary','junior','senior'].includes(r.division)) continue;
      if (r.sharedScoreApi===base() && (r.sharedScoreLink || '')===deviceCode()) continue;
      try { await save({...r,details:r.details || []}); count++; }
      catch (error) {
        if (error.status===400 || error.status===413) { invalid=true; continue; }
        throw error;
      }
    }
    if (invalid) throw new Error("Some saved rounds could not be imported. They remain in this browser.");
    return count;
  }
  async function createDeviceCode() {
    await sync();
    const result=await api('/device-link',{method:'POST'});
    // Pin this device too, so both keep the same history if its IP later changes.
    await linkDevice(result.code);
    return result.code;
  }
  async function linkDevice(value) {
    const code=value.replace(/[\s-]/g,'').toLowerCase();
    if (!/^(?:[0-9]{8}|[a-f0-9]{32})$/.test(code)) throw new Error('Enter the complete code from the other device.');
    if (syncInFlight) { try { await syncInFlight; } catch {} }
    if (importInFlight) { try { await importInFlight; } catch {} }
    await api('/rounds?division=primary',{},code);
    localStorage.setItem('oralRoundDeviceCode',code);
    await sync();
  }
  return {local,save,list,sync,mergeRounds,importLocal,createDeviceCode,linkDevice,enabled:()=>Boolean(base())};
})();

// Opening the site merges both directions. Open linked devices refresh periodically.
function backgroundScoreSync() {
  ScoreSync.sync().then(()=>window.dispatchEvent(new Event('scores-synced'))).catch(()=>{});
}
backgroundScoreSync();
window.addEventListener('online',backgroundScoreSync);
window.addEventListener('focus',backgroundScoreSync);
window.setInterval(backgroundScoreSync,30000);
