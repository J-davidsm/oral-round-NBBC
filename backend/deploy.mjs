// Isolate bundling from unrelated package.json files above this checkout.
import {mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const source=dirname(fileURLToPath(import.meta.url));
const directory=mkdtempSync(join(tmpdir(),'oral-round-deploy-'));
try {
  for (const file of ['worker.js','wrangler.jsonc','package.json']) copyFileSync(join(source,file),join(directory,file));
  const result=spawnSync(process.execPath,[join(source,'node_modules/wrangler/bin/wrangler.js'),'deploy',...process.argv.slice(2)],{cwd:directory,stdio:'inherit'});
  if (result.error) throw result.error;
  process.exitCode=result.status ?? 1;
} finally { rmSync(directory,{recursive:true,force:true}); }
