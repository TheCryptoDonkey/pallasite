"""Bake a short 3D reactor-plasma burst for the level-one player crash."""
import bpy, math, sys
from pathlib import Path
from mathutils import Vector
OUT=Path(__file__).resolve().parent/'assets'
FRAMES=OUT/'frames'/'death';FRAMES.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=48;scene.cycles.use_denoising=True
scene.cycles.volume_bounces=0;scene.cycles.max_bounces=4;scene.cycles.volume_step_rate=2
scene.render.resolution_x=scene.render.resolution_y=256;scene.render.resolution_percentage=100
scene.render.film_transparent=True;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.view_settings.view_transform='AgX';scene.view_settings.exposure=-.1
scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[1].default_value=.12

def plasma(name,colours):
    m=bpy.data.materials.new(name);m.use_nodes=True;n=m.node_tree.nodes;l=m.node_tree.links;n.clear()
    out=n.new('ShaderNodeOutputMaterial');p=n.new('ShaderNodeVolumePrincipled')
    noise=n.new('ShaderNodeTexNoise');noise.noise_dimensions='4D';noise.inputs['Scale'].default_value=8;noise.inputs['Detail'].default_value=6;noise.inputs['Roughness'].default_value=.72
    ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.46;ramp.color_ramp.elements[0].color=(*colours[0],1)
    ramp.color_ramp.elements[1].position=.72;ramp.color_ramp.elements[1].color=(*colours[2],1)
    ramp.color_ramp.elements.new(.62).color=(*colours[1],1)
    coords=n.new('ShaderNodeTexCoord')
    turbulence=n.new('ShaderNodeTexNoise');turbulence.inputs['Scale'].default_value=2.4;turbulence.inputs['Detail'].default_value=3
    l.new(coords.outputs['Object'],turbulence.inputs['Vector'])
    warp=n.new('ShaderNodeVectorMath');warp.operation='SCALE';warp.inputs['Scale'].default_value=.38;l.new(turbulence.outputs['Color'],warp.inputs[0])
    add=n.new('ShaderNodeVectorMath');add.operation='ADD';l.new(coords.outputs['Object'],add.inputs[0]);l.new(warp.outputs['Vector'],add.inputs[1]);l.new(add.outputs['Vector'],noise.inputs['Vector'])
    threshold=n.new('ShaderNodeMath');threshold.operation='SUBTRACT';threshold.inputs[1].default_value=.46;threshold.use_clamp=True;l.new(noise.outputs['Fac'],threshold.inputs[0])
    # One continuous turbulent volume instead of a flower of round lobes.
    generated=n.new('ShaderNodeTexCoord')
    boundaryNoise=n.new('ShaderNodeTexNoise');boundaryNoise.inputs['Scale'].default_value=3.4;boundaryNoise.inputs['Detail'].default_value=4
    l.new(generated.outputs['Generated'],boundaryNoise.inputs['Vector'])
    boundaryCenter=n.new('ShaderNodeVectorMath');boundaryCenter.operation='SUBTRACT';boundaryCenter.inputs[1].default_value=(.5,.5,.5);l.new(boundaryNoise.outputs['Color'],boundaryCenter.inputs[0])
    boundaryScale=n.new('ShaderNodeVectorMath');boundaryScale.operation='SCALE';boundaryScale.inputs['Scale'].default_value=.7;l.new(boundaryCenter.outputs['Vector'],boundaryScale.inputs[0])
    boundary=n.new('ShaderNodeVectorMath');boundary.operation='ADD';l.new(generated.outputs['Generated'],boundary.inputs[0]);l.new(boundaryScale.outputs['Vector'],boundary.inputs[1])
    dist=n.new('ShaderNodeVectorMath');dist.operation='DISTANCE';dist.inputs[1].default_value=(.5,.5,.5);l.new(boundary.outputs['Vector'],dist.inputs[0])
    edge=n.new('ShaderNodeMath');edge.operation='SUBTRACT';edge.inputs[0].default_value=.49;edge.use_clamp=True;l.new(dist.outputs['Value'],edge.inputs[1])
    field=n.new('ShaderNodeMath');field.operation='MULTIPLY';l.new(threshold.outputs[0],field.inputs[0]);l.new(edge.outputs[0],field.inputs[1])
    density=n.new('ShaderNodeMath');density.operation='MULTIPLY';density.inputs[1].default_value=35
    l.new(field.outputs[0],density.inputs[0]);l.new(density.outputs[0],p.inputs['Density'])
    # Emission concentrates in the hottest dense filaments, leaving dark gaps.
    heat=n.new('ShaderNodeMath');heat.operation='POWER';heat.inputs[1].default_value=2;l.new(threshold.outputs[0],heat.inputs[0])
    hotDensity=n.new('ShaderNodeMath');hotDensity.operation='MULTIPLY';l.new(density.outputs[0],hotDensity.inputs[0]);l.new(heat.outputs[0],hotDensity.inputs[1])
    emission=n.new('ShaderNodeMath');emission.operation='MULTIPLY';l.new(hotDensity.outputs[0],emission.inputs[0]);l.new(emission.outputs[0],p.inputs['Emission Strength'])
    p.inputs['Color'].default_value=(.045,.052,.067,1)
    l.new(noise.outputs['Fac'],ramp.inputs[0]);l.new(ramp.outputs[0],p.inputs['Emission Color'])
    l.new(p.outputs[0],out.inputs['Volume'])
    return m,emission,noise

