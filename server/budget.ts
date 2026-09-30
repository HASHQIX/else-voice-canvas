import { db, uuid } from './db.js';
import { DomainError } from './validation.js';

db.exec(`CREATE TABLE IF NOT EXISTS budget_reservations (
 id TEXT PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL,
 reserved_usd REAL NOT NULL, actual_usd REAL, created_at TEXT NOT NULL
); CREATE INDEX IF NOT EXISTS budget_day ON budget_reservations(day);`);

export function budgetStatus() {
 const day=new Date().toISOString().slice(0,10);
 const row=db.prepare('SELECT COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) used FROM budget_reservations WHERE day=?').get(day) as {used:number};
 const limit=Number(process.env.DAILY_LLM_BUDGET_USD||process.env.DAILY_BUDGET_USD);
 return {day,limit:Number.isFinite(limit)&&limit>0?limit:0,reservedUsd:row.used};
}
/** Reserve before a paid request. Unknown outcomes keep their reservation across restarts. */
export function reserveBudget(maxCost:number,kind='inference') {
 return db.transaction(()=>{
  const status=budgetStatus();
  if(!status.limit)throw new DomainError('budget_unconfigured','The operator must configure a positive daily AI budget',503);
  if(!Number.isFinite(maxCost)||maxCost<=0)throw new DomainError('invalid_reservation','Invalid cost reservation',500);
  if(status.reservedUsd+maxCost>status.limit)throw new DomainError('budget_exhausted','Daily AI budget reached. Your board remains available.',429);
  const id=uuid();db.prepare('INSERT INTO budget_reservations(id,day,kind,reserved_usd,created_at) VALUES(?,?,?,?,?)').run(id,status.day,kind,maxCost,new Date().toISOString());return id;
 })();
}
/** Only reconciled authoritative usage may release a reservation. */
export function reconcileBudget(id:string,actualUsd:number) {
 if(!Number.isFinite(actualUsd)||actualUsd<0)throw new DomainError('invalid_usage','Invalid usage amount',500);
 db.prepare('UPDATE budget_reservations SET actual_usd=? WHERE id=?').run(actualUsd,id);
}
