"""Minted sats and faceted mineral dust: shared live meshes and turntable plates."""
import bpy, math
from pathlib import Path
OUT=Path(__file__).resolve().parent/'assets'
FRAMES=OUT/'frames'/'collectables';FRAMES.mkdir(parents=True,exist_ok=True)
def material(name,color,metal,rough):
    m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    return m
for kind in ['sat','dust']:
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    gold=material('minted gold',(.83,.47,.08),.88,.23)
    inset=material('recessed gold',(.20,.09,.018),.8,.3)
    gem=material('peridot facets',(.09,.65,.27),.36,.18)
    steel=material('native nickel iron',(.37,.44,.47),.85,.27)
    def finish(o,m,bevel=0):
        o.data.materials.append(m)
        if bevel:
            mod=o.modifiers.new('edge bevel','BEVEL');mod.width=bevel;mod.segments=1
            o.modifiers.new('weighted normals','WEIGHTED_NORMAL')
        return o
    def cylinder(radius,depth,z,m):
        bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=radius,depth=depth,location=(0,0,z))
        return finish(bpy.context.object,m,.02)
    def line(points,z,m,width=.045):
        c=bpy.data.curves.new('raised relief','CURVE');c.dimensions='3D';c.bevel_depth=width;c.bevel_resolution=0
        s=c.splines.new('POLY');s.points.add(len(points)-1)
        for p,(x,y) in zip(s.points,points):p.co=(x,y,z,1)
        o=bpy.data.objects.new('relief',c);bpy.context.collection.objects.link(o);c.materials.append(m)
        bpy.context.view_layer.objects.active=o;o.select_set(True);bpy.ops.object.convert(target='MESH');o.select_set(False)
    if kind=='sat':
        cylinder(.96,.23,0,gold)
        for face in [-1,1]:
            cylinder(.79,.025,face*.125,inset)
            bpy.ops.mesh.primitive_torus_add(major_segments=32,minor_segments=4,major_radius=.85,minor_radius=.045,location=(0,0,face*.14));finish(bpy.context.object,gold)
            paths=[[(-.20,-.43),(-.20,.43)],[(-.30,.35),(.11,.35),(.29,.26),(.29,.14),(.12,.035),(-.20,.035),(.15,.035),(.32,-.08),(.32,-.25),(.12,-.35),(-.30,-.35)]]
            paths += [[(x,-.48),(x,-.35)] for x in [-.08,.07]]+ [[(x,.35),(x,.48)] for x in [-.08,.07]]
            for pts in paths:line([(x*face,y) for x,y in pts],face*.175,gold)
        for i in range(16):
            a=i*math.tau/16
            bpy.ops.mesh.primitive_cube_add(size=1,location=(.955*math.cos(a),.955*math.sin(a),0),rotation=(0,0,a))
            o=bpy.context.object;o.scale=(.02,.025,.19);finish(o,gold)
    else:
        # Unequal rings and split faces retain a mineral silhouette, rather than a power-cell sphere.
        vs=[(0,0,1.05)];rings=[(.58,.55),(.91,-.05),(.49,-.65)]
        for row,(r,z) in enumerate(rings):
            for i in range(7):
                a=i*math.tau/7+row*.14;rr=r*(1+.12*math.sin(i*3+row));vs.append((rr*math.cos(a),rr*math.sin(a),z+.08*math.sin(i*2)))
        vs.append((.12,-.08,-1.0));fs=[]
        for i in range(7):
            n=(i+1)%7;fs.append((0,1+i,1+n));fs.append((22,15+n,15+i))
            for row in range(2):
                j=1+row*7;fs.extend([(j+i,j+7+i,j+n),(j+n,j+7+i,j+7+n)])
        mesh=bpy.data.meshes.new('split crystal facets');mesh.from_pydata(vs,[],fs);mesh.update()
        o=bpy.data.objects.new('peridot crystal',mesh);bpy.context.collection.objects.link(o);finish(o,gem)
        for pos,scale in [((.48,-.50,.24),(.22,.13,.44)),((-.48,.30,-.28),(.24,.10,.34)),((.10,-.73,-.10),(.3,.08,.19))]:
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=1,location=pos);o=bpy.context.object;o.scale=scale;finish(o,steel)
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        bpy.context.view_layer.objects.active=o;o.select_set(True)
        for mod in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
        o.select_set(False)
    for o in meshes:o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join();obj=bpy.context.object
    bpy.context.scene.cursor.location=(0,0,0);bpy.ops.object.origin_set(type='ORIGIN_CURSOR');obj.name='collectable '+kind
    bpy.ops.export_scene.gltf(filepath=str(OUT/('collectable-'+kind+'.glb')),export_format='GLB',use_selection=True,export_yup=True)
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
    scene.render.resolution_x=scene.render.resolution_y=128;scene.render.resolution_percentage=100
    scene.render.film_transparent=True;scene.render.image_settings.file_format='PNG';scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.08,.11,.15,1);scene.world.node_tree.nodes['Background'].inputs[1].default_value=.6
    bpy.ops.object.camera_add(location=(0,0,7));camera=bpy.context.object;camera.data.type='ORTHO';camera.data.ortho_scale=2.8;scene.camera=camera
    for pos,energy,col in [((-3,4,6),700,(1,.86,.65)),((3,-2,4),450,(.3,.7,1))]:
        bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=energy;o.data.color=col;o.data.size=3;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/('collectable-'+kind+'.blend')))
    for frame in range(16):
        t=frame*math.tau/16;obj.rotation_euler=(.32+.18*math.sin(t),t,.15 if kind=='sat' else t*.5)
        scene.render.filepath=str(FRAMES/(kind+'-'+str(frame).zfill(2)+'.png'));bpy.ops.render.render(write_still=True)
print('COLLECTABLES EXPORTED',flush=True)
