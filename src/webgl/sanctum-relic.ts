import * as THREE from 'three';
import type { CouncilMemberRef } from '../types.js';
import { councilRelicFaces, signalRelicFaces, relicMaterial, type RelicFaces } from '../sanctum-art.js';

/** Shared code-native master: beveled, milled metal surrounding an inset portrait. */
export function createSanctumRelic(member?:CouncilMemberRef):THREE.Group {
  const faces=member?councilRelicFaces(member):signalRelicFaces(),profile=relicMaterial(member);
  const rim=new THREE.MeshStandardMaterial({color:profile.metal,metalness:.86,roughness:profile.roughness,envMapIntensity:1.1});
  const body=new THREE.MeshStandardMaterial({color:profile.dark,metalness:.8,roughness:.48});
  const group=new THREE.Group();
  const wall=new THREE.CylinderGeometry(1,1,.24,48,1,true);wall.rotateX(Math.PI/2);group.add(new THREE.Mesh(wall,body));
  const textures=[faces.front,faces.back].map(c=>{const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;});
  const disc=new THREE.CircleGeometry(.995,48);
  for(let i=0;i<2;i++) {
    const m=new THREE.MeshStandardMaterial({map:textures[i],metalness:.16,roughness:.68,envMapIntensity:.35});
    const face=new THREE.Mesh(disc,m);face.position.z=i===0?.125:-.125;if(i)face.rotation.y=Math.PI;group.add(face);
  }
  const bead=new THREE.TorusGeometry(.985,.035,6,48);
  for(const z of [-.13,.13]){const ring=new THREE.Mesh(bead,rim);ring.position.z=z;group.add(ring);}
  group.userData.relic={faces,textures,revision:faces.revision,member};
  group.traverse(o=>{if(o instanceof THREE.Mesh)o.castShadow=o.receiveShadow=true;});
  return group;
}
/** Updates the shared texture when a slow portrait arrives, including existing clones. */
export function updateSanctumRelic(source:THREE.Group):void {
  const data=source.userData.relic as {faces:RelicFaces;textures:THREE.CanvasTexture[];revision:number;member?:CouncilMemberRef};
  if(data.member)councilRelicFaces(data.member);
  if(data.revision!==data.faces.revision){for(const t of data.textures)t.needsUpdate=true;data.revision=data.faces.revision;}
}
export function disposeSanctumRelic(source:THREE.Group):void {
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();
  source.traverse(o=>{if(o instanceof THREE.Mesh){geometries.add(o.geometry);materials.add(o.material as THREE.Material);}});
  for(const g of geometries)g.dispose();for(const m of materials)m.dispose();
  for(const t of source.userData.relic.textures as THREE.Texture[])t.dispose();
}
