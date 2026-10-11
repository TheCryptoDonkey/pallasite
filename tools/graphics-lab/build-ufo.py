"""Author the first-level alien interceptor in Blender; export live and baked art."""
import bpy, math
from pathlib import Path
from mathutils import Vector

OUT=Path(__file__).resolve().parent/'assets'
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.engine='CYCLES';scene.cycles.samples=64;scene.cycles.use_denoising=True
scene.render.resolution_x=scene.render.resolution_y=768
scene.render.resolution_percentage=100;scene.render.film_transparent=True
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.035,.045,.07,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.45

def material(name,color,metal,rough,emission=0):
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    p=mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    if emission:
        p.inputs['Emission Color'].default_value=(*color,1);p.inputs['Emission Strength'].default_value=emission
    return mat

titanium=material('alien smoked titanium',(.18,.22,.28),.82,.3)
silver=material('silver armour facets',(.48,.52,.58),.75,.26)
dark=material('black ceramic seams',(.013,.019,.026),.35,.38)
alloy=material('warm iridium edges',(.45,.29,.17),.8,.27)
glass=material('amethyst canopy',(.075,.022,.16),.6,.13,.16)
plasma=material('violet reactor',(.42,.065,1),.15,.2,2.3)
amber=material('amber weapon capacitors',(1,.22,.045),.3,.24,2.3)

def finish(obj,name,mat,bevel=0):
    obj.name=name;obj.data.materials.append(mat)
    if bevel:
        mod=obj.modifiers.new('machined bevel','BEVEL');mod.width=bevel;mod.segments=2
        obj.modifiers.new('weighted normals','WEIGHTED_NORMAL')
    return obj

def lathe(name,profile,mat):
    vertices=[];faces=[];segments=96
    for r,z in profile:
        for i in range(segments):
            a=i*math.tau/segments;vertices.append((r*math.cos(a),r*math.sin(a),z))
    for j in range(len(profile)-1):
        for i in range(segments):
            n=(i+1)%segments;faces.append((j*segments+i,j*segments+n,(j+1)*segments+n,(j+1)*segments+i))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);finish(obj,name,mat)
    for p in mesh.polygons:p.use_smooth=True
    return obj

def torus(name,r,z,minor,mat):
    bpy.ops.mesh.primitive_torus_add(major_segments=96,minor_segments=8,location=(0,0,z),major_radius=r,minor_radius=minor)
    obj=finish(bpy.context.object,name,mat)
    for p in obj.data.polygons:p.use_smooth=True
    return obj

lathe('lenticular armoured hull',[(0,-.23),(.38,-.24),(.78,-.16),(1.02,-.01),(.97,.08),(.71,.18),(.38,.25),(0,.25)],titanium)
torus('equatorial black seam',.992,.015,.018,dark)
torus('iridium collision rim',1.012,-.018,.015,alloy)
torus('lower reactor glow',.68,-.175,.027,plasma)
torus('reactor protective rail',.70,-.151,.011,silver)
torus('canopy gasket',.39,.252,.026,dark)
torus('canopy iridium frame',.367,.278,.016,alloy)
torus('reactor crown',.44,.236,.014,plasma)
bpy.ops.mesh.primitive_uv_sphere_add(segments=40,ring_count=20,location=(0,0,.27))
dome=finish(bpy.context.object,'raised smoked canopy',glass)
dome.scale=(.35,.35,.28)
for p in dome.data.polygons:p.use_smooth=True

# Eight independent plated sectors leave actual recessed radial panel seams.
for sector in range(8):
    vertices=[]
    for r,z in [(.48,.249),(.92,.109)]:
        for j in range(9):
            a=(sector+(j/8*.88+.06))*math.tau/8
            vertices.append((r*math.cos(a),r*math.sin(a),z))
    faces=[(j,j+1,9+j+1,9+j) for j in range(8)]
    mesh=bpy.data.meshes.new('sector plate');mesh.from_pydata(vertices,[],faces);mesh.update()
    obj=bpy.data.objects.new('swept armour sector',mesh);bpy.context.collection.objects.link(obj)
    finish(obj,'swept armour sector',silver if sector%3 else titanium)
    thick=obj.modifiers.new('armour thickness','SOLIDIFY');thick.thickness=.018
    bevel=obj.modifiers.new('plate edges','BEVEL');bevel.width=.008;bevel.segments=2
    obj.modifiers.new('plate normals','WEIGHTED_NORMAL')
    for r in [.54,.87]:
        a=(sector+.5)*math.tau/8
        bpy.ops.mesh.primitive_uv_sphere_add(segments=8,ring_count=4,radius=.014,location=(r*math.cos(a),r*math.sin(a),.25 if r<.6 else .13))
        finish(bpy.context.object,'recessed fastener',dark)

for i in range(16):
    a=i*math.tau/16
    bpy.ops.mesh.primitive_cube_add(size=1,location=(.948*math.cos(a),.948*math.sin(a),.088))
    obj=finish(bpy.context.object,'rim drive emitter',plasma if i%4 else amber,.005)
    obj.scale=(.033,.088,.028);obj.rotation_euler.z=a
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
for i in range(4):
    a=i*math.tau/4+math.pi/4
    bpy.ops.mesh.primitive_cylinder_add(vertices=24,radius=.054,depth=.045,location=(.72*math.cos(a),.72*math.sin(a),.195))
    finish(bpy.context.object,'weapon aperture collar',dark,.006)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=.036,location=(.72*math.cos(a),.72*math.sin(a),.216))
    obj=finish(bpy.context.object,'weapon capacitor lens',amber);obj.scale.z=.45

