"""Bake campaign minerals, alien variants and original station hardware."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from campaign_authoring import *

# Mineral profiles come from the runtime source, avoiding palette drift.
profiles=(ROOT/'src'/'ultra-materials.ts').read_text()
pattern=r"(\w+):\{source:'(\w+)',color:0x([\da-f]+),metal:([\d.]+),rough:([\d.]+),emission:([\d.]+),stretch:\[([^\]]+)\]"
for name,source,col,metal,rough,emission,stretch in re.findall(pattern,profiles):
    clear();bpy.ops.import_scene.gltf(filepath=str(OUT/(source+'-cinematic.glb')))
    body=[o for o in bpy.context.scene.objects if o.type=='MESH'][0]
    # GLTF import restores Blender's original Z-up geology.
    body.scale=tuple(float(v) for v in stretch.split(','))
    for m in body.data.materials:
        p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Metallic'].default_value=float(metal);p.inputs['Roughness'].default_value=float(rough)
        p.inputs['Emission Color'].default_value=(*rgb(int(col,16)),1);p.inputs['Emission Strength'].default_value=float(emission)
        link=next((l for l in m.node_tree.links if l.to_socket==p.inputs['Base Color']),None)
        if link:
            mix=m.node_tree.nodes.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1;mix.inputs[2].default_value=(*rgb(int(col,16)),1)
            m.node_tree.links.new(link.from_socket,mix.inputs[1]);m.node_tree.links.new(mix.outputs[0],p.inputs['Base Color'])
    setup();bpy.context.scene.render.resolution_x=bpy.context.scene.render.resolution_y=128
    for frame in range(16):
        body.rotation_euler=(.2,.25,frame*math.tau/16)
        bpy.context.scene.render.filepath=str(FRAMES/(name+'-'+str(frame).zfill(2)+'.png'));bpy.ops.render.render(write_still=True)
    print('MINERAL BAKED',name,flush=True)

# Retain the fully authored hull/rotor; add substantial class-specific armour,
# sensor banks and weapons. Each class has a different silhouette.
for kind in ['elite','tank','sniper','boss']:
    bpy.ops.wm.open_mainfile(filepath=str(OUT/'ufo.blend'))
    for o in list(bpy.context.scene.objects):
        if o.type in ['CAMERA','LIGHT']:bpy.data.objects.remove(o,do_unlink=True)
    metal=material('class titanium',0x617583);dark=material('class ceramic',0x111f2c,.4,.45)
    accent=material('class weapon lens',{'elite':0xff587b,'tank':0xff884c,'sniper':0x63e9e8,'boss':0xffd56b}[kind],.4,.22,1.5)
    for o in list(bpy.context.scene.objects):
        if o.type=='MESH':o.scale.z*=1.25 if kind in ['tank','boss'] else .85 if kind=='sniper' else 1
    if kind=='sniper':
        for side in [-1,1]:
            box((side*.57,-.22,.22),(.18,1.22,.16),metal)
            box((side*.57,-.74,.22),(.10,.10,.11),accent)
    else:
        count=4 if kind=='elite' else 8
        for i in range(count):
            a=i*math.tau/count;r=.86
            o=box((r*math.cos(a),r*math.sin(a),.18),(.38,.16,.20 if kind=='elite' else .32),metal);o.rotation_euler.z=a
            sphere((.99*math.cos(a),.99*math.sin(a),.20),(.08,.08,.07),accent)
    if kind=='boss':
        torus(.56,.36,.04,metal);torus(.54,.39,.02,accent)
        sphere((0,0,.52),(.18,.18,.13),accent)
    # Merge new fittings by material; keep Upper Rotor independently animated.
    added=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.name not in ['Alien Hull','Upper Rotor']]
    if added:
        bpy.ops.object.select_all(action='DESELECT')
        for o in added:
            bpy.context.view_layer.objects.active=o;o.select_set(True)
            for mod in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.context.view_layer.objects.active=added[0];bpy.ops.object.join();bpy.context.object.name='Class Hardware'
    meshes=export('ufo-'+kind)
    # The approved plate uses an oblique view; live GLBs keep the true body axes.
    setup(2.8)
    for o in meshes:o.rotation_euler.x+=.35
    plate('ufo-'+kind)
    print('ALIEN EXPORTED',kind,flush=True)

for part in ['core','arm','emitter','mine','missile']:
    clear();metal=material('brushed titanium',0x617b8e,.83,.3);dark=material('ceramic recesses',0x0e1b28,.4,.43)
    green=material('peridot reactor',0x64de8e,.35,.18,1.2);hot=material('warning amber',0xff8b3c,.45,.22,1.5)
    if part=='core':
        sphere((0,0,0),(.31,.31,.31),dark)
        for tilt in [(0,0,0),(math.pi/2,0,0),(0,math.pi/2,0)]:
            o=torus(.85,0,.09,metal);o.rotation_euler=tilt
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=.56);finish(bpy.context.object,green).name='Reactor Crystal'
        torus(1.12,0,.025,hot)
        for i in range(12):
            a=i*math.tau/12;o=box((.87*math.cos(a),.87*math.sin(a),.06),(.17,.07,.16),dark);o.rotation_euler.z=a
    elif part=='arm':
        box((0,0,0),(2,.34,.44),metal);box((0,-.19,-.08),(2,.12,.43),dark)
        box((0,.18,.12),(1.8,.055,.055),green)
        for x in [-.72,-.43,-.14,.15,.44,.73]:
            box((x,0,.10),(.06,.43,.42),dark)
            for y in [-.18,.18]:sphere((x,y,.34),(.025,.025,.014),metal)
    elif part=='emitter':
        sphere((0,0,0),(.87,.65,.5),dark)
        for z in [-.18,.03,.24]:torus(.65,z,.055,metal)
        sphere((0,0,.57),(.47,.47,.14),hot)
        for i in range(8):
            a=i*math.tau/8;o=box((.69*math.cos(a),.69*math.sin(a),0),(.30,.08,.43),metal);o.rotation_euler.z=a
    elif part=='mine':
        sphere((0,0,0),(.73,.73,.66),dark);torus(.71,0,.035,hot)
        for i in range(8):
            a=i*math.tau/8
            bpy.ops.mesh.primitive_cone_add(vertices=12,radius1=.12,radius2=.04,depth=.43,location=(.82*math.cos(a),.82*math.sin(a),0))
            o=finish(bpy.context.object,metal);o.rotation_euler=(math.pi/2,0,a-math.pi/2)
        sphere((0,0,.56),(.25,.25,.13),hot)
    else:
        body=box((0,0,0),(1.4,.35,.35),metal,.055)
        bpy.ops.mesh.primitive_cone_add(vertices=24,radius1=.22,radius2=0,depth=.5,location=(.85,0,0))
        o=finish(bpy.context.object,metal);o.rotation_euler.y=math.pi/2
        sphere((.94,0,0),(.11,.13,.13),hot)
        for side in [-1,1]:
            box((-.48,side*.29,0),(.5,.08,.43),dark,.008)
        sphere((-.76,0,0),(.06,.17,.17),hot)
    # Join static assemblies into one mesh with four material batches.
    name='station-'+part if part in ['core','arm','emitter'] else part
    meshes=export(name)
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join();body=bpy.context.object
    bpy.context.scene.cursor.location=(0,0,0);bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    export(name);setup(2.7);plate(name)
    print('HARDWARE EXPORTED',part,flush=True)
