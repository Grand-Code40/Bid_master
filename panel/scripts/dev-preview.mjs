// ISOLATED QA ONLY. Never packaged in the Worker. Synthetic in-memory data;
// fake owner injection is intentionally restricted to the managed preview.
import {createServer} from 'node:http';
import {fixture} from '../tests/d1-fixture.mjs';
import {ingestObservations} from '../src/ingest.mjs';
import worker from '../build/worker.mjs';
if(process.env.SITES_MANAGED_LINUX_CONTAINER!=='1')throw new Error('Managed QA preview only');
const db=fixture();
await ingestObservations(db,'qa-owner',[{source_id:'fl',external_id:'999999',canonical_url:'https://www.fl.ru/projects/999999/qa-only.html',title:'ТЕСТ QA — чертёж детали (не реальный заказ)',description:'Синтетическая карточка только для проверки редактора. Не отправлять.',listing_kind:'order',availability:'open',requested_formats:['DXF'],budget_min:'1000',currency:'RUB',observed_at:new Date().toISOString()}],new Date().toISOString());
const index=process.argv.indexOf('--port'),port=Number(index>=0?process.argv[index+1]:process.env.PORT??3000);
createServer(async(req,res)=>{
 try{const origin=req.headers.origin??('http://'+req.headers.host),url=new URL(req.url,origin);const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','qa-owner');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const request=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
  const response=await worker.fetch(request,{DB:db,OWNER_USER_ID:'qa-owner'});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Preview error');}
}).listen(port,'127.0.0.1',()=>console.log('QA preview ready on '+port));
