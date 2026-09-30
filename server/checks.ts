/** Only computes explicitly written arithmetic with an explicit, same-unit limit. */
export function durationCheck(text:string, turnId:string) {
  const expression=text.match(/\b(\d+(?:\s*\+\s*\d+){1,12})\s*(minutes?|mins?)\b/iu);
  const limit=text.match(/(?:limit|budget|available|no more than)\s*(?:of|:|=)?\s*(\d+)\s*(minutes?|mins?)\b/iu);
  if(!expression||!limit)return null;
  const values=expression[1].split('+').map(s=>Number(s.trim()));
  const maximum=Number(limit[1]);
  if(values.some(n=>!Number.isSafeInteger(n)||n<0)||!Number.isSafeInteger(maximum))return null;
  const total=values.reduce((sum,n)=>sum+n,0);
  return {inputs:values.map(value=>({value,unit:'minutes',source:{turnId,quote:expression[0]}})),limit:{value:maximum,unit:'minutes',source:{turnId,quote:limit[0]}},formula:values.join(' + '),total,shortfall:Math.max(0,total-maximum)};
}
