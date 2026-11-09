import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { listSets } from "../../src/server/modules/catalogue";
import { nowIso } from "../../src/server/db";

describe("bounded public set listing", () => {
  it("keeps D1 statement count bounded at 1, 20 and 100 sets and rejects overload", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local"), player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner), now = nowIso();
    await makeInstance(player, player.user!.id, fixture);
    // This isolated fixture measures exactly the requested number of sets.
    await runtime.DB.prepare("DELETE FROM fb_set_memberships WHERE tenant_id=?").bind(owner.tenant.id).run();
    await runtime.DB.prepare("DELETE FROM fb_set_reward_rules WHERE tenant_id=?").bind(owner.tenant.id).run();
    await runtime.DB.prepare("DELETE FROM fb_sets WHERE tenant_id=?").bind(owner.tenant.id).run();
    const card = await runtime.DB.prepare("SELECT slug,name FROM fb_card_definitions WHERE id=?").bind(fixture.cardId).first<{slug:string;name:string}>();
    const roster = JSON.stringify([[fixture.cardId,card!.slug,card!.name,0]]);
    const measures: Array<{sets:number;queries:number;ms:number}> = [];
    let made = 0;
    for (const size of [1,20,100]) {
      while (made < size) {
        const n = made++, id=`batch_set_${n}`, slug=`batch-set-${n}`, name=`Batch ${n}`;
        await runtime.DB.batch([
          runtime.DB.prepare("INSERT INTO fb_sets (id,tenant_id,slug,name,description,status,version,created_at) VALUES (?,?,?,?,'fixture','published',1,?)").bind(id,owner.tenant.id,slug,name,now),
          runtime.DB.prepare("INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,created_at) VALUES (?,?,?,1,?,?)").bind(`batch_member_${n}`,owner.tenant.id,id,fixture.cardId,now),
          runtime.DB.prepare("INSERT INTO fb_set_reward_rules (id,tenant_id,set_id,set_version,reward_amount,created_at) VALUES (?,?,?,1,1,?)").bind(`batch_rule_${n}`,owner.tenant.id,id,now),
          // Synthetic reviewed-release fixture, never a real approval.
          runtime.DB.prepare("INSERT INTO fb_public_set_releases (id,tenant_id,set_id,set_version,slug,name,description,reward_amount,roster_json,snapshot_hash,review_note,reviewed_by,reviewed_at) VALUES (?,?,?,1,?,?,'fixture',1,?,'fixture','synthetic fixture',?,?)").bind(`batch_release_${n}`,owner.tenant.id,id,slug,name,roster,owner.user!.id,now),
        ]);
      }
      let queries=0;
      const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return(sql:string)=>{queries++;return target.prepare(sql);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
      const start=performance.now();
      const result=await listSets({...player,db},player.user!.id);
      const ms=Math.round(performance.now()-start);
      expect(result).toHaveLength(size);
      expect(result.every(set=>set.progress?.owned===1)).toBe(true);
      measures.push({sets:size,queries,ms});
    }
    expect(measures[0]!.queries).toBe(measures[1]!.queries);
    expect(measures[1]!.queries).toBe(measures[2]!.queries);
    expect(measures[2]!.queries).toBeLessThanOrEqual(12);
    console.info("Public set listing local measurements:",JSON.stringify(measures));
    await runtime.DB.prepare("INSERT INTO fb_sets (id,tenant_id,slug,name,description,status,version,created_at) VALUES ('overload',?,'overload','Overload','fixture','draft',1,?)").bind(owner.tenant.id,now).run();
    // An unreviewed hidden set must not cause a public overload oracle.
    expect(await listSets(player,player.user!.id)).toHaveLength(100);
    await runtime.DB.prepare("UPDATE fb_sets SET status='published' WHERE id='overload'").run();
    await runtime.DB.prepare("INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,created_at) VALUES ('overload_member',?,'overload',1,?,?)").bind(owner.tenant.id,fixture.cardId,now).run();
    await runtime.DB.prepare("INSERT INTO fb_set_reward_rules (id,tenant_id,set_id,set_version,reward_amount,created_at) VALUES ('overload_rule',?,'overload',1,1,?)").bind(owner.tenant.id,now).run();
    await runtime.DB.prepare("INSERT INTO fb_public_set_releases (id,tenant_id,set_id,set_version,slug,name,description,reward_amount,roster_json,snapshot_hash,review_note,reviewed_by,reviewed_at) VALUES ('overload_release',?,'overload',1,'overload','Overload','fixture',1,?,'fixture','synthetic fixture',?,?)").bind(owner.tenant.id,roster,owner.user!.id,now).run();
    await expect(listSets(player,player.user!.id)).rejects.toMatchObject({code:"set_list_overloaded"});
  });
});
