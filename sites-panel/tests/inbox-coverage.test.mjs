import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
function coverage(){const match=html.match(/<details id="inbox-coverage"[\s\S]*?<\/details>/);assert.ok(match,'inbox must expose unconfigured public coverage');return match[0];}
test('public export lists six platforms without publishing private account settings',()=>{
 const section=coverage();
 assert.equal((section.match(/data-inbox-source=/g)||[]).length,6);
 for(const id of ['fl','freelance','weblancer','vmasshtabe','3ddd','enginer'])assert.ok(section.includes('data-inbox-source="'+id+'"'));
 assert.equal((section.match(/Не настроено в публичной копии/g)||[]).length,6);
 assert.doesNotMatch(section,/<time|Email включён|email включён|2026-11-03|03\.11\.2026/);
});
test('public coverage does not claim delivery, synchronization or working access',()=>{
 const section=coverage();
 assert.match(section,/не подтверждает доставку/);assert.match(section,/не проверка новых сообщений/);
 assert.match(section,/Прямое чтение переписок площадок не подключено/);
 assert.equal(/data-status="(?:connected|live|healthy)"/.test(section),false);
 assert.equal(/<script|<iframe|<img|<form|<input/.test(section),false);
});
