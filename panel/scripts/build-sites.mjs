// Self-authored output preparation; the supported Sites source helper still
// owns source synchronization, archive validation and packaging.
import {readFileSync,mkdirSync,writeFileSync,cpSync,existsSync,readdirSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('.openai/hosting.json',root),'utf8'));
if(typeof manifest.project_id!=='string'||!manifest.project_id)throw new Error('Site not registered: no project_id. Owner must create once and persist returned ID.');
if(manifest.d1!=='DB'||manifest.static)throw new Error('Expected Worker with DB binding and no static configuration');
const migrations=new URL('drizzle/',root);
if(!existsSync(new URL('meta/_journal.json',migrations))||!existsSync(migrations)||!readdirSync(migrations).some(x=>x.endsWith('.sql')))throw new Error('Generate and inspect official Drizzle migrations before packaging; local schema.sql is not deployment metadata.');
await import('./build-local.mjs');
mkdirSync(new URL('dist/server/',root),{recursive:true});mkdirSync(new URL('dist/.openai/',root),{recursive:true});
cpSync(new URL('build/worker.mjs',root),new URL('dist/server/index.js',root));
writeFileSync(new URL('dist/.openai/hosting.json',root),JSON.stringify(manifest,null,2)+'\n');
console.log('Prepared dist/server/index.js for Sites source workflow; hosted verification still required.');
