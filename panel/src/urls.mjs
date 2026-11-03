import {sourceHosts,maxExternalIdLength,telegramChannels} from './sources.mjs';
const hosts=sourceHosts;
const invalid=()=>{throw new Error('invalid_observation');};
export function validatedCanonicalUrl(source,id,value){
 if(!Object.hasOwn(hosts,source)||typeof id!=='string'||id.length>maxExternalIdLength||typeof value!=='string'||value.length>2048||/[\x00-\x20\\]/.test(value))invalid();
 const rawPath=value.match(/^https:\/\/[^/?#]+([^?#]*)/)?.[1];
 if(rawPath===undefined||rawPath.includes('%')||rawPath.split('/').some(x=>x==='.'||x==='..'))invalid();
 let url;try{url=new URL(value);}catch{invalid();}
 if(url.protocol!=='https:'||url.port||url.username||url.password||!hosts[source].includes(url.hostname)||url.pathname.includes('%'))invalid();
 let path=url.pathname.replace(/\/$/,''),match,identity,query='';
 if(source==='fl')identity=path.match(/^\/projects\/([1-9][0-9]*)\/[a-zA-Z0-9_-]+\.html$/)?.[1];
 if(source==='freelance')identity=(path.match(/^\/task\/view\/([1-9][0-9]*)$/)||path.match(/^\/projects\/[a-zA-Z0-9_-]+-([1-9][0-9]*)\.html$/))?.[1];
 // Validate the raw path too: URL normalization must not conceal dot segments.
 if(source==='vmasshtabe'){match=value.match(/^https:\/\/vmasshtabe\.ru(\/task\/([a-z0-9][a-z0-9-]{0,127})\/?)(?:[?#].*)?$/);if(match)identity=match[2];}
 if(source==='telegram'){match=path.match(/^\/(?:s\/)?([a-zA-Z][a-zA-Z0-9_]{3,63})\/([1-9][0-9]*)$/);if(match){const channel=match[1].toLowerCase();if(telegramChannels.some(x=>x.channel===channel&&!x.import_enabled))invalid();identity=channel+'/'+match[2];path='/'+identity;}}
 if(source==='weblancer')identity=path.match(/^\/freelance\/[a-z0-9-]+-([0-9]+)\/[a-z0-9-]+-([1-9][0-9]*)$/)?.[2];
 if(source==='3ddd')identity=path.match(/^\/work\/task_show\/([1-9][0-9]*)$/)?.[1];
 if(source==='dwg')identity=path.match(/^\/board\/([1-9][0-9]*)$/)?.[1];
 if(source==='enginer')identity=path.match(/^\/request\/([a-z0-9][a-z0-9-]{0,127})$/)?.[1];
 if(!identity||identity!==id)invalid();return 'https://'+hosts[source][0]+path+query;
}
