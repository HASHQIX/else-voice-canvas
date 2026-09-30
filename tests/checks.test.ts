import {expect,it} from 'vitest';
import {durationCheck} from '../server/checks.js';
it('D09 calculates only supplied quantities with sources',()=>{
 const result=durationCheck('60+20+60 minutes; limit 120 minutes','turn1');
 expect(result?.total).toBe(140);expect(result?.shortfall).toBe(20);
 expect(result?.inputs.every(n=>n.source.turnId==='turn1')).toBe(true);
 expect(durationCheck('60+?+60 minutes; limit 120 minutes','turn1')).toBeNull();
 expect(durationCheck('60+20+60 minutes; limit 120 hours','turn1')).toBeNull();
 expect(durationCheck('60+20+60 minutes; limit 120 minutes','turn1')?.total).toBe(140);
});
