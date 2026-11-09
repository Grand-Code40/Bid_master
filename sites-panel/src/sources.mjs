export const maxExternalIdLength=128;
// Evidence is a source existence observation, NOT permission for automation.
// No network requests, scraping, delivery, or database migrations live here.
const manual=(id,name,hosts,evidence_url=null)=>({id,name,hosts,evidence_url,counts_as_source:true,state:'observed',rules_status:'unverified',automation:'unverified',import_enabled:true,import_mode:'manual_observation',implemented:false});
export const sourceRegistry=Object.freeze([
 manual('fl','FL.ru',['www.fl.ru','fl.ru']),
 manual('freelance','Freelance.ru',['freelance.ru','www.freelance.ru']),
 {...manual('telegram','Telegram · общий фильтр (не отдельный источник)',['t.me']),state:'unverified',counts_as_source:false},
 {...manual('vmasshtabe','В Масштабе',['vmasshtabe.ru']),automation:'prohibited',import_mode:'single_observation'},
 manual('weblancer','Weblancer',['www.weblancer.net','weblancer.net'],'https://www.weblancer.net/freelance/chertezhi-i-skhemi-78/proektirovanie-printsipialnoi-skhemi-1270205/'),
 manual('3ddd','3ddd',['3ddd.ru'],'https://3ddd.ru/work/task_show/12719'),
 manual('dwg','DWG.ru',['dwg.ru'],'https://dwg.ru/board/43114'),
 manual('enginer','Enginer',['enginer.ru'],'https://enginer.ru/request/razrabotka-himstojkogo-ventilyatora-i-filtra-vfg-v-kompas-3d/'),
 {...manual('pro_pto','PRO-PTO',['pro-pto.ru'],'https://pro-pto.ru/projects'),state:'candidate',import_enabled:false,import_mode:'unavailable',evidence_scope:'public_section',content_date:null,activity_status:'unverified',evidence_note:'Инженерные проекты · даты без года · актуальность и RSS не подтверждены · автоматический сбор не подключён'},
 {...manual('3dtoday','3Dtoday',['3dtoday.ru'],'https://3dtoday.ru/board'),state:'candidate',counts_as_source:false,rules_status:'restricted',automation:'prohibited',import_enabled:false,import_mode:'unavailable',evidence_scope:'public_section',content_date:null,activity_status:'unverified',evidence_note:'Только кандидат для ручного просмотра, не разрешение на сбор · п. 7.3.5: автоматический сбор запрещён без специального разрешения · п. 11.4: регистрация включает рекламные уведомления; регистрация и подписка не разрешены · даты, актуальность и RSS не подтверждены'},
 ...[['profi','Профи','profi.ru'],['youdo','YouDo','youdo.com']].map(([id,name,host])=>({...manual(id,name,[host]),state:'candidate',import_enabled:false,import_mode:'unavailable'}))
].map(x=>Object.freeze({...x,hosts:Object.freeze(x.hosts)})));
const channelSource=(channel,post=null,state='observed')=>Object.freeze({
 id:'telegram:'+channel.toLowerCase(),source_id:'telegram',channel:channel.toLowerCase(),name:'Telegram · @'+channel,
 counts_as_source:true,state,rules_status:'unverified',automation:state==='candidate'?'prohibited':'unverified',
 import_enabled:state!=='candidate',import_mode:state==='candidate'?'unavailable':'manual_observation',implemented:false,
 evidence_url:'https://t.me/'+channel+(post?'/'+post:''),evidence_scope:post?'public_post':'public_channel',content_date:null
});
export const telegramChannels=Object.freeze([
 ...[['cgfreelance','20742'],['zakaz_design','4881'],['job_design','2582'],['profreel','1225'],['designs_job','3743']].map(([channel,post])=>channelSource(channel,post)),
 ...['zakaz3dmodels','in3ddd','work_club_engineers','arch_freelance'].map(channel=>channelSource(channel,null,'candidate')),
 channelSource('help_kirill_autoCAD'),
 Object.freeze({...channelSource('free_Design1','5565'),activity_status:'unverified',evidence_note:'Публичная заявка: 3D, STL/FBX · дата неизвестна · активность не подтверждена'}),
 Object.freeze({...channelSource('rueventjob','19032'),activity_status:'unverified',unique_orders_verified:false,dedup_required:true,evidence_note:'Публичная заявка: деталь STEP, 3D · дата неизвестна · активность не подтверждена · частично агрегатор/репосты: не уникальные заказы; перед импортом сверять первоисточник и дубли'})
]);
export const importSourceIds=Object.freeze(sourceRegistry.filter(x=>x.import_enabled).map(x=>x.id));
export const legacySourceIds=Object.freeze(['kwork','freelancer','freelancehunt']);
export const readableSourceIds=Object.freeze([...sourceRegistry.map(x=>x.id),...legacySourceIds]);
export const sourceHosts=Object.freeze(Object.fromEntries(sourceRegistry.filter(x=>x.import_enabled).map(x=>[x.id,x.hosts])));
export function publicSources(listings,checks=[]){return [...sourceRegistry,...telegramChannels].map(({hosts,...source})=>{
 const rows=listings.filter(x=>x.source_id===(source.source_id??source.id)&&(!source.channel||x.external_id.startsWith(source.channel+'/')));
 const check=checks.find(c=>c.source_id===source.id)??null;
 return {...source,code:check?.status??(rows.length?'agent_observed':'not_scanned'),last_success:check?.status==='success'||check?.status==='empty'?check.checked_at:null,last_observed_at:rows.map(x=>x.last_seen).sort().at(-1)??null,last_checked_at:check?.checked_at??null,last_check:check};
});}