core,pg,ng=plasma('orange white hot ruptured reactor',[(.001,.00003,.00001),(1,.28,.003),(1,.6,.06)])
warm,pw,nw=plasma('red cooling metal vapour',[(.0003,.00001,.00001),(.65,.006,.001),(1,.10,.005)])
blue,pb,nb=plasma('blue reactor ion vent',[(.00001,.0001,.002),(.005,.25,1),(.08,.7,1)])
bpy.ops.mesh.primitive_cube_add(size=2)
cloud=bpy.context.object;cloud.name='continuous turbulent cooling ejecta';cloud.data.materials.append(warm)
bpy.ops.mesh.primitive_cube_add(size=2)
reactor=bpy.context.object;reactor.name='white hot reactor rupture';reactor.data.materials.append(core)
bpy.ops.mesh.primitive_cube_add(size=2)
ion=bpy.context.object;ion.name='blue sheared reactor vent';ion.data.materials.append(blue)
bpy.ops.object.camera_add(location=(0,0,8));camera=bpy.context.object;camera.data.type='ORTHO';camera.data.ortho_scale=5.4;scene.camera=camera
for pos,energy,color in [((-3,4,5),1100,(1,.82,.55)),((3,-2,4),500,(.5,.64,1))]:
    bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=energy;o.data.color=color;o.data.size=2
    o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
for frame in ([7] if '--preview' in sys.argv else range(24)):
    t=(frame+.4)/24;expansion=1.85*(1-math.exp(-t*3.4))
    size=.18+expansion*1.1
    cloud.scale=(size*1.16,size*.83,size*.76);cloud.rotation_euler=(.18,.3,.2)
    reactor.scale=(size*.72,size*.61,size*.55);reactor.location=(t*.32,-t*.17,.05)
    ion.scale=(size*.34,size*.57,size*.35);ion.location=(size*.27,-size*.23,.32);ion.rotation_euler=(0,.2,-.45)
    pg.inputs[1].default_value=7000*math.exp(-t*7)+.03
    pw.inputs[1].default_value=650*math.exp(-t*4.8)+.015
    pb.inputs[1].default_value=3200*math.exp(-t*7)+.015
    ng.inputs['W'].default_value=nw.inputs['W'].default_value=nb.inputs['W'].default_value=t*.9
    scene.render.filepath=str(FRAMES/(str(frame).zfill(2)+'.png'));bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'death-burst.blend'))
print('BLENDER DEATH BURST FRAMES BAKED',flush=True)
