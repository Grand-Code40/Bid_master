// Bundler provides api and assets. Requires the authenticated Sites gateway.
export default {
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(path==='/mcp')return mcp.handleMcp(request,env);
  if(path.startsWith('/api/'))return api.handleApi(request,env);
  if(!env.OWNER_USER_ID)return new Response('Site not configured',{status:503});
  const identity=request.headers.get('oai-authenticated-user-id');
  if(!identity)return new Response('Sign in through the private Site to continue.',{status:401});
  if(identity!==env.OWNER_USER_ID)return new Response('Owner access required',{status:403});
  const asset=assets[path];
  if(request.method!=='GET'||!asset)return new Response('Not found',{status:404});
  return new Response(asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"}});
 }
};
