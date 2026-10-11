import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { impactAge, lifetime, fragment, dustOpacity } from './impact.js';

// Review-only live 3D renderer. No imports or defaults in the shipping game.
export async function createCinematic(canvas, previous=false) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0,1280,720,0,.1,4000);
  camera.position.set(0,0,1500);
  camera.lookAt(0,0,0);
  const ambient = new THREE.HemisphereLight(0xc1d2d8,previous?0x070809:0x231b13,previous?.65:.72);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(previous?0xffe5bc:0xffefd7,4.6);
  key.position.set(-200,1100,650);
  key.target.position.set(640,360,0);
  key.castShadow=true;
  key.shadow.mapSize.set(2048,2048);
  Object.assign(key.shadow.camera,{left:-900,right:900,top:900,bottom:-900,near:1,far:2200});
  key.shadow.bias=-.0002;
  key.shadow.normalBias=.55;
  scene.add(key,key.target);
  const rim=new THREE.DirectionalLight(previous?0xc0d1db:0x79bed0,previous?1.35:.85);
  rim.position.set(1000,-200,300);scene.add(rim);
  const back=new THREE.DirectionalLight(0xffb987,previous?1.4:.45);
  back.position.set(800,600,-300);scene.add(back);

  // A compact environment with warm stellar light and a cool nebular fill.
  const envCanvas=document.createElement('canvas');envCanvas.width=512;envCanvas.height=256;
  const ec=envCanvas.getContext('2d');
  ec.fillStyle='#070c13';ec.fillRect(0,0,512,256);
  for(const [x,y,r,colour] of [[70,65,80,'#dcc7a3'],[340,180,100,'#3a7994'],[480,80,45,'#b67237']]) {
    const gradient=ec.createRadialGradient(x,y,0,x,y,r);gradient.addColorStop(0,colour);gradient.addColorStop(1,'#070c13');ec.fillStyle=gradient;ec.fillRect(x-r,y-r,r*2,r*2);
  }
  const environment=new THREE.CanvasTexture(envCanvas);environment.mapping=THREE.EquirectangularReflectionMapping;environment.colorSpace=THREE.SRGBColorSpace;
  const pmrem=new THREE.PMREMGenerator(renderer);
  scene.environment=pmrem.fromEquirectangular(environment).texture;environment.dispose();pmrem.dispose();
  const loader=new GLTFLoader();
  const models=Object.fromEntries(await Promise.all(['stony','pallasite','ship'].map(async name=>{
    const gltf=await loader.loadAsync(`./assets/${name}-${previous&&name!=='ship'?'previous':'cinematic'}.glb?art=3`);
    const model=new THREE.Group();model.add(gltf.scene);gltf.scene.rotation.x=Math.PI/2;
    gltf.scene.traverse(obj=>{if(obj.isMesh){obj.castShadow=true;obj.receiveShadow=true;obj.material.envMapIntensity=previous?.7:.45;for(const key of ['map','normalMap','roughnessMap'])if(obj.material[key])obj.material[key].anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());}});
    return [name,model];
  })));
  const objects=new Map();
  const bgTexture=await new THREE.TextureLoader().loadAsync('./assets/background-native.webp');bgTexture.colorSpace=THREE.SRGBColorSpace;
  const bg=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:bgTexture,toneMapped:false}));bg.position.z=-900;scene.add(bg);
  const composer=new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene,camera));
  const bloom=new UnrealBloomPass(new THREE.Vector2(1,1),.32,.35,1.1);composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const chipGeometry=new THREE.IcosahedronGeometry(1,0);
  const chips=new THREE.InstancedMesh(chipGeometry,new THREE.MeshStandardMaterial({color:0xbcb4a4,roughness:.8,metalness:.15}),24);
  chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);chips.castShadow=true;chips.receiveShadow=true;chips.count=0;scene.add(chips);
  const dummy=new THREE.Object3D();
  const dustCanvas=document.createElement('canvas');dustCanvas.width=dustCanvas.height=64;
  const dc=dustCanvas.getContext('2d');const dg=dc.createRadialGradient(32,32,0,32,32,32);dg.addColorStop(0,'rgba(211,193,161,.5)');dg.addColorStop(.4,'rgba(153,141,124,.18)');dg.addColorStop(1,'rgba(100,100,100,0)');dc.fillStyle=dg;dc.fillRect(0,0,64,64);
  const dustGeo=new THREE.BufferGeometry();const dustPositions=new Float32Array(72*3);dustGeo.setAttribute('position',new THREE.BufferAttribute(dustPositions,3));
  const dustMat=new THREE.PointsMaterial({map:new THREE.CanvasTexture(dustCanvas),size:6,sizeAttenuation:false,transparent:true,opacity:0,depthWrite:false,color:0xc8bda5});
  const dust=new THREE.Points(dustGeo,dustMat);dust.frustumCulled=false;scene.add(dust);
  let size='';
  let lastStats={calls:0,triangles:0,shadows:true};
  const spinAxis=new THREE.Vector3();const initialRotation=new THREE.Quaternion();const initialEuler=new THREE.Euler();
  function syncObject(id,type,pos,radius,rotation,t) {
    let entry=objects.get(id);
    if(!entry||entry.type!==type){
      if(entry){scene.remove(entry.model);if(!previous&&entry.type!=='ship')entry.model.traverse(obj=>{if(obj.isMesh)obj.material.dispose();});}
      entry={type,model:models[type].clone(true)};
      if(!previous&&type!=='ship')entry.model.traverse(obj=>{if(obj.isMesh){obj.material=obj.material.clone();obj.material.color.multiply(new THREE.Color(type==='pallasite'?0xfff1d8:id%2?0xffebd6:0xeff3ed));}});
      scene.add(entry.model);objects.set(id,entry);
    }
    entry.model.visible=true;
    entry.model.position.set(pos.x,720-pos.y,type==='ship'?85:0);
    entry.model.scale.setScalar(type==='ship'?radius*4/3/1.38:radius/1.06);
    if(type==='ship'||previous)entry.model.rotation.set(type==='ship'?0:.45*Math.sin(t*.24+id),type==='ship'?0:t*.22+id*.8,type==='ship'?-rotation-Math.PI/2:-rotation);
    else {
      // Each body spins steadily about its own axis; no synchronized sway.
      spinAxis.set(Math.sin(id*1.73),Math.cos(id*.93),.5+Math.sin(id*.37)).normalize();
      initialRotation.setFromEuler(initialEuler.set(.2+Math.sin(id)*.45,id*.8,-rotation+t*.1));
      entry.model.quaternion.setFromAxisAngle(spinAxis,t*(.07+(id%7)*.018)).multiply(initialRotation);
    }
    return entry.model;
  }
  function renderFrame(g,state,time,config) {
    const next=`${g.w}:${g.h}:${g.dpr}`;
    if(size!==next) {
      size=next;renderer.setSize(Math.round(g.w*g.dpr),Math.round(g.h*g.dpr),false);composer.setSize(Math.round(g.w*g.dpr),Math.round(g.h*g.dpr));
      camera.left=-g.tx/g.scale;camera.right=(g.w-g.tx)/g.scale;camera.top=720+g.ty/g.scale;camera.bottom=720-(g.h-g.ty)/g.scale;camera.updateProjectionMatrix();
      const cover=Math.max((g.w/g.scale)/bgTexture.image.width,(g.h/g.scale)/bgTexture.image.height);
      bg.scale.set(bgTexture.image.width*cover,bgTexture.image.height*cover,1);bg.position.x=(camera.left+camera.right)/2;bg.position.y=(camera.top+camera.bottom)/2;
    }
    renderer.shadowMap.enabled=config.shadows!==false;
    for(const entry of objects.values())entry.model.visible=false;
    const t=time/1000;
    state.asteroids.forEach(rock=>syncObject(rock.id,rock.type,rock.pos,rock.radius,rock.rot,t));
    const ship=state.players[0].ship;
    syncObject('ship','ship',ship.pos,ship.radius,ship.rot,t);
    // The vignette is a controlled contact/rebound fixture. Effects are
    // derived from its clock and never alter the production simulation.
    const age=impactAge(t);
    const impact=config.scene==='collision'&&age>=0&&age<lifetime&&config.debris!==false;
    chips.count=impact?24:0;
    dustMat.opacity=impact?.42*dustOpacity(age):0;
    dustMat.size=(12+Math.max(0,age)*10)*g.scale*g.dpr;
    if(impact) {
      const portrait=g.h>g.w;
      // Shared contact drift follows centre-of-mass motion. Most ejecta
      // travel along the tangent with a small normal component; no gravity
      // or drag is invented in this vacuum fixture.
      for(let i=0;i<24;i++) {
        const p=fragment(i,age,portrait);
        dummy.position.set(p.x,720-p.y,p.z);
        dummy.scale.set(p.size,p.size*.45,p.size*.6);dummy.rotation.set(age*(i%3+1),age*(i%2+1),i*2.4);dummy.updateMatrix();chips.setMatrixAt(i,dummy.matrix);
      }
      chips.instanceMatrix.needsUpdate=true;
      for(let i=0;i<72;i++) {
        const p=fragment(i,age,portrait,true);
        dustPositions[i*3]=p.x;
        dustPositions[i*3+1]=720-p.y;
        dustPositions[i*3+2]=p.z;
      }
      dustGeo.attributes.position.needsUpdate=true;
    }
    bloom.enabled=config.bloom!==false;
    if(config.bloom!==false)composer.render();else renderer.render(scene,camera);
    lastStats={calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,shadows:renderer.shadowMap.enabled};
  }
  return {render:renderFrame,stats:()=>lastStats};
}
