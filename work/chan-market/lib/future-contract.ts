const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const monthCodes = 'FGHJKMNQUVXZ';
const products:Record<string,{name:string;exchange:string}> = {
  GC:{name:'Gold',exchange:'CMX'}, SI:{name:'Silver',exchange:'CMX'}, CL:{name:'Crude Oil',exchange:'NYM'},
};

/** A continuous ticker alone does not specify this month's listed contract. */
export function yahooFutureContract(symbol:string, metadata:unknown):string|undefined {
  if(!metadata || typeof metadata!=='object')return;
  const meta=metadata as Record<string,unknown>, root=symbol.split('=')[0], product=products[root];
  if(!product || symbol!==root+'=F' || meta.symbol!==symbol || meta.currency!=='USD'
    || meta.instrumentType!=='FUTURE' || meta.exchangeName!==product.exchange || typeof meta.shortName!=='string')return;
  const parts=meta.shortName.trim().match(/^(.+) ([A-Z][a-z]{2}) (\d{2}|20\d{2})$/);
  if(!parts || parts[1]!==product.name || !months.includes(parts[2]))return;
  return root+monthCodes[months.indexOf(parts[2])]+parts[3].slice(-2);
}
