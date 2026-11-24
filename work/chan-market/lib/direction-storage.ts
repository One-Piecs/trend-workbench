import type {MarketData} from './market-types.ts';
import type {MarketForecast} from './forecast-types.ts';
import {directionFeed,directionVersion,emptyDirectionBook,prepareDirectionBars,updateDirectionBook,type DirectionBook} from './direction-scorecard.ts';

export function openDirectionStore():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('trend-direction-scorecard-v1',1);
    request.onupgradeneeded=()=>{
      request.result.createObjectStore('books',{keyPath:'series'}).createIndex('by-feed','feed');
      request.result.createObjectStore('observations',{keyPath:'id'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
export function loadDirectionBooks(db:IDBDatabase):Promise<DirectionBook[]> {
  return new Promise((resolve,reject)=>{
    const req=db.transaction('books').objectStore('books').getAll();
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
export function saveDirectionSnapshot(db:IDBDatabase,data:MarketData,forecast:MarketForecast,recordNew:boolean,now:number):Promise<boolean> {
  const prepared=prepareDirectionBars(data,now);
  if(!prepared)return Promise.resolve(false);
  const feed=directionFeed(data),version=directionVersion(forecast);
  return new Promise((resolve,reject)=>{
    // The read and write share one transaction. Multiple tabs observing the
    // same candle freeze the first prediction and cannot count it twice.
    const tx=db.transaction(['books','observations'],'readwrite');
    const books=tx.objectStore('books'),observations=tx.objectStore('observations');
    let changed=false;
    const read=books.index('by-feed').getAll(feed);
    read.onsuccess=()=>{
      const cohorts:DirectionBook[]=read.result;
      if(recordNew&&!cohorts.some(b=>b.version===version))cohorts.push(emptyDirectionBook(data,version));
      for(const cohort of cohorts){
        const result=updateDirectionBook(cohort,prepared,data,recordNew&&cohort.version===version?forecast:null,now);
        if(!result)continue;
        books.put(result.book);
        for(const row of result.rows)observations.put(row);
        changed=true;
      }
    };
    tx.oncomplete=()=>resolve(changed);
    tx.onerror=tx.onabort=()=>reject(tx.error??new Error('Direction observations could not be saved.'));
  });
}
