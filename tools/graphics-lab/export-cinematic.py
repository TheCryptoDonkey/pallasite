"""Bake Blender surfaces to UV PBR maps and export review-only GLBs."""
import bpy
import math
import random
from mathutils import Vector, noise
from pathlib import Path

OUT = Path(__file__).resolve().parent / 'assets'
ROOT = Path(__file__).resolve().parents[2]

def geology(name):
    """Ultra-only fractured rock, with joined rubble and independent microrelief."""
    rng=random.Random(819 if name=='stony' else 421)
    metal=name=='pallasite'
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    mat=bpy.data.materials.new(name+' unweathered interior and space-weathered crust')
    mat.use_nodes=True
    nodes,links=mat.node_tree.nodes,mat.node_tree.links
    bsdf=nodes.get('Principled BSDF')
    tex=nodes.new('ShaderNodeTexImage')
    tex.image=bpy.data.images.load(str(ROOT/'public'/'backgrounds'/('asteroid-'+name+'.webp')))
    tex.projection='BOX';tex.projection_blend=.35
    coords=nodes.new('ShaderNodeTexCoord');links.new(coords.outputs['Generated'],tex.inputs['Vector'])
    hue=nodes.new('ShaderNodeHueSaturation');hue.inputs['Saturation'].default_value=.92 if metal else .6;hue.inputs['Value'].default_value=1.08 if metal else .95
    links.new(tex.outputs['Color'],hue.inputs['Color']);links.new(hue.outputs['Color'],bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value=.68 if metal else .93
    bsdf.inputs['Metallic'].default_value=.35 if metal else 0
    # Relief is geological geometry/noise, never brightness interpreted as height.
    grain=nodes.new('ShaderNodeTexNoise');grain.inputs['Scale'].default_value=145;grain.inputs['Detail'].default_value=5;grain.inputs['Roughness'].default_value=.8
    links.new(coords.outputs['Generated'],grain.inputs['Vector'])
    fine=nodes.new('ShaderNodeBump');fine.inputs['Strength'].default_value=.5;fine.inputs['Distance'].default_value=.012
    links.new(grain.outputs['Fac'],fine.inputs['Height'])
    cracks=nodes.new('ShaderNodeTexVoronoi');cracks.feature='DISTANCE_TO_EDGE';cracks.inputs['Scale'].default_value=24
    links.new(coords.outputs['Generated'],cracks.inputs['Vector'])
    fissure=nodes.new('ShaderNodeValToRGB');fissure.color_ramp.elements[0].position=.018;fissure.color_ramp.elements[1].position=.055
    links.new(cracks.outputs['Distance'],fissure.inputs[0])
    relief=nodes.new('ShaderNodeBump');relief.inputs['Strength'].default_value=.48;relief.inputs['Distance'].default_value=.026
    links.new(fissure.outputs['Color'],relief.inputs['Height']);links.new(fine.outputs['Normal'],relief.inputs['Normal']);links.new(relief.outputs['Normal'],bsdf.inputs['Normal'])

    planes=[(Vector((rng.uniform(-1,1),rng.uniform(-1,1),rng.uniform(-1,1))).normalized(),rng.uniform(.77,1.03)) for _ in range(11)]
    def surface(direction):
        r=1+.17*noise.noise_vector(direction*2.1)[0]+.065*noise.noise_vector(direction*7.3)[1]
        for axis,limit in planes:
            projection=direction.dot(axis)
            if projection>0:r=min(r,limit/projection)
        return Vector((direction.x*r*1.04,direction.y*r*.83,direction.z*r*.91))
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=5,radius=1)
    body=bpy.context.object;body.name=name+' fractured core'
    for vert in body.data.vertices:vert.co=surface(vert.co.normalized())
    body.data.materials.append(mat)
    for face in body.data.polygons:face.use_smooth=True
    edges=body.modifiers.new('broken face boundaries','EDGE_SPLIT');edges.split_angle=1.25;edges.use_edge_sharp=False
    bpy.ops.object.modifier_apply(modifier=edges.name)
    pieces=[body]
    # Most grains remain half buried. Sparse larger shards interrupt the silhouette.
    for i in range(310 if not metal else 190):
        d=Vector((rng.gauss(0,1),rng.gauss(0,1),rng.gauss(0,1))).normalized()
        s=rng.uniform(.018,.065) if i%13 else rng.uniform(.07,.13)
        point=surface(d)-d*s*.65
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2 if i%13==0 else 1,radius=1,location=point)
        shard=bpy.context.object
        for vert in shard.data.vertices:vert.co*=rng.uniform(.72,1.22)
        shard.scale=(s*rng.uniform(.7,1.3),s*rng.uniform(.7,1.3),s*.65)
        shard.rotation_euler=(rng.random()*6.28,rng.random()*6.28,rng.random()*6.28)
        shard.data.materials.append(mat);pieces.append(shard)
    bpy.ops.object.select_all(action='DESELECT')
    for part in pieces:part.select_set(True)
    bpy.context.view_layer.objects.active=body;bpy.ops.object.join()
    body.rotation_euler=(.1,-.12,.18 if metal else -.2)
    bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(name+'-ultra-source.blend')))
    return body

