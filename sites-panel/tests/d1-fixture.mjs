// Test-only adapter: executes our SQL on SQLite, not a D1 runtime emulator.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
export function fixture() {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('PRAGMA foreign_keys=ON');
 if(process.env.USE_GENERATED_MIGRATIONS==='1'){
  const directory=new URL('../drizzle/',import.meta.url);
  for(const file of readdirSync(directory).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(file,directory),'utf8'));
 }else sqlite.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));
 const db={prepare(sql) {
   const statement=sqlite.prepare(sql); let params=[];
   return {bind(...args){params=args;return this;},async first(){return statement.get(...params)??null;},async all(){return {results:statement.all(...params)};},
     runSync(){const r=statement.run(...params);return {meta:{changes:Number(r.changes)}};},async run(){return this.runSync();}};
 },async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(x=>x.runSync());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}},close(){sqlite.close();}};
 return db;
}
