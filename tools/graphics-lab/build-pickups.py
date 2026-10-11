"""Six Blender-authored spherical power cells with raised semantic symbols."""
import bpy, math
from pathlib import Path
from mathutils import Vector
OUT=Path(__file__).resolve().parent/'assets'
TYPES={'rapid':(1,.25,.035),'satboost':(1,.69,.055),'nova':(1,.065,.08),
       'trident':(1,.69,.055),'magnet':(.075,.35,1),'extralife':(.08,1,.13)}

def material(name,color,metal=.7,rough=.25,emit=0):
    m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1);p.inputs['Metallic'].default_value=metal
    p.inputs['Roughness'].default_value=rough;p.inputs['Emission Color'].default_value=(*color,1)
    p.inputs['Emission Strength'].default_value=emit;return m

for kind,color in TYPES.items():
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    steel=material('polished titanium',(.43,.51,.57),.8,.2)
    shell=material('coloured pearl alloy',tuple(.13+c*.28 for c in color),.48,.2)
    dark=material('recessed ceramic',(.012,.026,.04),.4,.36)
    trim=material('warm alloy fasteners',(.55,.34,.13),.85,.23)
    glow=material('status emitter',color,.4,.24,.9)
    def finish(o,name,m,bevel=.025):
        o.name=name;o.data.materials.append(m)
        if bevel:
            mod=o.modifiers.new('machined bevel','BEVEL');mod.width=bevel;mod.segments=2
            o.modifiers.new('weighted normals','WEIGHTED_NORMAL')
        return o
    def disc(name,r,z,depth,m,vertices=6):
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=r,depth=depth,location=(0,0,z),rotation=(0,0,math.pi/6))
        return finish(bpy.context.object,name,m)
    def path(name,points,width=.035,m=None,closed=False):
        curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.bevel_depth=width;curve.bevel_resolution=2
        spline=curve.splines.new('POLY');spline.points.add(len(points)-1)
        for p,(x,y) in zip(spline.points,points):p.co=(x,y,1.015,1)
        spline.use_cyclic_u=closed
        o=bpy.data.objects.new(name,curve);bpy.context.collection.objects.link(o);curve.materials.append(m or glow)
        bpy.context.view_layer.objects.active=o;o.select_set(True);bpy.ops.object.convert(target='MESH');o.select_set(False)
    def raised(name,points):
        n=len(points);vs=[(x,y,z) for z in [.985,1.075] for x,y in points]
        faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
        mesh=bpy.data.meshes.new(name);mesh.from_pydata(vs,[],faces);mesh.update()
        o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);finish(o,name,glow,.012)
    # A smooth spherical shell with a small recessed front display opening.
    vertices=[];faces=[];segments=48;rings=24
    for j in range(rings+1):
        t=math.acos(.8)+(math.pi-math.acos(.8))*j/rings
        for i in range(segments):
            a=i*math.tau/segments;vertices.append((math.sin(t)*math.cos(a),math.sin(t)*math.sin(a),math.cos(t)))
    for j in range(rings):
        for i in range(segments):
            n=(i+1)%segments;faces.append((j*segments+i,(j+1)*segments+i,(j+1)*segments+n,j*segments+n))
    mesh=bpy.data.meshes.new('spherical shell');mesh.from_pydata(vertices,[],faces);mesh.update()
    obj=bpy.data.objects.new('spherical pearl alloy shell',mesh);bpy.context.collection.objects.link(obj);finish(obj,obj.name,shell,0)
    for p in mesh.polygons:p.use_smooth=True
    def ring(name,r,z,width,m):
        bpy.ops.mesh.primitive_torus_add(major_segments=48,minor_segments=8,major_radius=r,minor_radius=width,location=(0,0,z))
        o=finish(bpy.context.object,name,m,0)
        for p in o.data.polygons:p.use_smooth=True
    ring('equatorial energy seam',1.005,0,.022,glow)
    ring('front titanium bezel',.61,.825,.035,steel)
    ring('front status ring',.59,.865,.018,glow)
    disc('circular ceramic glyph well',.59,.897,.065,dark,48)
    disc('rear reactor housing',.33,-.96,.11,steel,32)
    disc('rear reactor lens',.23,-1.024,.035,glow,32)
    for i in range(6):
        a=i*math.tau/6
        curve=bpy.data.curves.new('spherical armour meridian','CURVE');curve.dimensions='3D';curve.bevel_depth=.018;curve.bevel_resolution=1
        spline=curve.splines.new('POLY');spline.points.add(24)
        for j,p in enumerate(spline.points):
            t=.69+(math.pi-1.03)*j/24
            p.co=(1.012*math.sin(t)*math.cos(a),1.012*math.sin(t)*math.sin(a),1.012*math.cos(t),1)
        o=bpy.data.objects.new('titanium meridian rail',curve);bpy.context.collection.objects.link(o);curve.materials.append(steel)
        bpy.context.view_layer.objects.active=o;o.select_set(True);bpy.ops.object.convert(target='MESH');o.select_set(False)
        for t in [.76,2.64]:
            bpy.ops.mesh.primitive_uv_sphere_add(segments=8,ring_count=4,radius=.035,location=(1.01*math.sin(t)*math.cos(a),1.01*math.sin(t)*math.sin(a),1.01*math.cos(t)))
            finish(bpy.context.object,'alloy captive fastener',trim,0)
    if kind=='rapid':raised('raised lightning',[(.12,.43),(-.33,-.03),(-.04,-.03),(-.13,-.43),(.33,.10),(.04,.10)])
    elif kind=='satboost':
        path('bitcoin spine',[(-.18,-.38),(-.18,.38)])
        path('bitcoin loops',[(-.27,.30),(.11,.30),(.26,.23),(.26,.12),(.10,.02),(-.18,.02),(.13,.02),(.28,-.07),(.28,-.22),(.12,-.30),(-.27,-.30)])
        for x in [-.08,.045]:path('bitcoin bars',[(x,-.42),(x,-.29)]);path('bitcoin bars',[(x,.30),(x,.42)])
    elif kind=='nova':
        path('nova core',[(.15*math.cos(i*math.tau/24),.15*math.sin(i*math.tau/24)) for i in range(24)],closed=True)
        for i in range(8):
            a=i*math.tau/8;path('nova ray',[(r*math.cos(a),r*math.sin(a)) for r in [.27,.44]],.03)
    elif kind=='trident':
        for y in [-.27,0,.27]:
            path('three shot shaft',[(-.35,0),(.33,y)],.027)
            path('three shot arrow',[(.19,y-.1),(.33,y),(.19,y+.1)],.027)
    elif kind=='magnet':
        path('horseshoe magnet',[(-.28,.30),(-.28,-.09),(-.22,-.27),(0,-.35),(.22,-.27),(.28,-.09),(.28,.30)],.065)
        for x in [-.28,.28]:path('magnet poles',[(x-.09,.18),(x+.09,.18)],.025,steel)
    elif kind=='extralife':
        pts=[]
        for i in range(48):
            t=i*math.tau/48;pts.append((16*math.sin(t)**3/40,(13*math.cos(t)-5*math.cos(2*t)-2*math.cos(3*t)-math.cos(4*t))/40))
        raised('raised heart',list(reversed(pts)))
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        bpy.context.view_layer.objects.active=o;o.select_set(True)
        for mod in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
        o.select_set(False)
    for o in meshes:o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join();obj=bpy.context.object;obj.name='pickup '+kind
    bpy.context.scene.cursor.location=(0,0,0);bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    bpy.ops.export_scene.gltf(filepath=str(OUT/('pickup-'+kind+'.glb')),export_format='GLB',use_selection=True,export_yup=True)
    # Baked plates preserve the spherical silhouette and raised symbols.
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True
    scene.render.resolution_x=scene.render.resolution_y=256;scene.render.resolution_percentage=100
    scene.render.film_transparent=True;scene.render.image_settings.file_format='PNG'
    scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.05,.075,.10,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.55
    bpy.ops.object.camera_add(location=(2,-3,7));camera=bpy.context.object
    camera.rotation_euler=(-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.type='ORTHO';camera.data.ortho_scale=3;scene.camera=camera
    for pos,energy,col,size in [((-3,4,6),800,(1,.87,.69),3),((3,-2,4),400,(.3,.7,1),2)]:
        bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object
        o.data.energy=energy;o.data.color=col;o.data.size=size;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(OUT/('pickup-'+kind+'.png'))
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/('pickup-'+kind+'.blend')));bpy.ops.render.render(write_still=True)
print('SIX SCULPTED PICKUPS EXPORTED',flush=True)
