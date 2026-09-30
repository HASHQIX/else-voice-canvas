import { describe, it, expect } from 'vitest';
import { ThoughtBuffer } from '../server/turn-state.js';
import { layoutNewNodes } from '../server/layout.js';
describe('ASR thought invariants',()=>{
 it('A04/A05 replaces partial snapshots and deduplicates committed final segments',()=>{
  const s=new ThoughtBuffer();
  s.update({turn_order:0,transcript:'For designers',end_of_turn:false});
  s.update({turn_order:0,transcript:'For designers in small studios',end_of_turn:true});
  expect(s.text).toBe('For designers in small studios');
  expect(s.update({turn_order:0,transcript:s.text,end_of_turn:true})).toBe(false);
  expect(s.commit(s.token())).toBe(true);
  expect(s.update({turn_order:0,transcript:'For designers in small studios',end_of_turn:true})).toBe(false);
  expect(s.text).toBe('');
 });
 it('A09/A10 accepts growing compatible previews, rejects old corrections',()=>{
  const s=new ThoughtBuffer();s.update({turn_order:1,transcript:'An app for designers',end_of_turn:false});const early=s.token();
  s.update({turn_order:1,transcript:'An app for designers to create visual concepts',end_of_turn:false});expect(s.acceptsPreview(early)).toBe(true);
  s.update({turn_order:1,transcript:'An app for designers to create visual concepts, no, for small studios',end_of_turn:false});expect(s.acceptsPreview(early)).toBe(false);
 });
 it('A03 continuation invalidates an unfinished final',()=>{
  const s=new ThoughtBuffer();s.update({turn_order:1,transcript:'Payment for',end_of_turn:true});const final=s.token();
  s.update({turn_order:2,transcript:'each project',end_of_turn:false});expect(s.acceptsFinal(final)).toBe(false);
  s.update({turn_order:2,transcript:'each project',end_of_turn:true});expect(s.text).toBe('Payment for each project');
 });
});
it('stable deterministic layout preserves root and existing positions without overlaps',()=>{
 const s={nodes:{r:{kind:'idea'},a:{kind:'statement'},q:{kind:'question'}},navigation:[{parentId:'r',childId:'a'},{parentId:'a',childId:'q'}],layout:{}};
 const first=layoutNewNodes(s);expect(first).toEqual(layoutNewNodes(s));expect(first.r).toEqual({x:-190,y:-88,width:380,height:176});
 expect(first.q.y).toBe(first.a.y+first.a.height+112);
 expect(layoutNewNodes({...s,layout:first,nodes:{...s.nodes,b:{kind:'statement'}},navigation:[...s.navigation,{parentId:'r',childId:'b'}]}).a).toEqual(first.a);
});
