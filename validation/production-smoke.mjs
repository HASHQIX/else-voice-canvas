// Exercises the compiled production server with isolated in-memory storage. No provider calls.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.NODE_ENV='production';
process.env.DATABASE_PATH=':memory:';
process.env.SESSION_SECRET=crypto.randomBytes(32).toString('hex');
process.env.APP_ORIGIN='https://else.example';
process.env.DEMO_ACCESS_CODE='';
process.env.LLM_PROVIDER='openrouter';
process.env.OPENROUTER_API_KEY='synthetic-validation-only';
process.env.ASSEMBLYAI_API_KEY='synthetic-validation-only';
process.env.DAILY_LLM_BUDGET_USD='1';
const store=await import('../dist/server/db.js');
const {buildApp}=await import('../dist/server/index.js');
const app=await buildApp();
const origin=process.env.APP_ORIGIN;
try {
 await app.ready();
 const home=await app.inject({url:'/'});
 assert.equal(home.statusCode,200);
 assert.ok(home.body.includes('<title>ELSE'));
 assert.ok(home.headers['content-security-policy'].includes("default-src 'self'"));
 const assets=[...home.body.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match=>match[1]);
 assert.ok(assets.length>=2,'Built JS and CSS are referenced');
 for(const url of assets){const result=await app.inject({url});assert.equal(result.statusCode,200);assert.ok(!result.body.startsWith('<!doctype html>'));}
 const worklet=await app.inject({url:'/worklets/pcm-capture.js'});
 assert.equal(worklet.statusCode,200);assert.ok(worklet.body.includes('registerProcessor'));
 const reportShell=await app.inject({url:'/report/example-report'});
 assert.equal(reportShell.statusCode,200);assert.ok(reportShell.body.includes('<title>ELSE'));
 assert.equal((await app.inject({method:'POST',url:'/api/guest',headers:{origin:'https://foreign.example'},payload:{}})).statusCode,403);
 const guest=await app.inject({method:'POST',url:'/api/guest',headers:{origin},payload:{}});
 assert.equal(guest.statusCode,200);
 const cookieHeader=guest.headers['set-cookie'];
 assert.match(cookieHeader,/HttpOnly/i);assert.match(cookieHeader,/Secure/i);assert.match(cookieHeader,/SameSite=Lax/i);
 const cookie=cookieHeader.split(';')[0],headers={origin,cookie};
 const created=await app.inject({method:'POST',url:'/api/projects',headers,payload:{title:'Production validation'}});
 assert.equal(created.statusCode,201);const project=created.json();
 const sessionResult=await app.inject({method:'POST',url:`/api/projects/${project.id}/sessions`,headers,payload:{clientId:'production-validation',branchId:project.branches[0].id}});
 assert.equal(sessionResult.statusCode,201);const session=sessionResult.json();
 const ws=await app.injectWS(`/api/live/${session.id}`,{headers});
 try {
  const pong=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Production WebSocket did not respond')),3000);ws.once('message',data=>{clearTimeout(timer);resolve(JSON.parse(data.toString()));});});
  ws.send(JSON.stringify({protocolVersion:1,sessionId:session.id,type:'fork.ping'}));
  assert.equal((await pong).type,'fork.pong');
 } finally {ws.close();}
 const owner=store.db.prepare('SELECT owner_id FROM projects WHERE id=?').get(project.id).owner_id;
 store.saveSpeechSegment(owner,project.id,session.id,'0','Can we book the studio?',true,'A');
 store.saveSpeechSegment(owner,project.id,session.id,'1','Friday is available.',true,'B');
 const exported=await app.inject({method:'POST',url:`/api/projects/${project.id}/reports`,headers,payload:{}});
 assert.equal(exported.statusCode,201);
 const report=await app.inject({url:`/api/reports/${exported.json().id}`,headers:{cookie}});
 assert.equal(report.statusCode,200);assert.deepEqual(report.json().report.transcript.map(segment=>segment.speaker),['A','B']);
 assert.equal((await app.inject({url:`/api/reports/${exported.json().id}`})).statusCode,401);
 console.log('PASS: compiled production assets, report deep link, microphone worklet, origin checks, secure guest cookie, authenticated WebSocket and private speaker-labeled report');
} finally {await app.close();store.db.close();}
