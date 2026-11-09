// ISOLATED QA ONLY. Never packaged in the Worker. Synthetic in-memory data;
// fake owner injection is intentionally restricted to the managed preview.
import {createServer} from 'node:http';
import {fixture} from '../tests/d1-fixture.mjs';
import {ingestObservations} from '../src/ingest.mjs';
import {recordMail,linkMailConversation} from '../src/inbox.mjs';
import worker from '../build/worker.mjs';
if(process.env.SITES_MANAGED_LINUX_CONTAINER!=='1')throw new Error('Managed QA preview only');
const db=fixture();
await ingestObservations(db,'qa-owner',[{source_id:'fl',external_id:'999999',canonical_url:'https://www.fl.ru/projects/999999/qa-only.html',title:'ТЕСТ QA — чертёж детали (не реальный заказ)',description:'Синтетическая карточка только для проверки редактора. Не отправлять.',listing_kind:'order',availability:'open',published_at:'2026-11-08T12:30:00.000Z',requested_formats:['DXF'],budget_min:'1000',currency:'RUB',observed_at:new Date().toISOString()}],new Date().toISOString());
const qaTime=new Date().toISOString();
await recordMail(db,'qa-owner',{mailbox:'qa@example.test',message_id:'abcdef',thread_id:'abcdef',received_at:qaTime,observed_at:qaTime,sender:'"В Масштабе" <info@vmasshtabe.ru>',subject:'ТЕСТ QA — уведомление, не реальная переписка',plain_text:'Посмотреть сообщение к Вашему отклику',reference:null},qaTime);
await linkMailConversation(db,'qa-owner',{mailbox:'qa@example.test',message_id:'abcdef',conversation_url:'https://vmasshtabe.ru/account/view-task?id=999999999999999&response_id=999999999999999',observed_at:qaTime},qaTime);
const index=process.argv.indexOf('--port'),port=Number(index>=0?process.argv[index+1]:process.env.PORT??3000);
createServer(async(req,res)=>{
 if(req.url==='/qa-mobile'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Isolated mobile QA</title><iframe title="Mobile 390px" src="/" style="width:390px;height:844px;border:0"></iframe>');return;}
 try{const origin=req.headers.origin??('http://'+req.headers.host),url=new URL(req.url,origin);const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','qa-owner');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const request=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
  const response=await worker.fetch(request,{DB:db,OWNER_USER_ID:'qa-owner'});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Preview error');}
}).listen(port,'0.0.0.0',()=>console.log('QA preview ready on '+port));
