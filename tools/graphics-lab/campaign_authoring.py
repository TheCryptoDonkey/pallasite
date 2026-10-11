"""Extend the approved Blender art: mineral turntables, alien classes, station,
Forge containment hardware and gravity mines. CPU Cycles; no gameplay data."""
import bpy, math, re
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[2]
OUT=Path(__file__).resolve().parent/'assets'
FRAMES=OUT/'frames'/'campaign';FRAMES.mkdir(parents=True,exist_ok=True)
def rgb(h):
    # Art swatches are sRGB hex; Blender shader inputs and GLTF factors are
    # linear. Passing the swatches straight through washed lit reactors white.
    def linear(c):return c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
    return tuple(linear(((h>>n)&255)/255) for n in (16,8,0))
def material(name,color,metal=.75,rough=.3,emission=0):
    m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*rgb(color),1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    p.inputs['Emission Color'].default_value=(*rgb(color),1);p.inputs['Emission Strength'].default_value=emission
    return m
def finish(o,m,bevel=0):
    o.data.materials.append(m)
    if bevel:
        mod=o.modifiers.new('machined edge','BEVEL');mod.width=bevel;mod.segments=2
        o.modifiers.new('weighted surface normals','WEIGHTED_NORMAL')
    return o
def box(pos,scale,m,bevel=.015):
    bpy.ops.mesh.primitive_cube_add(size=1,location=pos);o=bpy.context.object;o.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);return finish(o,m,bevel)
def torus(r,z,tube,m):
    bpy.ops.mesh.primitive_torus_add(major_segments=48,minor_segments=8,major_radius=r,minor_radius=tube,location=(0,0,z));return finish(bpy.context.object,m)
def sphere(pos,scale,m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,location=pos);o=bpy.context.object;o.scale=scale
    for p in o.data.polygons:p.use_smooth=True
    return finish(o,m)
def clear():
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def setup(ortho=2.7):
    s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=16;s.cycles.use_denoising=True
    s.render.resolution_x=s.render.resolution_y=256;s.render.resolution_percentage=100
    s.render.film_transparent=True;s.render.image_settings.file_format='PNG';s.render.image_settings.color_mode='RGBA'
    s.world.use_nodes=True;s.world.node_tree.nodes['Background'].inputs[0].default_value=(.08,.11,.15,1);s.world.node_tree.nodes['Background'].inputs[1].default_value=.6
    bpy.ops.object.camera_add(location=(0,0,7));c=bpy.context.object;c.data.type='ORTHO';c.data.ortho_scale=ortho;s.camera=c
    for pos,energy,col in [((-3,4,6),700,(1,.86,.65)),((3,-2,4),450,(.3,.7,1))]:
        bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=energy;o.data.color=col;o.data.size=3;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
def export(name):
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH'];bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        bpy.context.view_layer.objects.active=o;o.select_set(True)
        for mod in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
        o.select_set(False)
    for o in meshes:o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True)
    return meshes
def plate(name):
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(name+'.blend')))
    bpy.context.scene.render.filepath=str(FRAMES/(name+'.png'));bpy.ops.render.render(write_still=True)
