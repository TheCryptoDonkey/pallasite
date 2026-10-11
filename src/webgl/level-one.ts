import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Asteroid, Coin, GameState, Mine, Ship, Ufo } from '../types.js';
import { POWERUP_CONFIG } from '../types.js';
import { SHIP_BLENDER_SCALE, PICKUP_ART_SCALE, PICKUP_KINDS, DEBRIS_KINDS, debrisKind, debrisScale, COLLECTABLE_KINDS, COLLECTABLE_ART_SCALE, collectableAlpha, collectablePhase, stationArt, PICKUP_ART_REVISION } from '../level-one-art.js';
import { livePlayerBursts, playerShard, playerBurstDuration, type PlayerBurst } from '../level-one-death.js';
import { ULTRA_ROCKS, ULTRA_UFOS, ULTRA_PILOT_COLOURS } from '../ultra-materials.js';
import { MINERAL_SHARDS, DEFAULT_SHARD_TYPE, SHARD_VERTICES, SHARD_FACES, shardAccentFace } from '../mineral-shards.js';

/** Critically damped presentation, with a bounded angular speed. */
function easeAngle(model:THREE.Group,key:string,target:number,dt:number):number {
  const current=model.userData[key]??target,velocity=model.userData[`${key}Velocity`]??0,omega=8;
  const error=current-target,term=velocity+omega*error,decay=Math.exp(-omega*dt);
  const next=target+(error+term*dt)*decay;
  model.userData[`${key}Velocity`]=THREE.MathUtils.clamp((velocity-omega*term*dt)*decay,-2.8,2.8);
  return model.userData[key]=current+THREE.MathUtils.clamp(next-current,-2.8*dt,2.8*dt);
}

