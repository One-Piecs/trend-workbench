"use client";
import {useEffect,useCallback,useState,useRef} from 'react';
import type {MarketData} from '@/lib/market-types';
import type {MarketForecast} from '@/lib/forecast-types';
import type {DirectionBook} from '@/lib/direction-scorecard';
import {openDirectionStore,loadDirectionBooks,saveDirectionSnapshot} from '@/lib/direction-storage';

export function useDirectionScorecard() {
  const [records,setRecords]=useState<DirectionBook[]>([]),[saved,setSaved]=useState(true);
  const store=useRef<Promise<IDBDatabase>|null>(null),updates=useRef<BroadcastChannel|null>(null);
  useEffect(()=>{
    const opening=openDirectionStore();
    store.current=opening;
    const sync=async()=>{
      try{
        const books=await loadDirectionBooks(await opening);
        if(store.current===opening)setRecords(books);
      }catch{if(store.current===opening)setSaved(false);}
    };
    const channel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('trend-direction-scorecard-v1');
    updates.current=channel;
    if(channel)channel.onmessage=sync;
    void sync();
    return ()=>{
      store.current=null;updates.current=null;channel?.close();
      void opening.then(db=>db.close()).catch(()=>{});
    };
  },[]);
  const observe=useCallback((data:MarketData,forecast:MarketForecast,recordNew:boolean)=>{
    const opening=store.current,now=Date.now()/1000;
    if(!opening)return;
    void opening.then(async db=>{
      if(opening!==store.current)return;
      if(await saveDirectionSnapshot(db,data,forecast,recordNew,now)){
        const books=await loadDirectionBooks(db);
        if(opening===store.current){setRecords(books);setSaved(true);updates.current?.postMessage('changed');}
      }
    }).catch(()=>{if(opening===store.current)setSaved(false);});
  },[]);
  return {records,saved,observe};
}
