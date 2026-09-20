import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const ignored = new Set(['node_modules','.git','.vite','public']);
const forbidden = new RegExp([['TO','DO'].join(''),['FIX','ME'].join(''),['place','holder'].join(''),['rest',' of code'].join(''),['implement',' later'].join(''),['your code',' here'].join('')].join('|'), 'i');
const envPattern = /process\.env\.([A-Z0-9_]+)/g;

async function walk(dir) {
  const out=[];
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    if (ignored.has(entry.name)) continue;
    const full=path.join(dir,entry.name);
    if (entry.isDirectory()) out.push(...await walk(full)); else out.push(full);
  }
  return out;
}

const files = await walk(root);
const textFiles = files.filter(f => !/[.]png$|[.]jpg$|[.]jpeg$|[.]gif$|[.]ico$/i.test(f));
for (const file of textFiles) {
  const content = await readFile(file,'utf8');
  if (forbidden.test(content)) throw new Error(`Forbidden incomplete-code marker in ${path.relative(root,file)}`);
}

const envSource = await readFile(path.join(root,'server/config/env.mjs'),'utf8');
const used = new Set([...envSource.matchAll(/\b([A-Z][A-Z0-9_]+)\s*:/g)].map(m=>m[1]));
const envExample = await readFile(path.join(root,'.env.example'),'utf8');
const documented = new Set([...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m=>m[1]));
for (const name of used) if (!documented.has(name)) throw new Error(`Environment variable ${name} is not documented`);
for (const name of documented) if (!used.has(name)) throw new Error(`Unused environment variable ${name} is documented`);

const pkg = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
for (const script of ['build','start','test','check']) if (!pkg.scripts?.[script]) throw new Error(`Missing npm script: ${script}`);
if (!pkg.dependencies?.['@whiskeysockets/baileys']) throw new Error('Baileys dependency missing');
if (!pkg.dependencies?.['pg']) throw new Error('PostgreSQL dependency missing');

console.log(`Project check passed: ${files.length} files inspected; ${used.size} environment variables documented.`);