export async function createLevelOneRenderer() {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true});
  renderer.setClearColor(0,0); renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  // A small, baked reflection environment gives metal and glass readable
  // highlights without another per-frame pass or a full-screen bloom buffer.
  const envCanvas = document.createElement('canvas'); envCanvas.width=512; envCanvas.height=256;
  const ec = envCanvas.getContext('2d')!; ec.fillStyle='#070c13'; ec.fillRect(0,0,512,256);
  for (const [x,y,r,color] of [[70,65,80,'#dcc7a3'],[340,180,100,'#3a7994'],[480,80,45,'#b67237']] as const) {
    const g=ec.createRadialGradient(x,y,0,x,y,r); g.addColorStop(0,color); g.addColorStop(1,'#070c13');
    ec.fillStyle=g; ec.fillRect(x-r,y-r,r*2,r*2);
  }
  const env = new THREE.CanvasTexture(envCanvas); env.mapping=THREE.EquirectangularReflectionMapping; env.colorSpace=THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer); const reflection=pmrem.fromEquirectangular(env);
  scene.environment=reflection.texture; env.dispose(); pmrem.dispose();
  const camera = new THREE.OrthographicCamera(0,1280,720,0,.1,4000);
  camera.position.set(0,0,1500); camera.lookAt(0,0,0);
  scene.add(new THREE.HemisphereLight(0xc1d2d8,0x231b13,.72));
  const key = new THREE.DirectionalLight(0xffefd7,4.6);
  // A high, oblique sun keeps flying-body shadows close to the rock they
  // cross. The same light shades the actual surfaces and casts the shadow.
  key.position.set(340,720,1800); key.target.position.set(640,360,0); key.castShadow=true;
  key.shadow.mapSize.set(2048,2048);
  Object.assign(key.shadow.camera,{left:-900,right:900,top:900,bottom:-900,near:1,far:4000});
  key.shadow.bias=-.0002; key.shadow.normalBias=.2; scene.add(key,key.target);
  const rim = new THREE.DirectionalLight(0x79bed0,.85); rim.position.set(1000,-200,300); scene.add(rim);
  const back = new THREE.DirectionalLight(0xffb987,.45); back.position.set(800,600,-300); scene.add(back);
  let source: THREE.Group, shipSource: THREE.Group, ufoSource: THREE.Group;
  const loader = new GLTFLoader();
  const names=['stony-cinematic','ship-cinematic','ufo-cinematic',...PICKUP_KINDS.map(k=>`pickup-${k}`),...DEBRIS_KINDS.map(k=>`debris-${k}`),...COLLECTABLE_KINDS.map(k=>`collectable-${k}`)];
  const loaded = await Promise.allSettled(names.map(name => loader.loadAsync(`/graphics/level-one/${name}.glb${name.startsWith('pickup-')?`?art=${PICKUP_ART_REVISION}`:''}`)));
  if (loaded.some(r=>r.status==='rejected')) {
    for (const r of loaded) if (r.status==='fulfilled') disposeModel(r.value.scene);
    reflection.dispose(); renderer.dispose(); throw new Error('Level one model unavailable');
  }
  source=(loaded[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof loader.loadAsync>>>).value.scene;
  shipSource=(loaded[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof loader.loadAsync>>>).value.scene;
  ufoSource=(loaded[2] as PromiseFulfilledResult<Awaited<ReturnType<typeof loader.loadAsync>>>).value.scene;
  const pickupSources=loaded.slice(3,3+PICKUP_KINDS.length).map(r=>(r as PromiseFulfilledResult<Awaited<ReturnType<typeof loader.loadAsync>>>).value.scene);
  const fragmentSources=loaded.slice(3+PICKUP_KINDS.length,3+PICKUP_KINDS.length+DEBRIS_KINDS.length).map(r=>(r as PromiseFulfilledResult<Awaited<ReturnType<typeof loader.loadAsync>>>).value.scene);
  const collectableSources=loaded.slice(3+PICKUP_KINDS.length+DEBRIS_KINDS.length).map(r=>(r as PromiseFulfilledResult<Awaited<ReturnType<typeof loader.loadAsync>>>).value.scene);
  for(const model of [...pickupSources,...fragmentSources]) {
    model.rotation.x=Math.PI/2;model.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=o.receiveShadow=true;(o.material as THREE.MeshStandardMaterial).envMapIntensity=.8;}});
  }
  // One instanced draw per authored material, independent of pickup count.
  // Overflow remains visible through the baked renderer; no extra lights.
  const collectableCapacity=256,shownCollectables=new Set<Coin>();
  const collectableBatches=collectableSources.map((authored,kind)=>{
    const mineral=COLLECTABLE_KINDS[kind]==='dust';
    let model=authored;
    if(mineral) {
      // Two shared instanced facet batches for every mineral, regardless of count.
      model=new THREE.Group();
      for(const accent of [false,true]) {
        const positions=SHARD_FACES.flatMap((face,i)=>shardAccentFace(i)===accent?face.flatMap(v=>[...SHARD_VERTICES[v]]):[]);
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();
        model.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0xffffff,metalness:.3,roughness:.5})));
      }
      disposeModel(authored);
    } else model.rotation.x=Math.PI/2;
    model.updateMatrixWorld(true);
    const byMaterial=new Map<THREE.MeshStandardMaterial,THREE.BufferGeometry[]>();
    model.traverse(o=>{if(o instanceof THREE.Mesh){
      const material=o.material as THREE.MeshStandardMaterial;
      const geometry=(o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone()).applyMatrix4(o.matrixWorld);
      for(const name of Object.keys(geometry.attributes))if(name!=='position'&&name!=='normal')geometry.deleteAttribute(name);
      const list=byMaterial.get(material)??[];list.push(geometry);byMaterial.set(material,list);
    }});
    const result=[...byMaterial].map(([original,parts],batch)=>{
      const geometry=mergeGeometries(parts)!;for(const part of parts)part.dispose();
      const opacity=new THREE.InstancedBufferAttribute(new Float32Array(collectableCapacity),1);geometry.setAttribute('collectableAlpha',opacity);
      const surface=new THREE.InstancedBufferAttribute(new Float32Array(collectableCapacity*2),2);
      if(mineral)geometry.setAttribute('mineralSurface',surface);
      const material=original.clone();material.envMapIntensity=1;material.transparent=true;material.depthWrite=true;material.forceSinglePass=true;
      material.onBeforeCompile=shader=>{
        shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float collectableAlpha; varying float vCollectableAlpha;').replace('#include <begin_vertex>','#include <begin_vertex>\nvCollectableAlpha=collectableAlpha;');
        shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying float vCollectableAlpha;').replace('#include <alphatest_fragment>','diffuseColor.a *= vCollectableAlpha;\n#include <alphatest_fragment>');
        if(mineral) {
          shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec2 mineralSurface; varying vec2 vMineralSurface;').replace('#include <begin_vertex>','#include <begin_vertex>\nvMineralSurface=mineralSurface;');
          shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 vMineralSurface;')
            .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=vMineralSurface.y;')
            .replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=vMineralSurface.x;');
        }
      };
      material.customProgramCacheKey=()=>mineral?'mineral-shard-1':'sat-coin-1';
      const mesh=new THREE.InstancedMesh(geometry,material,collectableCapacity);mesh.count=0;mesh.frustumCulled=false;mesh.receiveShadow=true;scene.add(mesh);
      if(mineral)mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(collectableCapacity*3),3);
      return {mesh,opacity,surface,accent:mineral&&batch===1};
    });
    disposeModel(model);return result;
  });
  const collectablePose=new THREE.Object3D(),mineralColour=new THREE.Color();let collectableInstances=0;
  const shownShardTypes=new Set<string>();
  const pickups=new Map<GameState['powerups'][number],THREE.Group>();
  const debris=new Map<GameState['debris'][number],THREE.Group>();
  ufoSource.rotation.x=Math.PI/2;
  ufoSource.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=o.receiveShadow=true;(o.material as THREE.MeshStandardMaterial).envMapIntensity=.85;}});
  // Later classes/hardware load on first encounter, sharing this scene,
  // environment and shadow map. Failed additions retain their baked art.
  const extraSources=new Map<string,THREE.Group>(),extraPending=new Set<string>();
  let councilArt:typeof import('./overlay.js')|undefined,councilLoading=false;
  const councilSources=new Map<string,THREE.Group>();
  function council(member:NonNullable<Asteroid['councilMember']>):THREE.Group|undefined {
    if(!councilArt){if(!councilLoading){councilLoading=true;void import('./overlay.js').then(m=>{councilArt=m;});}return;}
    const id=`${member.pubkey??member.name}:${member.img}`;
    let model=councilSources.get(id);
    if(!model){
      const rim=new THREE.MeshStandardMaterial({color:0xe5ad52,metalness:.88,roughness:.25,envMapIntensity:1});
      const face=new THREE.MeshStandardMaterial({map:councilArt.getCouncilFrontTexture(member),metalness:.2,roughness:.42});
      const back=new THREE.MeshStandardMaterial({map:councilArt.getCouncilBackTexture(member),metalness:.3,roughness:.38});
      const disc=new THREE.CylinderGeometry(1,1,.25,64);disc.rotateX(Math.PI/2);
      model=new THREE.Group();model.add(new THREE.Mesh(disc,[rim,face,back]));
      const ring=new THREE.TorusGeometry(.98,.025,6,64);
      for(const z of [-.135,.135]){const bead=new THREE.Mesh(ring,rim);bead.position.z=z;model.add(bead);}
      model.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=o.receiveShadow=true;}});
      councilSources.set(id,model);
    }
    return model;
  }
  let disposed=false;
  function extra(name:string):THREE.Group|undefined {
    if(!extraSources.has(name)&&!extraPending.has(name)) {
      extraPending.add(name);
      void loader.loadAsync(`/graphics/level-one/${name}.glb`).then(g=>{
        if(disposed){disposeModel(g.scene);return;}
        g.scene.rotation.x=Math.PI/2;
        g.scene.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=o.receiveShadow=true;(o.material as THREE.MeshStandardMaterial).envMapIntensity=.8;}});
        extraSources.set(name,g.scene);
      }).catch(()=>{/* Baked fallback stays visible, without retrying per frame. */});
    }
    return extraSources.get(name);
  }
  const shownRocks=new Set<Asteroid>(),shownUfos=new Set<Ufo>(),shownShips=new Set<Ship>(),shownPickups=new Set<GameState['powerups'][number]>(),shownMines=new Set<Mine>();
  const mineModels=new Map<Mine,THREE.Group>();
  const rockCapacity=48,ufoCapacity=16,pickupCapacity=24,shipCapacity=8,mineCapacity=16;
  const ufos=new Map<string,THREE.Group>();
  source.rotation.x = Math.PI / 2;
  source.traverse(obj => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = obj.receiveShadow = true;
      const material = obj.material as THREE.MeshStandardMaterial;
      material.envMapIntensity=.25;
      for (const map of [material.map,material.normalMap]) if (map) map.anisotropy = Math.min(8,renderer.capabilities.getMaxAnisotropy());
    }
  });
  // Blender's numerous armour plates and fasteners become one draw per
  // material. Preserve their geometry and self-shadowing, share it on wrap.
  shipSource.rotation.x=Math.PI/2; shipSource.updateMatrixWorld(true);
  const batches=new Map<THREE.Material,THREE.BufferGeometry[]>();
  shipSource.traverse(obj=>{if(obj instanceof THREE.Mesh) {
    const mat=obj.material as THREE.MeshStandardMaterial; mat.envMapIntensity=.8;
    const geometry=(obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone()).applyMatrix4(obj.matrixWorld);
    for(const name of Object.keys(geometry.attributes)) if(name!=='position' && name!=='normal') geometry.deleteAttribute(name);
    const list=batches.get(mat) ?? []; list.push(geometry); batches.set(mat,list);
  }});
  const shipBody=new THREE.Group();
  for (const [material,geometries] of batches) {
    const geometry=mergeGeometries(geometries)!; const mesh=new THREE.Mesh(geometry,material);
    mesh.castShadow=mesh.receiveShadow=true; shipBody.add(mesh); for(const g of geometries) g.dispose();
  }
  shipSource.traverse(o=>{if(o instanceof THREE.Mesh)o.geometry.dispose();});
  const ships=new Map<string,THREE.Group>();
  const shieldGeometry=new THREE.SphereGeometry(1,40,24);
  const shieldMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,
    uniforms:{time:{value:0},hit:{value:0},fade:{value:1}},
    vertexShader:`varying vec3 n; varying vec3 v; varying vec2 vUv;
      void main(){vUv=uv;n=normalize(normalMatrix*normal);vec4 p=modelViewMatrix*vec4(position,1.);v=-p.xyz;gl_Position=projectionMatrix*p;}`,
    fragmentShader:`uniform float time;uniform float hit;uniform float fade;varying vec3 n;varying vec3 v;varying vec2 vUv;
      void main(){float rim=pow(1.-abs(dot(normalize(n),normalize(v))),2.2);
      vec2 p=vUv*vec2(24.,14.);vec2 grid=vec2(1.732,3.);
      vec2 a=mod(p,grid)-grid*.5;vec2 b=mod(p-grid*.5,grid)-grid*.5;vec2 q=dot(a,a)<dot(b,b)?a:b;
      float d=max(dot(abs(q),vec2(.866,.5)),abs(q.y));float hex=smoothstep(.78,.87,d);
      float ripple=pow(max(0.,sin(vUv.y*38.-time*5.)),12.)*hit;
      vec3 color=mix(vec3(.18,.67,1.),vec3(.75,1.,1.),rim+hit*.5);
      gl_FragColor=vec4(color,fade*(.025+rim*.5+hex*.13*rim+hit*.18+ripple*.25));}`
  });
  const shields=new Map<string,THREE.Mesh>();
  const engineLight=new THREE.PointLight(0x57cfff,0,80,2); const muzzleLight=new THREE.PointLight(0xffd6a0,0,75,2);
  const ufoLight=new THREE.PointLight(0x666bff,0,100,2),deathLight=new THREE.PointLight(0xffd4a1,0,230,2);
  scene.add(engineLight,muzzleLight,ufoLight,deathLight);
  // Two cached, banked light plates sit below the actual belly. Their halo
  // spills beyond the rim while the hull naturally occludes the blue core.
  const underglowGeometry=new THREE.PlaneGeometry(1,1);
  function driveGlow(color:string):THREE.CanvasTexture {
    const c=document.createElement('canvas');c.width=c.height=64;
    const ctx=c.getContext('2d')!,g=ctx.createRadialGradient(32,32,0,32,32,32);
    g.addColorStop(0,color);g.addColorStop(.3,color);g.addColorStop(1,'transparent');
    ctx.fillStyle=g;ctx.fillRect(0,0,64,64);
    const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;return texture;
  }
  const underglowTextures=[driveGlow('#7952ee'),driveGlow('#326fff')];
  const underglowMaterials=underglowTextures.map((map,i)=>new THREE.MeshBasicMaterial({map,transparent:true,opacity:i?.65:.55,
    blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,forceSinglePass:true}));
  const driveCentre=new THREE.Vector3();
  // Small extra shards reuse one real Blender wing primitive in one batch.
  let shardGeometry:THREE.BufferGeometry|undefined;
  fragmentSources[0].traverse(o=>{if(o instanceof THREE.Mesh&&(!shardGeometry||o.geometry.attributes.position.count>shardGeometry.attributes.position.count))shardGeometry=o.geometry;});
  const shardMaterial=new THREE.MeshStandardMaterial({color:0x9faeb4,metalness:.78,roughness:.32,envMapIntensity:.8});
  const shrapnel=new THREE.InstancedMesh(shardGeometry!,shardMaterial,72);shrapnel.count=0;shrapnel.frustumCulled=false;shrapnel.castShadow=shrapnel.receiveShadow=true;scene.add(shrapnel);
  const shardPose=new THREE.Object3D();let deathBursts=0,finalDeathBursts=0;
  const objects = new Map<string,THREE.Group>();
  const axis = new THREE.Vector3(); const initial = new THREE.Quaternion(); const euler = new THREE.Euler();
  const hitColor = new THREE.Color(0xffd9bc);
  let size = '';
  let animationTime=0,lastElapsed:number|undefined;
  let renderedWave=0;
  function render(s: GameState, width: number, height: number, m: DOMMatrix, xs: number[], ys: number[], shadows: boolean, now: number, reducedMotion: boolean, bursts:ReadonlyArray<PlayerBurst>=livePlayerBursts(s)): void {
    renderedWave=s.wave;
    if(renderer.getContext().isContextLost()) throw new Error('Level one WebGL context lost');
    // elapsed also advances while the game's pause menu is open. Keep this
    // cosmetic clock local so a paused comparison holds the same 3D pose.
    if(lastElapsed===undefined||s.elapsed<lastElapsed)animationTime=s.elapsed;
    else if(s.phase!=='paused')animationTime+=s.elapsed-lastElapsed;
    lastElapsed=s.elapsed;
    // Cap the additional render surface independently of retina window size.
    const ratio = Math.min(1, Math.sqrt(2560*1440/(width*height)));
    const w = Math.round(width*ratio), h = Math.round(height*ratio);
    if (size !== `${w}:${h}`) { size = `${w}:${h}`; renderer.setSize(w,h,false); }
    camera.left = -m.e/m.a; camera.right = (width-m.e)/m.a;
    camera.top = 720+m.f/m.d; camera.bottom = 720-(height-m.f)/m.d; camera.updateProjectionMatrix();
    renderer.shadowMap.enabled = shadows;
    shownRocks.clear();shownUfos.clear();shownShips.clear();shownPickups.clear();shownMines.clear();
    // Follow the visible camera in large arenas; a fixed campaign shadow box
    // would otherwise leave remote deathmatch cover and ships unshadowed.
    key.target.position.set((camera.left+camera.right)/2,(camera.top+camera.bottom)/2,0);
    key.position.copy(key.target.position).add(new THREE.Vector3(-300,360,1800));
    const seen = new Set<string>();
    for (let index = 0; index < s.asteroids.length; index++) {
      const a = s.asteroids[index];
      const rockId = a.id ?? index;
      if (!a.alive || (a.depth??3) !== 3) continue;
      const profile=ULTRA_ROCKS[a.type];
      const rockSource=a.councilMember?council(a.councilMember):a.stationPart?extra(stationArt(a,s.wave)):profile.source==='stony'?source:extra('pallasite-cinematic');
      if(!rockSource)continue;
      // Reserve every visible seam copy together; overflow remains baked.
      let copies=0;for(const dx of xs)for(const dy of ys){const x=a.pos.x+dx,y=720-a.pos.y-dy,r=a.radius*1.5;
        if(x+r>=camera.left&&x-r<=camera.right&&y+r>=camera.bottom&&y-r<=camera.top)copies++;}
      if(seen.size+copies>rockCapacity)continue;
      for (const dx of xs) for (const dy of ys) {
        const x = a.pos.x+dx, y = a.pos.y+dy;
        if (x+a.radius*1.3 < camera.left || x-a.radius*1.3 > camera.right
          || 720-y+a.radius*1.3 < camera.bottom || 720-y-a.radius*1.3 > camera.top) continue;
        const id = `${rockId}:${a.councilMember?.name??(a.stationPart?stationArt(a,s.wave):a.type)}:${dx}:${dy}`; seen.add(id);shownRocks.add(a);
        let model = objects.get(id);
        if (!model) {
          model = new THREE.Group(); model.add(rockSource.clone(true));
          // Shared immutable textures/geometry, small per-body material only.
          model.traverse(obj => { if (obj instanceof THREE.Mesh) {
            const convert=(original:THREE.MeshStandardMaterial)=>{const material=original.clone();
              if(!a.stationPart&&!a.councilMember){material.color.multiply(new THREE.Color(profile.color));material.metalness=profile.metal;material.roughness=profile.rough;}
              material.userData.baseEmission=material.emissive.clone();material.userData.baseStrength=material.emissiveIntensity;return material;};
            obj.material = Array.isArray(obj.material)?obj.material.map(m=>convert(m as THREE.MeshStandardMaterial)):convert(obj.material as THREE.MeshStandardMaterial);
          } });
          objects.set(id,model); scene.add(model);
        }
        // Pods sit above the radial beams, so their lenses and armour remain
        // visible where the rig joins instead of disappearing into the beam.
        model.position.set(x,720-y,a.stationPart==='emitter'?18:0);
        if(a.councilMember){model.scale.setScalar(a.radius);model.rotation.set(reducedMotion?.12:Math.sin(animationTime*.0003)*.2,reducedMotion?0:animationTime*.0005+rockId,0);}
        else if(a.stationPart){model.scale.setScalar(a.stationPart==='arm'?42:a.radius);
          model.rotation.set(a.stationPart==='core'?(reducedMotion?.2:.2+Math.sin(animationTime*.0006)*.12):0,0,a.stationPart==='core'?(reducedMotion?0:animationTime*.00012):-a.rot);
        }else {model.scale.set(a.radius/1.06*profile.stretch[0],a.radius/1.06*profile.stretch[1],a.radius/1.06*profile.stretch[2]);
        axis.set(Math.sin(rockId*1.73),Math.cos(rockId*.93),.5+Math.sin(rockId*.37)).normalize();
        initial.setFromEuler(euler.set(.2+Math.sin(rockId)*.45,rockId*.8,-a.rot));
        model.quaternion.setFromAxisAngle(axis,reducedMotion?0:animationTime/1000*(.07+(rockId%7)*.018)).multiply(initial);}
        model.traverse(obj => { if (obj instanceof THREE.Mesh) {
          for(const material of (Array.isArray(obj.material)?obj.material:[obj.material]) as THREE.MeshStandardMaterial[]) {
          if(a.stationPart){const instability=a.hpMax?1-a.hp/a.hpMax:0;
            material.emissive.copy(material.userData.baseEmission).lerp(hitColor,a.hitFlash*.6);
            material.emissiveIntensity=material.userData.baseStrength*(1+instability*.65)+a.hitFlash*.6;
          }else {material.emissive.setHex(a.isVein?0xe3b34a:profile.color);material.emissiveIntensity=(a.councilMember?0:profile.emission)+(a.isVein?.09:0)+a.hitFlash*.35;}}
        } });
      }
    }
    for (const [id,model] of objects) if (!seen.has(id)) {
      scene.remove(model); model.traverse(o => { if (o instanceof THREE.Mesh) for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose(); }); objects.delete(id);
    }
    const seenUfos=new Set<string>();
    ufoLight.intensity=0;
    // UFOs enter from a world edge and never wrap. X seam copies are needed
    // only by the narrow follow camera, just as in the existing entity pass.
    const follow=(camera.right-camera.left)<1280;
    for(const u of s.ufos)if(u.alive) {
      const ufoClass=ULTRA_UFOS[u.type],alienSource=u.type==='cruiser'?ufoSource:extra(ufoClass.asset);
      const offsets=follow?xs:[0];let copies=0;
      for(const dx of offsets){const x=u.pos.x+dx,y=720-u.pos.y,r=u.radius*1.3;if(x+r>=camera.left&&x-r<=camera.right&&y+r>=camera.bottom&&y-r<=camera.top)copies++;}
      if(!alienSource||seenUfos.size+copies>ufoCapacity)continue;
      for(const dx of offsets) {
      const x=u.pos.x+dx,y=u.pos.y;
      if(x+u.radius*1.3<camera.left||x-u.radius*1.3>camera.right||720-y+u.radius*1.3<camera.bottom||720-y-u.radius*1.3>camera.top)continue;
      const id=`${u.id??s.ufos.indexOf(u)}:${u.type}:${dx}`;seenUfos.add(id);shownUfos.add(u);
      let model=ufos.get(id);
      if(!model){model=new THREE.Group();model.add(alienSource.clone(true));
        model.traverse(o=>{if(o instanceof THREE.Mesh){const mat=(o.material as THREE.MeshStandardMaterial).clone();
          mat.userData.baseEmission=mat.emissive.clone();mat.userData.baseStrength=mat.emissiveIntensity;o.material=mat;
        }});model.userData.rotor=model.getObjectByName('Upper_Rotor')??model.getObjectByName('Upper Rotor');
        const thrust=new THREE.Group();
        for(const material of underglowMaterials)thrust.add(new THREE.Mesh(underglowGeometry,material));
        model.userData.thrust=thrust;scene.add(thrust);
        ufos.set(id,model);scene.add(model);
      }
      // Above the largest first-level rocks, including the steep belly bank.
      model.position.set(x,720-y,140);model.scale.setScalar(u.radius);
      const dt=s.phase==='paused'?0:Math.min(.1,Math.max(0,(s.elapsed-(model.userData.lastTime??s.elapsed))/1000));model.userData.lastTime=s.elapsed;
      // Course changes produce a short, damped steep bank; sustained drift
      // holds a gentler lean. The simulation position and velocity stay intact.
      const change=u.vel.y-(model.userData.previousVy??u.vel.y);model.userData.previousVy=u.vel.y;
      if(Math.abs(change)>8)model.userData.turnHold=.4;
      model.userData.turnHold=Math.max(0,(model.userData.turnHold??0)-dt);
      model.userData.turnKick=reducedMotion?0:Math.min(1.8,(model.userData.turnKick??0)*Math.exp(-dt*(model.userData.turnHold>0?0:2))+Math.abs(change)/28);
      const target=reducedMotion?0:Math.max(-.5,Math.min(.5,u.vel.y*.014));
      model.userData.bank=easeAngle(model,'bank',target,dt);
      const pitchTarget=reducedMotion?-.48:-.48-Math.min(1.65,Math.abs(target)*.45+model.userData.turnKick);
      if(model.userData.pitch===undefined)model.userData.pitch=-.48;
      model.userData.pitch=easeAngle(model,'pitch',pitchTarget,dt);
      model.rotation.set(model.userData.pitch,reducedMotion?0:model.userData.bank,reducedMotion?0:Math.sin(animationTime*.0005)*.06);
      const rotor=model.userData.rotor as THREE.Object3D|undefined;
      if(rotor)rotor.rotation.y=reducedMotion?0:animationTime*.00085;
      const thrust=model.userData.thrust as THREE.Group,speed=Math.hypot(u.vel.x,u.vel.y),power=Math.min(1,speed/100);
      model.updateMatrixWorld(true);
      thrust.position.copy(model.position);thrust.quaternion.copy(model.quaternion);thrust.scale.copy(model.scale);
      const pulse=reducedMotion?1:1+.035*Math.sin(animationTime*.003);
      thrust.children[0].position.set(0,0,-.43);thrust.children[0].scale.setScalar((2.75+power*.18)*pulse);
      thrust.children[1].position.set(0,0,-.36);thrust.children[1].scale.setScalar(.95*pulse);
      if(dx===0){driveCentre.set(0,0,-.38).applyMatrix4(model.matrixWorld);ufoLight.position.copy(driveCentre);ufoLight.intensity=180+170*power;}
      model.traverse(o=>{if(o instanceof THREE.Mesh){const mat=o.material as THREE.MeshStandardMaterial;
        mat.emissive.copy(mat.userData.baseEmission).lerp(hitColor,u.hitFlash*.65);
        mat.emissiveIntensity=mat.userData.baseStrength+(u.hitFlash*.6)+(u.type==='boss'?(u.bossPhase-1)*.22:0);
      }});
    }}
    for(const [id,model] of ufos)if(!seenUfos.has(id)){scene.remove(model,model.userData.thrust);model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).dispose();});ufos.delete(id);}
    const seenPickups=new Set<GameState['powerups'][number]>();
    for(let i=0;i<s.powerups.length;i++) {
      const p=s.powerups[i];if(!p.alive||p.collected||p.pos.x+p.radius*3<camera.left||p.pos.x-p.radius*3>camera.right
        ||720-p.pos.y+p.radius*3<camera.bottom||720-p.pos.y-p.radius*3>camera.top||seenPickups.size>=pickupCapacity)continue;
      // Pickups near a world seam use baked copies so no neighbouring copy
      // disappears when the single live body is visible.
      let copies=0;
      for(const dx of xs)for(const dy of ys){const x=p.pos.x+dx,y=720-p.pos.y-dy,r=p.radius*3;
        if(x+r>=camera.left&&x-r<=camera.right&&y+r>=camera.bottom&&y-r<=camera.top)copies++;}
      if(copies>1)continue;
      seenPickups.add(p);shownPickups.add(p);let model=pickups.get(p);
      if(!model){model=new THREE.Group();model.add(pickupSources[PICKUP_KINDS.indexOf(p.type)].clone(true));
        model.traverse(o=>{if(o instanceof THREE.Mesh){const mat=(o.material as THREE.MeshStandardMaterial).clone();mat.transparent=true;mat.forceSinglePass=true;
          if(mat.name.includes('status')){mat.color.set(POWERUP_CONFIG[p.type].colour);mat.emissive.set(POWERUP_CONFIG[p.type].colour);}
          o.material=mat;}});pickups.set(p,model);scene.add(model);
      }
      model.position.set(p.pos.x,720-p.pos.y,90);model.scale.setScalar(p.radius*PICKUP_ART_SCALE);
      // Keep the raised front symbol visible while showing substantial side
      // walls, rear reactor and rails. Stable type phase survives collections.
      const phase=PICKUP_KINDS.indexOf(p.type)*.9;
      model.rotation.set(reducedMotion?-.45:-.45+Math.sin(animationTime*.0012+phase)*.18,
        reducedMotion?.3:.3+Math.cos(animationTime*.0014+phase)*.22,
        reducedMotion?0:Math.sin(animationTime*.0008+phase)*.16);
      model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).opacity=Math.min(1,Math.max(0,p.ttl/1600));});
    }
    for(const [id,model] of pickups)if(!seenPickups.has(id)){scene.remove(model);model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).dispose();});pickups.delete(id);}
    shownCollectables.clear();shownShardTypes.clear();collectableInstances=0;
    for(let kind=0;kind<COLLECTABLE_KINDS.length;kind++) {
      let count=0;
      for(const c of s.coins) {
        if(!c.alive||c.collected||c.kind!==COLLECTABLE_KINDS[kind])continue;
        const phase=collectablePhase(c),t=reducedMotion?0:animationTime*.0011+phase;
        if(count+xs.length*ys.length>collectableCapacity) {
          let copies=0;
          for(const dx of xs)for(const dy of ys){const x=c.pos.x+dx,y=720-c.pos.y-dy,r=c.radius*2.3;
            if(x+r>=camera.left&&x-r<=camera.right&&y+r>=camera.bottom&&y-r<=camera.top)copies++;}
          // Keep all visible wrap copies together; otherwise every copy of
          // this pickup uses the baked path instead of losing one at a seam.
          if(count+copies>collectableCapacity)continue;
        }
        for(const dx of xs)for(const dy of ys) {
          const x=c.pos.x+dx,y=720-c.pos.y-dy,r=c.radius*2.3;
          if(x+r<camera.left||x-r>camera.right||y+r<camera.bottom||y-r>camera.top||count>=collectableCapacity)continue;
          collectablePose.position.set(x,y,85);collectablePose.scale.setScalar(c.radius*COLLECTABLE_ART_SCALE);
          const type=c.sourceType??DEFAULT_SHARD_TYPE,mineral=MINERAL_SHARDS[type];
          if(c.kind==='dust')collectablePose.scale.set(c.radius*COLLECTABLE_ART_SCALE*mineral.stretch[0],c.radius*COLLECTABLE_ART_SCALE*mineral.stretch[1],c.radius*COLLECTABLE_ART_SCALE*mineral.stretch[2]);
          collectablePose.rotation.set(.32+.18*Math.sin(t),t,c.kind==='sat'?.15:t*.5);collectablePose.updateMatrix();
          for(const {mesh,opacity,surface,accent} of collectableBatches[kind]) {
            mesh.setMatrixAt(count,collectablePose.matrix);opacity.setX(count,collectableAlpha(c.ttl));
            if(c.kind==='dust') {
              mesh.setColorAt(count,mineralColour.set(accent?mineral.accent:mineral.colour));
              surface.setXY(count,mineral.metal,mineral.rough);shownShardTypes.add(type);
            }
          }
          shownCollectables.add(c);count++;
        }
      }
      for(const {mesh,opacity,surface} of collectableBatches[kind]){mesh.count=count;mesh.instanceMatrix.needsUpdate=true;opacity.needsUpdate=true;surface.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;}
      collectableInstances+=count;
    }
    const seenDebris=new Set<GameState['debris'][number]>();
    for(let i=0;i<s.debris.length;i++) {
      const d=s.debris[i];if(d.ttl<=0)continue;seenDebris.add(d);let model=debris.get(d);
      if(!model){model=new THREE.Group();model.add(fragmentSources[DEBRIS_KINDS.indexOf(debrisKind(i,d.length))].clone(true));
        model.traverse(o=>{if(o instanceof THREE.Mesh){const mat=(o.material as THREE.MeshStandardMaterial).clone();mat.transparent=true;o.material=mat;}});
        debris.set(d,model);scene.add(model);
      }
      const age=(d.maxTtl-d.ttl)/1000;
      model.position.set(d.pos.x,720-d.pos.y,85);model.scale.setScalar(debrisScale(d.length));
      model.rotation.set(reducedMotion?0:age*.9,reducedMotion?0:age*1.4,-d.rot);
      model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).opacity=Math.min(1,d.ttl/d.maxTtl);});
    }
    for(const [d,model] of debris)if(!seenDebris.has(d)){scene.remove(model);model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).dispose();});debris.delete(d);}
    deathLight.intensity=0;shrapnel.count=0;deathBursts=bursts.length;finalDeathBursts=bursts.filter(b=>b.final).length;
    for(const b of bursts) {
      const age=(s.elapsed-b.time)/1000;
      const lightDuration=b.final?.7:.35;
      if(age<lightDuration){deathLight.position.set(b.x+b.vx*.5*age,720-b.y-b.vy*.5*age,95);
        deathLight.color.setHex(age<.09?0x93cbff:age<.28?0xffa23d:0xeb4528);
        deathLight.intensity=(b.final?18000:9000)*(reducedMotion?.3:1)*Math.pow(1-age/lightDuration,2);}
      if(!reducedMotion)for(let i=0;i<(b.final?24:12)&&shrapnel.count<72;i++) {
        const p=playerShard(b,i,age);shardPose.position.set(p.x,720-p.y,85+Math.sin(i*2.4)*age*18);
        shardPose.rotation.set(Math.PI/2+age*(i%3+1),age*(i%2?-2:3),-p.rot);
        shardPose.scale.setScalar(p.size*Math.max(0,1-age/playerBurstDuration(b)));shardPose.updateMatrix();shrapnel.setMatrixAt(shrapnel.count++,shardPose.matrix);
      }
    }
    shrapnel.instanceMatrix.needsUpdate=true;
    for(const model of ships.values()) model.visible=false;
    for(const shield of shields.values()) shield.visible=false;
    engineLight.intensity=muzzleLight.intensity=0;
    const activeShipIds=new Set<string>();
    for(let slot=0;slot<s.players.length&&slot<shipCapacity;slot++) {
      const ship=s.players[slot].ship;
      if(!ship.alive||ship.hyperspaceCloakMs>0)continue;
      const blink=ship.invulnerableUntil>s.elapsed&&Math.floor(now/80)%2===0;
      for(const dx of xs)for(const dy of ys) {
        const x=ship.pos.x+dx,y=ship.pos.y+dy;
        if(x+80<camera.left||x-80>camera.right||720-y+80<camera.bottom||720-y-80>camera.top)continue;
        const tintColour=s.players.length>=2&&s.players.length<=8?ULTRA_PILOT_COLOURS[slot%8]:null;
        const id=`${slot}:${tintColour??'solo'}:${dx}:${dy}`;activeShipIds.add(id);shownShips.add(ship);
        let model=ships.get(id);
        if(!model){model=shipBody.clone(true);
          // Match the established pilot/HUD colours, preserving the metal and
          // reactor materials. Shared geometry, seven material batches per ship.
          const tint=tintColour?new THREE.Color(tintColour):null;
          model.traverse(o=>{if(o instanceof THREE.Mesh){const mat=(o.material as THREE.MeshStandardMaterial).clone();
            if(tint&&mat.metalness>.5)mat.color.lerp(tint,.45);o.material=mat;}});
          ships.set(id,model);scene.add(model);
        }
        model.visible=!blink;model.position.set(x-Math.cos(ship.rot)*ship.recoilOffset,720-y+Math.sin(ship.rot)*ship.recoilOffset,85);
        model.scale.setScalar(SHIP_BLENDER_SCALE);model.rotation.set(0,0,-ship.rot-Math.PI/2);
        if(!reducedMotion)model.rotateY(Math.max(-.24,Math.min(.24,ship.rotVel*.055)));
        if(ship.shieldUp) {
          let shield=shields.get(id);
          if(!shield){shield=new THREE.Mesh(shieldGeometry,shieldMaterial.clone());scene.add(shield);shields.set(id,shield);}
          shield.visible=!blink;shield.position.set(x,720-y,85);shield.scale.setScalar(ship.radius*2.2);
          const mat=shield.material as THREE.ShaderMaterial;
          mat.uniforms.time.value=reducedMotion?0:animationTime/1000;mat.uniforms.hit.value=ship.shieldHitFlash;
          mat.uniforms.fade.value=Math.min(1,Math.max(0,(ship.shieldExpiresAt-s.elapsed)/300));
        }
      }
      // Fixed shared light budget, even in eight-player combat.
      if(slot===0&&!blink){
        engineLight.position.set(ship.pos.x-Math.cos(ship.rot)*14,720-ship.pos.y+Math.sin(ship.rot)*14,95);
        muzzleLight.position.set(ship.pos.x+Math.cos(ship.rot)*16,720-ship.pos.y-Math.sin(ship.rot)*16,95);
        engineLight.intensity=ship.thrusting?150:8;muzzleLight.intensity=reducedMotion?0:ship.recoilOffset*130;
      }
    }
    for(const [id,model] of ships)if(!activeShipIds.has(id)){
      scene.remove(model);model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).dispose();});ships.delete(id);
      const shield=shields.get(id);if(shield){scene.remove(shield);(shield.material as THREE.Material).dispose();shields.delete(id);}
    }
    const seenMines=new Set<Mine>();
    for(const mine of s.mines) {
      if(!mine.alive||seenMines.size>=mineCapacity||mine.pos.x+mine.radius*1.5<camera.left||mine.pos.x-mine.radius*1.5>camera.right
        ||720-mine.pos.y+mine.radius*1.5<camera.bottom||720-mine.pos.y-mine.radius*1.5>camera.top)continue;
      const art=extra('mine');if(!art)continue;
      seenMines.add(mine);shownMines.add(mine);let model=mineModels.get(mine);
      if(!model){model=new THREE.Group();model.add(art.clone(true));model.traverse(o=>{if(o instanceof THREE.Mesh){const mat=(o.material as THREE.MeshStandardMaterial).clone();mat.userData.baseEmission=mat.emissive.clone();mat.userData.baseStrength=mat.emissiveIntensity;o.material=mat;}});mineModels.set(mine,model);scene.add(model);}
      model.position.set(mine.pos.x,720-mine.pos.y,20);model.scale.setScalar(mine.radius);
      model.rotation.set(.24,reducedMotion?0:Math.sin(animationTime*.0004)*.2,reducedMotion?0:animationTime*.0003);
      model.traverse(o=>{if(o instanceof THREE.Mesh){const mat=o.material as THREE.MeshStandardMaterial;mat.emissive.copy(mat.userData.baseEmission).lerp(hitColor,mine.hitFlash);mat.emissiveIntensity=mat.userData.baseStrength*(1+(reducedMotion?0:.12*Math.sin(animationTime*.005)))+mine.hitFlash;}});
    }
    for(const [mine,model] of mineModels)if(!seenMines.has(mine)){scene.remove(model);model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).dispose();});mineModels.delete(mine);}
    renderer.render(scene,camera);
  }
  function disposeModel(model: THREE.Group): void {
    const geometries=new Set<THREE.BufferGeometry>(), materials=new Set<THREE.Material>(), maps=new Set<THREE.Texture>();
    model.traverse(o=>{if(o instanceof THREE.Mesh){geometries.add(o.geometry);for(const mat of Array.isArray(o.material)?o.material:[o.material]){
      materials.add(mat);const p=mat as THREE.MeshStandardMaterial;
      for(const map of [p.map,p.normalMap,p.roughnessMap,p.metalnessMap])if(map)maps.add(map);
    }}});
    for(const g of geometries)g.dispose();for(const m of materials)m.dispose();for(const t of maps)t.dispose();
  }
  function dispose(): void {
    disposed=true;for(const model of extraSources.values())disposeModel(model);
    for(const model of [...ships.values(),...mineModels.values()])model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).dispose();});
    for(const shield of shields.values())(shield.material as THREE.Material).dispose();
    for (const model of objects.values()) model.traverse(o => { if (o instanceof THREE.Mesh) for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose(); });
    // Portrait textures belong to the shared identity cache; dispose only the
    // medallion geometry/material here, never another renderer's textures.
    for(const model of councilSources.values()){const gs=new Set<THREE.BufferGeometry>(),ms=new Set<THREE.Material>();model.traverse(o=>{if(o instanceof THREE.Mesh){gs.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material])ms.add(m);}});for(const g of gs)g.dispose();for(const m of ms)m.dispose();}
    for(const model of ufos.values())model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).dispose();});
    for(const model of [...pickups.values(),...debris.values()])model.traverse(o=>{if(o instanceof THREE.Mesh)(o.material as THREE.Material).dispose();});
    for(const model of [...pickupSources,...fragmentSources])disposeModel(model);
    disposeModel(source);disposeModel(shipBody);disposeModel(ufoSource);shieldGeometry.dispose();shieldMaterial.dispose();reflection.dispose();
    key.shadow.map?.dispose(); renderer.dispose();
    for(const batches of collectableBatches)for(const {mesh} of batches){mesh.dispose();mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}
    shrapnel.dispose();shardMaterial.dispose();underglowGeometry.dispose();for(const material of underglowMaterials)material.dispose();for(const texture of underglowTextures)texture.dispose();
  }
  function diagnostics() {
    return {wave:renderedWave,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,
      width:canvas.width,height:canvas.height,shipMaterialBatches:shipBody.children.length,
      visibleShips:[...ships.values()].filter(o=>o.visible).length,
      visibleUfos:ufos.size,stationAssets:[...extraSources.keys()].filter(n=>n.startsWith('station-')||n.startsWith('forge-')),shipScale:SHIP_BLENDER_SCALE,
      visibleRocks:shownRocks.size,rockCopies:objects.size,rockCapacity,rockTypes:[...new Set([...shownRocks].map(a=>a.stationPart??a.type))],
      visibleMines:shownMines.size,loadedCampaignModels:[...extraSources.keys()],
      ufos:[...ufos.values()].map(o=>({scale:o.scale.x,pitch:o.rotation.x,bank:o.rotation.y,rotorAngle:(o.userData.rotor as THREE.Object3D|undefined)?.rotation.y,
        undersideGlow:(o.userData.thrust as THREE.Group).children.map(c=>({z:c.position.z,width:c.scale.x})),
        shadowCasters:(()=>{let n=0;o.traverse(c=>{if(c instanceof THREE.Mesh&&c.castShadow)n++;});return n;})()})),
      pickupMaterialBatches:pickupSources.map(o=>{let n=0;o.traverse(c=>{if(c instanceof THREE.Mesh)n++;});return n;}),
      visiblePickups:pickups.size,visibleDebris:debris.size,
      visibleCollectables:shownCollectables.size,collectableInstances,collectableCapacity,collectableMaterialBatches:collectableBatches.map(b=>b.length),
      collectableClock:animationTime,
      collectableShardTypes:[...shownShardTypes],
      visibleShields:[...shields.values()].filter(o=>o.visible).length,
      engineLight:engineLight.intensity,muzzleLight:muzzleLight.intensity,
      ufoThrustMeshes:ufos.size*2,ufoLight:ufoLight.intensity,deathBursts,finalDeathBursts,shrapnelInstances:shrapnel.count,deathLight:deathLight.intensity};
  }
  return {canvas,render,dispose,diagnostics,hasRock:(a:Asteroid)=>shownRocks.has(a),hasUfo:(u:Ufo)=>shownUfos.has(u),hasShip:(ship:Ship)=>shownShips.has(ship),hasPickup:(p:GameState['powerups'][number])=>shownPickups.has(p),hasMine:(m:Mine)=>shownMines.has(m),hasCollectable:(c:Coin)=>shownCollectables.has(c)};
}
