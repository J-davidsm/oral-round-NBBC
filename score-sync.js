/* Shared history is fetched on every visit to Highscores. Local history is kept
   separately, so moving networks never silently publishes old rounds there. */
window.ScoreSync = (() => {
  const base = () => (window.SCORE_API_URL || '').replace(/\/$/,'');
  function local() {
    try {
      const data = JSON.parse(localStorage.getItem('oralRounds') || '[]');
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }
  async function api(path, options={}) {
    const response = await fetch(base()+path, {...options, signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('Score service unavailable');
    return response.json();
  }
  async function save(record) {
    if (!base()) return false;
    await api('/rounds', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)});
    return true;
  }
  async function list(division) {
    if (!base()) return {rounds:local().filter(r=>r.division===division), shared:false};
    const rounds=[]; let after='';
    do {
      const page=await api('/rounds?division='+encodeURIComponent(division)+'&after='+encodeURIComponent(after));
      rounds.push(...page.rounds); after=page.next;
    } while (after);
    rounds.sort((a,b)=>new Date(a.date)-new Date(b.date));
    return {rounds,shared:true};
  }
  async function importLocal() {
    const records=local();
    // Persist IDs before sending: retrying an interrupted import cannot duplicate rounds.
    records.forEach(r=>{ if (!r.id) r.id=crypto.randomUUID(); });
    localStorage.setItem('oralRounds',JSON.stringify(records));
    let count=0;
    for (const r of records) {
      if (!['primary','junior','senior'].includes(r.division)) continue;
      await save(r); count++;
    }
    return count;
  }
  return {local,save,list,importLocal,enabled:()=>Boolean(base())};
})();
