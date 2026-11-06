import test from 'node:test';
import assert from 'node:assert/strict';
import { readJournalFeed } from '../../src/lib/journal-feed.mjs';

test('published notes and a successful empty result remain distinct from CMS failures', async () => {
  const note={id:'note-id',slug:'a-note',data:{title:'A note',excerpt:'A real published note',publishedAt:'2026-01-01'}};
  assert.deepEqual(await readJournalFeed(async()=>({entries:[note]})),{entries:[{id:'note-id',slug:'a-note',title:'A note',excerpt:'A real published note',publishedAt:'2026-01-01'}],error:false});
  assert.deepEqual(await readJournalFeed(async()=>({entries:[]})),{entries:[],error:false});
  assert.deepEqual(await readJournalFeed(async()=>({entries:[],error:new Error('offline')})),{entries:[],error:true});
  assert.deepEqual(await readJournalFeed(async()=>{throw new Error('offline')}),{entries:[],error:true});
});
