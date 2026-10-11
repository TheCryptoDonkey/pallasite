"""Blender pickup capsule and real player-hull fragments, with cheap baked fallbacks."""
import bpy,math
from pathlib import Path
from mathutils import Vector
OUT=Path(__file__).resolve().parent/'assets'
FRAMES=OUT/'frames'/'debris';FRAMES.mkdir(parents=True,exist_ok=True)

def mat(name,color,metal=.6,rough=.3,emit=0):
    m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    p.inputs['Emission Color'].default_value=(*color,1);p.inputs['Emission Strength'].default_value=emit;return m
def setup(scale):
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
    scene.render.resolution_x=scene.render.resolution_y=128;scene.render.resolution_percentage=100
    scene.render.film_transparent=True;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
    scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.06,.075,.095,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.5
    bpy.ops.object.camera_add(location=(0,0,8));camera=bpy.context.object;camera.data.type='ORTHO';camera.data.ortho_scale=scale;scene.camera=camera
    for pos,energy,color,size in [((-3,4,6),700,(1,.88,.7),3),((3,-2,4),350,(.3,.7,1),2)]:
        bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=energy;o.data.color=color;o.data.size=size;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
    return scene

for kind in ['wing','engine','canopy','hull']:
    bpy.ops.wm.open_mainfile(filepath=str(OUT/'ship.blend'))
    selected=[]
    for obj in list(bpy.context.scene.objects):
        if obj.type!='MESH':bpy.data.objects.remove(obj,do_unlink=True);continue
        centre=sum((obj.matrix_world@Vector(v) for v in obj.bound_box),Vector())/8
        name=obj.name.lower()
        include=(kind=='wing' and centre.x>.2 and any(x in name for x in ['armour segment','forward swept armour','leading edge rail','radiator'])) or \
            (kind=='engine' and centre.x>.1 and any(x in name for x in ['engine','nozzle','exhaust lens'])) or \
            (kind=='canopy' and any(x in name for x in ['canopy','cockpit gasket'])) or \
            (kind=='hull' and any(x in name for x in ['reactor','spinal inset','nose sensor']))
        if not include:bpy.data.objects.remove(obj,do_unlink=True)
        else:selected.append(obj)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in selected:
        bpy.context.view_layer.objects.active=obj;obj.select_set(True)
        for modifier in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    for obj in selected:obj.select_set(True)
    bpy.context.view_layer.objects.active=selected[0];bpy.ops.object.join();obj=bpy.context.object;obj.name='debris-'+kind
    # All fragment origins are their own mass centres; long axis points +X.
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    bounds=[obj.matrix_world@Vector(v) for v in obj.bound_box]
    centre=sum(bounds,Vector())/8
    size=max(max(v[i] for v in bounds)-min(v[i] for v in bounds) for i in range(3))
    for v in obj.data.vertices:v.co=(obj.matrix_world@v.co-centre)/size
    obj.location=(0,0,0);obj.rotation_euler=(0,0,-math.pi/2)
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/('debris-'+kind+'.glb')),export_format='GLB',use_selection=True,export_yup=True)
    scene=setup(1.45)
    for frame in range(16):
        obj.rotation_euler=(frame*.37,frame*math.tau/16,frame*.21)
        scene.render.filepath=str(FRAMES/(kind+'-'+str(frame).zfill(2)+'.png'));bpy.ops.render.render(write_still=True)

bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
dark=mat('pickup ceramic face',(.016,.035,.047),.4,.4)
steel=mat('pickup bevelled titanium',(.37,.47,.52),.8,.25)
glow=mat('pickup status emitter',(.2,.65,1),.2,.2,1.5)
for name,r,z,depth,m in [('armoured capsule',1,0,.22,steel),('ceramic glyph display',.87,.135,.045,dark),('status rail',.94,.155,.025,glow)]:
    bpy.ops.mesh.primitive_cylinder_add(vertices=6,radius=r,depth=depth,location=(0,0,z),rotation=(0,0,math.pi/6))
    o=bpy.context.object;o.name=name;o.data.materials.append(m)
    mod=o.modifiers.new('machined edges','BEVEL');mod.width=.05;mod.segments=3;o.modifiers.new('normals','WEIGHTED_NORMAL')
# A dark inner disc leaves room for a screen-facing semantic glyph.
bpy.ops.mesh.primitive_cylinder_add(vertices=6,radius=.80,depth=.02,location=(0,0,.183),rotation=(0,0,math.pi/6))
o=bpy.context.object;o.name='semantic display face';o.data.materials.append(dark)
for i in range(6):
    a=(i+.5)*math.tau/6
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=6,radius=.03,location=(.90*math.cos(a),.90*math.sin(a),.19))
    bpy.context.object.name='capsule fastener';bpy.context.object.data.materials.append(steel)
bpy.ops.object.select_all(action='SELECT')
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
for o in meshes:
    bpy.context.view_layer.objects.active=o
    for modifier in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=modifier.name)
bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join()
bpy.context.object.name='pickup capsule'
bpy.ops.export_scene.gltf(filepath=str(OUT/'pickup-cinematic.glb'),export_format='GLB',use_selection=True,export_yup=True)
scene=setup(2.5);scene.render.resolution_x=scene.render.resolution_y=256;scene.render.filepath=str(OUT/'pickup.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'pickup.blend'));bpy.ops.render.render(write_still=True)
print('FLIGHT ASSETS EXPORTED',flush=True)
