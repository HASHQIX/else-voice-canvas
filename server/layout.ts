export interface Box { x: number; y: number; width: number; height: number }
type LayoutSnapshot = { nodes: Record<string, {kind:string}>; navigation: Array<{parentId:string;childId:string}>; layout: Record<string,Box> };
export const nodeSize = (kind:string) => kind === 'idea' ? {width:380,height:176} : kind === 'question' ? {width:360,height:224} : {width:320,height:144};
const overlap = (a:Box,b:Box) => a.x < b.x+b.width+24 && a.x+a.width+24 > b.x && a.y < b.y+b.height+24 && a.y+a.height+24 > b.y;
/** Preserve all existing geometry; place only new nodes, independent of semantic edges. */
export function layoutNewNodes(snapshot:LayoutSnapshot, lane = 0): Record<string,Box> {
  const layout = structuredClone(snapshot.layout);
  const roots = Object.keys(snapshot.nodes).filter(id=>snapshot.nodes[id].kind === 'idea');
  if (roots[0] && !layout[roots[0]]) layout[roots[0]]={x:-190,y:-88,width:380,height:176};
  const pending = Object.keys(snapshot.nodes).filter(id=>!layout[id]);
  while(pending.length) {
    const index = pending.findIndex(id=>{const parent=snapshot.navigation.find(e=>e.childId===id)?.parentId;return !parent || !!layout[parent];});
    if(index<0) throw new Error('navigation_cycle');
    const id=pending.splice(index,1)[0]; const size=nodeSize(snapshot.nodes[id].kind);
    const parentId=snapshot.navigation.find(e=>e.childId===id)?.parentId;
    const parent=parentId?layout[parentId]:layout[roots[0]];
    const box={...size,x:(parent?parent.x+parent.width/2:0)-size.width/2+lane*520,y:parent?parent.y+parent.height+112:200};
    for(let tries=0;tries<=Object.keys(layout).length;tries++) {
      const conflicts=Object.values(layout).filter(other=>overlap(box,other));
      if(!conflicts.length)break;
      box.y=Math.max(...conflicts.map(other=>other.y+other.height))+112;
    }
    layout[id]=box;
  }
  return layout;
}
