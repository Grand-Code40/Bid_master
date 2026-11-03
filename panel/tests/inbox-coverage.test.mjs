import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
function coverage(){const match=html.match(/<details id="inbox-coverage"[\s\S]*?<\/details>/);assert.ok(match,'inbox must expose a dated coverage snapshot');return match[0];}
test('coverage snapshot distinguishes six platform settings without claiming delivery',()=>{
 const section=coverage();
 assert.equal((section.match(/data-inbox-source=/g)||[]).length,6);
 for(const id of ['fl','freelance','weblancer','vmasshtabe','3ddd','enginer'])assert.ok(section.includes('data-inbox-source="'+id+'"'));
 assert.match(section,/<time datetime="2026-11-03">03\.11\.2026<\/time>/);
 assert.match(section,/не подтверждает доставку/);assert.match(section,/не проверка новых сообщений/);
 assert.equal(/data-status="(?:connected|live|healthy)"/.test(section),false);
});
test('confirmed settings retain limited event scope and unknown settings remain unknown',()=>{
 const section=coverage();
 assert.match(section,/FL\.ru[\s\S]*?Новые сообщения и комментарии/);
 assert.match(section,/Freelance\.ru[\s\S]*?Новые сообщения и события/);
 assert.match(section,/Weblancer[\s\S]*?через 5 минут[\s\S]*?личных сообщений не подтверждён/);
 for(const id of ['vmasshtabe','3ddd','enginer'])assert.match(section,new RegExp('data-inbox-source="'+id+'"[\\s\\S]*?<dd>Не установлено'));
 assert.equal(/<script|<iframe|<img|<form|<input/.test(section),false);
});