# Inset service bays, raised radiator teeth and under-rim drive hardware.
for sector in range(8):
    a=(sector+.28)*math.tau/8
    for j in range(6):
        r=.61+j*.026
        bpy.ops.mesh.primitive_cube_add(size=1,location=(r*math.cos(a),r*math.sin(a),.248-(r-.48)*.318))
        obj=finish(bpy.context.object,'radial radiator tooth',dark if j%2 else alloy,.003)
        obj.scale=(.013,.13,.019);obj.rotation_euler.z=a
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    for j in range(3):
        r=.80+j*.026;a2=a+.29
        bpy.ops.mesh.primitive_cube_add(size=1,location=(r*math.cos(a2),r*math.sin(a2),.248-(r-.48)*.318+.006))
        obj=finish(bpy.context.object,'etched service marking',alloy,.001)
        obj.scale=(.009,.075,.005);obj.rotation_euler.z=a2
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,location=(.86*math.cos(a),.86*math.sin(a),-.105))
    obj=finish(bpy.context.object,'under-rim drive nacelle',titanium);obj.scale=(.095,.095,.065)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=6,location=(.86*math.cos(a),.86*math.sin(a),-.165))
    obj=finish(bpy.context.object,'drive exhaust iris',plasma);obj.scale=(.05,.05,.018)
for meridian in range(4):
    a=meridian*math.pi/2
    curve=bpy.data.curves.new('canopy pressure rib','CURVE');curve.dimensions='3D';curve.bevel_depth=.005;curve.bevel_resolution=2
    path=curve.splines.new('POLY');path.points.add(12)
    for j,point in enumerate(path.points):
        t=j*math.pi/24;point.co=(.354*math.cos(t)*math.cos(a),.354*math.cos(t)*math.sin(a),.27+.285*math.sin(t),1)
    obj=bpy.data.objects.new('canopy pressure rib',curve);bpy.context.collection.objects.link(obj);curve.materials.append(alloy)
    bpy.context.view_layer.objects.active=obj;obj.select_set(True);bpy.ops.object.convert(target='MESH');obj.select_set(False)

# Belly hardware reads during the steep bank: recessed turbine, concentric
# rails, six radial heat exchangers and a protected central drive lens.
lathe('belly turbine well',[(0,-.29),(.26,-.29),(.33,-.25),(.42,-.235)],dark)
torus('belly turbine iridium rail',.33,-.265,.017,alloy)
torus('belly turbine light ring',.24,-.297,.022,plasma)
bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,location=(0,0,-.30))
obj=finish(bpy.context.object,'belly drive lens',glass);obj.scale=(.20,.20,.065)
for i in range(12):
    a=i*math.tau/12
    bpy.ops.mesh.primitive_cube_add(size=1,location=(.49*math.cos(a),.49*math.sin(a),-.231))
    obj=finish(bpy.context.object,'belly heat exchanger',silver if i%2 else dark,.008)
    obj.scale=(.22,.038,.035);obj.rotation_euler.z=a
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)

# Join into two independently animated assemblies, with a shared centre.
# Keep the underside and collision rim stationary while the upper plates,
# canopy and radiators rotate. Each assembly retains material batching.
bpy.ops.object.select_all(action='DESELECT')
meshes=[o for o in scene.objects if o.type=='MESH']
upper=[];lower=[]
for obj in meshes:
    bpy.context.view_layer.objects.active=obj;obj.select_set(True)
    for modifier in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)
    centre=sum((obj.matrix_world@Vector(v) for v in obj.bound_box),Vector())/8
    (upper if centre.z>.07 else lower).append(obj)
assemblies=[]
for name,parts in [('Alien Hull',lower),('Upper Rotor',upper)]:
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:obj.select_set(True)
    bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join()
    obj=bpy.context.object;obj.name=name
    scene.cursor.location=(0,0,0);bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    assemblies.append(obj)
for obj in assemblies:obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(OUT/'ufo-cinematic.glb'),export_format='GLB',use_selection=True,export_yup=True,export_materials='EXPORT')

bpy.ops.object.camera_add(location=(0,-4.5,8))
camera=bpy.context.object;camera.rotation_euler=(Vector((0,0,.1))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type='ORTHO';camera.data.ortho_scale=2.6;scene.camera=camera
for location,energy,color,size in [((-3,4,6),700,(1,.84,.68),3),((4,-2,4),450,(.3,.62,1),2),((0,-4,1.5),200,(.7,.25,1),2)]:
    bpy.ops.object.light_add(type='AREA',location=location);light=bpy.context.object
    light.data.energy=energy;light.data.color=color;light.data.shape='DISK';light.data.size=size
    light.rotation_euler=(-light.location).to_track_quat('-Z','Y').to_euler()
scene.render.filepath=str(OUT/'ufo.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'ufo.blend'))
bpy.ops.render.render(write_still=True)
print('UFO EXPORTED AND BAKED',flush=True)
