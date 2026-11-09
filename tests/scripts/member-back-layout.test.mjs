import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artCreditForBack, backSvg } from '../../art/collection-art.mjs';

const base={name:'Example',subtitle:'Member edition',collectionName:'Example collection',collectionDescription:'A description.',palette:['#243a2f','#8fbf6a','#f4efe6'],motif:'halftone'};

test('unknown licensing is not presented as a definite claim',()=>{
 const credit='Sourced from the named archive. Not official or licensed. Card design: Foilbury original.';
 assert.equal(artCreditForBack({art:{source:{credit,license:'Not stated by source'}}}),'Sourced from the named archive. Official status and licensing are unverified. Card design: Foilbury original.');
 assert.equal(artCreditForBack({art:{source:{credit,license:'Documented'}}}),credit);
});

test('normal long biographies and source credit use the available space',()=>{
 const bio=Array.from({length:9},(_,i)=>`line${i} ${'word '.repeat(5)}`).join(' ');
 const credit='Character artwork sourced from the named archive for this member collection. Not official or licensed.';
 const svg=backSvg({...base,bio,artCredit:credit,attributes:[{label:'Role',value:'Subject'}]});
 assert.match(svg,/line8/);
 assert.doesNotMatch(svg,/line[0-9][^<]*…/);
 assert.match(svg,/font-size="16" fill="#[0-9a-f]+" opacity="0.94"/i);
 assert.match(svg,/Not official or licensed/);
 assert.doesNotMatch(svg,/<circle cx="650" cy="930"/);
});

test('a four-line attribution is retained in full',()=>{
 const credit='Attribution for the supplied character image in the named archive; the artist and publisher remain unverified. This material is shown in a private member album. The card design was made separately.';
 const svg=backSvg({...base,bio:'Short profile.',artCredit:credit});
 const lines=[...svg.matchAll(/<text x="70" y="\d+"[^>]*font-size="16"[^>]*opacity="0\.94">([^<]*)<\/text>/g)].map(match=>match[1]);
 assert.equal(lines.join(' '),credit);
});

test('overflow is explicit and does not collide with the world section',()=>{
 const attrs=Array.from({length:6},(_,i)=>({label:`Attribute ${i}`,value:'A'.repeat(100)}));
 const svg=backSvg({...base,name:'Very long name '.repeat(12),bio:'Biography '.repeat(150),attributes:attrs,artCredit:'Attribution '.repeat(100)});
 assert.match(svg,/3 more in catalogue/);
 assert.ok((svg.match(/…/g)??[]).length>=4);
 const attrsY=[...svg.matchAll(/<text x="70" y="(\d+)"[^>]*>(?:ATTRIBUTE|3 more)/g)].map(m=>Number(m[1]));
 assert.equal(attrsY.length,4);
 assert.ok(attrsY.every(y=>y<768));
 const creditY=[...svg.matchAll(/<text x="70" y="(\d+)"[^>]*font-size="16"[^>]*opacity="0\.94"/g)].map(m=>Number(m[1]));
 assert.ok(creditY.length<=4 && creditY.every(y=>y>=901 && y<1002));
});