def bake(obj, mat, name, kind):
    nodes = mat.node_tree.nodes
    image = bpy.data.images.new(name + '-' + kind, width=2048, height=2048, alpha=False)
    image.colorspace_settings.name = 'sRGB' if kind == 'albedo' else 'Non-Color'
    target = nodes.new('ShaderNodeTexImage')
    target.image = image
    nodes.active = target
    bpy.context.scene.cycles.samples = 16
    bpy.context.scene.render.bake.margin = 12
    if kind == 'albedo':
        bpy.context.scene.render.bake.use_pass_direct = False
        bpy.context.scene.render.bake.use_pass_indirect = False
        bpy.context.scene.render.bake.use_pass_color = True
        bpy.ops.object.bake(type='DIFFUSE')
    else:
        bpy.ops.object.bake(type='NORMAL')
    image.filepath_raw = str(OUT / (name + '-' + kind + ('.jpg' if kind=='albedo' else '.png')))
    image.file_format = 'JPEG' if kind=='albedo' else 'PNG'
    image.save()
    return image

for name in ['stony', 'pallasite', 'ship']:
    bpy.ops.wm.open_mainfile(filepath=str(OUT / (name + '.blend')))
    bpy.ops.object.select_all(action='DESELECT')
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if name != 'ship':
        obj = geology(name)
        meshes=[obj]
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=1.2, island_margin=.0015,area_weight=.3)
        bpy.ops.object.mode_set(mode='OBJECT')
        source = obj.data.materials[0]
        albedo = bake(obj, source, name, 'albedo')
        normal = bake(obj, source, name, 'normal')
        mat = bpy.data.materials.new(name + ' cinematic PBR')
        mat.use_nodes = True
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        shader = nodes.get('Principled BSDF')
        shader.inputs['Roughness'].default_value = .68 if name == 'pallasite' else .93
        shader.inputs['Metallic'].default_value = .35 if name == 'pallasite' else 0
        colour = nodes.new('ShaderNodeTexImage')
        colour.image = albedo
        links.new(colour.outputs['Color'], shader.inputs['Base Color'])
        norm = nodes.new('ShaderNodeTexImage')
        norm.image = normal
        normnode = nodes.new('ShaderNodeNormalMap')
        links.new(norm.outputs['Color'], normnode.inputs['Color'])
        links.new(normnode.outputs['Normal'], shader.inputs['Normal'])
        if name == 'pallasite':
            separate = nodes.new('ShaderNodeSeparateColor')
            links.new(colour.outputs['Color'], separate.inputs['Color'])
            mask=nodes.new('ShaderNodeMath');mask.operation='MULTIPLY';mask.inputs[1].default_value=.6
            links.new(separate.outputs['Blue'],mask.inputs[0]);links.new(mask.outputs[0], shader.inputs['Metallic'])
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    for obj in meshes: obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT / (name + '-cinematic.glb')), export_format='GLB', use_selection=True, export_yup=True, export_texcoords=True, export_normals=True, export_materials='EXPORT', export_image_format='WEBP', export_image_quality=96)
    print('CINEMATIC EXPORTED:', name, flush=True)
