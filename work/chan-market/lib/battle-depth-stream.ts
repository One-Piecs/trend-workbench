import {readBattleBook,type BattleBook,type BattleSnapshot} from './battle-tape.ts';

/** Both channels send whole books; accepting only newer frames avoids rebuilding a partial delta book. */
export function subscribeBattleDepth(symbol:string,venue:BattleSnapshot['source'],publish:(value:BattleBook|null)=>void) {
  const primary=venue==='Binance',pair=symbol.slice(0,-4)+'-USDT';
  let socket:WebSocket|undefined,closed=false,lastSequence=0,failures=0,lastPaint=0;
  let retry:number|undefined,deadline:number|undefined,heartbeat:number|undefined;
  function disconnect(){
    window.clearTimeout(deadline);window.clearInterval(heartbeat);
    if(socket){
      socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;
      socket.close();socket=undefined;
    }
  }
  function lost(){
    disconnect();
    if(closed)return;
    publish(null);
    retry=window.setTimeout(connect,Math.min(30000,1500*2**Math.min(failures++,5)));
  }
  function watchdog(ms:number){window.clearTimeout(deadline);deadline=window.setTimeout(lost,ms);}
  function connect(){
    if(closed)return;
    try{socket=new WebSocket(primary?'wss://data-stream.binance.vision/ws/'+symbol.toLowerCase()+'@depth20@100ms':'wss://ws.okx.com:8443/ws/v5/public');}
    catch{lost();return;}
    const current=socket;
    lastSequence=0;lastPaint=0;watchdog(12000);
    current.onopen=()=>{
      if(primary)return;
      try{current.send(JSON.stringify({op:'subscribe',args:[{channel:'books5',instId:pair}]}));}catch{lost();return;}
      heartbeat=window.setInterval(()=>{try{current.send('ping');}catch{lost();}},20000);
    };
    current.onmessage=event=>{
      if(typeof event.data!=='string'||event.data==='pong')return;
      try{
        const raw=JSON.parse(event.data),now=Date.now();
        if(!raw||typeof raw!=='object')return;
        if(raw.event==='error'){lost();return;}
        if(!primary&&(raw.arg?.channel!=='books5'||raw.arg?.instId!==pair||!Array.isArray(raw.data)||raw.data.length!==1))return;
        const sequence=primary?raw.lastUpdateId:Number(raw.data[0]?.seqId??raw.data[0]?.ts);
        if(!Number.isSafeInteger(sequence)||sequence<=lastSequence)return;
        // Publish the latest complete book at most four times per second.
        // Accept the next packet after the interval instead of accumulating frames.
        if(now>=lastPaint&&now-lastPaint<250)return;
        const book=readBattleBook(primary?raw:{code:'0',data:raw.data},venue,now,now,primary?20:5);
        if(!book)return;
        lastSequence=sequence;lastPaint=now;failures=0;
        watchdog(10000);publish(book);
      }catch{/* Ignore malformed upstream frames. */}
    };
    current.onerror=current.onclose=lost;
  }
  connect();
  return ()=>{closed=true;window.clearTimeout(retry);disconnect();};
}
