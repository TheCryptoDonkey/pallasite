"""Offline Blender study: run with Blender --background --python this_file.

Source models and transparent renders stay in this isolated graphics lab.
"""
import bpy
import math
import random
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parent / 'assets'
ROOT = Path(__file__).resolve().parents[2]
OUT.mkdir(parents=True, exist_ok=True)
random.seed(194)

def material(name, colour, metallic=0, roughness=.5):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*colour, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*colour, 1)
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    return mat

def setup():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 128
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 1536
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '16'
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.045, .065, .085, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .4
    bpy.ops.object.camera_add(location=(0, 0, 8))
    camera = bpy.context.object
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 3.15
    scene.camera = camera
    for location, energy, colour, size in [((-3, 4, 6), 850, (.84, .91, 1), 2.2), ((4, 1, 2.7), 420, (1, .73, .36), 2), ((0, -4, 2), 480, (.16, .73, 1), 1.5)]:
        bpy.ops.object.light_add(type='AREA', location=location)
        light = bpy.context.object
        light.data.energy = energy
        light.data.color = colour
        light.data.shape = 'DISK'
        light.data.size = size
        light.rotation_euler = (Vector((0, 0, 0)) - light.location).to_track_quat('-Z', 'Y').to_euler()
    return scene

def rock(name, metal=False):
    scene = setup()
    mat = material(name, (.25, .29, .32) if metal else (.24, .20, .16), .78 if metal else .12, .34 if metal else .82)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = bpy.data.images.load(str(ROOT / 'public' / 'backgrounds' / ('asteroid-' + name + '.webp')))
    texture.projection = 'BOX'
    texture.projection_blend = .25
    coord = nodes.new('ShaderNodeTexCoord')
    links.new(coord.outputs['Generated'], texture.inputs[0])
    links.new(texture.outputs['Color'], nodes.get('Principled BSDF').inputs['Base Color'])
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .33 if metal else .65
    bump.inputs['Distance'].default_value = .032 if metal else .065
    links.new(texture.outputs['Color'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], nodes.get('Principled BSDF').inputs['Normal'])
    if metal:
        separate = nodes.new('ShaderNodeSeparateColor')
        links.new(texture.outputs['Color'], separate.inputs['Color'])
        links.new(separate.outputs['Blue'], nodes.get('Principled BSDF').inputs['Metallic'])
    craters = [(Vector((random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(-.15, 1))).normalized(), random.uniform(.08, .27), random.uniform(.025, .095)) for _ in range(24)]
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=6, radius=1)
    obj = bpy.context.object
    obj.name = name
    for vert in obj.data.vertices:
        p = vert.co.normalized()
        r = 1 + .11*math.sin(p.x*5+p.y*3) + .075*math.cos(p.z*7+p.y*8)
        r += .022*math.sin(p.x*33+p.z*21)*math.cos(p.y*28)
        for centre, radius, depth in craters:
            d = (p-centre).length/radius
            if d < 1.2:
                r -= depth*math.exp(-d*d*3)
                r += depth*.32*math.exp(-((d-.88)*8)**2)
        vert.co *= r
        vert.co.x *= .92
        if metal:
            vert.co.z = min(vert.co.z, .53+.065*math.sin(p.x*6+p.y*4))
    obj.data.materials.append(mat)
    for face in obj.data.polygons:
        face.use_smooth = True
    obj.rotation_euler = (.10, -.12, .18 if metal else -.2)
    bpy.ops.file.pack_all()
    scene.render.filepath = str(OUT / (name + '.png'))
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / (name + '.blend')))
    bpy.ops.render.render(write_still=True)
    turntable(scene, name)

def turntable(scene, name):
    """Bake fixed-light yaw frames; high-poly geometry never reaches Chrome."""
    scene.render.resolution_x = scene.render.resolution_y = 256
    scene.cycles.samples = 24
    scene.render.image_settings.color_depth = '8'
    parent = bpy.data.objects.new('offline turntable', None)
    scene.collection.objects.link(parent)
    for obj in list(scene.objects):
        if obj.type == 'MESH': obj.parent = parent
    frames = OUT / 'frames' / name
    frames.mkdir(parents=True, exist_ok=True)
    for frame in range(32):
        parent.rotation_euler.z = frame * math.tau / 32
        if name != 'ship':
            parent.rotation_euler.x = math.sin(frame*math.tau/32)*.28
        scene.render.filepath = str(frames / f'{frame:02}.png')
        bpy.ops.render.render(write_still=True)

