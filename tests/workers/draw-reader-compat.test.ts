import { beforeEach, expect, it } from "vitest";
import { findIdempotent } from "../../src/server/http";
import { bootstrap, ctxFor, runtime } from "./helpers";
import { ApiError } from "../../src/server/context";
import { errorCallback } from "../../src/server/discord/commands";

beforeEach(async () => { await bootstrap(); });

async function insert(status: 'completed'|'failed'|'in_progress', response: string, operation='draw.execute') {
  const ctx=await ctxFor('cabinet','player@foilbury.local');
  await runtime.DB.prepare(`INSERT INTO fb_idempotency_keys
    (tenant_id,actor_type,actor_id,operation,idempotency_key,request_digest,status,response_json,created_at)
    VALUES (?,?,?,?,'reader-test','digest',?,?,?)`)
    .bind(ctx.tenant.id,ctx.actor.type,ctx.actor.id,operation,status,response,new Date().toISOString()).run();
  return ctx;
}

it.each(['failed','in_progress'] as const)('does not return a %s draw row as a receipt',async(status)=>{
  const ctx=await insert(status,'{"kind":"draw_terminal_failure","code":"insufficient_funds","private":"secret"}');
  const error=await findIdempotent(ctx,'draw.execute',{key:'reader-test',digest:'digest'}).catch(e=>e);
  expect(error).toMatchObject({status:503,code:'draw_outcome_unavailable'});
  expect(JSON.stringify(error)).not.toContain('secret');
});

it('keeps a historical completed draw receipt unchanged',async()=>{
  const receipt={draw_id:'old-draw',instance_id:'old-instance',card_name:'Old card',balance_after:12};
  const ctx=await insert('completed',JSON.stringify(receipt));
  expect(await findIdempotent(ctx,'draw.execute',{key:'reader-test',digest:'digest'})).toEqual({response:receipt,replayed:true});
});

it('rejects a conflicting digest before interpreting the stored outcome',async()=>{
  const ctx=await insert('failed','{"kind":"draw_terminal_failure"}');
  await expect(findIdempotent(ctx,'draw.execute',{key:'reader-test',digest:'different'})).rejects.toMatchObject({code:'idempotency_conflict'});
});

it('does not change non-draw operation replay behavior',async()=>{
  const payload={existing:'behavior'};
  const ctx=await insert('failed',JSON.stringify(payload),'other.operation');
  expect(await findIdempotent(ctx,'other.operation',{key:'reader-test',digest:'digest'})).toEqual({response:payload,replayed:true});
});

it.each(['draw_outcome_unavailable','unknown_commit_outcome'])('gives neutral private Discord guidance for %s',code=>{
  const response=errorCallback(new ApiError(503,code,'private provider detail'));
  const body=JSON.stringify(response.data);
  expect(response.data?.flags).toBe(64);
  expect(body).toContain('may have completed');
  expect(body).not.toMatch(/nothing was charged|nothing was changed|private provider detail/i);
});
