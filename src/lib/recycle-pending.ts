/** Browser-origin storage for one explicitly confirmed recycle per account and copy.
 * IndexedDB read/write transactions serialize competing tabs; no credentials are stored. */
export interface PendingRecycle<T> { key:string; preview:T }

function database():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    let blocked=false;
    const request=indexedDB.open('foilbury-recycle-recovery-v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('pending');
    request.onsuccess=()=>{if(blocked) request.result.close(); else resolve(request.result);};
    request.onerror=()=>reject(request.error ?? new Error('Recovery storage is unavailable.'));
    request.onblocked=()=>{blocked=true;reject(new Error('Recovery storage is unavailable.'));};
  });
}

async function transact<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore,set:(value:T)=>void)=>void):Promise<T> {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('pending',mode);let result:T;
    tx.oncomplete=()=>{db.close();resolve(result);};
    tx.onerror=()=>{db.close();reject(tx.error ?? new Error('Recovery storage is unavailable.'));};
    tx.onabort=()=>{db.close();reject(tx.error ?? new Error('Recovery storage is unavailable.'));};
    try {run(tx.objectStore('pending'),value=>{result=value;});} catch(error) {tx.abort();reject(error);}
  });
}

export function readRecyclePending<T>(scope:string):Promise<PendingRecycle<T>|null> {
  return transact('readonly',(store,set)=>{const request=store.get(scope);request.onsuccess=()=>set(request.result ?? null);});
}

export function reserveRecyclePending<T>(scope:string,candidate:PendingRecycle<T>):Promise<{pending:PendingRecycle<T>;created:boolean}> {
  return transact('readwrite',(store,set)=>{const request=store.get(scope);request.onsuccess=()=>{
    if (request.result) {set({pending:request.result,created:false});return;}
    store.add(candidate,scope);set({pending:candidate,created:true});
  };});
}

export function clearRecyclePending(scope:string,key:string):Promise<void> {
  return transact('readwrite',(store,set)=>{const request=store.get(scope);request.onsuccess=()=>{
    if (request.result?.key===key) store.delete(scope);
    set(undefined);
  };});
}
