import { buildApp } from './index.js';
const app=await buildApp();
const address=await app.listen({port:Number(process.env.PORT||3000),host:process.env.HOST||'::'});
console.log(`ELSE listening at ${address}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