def hull_mesh(name, outline, z, depth, mat):
    n = len(outline)
    verts = [(x, y, z) for x, y in outline] + [(x*.98, y*.98, z+depth) for x, y in outline]
    faces = [tuple(range(n-1, -1, -1)), tuple(range(n, n*2))]
    faces += [(i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new('machined edges', 'BEVEL')
    bevel.width = .025
    bevel.segments = 3
    obj.modifiers.new('weighted normals', 'WEIGHTED_NORMAL')
    return obj

def cube(name, pos, scale, mat, bevel=.015, rot=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.rotation_euler.z = rot
    obj.data.materials.append(mat)
    mod = obj.modifiers.new('engineering edges', 'BEVEL')
    mod.width = bevel
    mod.segments = 3
    obj.modifiers.new('weighted normals', 'WEIGHTED_NORMAL')
    return obj

def cylinder(name, pos, radius, depth, mat, rot=(0,0,0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=depth, location=pos, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    mod = obj.modifiers.new('ring edges', 'BEVEL')
    mod.width = .008
    mod.segments = 2
    obj.modifiers.new('weighted normals', 'WEIGHTED_NORMAL')
    return obj

def weather(mat):
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 100
    noise.inputs['Detail'].default_value = 3
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .14
    bump.inputs['Distance'].default_value = .012
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], nodes.get('Principled BSDF').inputs['Normal'])
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (.19,.19,.19,1)
    ramp.color_ramp.elements[1].color = (.48,.48,.48,1)
    links.new(noise.outputs['Fac'], ramp.inputs[0])
    links.new(ramp.outputs[0], nodes.get('Principled BSDF').inputs['Roughness'])

def ship():
    scene = setup()
    scene.camera.data.ortho_scale = 3.35
    steel = material('brushed titanium', (.35, .43, .48), .85, .3)
    plate = material('ceramic silver armour', (.63,.68,.67), .62, .28)
    dark = material('carbon recesses', (.019,.025,.03), .65, .35)
    brass = material('warm alloy trim', (.58, .34, .13), .78, .25)
    glass = material('smoked teal canopy', (.015,.15,.18), .68, .15)
    glow = material('plasma emitter', (.08,.66,.86), .25, .22)
    glow.node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].default_value = (.08,.66,.86,1)
    glow.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value = 3
    warning = material('amber lens', (.9,.29,.03), .3, .3)
    for mat in [steel,plate,brass]: weather(mat)
    outline = [(0,1.38),(-.16,.74),(-1,-.77),(-.88,-1.03),(-.29,-.79),(0,-.96),(.29,-.79),(.88,-1.03),(1,-.77),(.16,.74)]
    hull_mesh('armoured lower chassis', outline, -.10, .22, dark)
    hull_mesh('titanium perimeter', [(x*.98,y*.98) for x,y in outline], .10, .07, steel)
    hull_mesh('central fuselage', [(0,1.35),(-.18,.59),(-.29,-.57),(0,-.83),(.29,-.57),(.18,.59)], .17, .12, plate)
    hull_mesh('spinal inset', [(0,1.2),(-.07,.68),(-.1,-.58),(0,-.73),(.1,-.58),(.07,.68)], .30, .025, dark)
    for side in [-1,1]:
        mirror = lambda poly: [(side*x,y) for x,y in poly]
        hull_mesh('wing inset cavity', mirror([(.2,.55),(.94,-.77),(.85,-.92),(.31,-.63)]), .18, .02, dark)
        hull_mesh('forward swept armour', mirror([(.24,.41),(.73,-.42),(.39,-.29),(.26,-.07)]), .21, .06, plate)
        hull_mesh('outer armour segment', mirror([(.77,-.48),(.91,-.77),(.81,-.86),(.45,-.42)]), .21, .055, steel)
        hull_mesh('rear armour segment', mirror([(.42,-.39),(.77,-.88),(.37,-.69),(.32,-.49)]), .21, .045, plate)
        hull_mesh('alloy leading edge rail', mirror([(.23,.55),(.96,-.79),(.93,-.86),(.19,.44)]), .22, .028, brass)
        cube('radiator bed', (side*.48,-.42,.295), (.15,.30,.03), dark, .008, side*.49)
        for i in range(8):
            cube('radiator fin', (side*(.435+i*.014),-.31-i*.032,.321), (.14,.012,.025), steel, .003, side*.49)
        cube('engine nacelle', (side*.31,-.80,.10), (.25,.54,.28), steel, .045)
        cube('engine spine', (side*.31,-.76,.26), (.08,.38,.026), dark, .012)
        for j in range(6):
            cube('engine cooling rib', (side*.31,-.64-j*.044,.283), (.22,.016,.025), dark, .004)
        cylinder('nozzle collar', (side*.31,-1.08,.09), .115, .10, brass, (math.pi/2,0,0))
        cylinder('nozzle dark core', (side*.31,-1.137,.09), .088, .013, dark, (math.pi/2,0,0))
        cube('exhaust lens', (side*.31,-1.13,.18), (.135,.07,.022), glow, .012)
        cube('weapon housing', (side*.65,-.73,.16), (.12,.30,.11), dark, .018)
        cylinder('gun barrel', (side*.65,-.54,.17), .028, .30, steel, (math.pi/2,0,0))
        cylinder('gun collar', (side*.65,-.49,.17), .041, .045, brass, (math.pi/2,0,0))
        for x,y in [(.29,.17),(.39,-.38),(.82,-.77),(.38,-.67)]:
            cylinder('recessed fastener', (side*x,y,.285), .014, .010, dark)
        cube('navigation lens', (side*.91,-.87,.265), (.045,.055,.025), glow if side<0 else warning, .009)
        for i in range(3):
            cube('amber service marking', (side*.54,-.67-i*.025,.292), (.08,.009,.009), brass, .002, side*.48)
    hull_mesh('cockpit gasket', [(0,.76),(-.155,.21),(-.126,-.18),(0,-.29),(.126,-.18),(.155,.21)], .32, .035, dark)
    hull_mesh('canopy frame', [(0,.70),(-.125,.19),(-.10,-.15),(0,-.23),(.10,-.15),(.125,.19)], .357, .018, brass)
    hull_mesh('curved canopy', [(0,.66),(-.105,.19),(-.085,-.13),(0,-.2),(.085,-.13),(.105,.19)], .379, .08, glass)
    cube('canopy central rib', (0,.22,.47), (.015,.68,.014), steel, .005)
    hull_mesh('nose sensor', [(0,1.27),(-.035,1.06),(.035,1.06)], .305, .018, glow)
    cube('reactor access panel', (0,-.56,.328), (.15,.22,.03), steel, .016)
    for i in range(5): cube('reactor vent', (0,-.48-i*.036,.352), (.13,.012,.014), dark, .003)
    scene.render.filepath = str(OUT / 'ship.png')
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'ship.blend'))
    bpy.ops.render.render(write_still=True)
    turntable(scene, 'ship')

rock('stony')
rock('pallasite', metal=True)
ship()
