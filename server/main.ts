import { buildApp } from './index.js';
const app=await buildApp();
await app.listen({port:Number(process.env.PORT||3000),host:process.env.HOST||'0.0.0.0'});
console.log(`ELSE listening at http://localhost:${process.env.PORT||3000}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
