import { describe, expect, it } from 'vitest';
import { mapPoolPreviews } from '../../src/server/modules/wishlist-paths';

describe('Wishlist pool preview scheduling', () => {
  it('starts at most four previews concurrently while preserving pool order', async () => {
    const started:number[]=[], release=new Map<number,()=>void>();let active=0,peak=0;
    const result=mapPoolPreviews([0,1,2,3,4,5,6,7],async item=>{
      started.push(item);active++;peak=Math.max(peak,active);
      await new Promise<void>(resolve=>release.set(item,resolve));active--;return item*2;
    });
    await Promise.resolve();expect(started).toEqual([0,1,2,3]);
    for(const item of [3,1,2,0])release.get(item)!();
    await viWaitUntil(()=>started.length===8);
    for(const item of [7,5,6,4])release.get(item)!();
    expect(await result).toEqual([0,2,4,6,8,10,12,14]);expect(peak).toBe(4);
  });

  it('propagates preview errors instead of reporting no eligible pools', async () => {
    const started:number[]=[];
    await expect(mapPoolPreviews([1,2,3,4,5,6],async item=>{started.push(item);if(item===2)throw new Error('preview unavailable');return item;})).rejects.toThrow('preview unavailable');
    expect(started).toEqual([1,2,3,4]);
  });
});

async function viWaitUntil(predicate:()=>boolean) {
  for(let i=0;i<20&&!predicate();i++) await Promise.resolve();
  expect(predicate()).toBe(true);
}
