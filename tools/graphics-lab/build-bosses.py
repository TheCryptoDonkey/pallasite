"""Detailed Eagle Station, unique Forge containment hardware and gravity cores.
Static geometry is joined by material; runtime shares lights and shadow budgets.
Run after build-campaign.py, then optimise-campaign.mjs.
"""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from campaign_authoring import *

def strut(a,b,width,mat):
    a,b=Vector(a),Vector(b);o=box((a+b)/2,(width,width,(b-a).length),mat,.008)
    o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();return o

def radial_box(radius,angle,z,dimensions,mat):
    o=box((radius*math.cos(angle),radius*math.sin(angle),z),dimensions,mat)
    o.rotation_euler.z=angle;return o

for name in ['station-core','station-arm','station-emitter','forge-core','forge-emitter','mine']:
    clear();forge=name.startswith('forge')
    metal=material('machined titanium',0x405a70,.86,.28)
    armour=material('scored armour panels',0x7e919e,.8,.38)
    dark=material('carbon ceramic',0x0b1521,.5,.42)
    hot=material('reactor conduits',0xff943d if forge else 0x42d5dc,.45,.24,.8)
    crystal=material('exposed olivine',0x6ddb94,.28,.16,.65)
    if name.endswith('core'):
        sphere((0,0,-.08),(.66,.66,.40),dark)
        # Faceted mineral suspended above a recessed industrial reactor.
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=.46,location=(0,0,.39));finish(bpy.context.object,crystal)
        for r,z,tube,mat in [(.56,.13,.06,metal),(.81,0,.095,metal),(1.02,-.10,.035,hot),(.77,.27,.035,dark)]:torus(r,z,tube,mat)
        count=8 if forge else 6
        for i in range(count):
            a=i*math.tau/count
            radial_box(.89,a,.16,(.29,.25,.30),armour)
            radial_box(.82,a,.34,(.21,.12,.035),dark)
            radial_box(.97,a,.33,(.11,.055,.02),hot)
            # Raised ribs span the bowl, with clear space over the crystal.
            strut((.77*math.cos(a),.77*math.sin(a),.15),(.52*math.cos(a),.52*math.sin(a),.72),.075,metal)
            for da in [-.09,.09]:sphere((.87*math.cos(a+da),.87*math.sin(a+da),.34),(.026,.026,.018),metal)
        if forge:
            # Larger layered heatsinks make the finale recognisably its own rig.
            for i in range(12):
                a=i*math.tau/12
                for z in [-.29,-.19,-.09]:radial_box(.94,a,z,(.34,.12,.035),dark)
            torus(.55,.58,.025,hot)
        else:
            for side in [-1,1]:
                box((side*.60,0,.26),(.11,1.2,.12),metal)
                box((side*.59,0,.34),(.025,.7,.025),hot)
    elif name=='station-arm':
        # Dark central spine, braced rails, alternating armour and copper runs.
        box((0,0,0),(2,.26,.24),dark)
        for y in [-.18,.18]:
            box((0,y,.16),(2,.065,.065),metal)
            box((0,y*.65,.21),(1.84,.018,.018),hot)
        for x in [-.78,-.39,0,.39,.78]:
            box((x,0,.12),(.27,.28,.13),armour)
            for y in [-.17,.17]:
                strut((x-.16,y,.05),(x+.16,-y,.13),.03,metal)
                sphere((x,y,.21),(.025,.025,.018),metal)
        for x in [-.94,.94]:box((x,0,.05),(.12,.43,.39),metal)
    elif name.endswith('emitter'):
        # Weapon pods have mechanical depth and recessed barrels, not a flat disc.
        box((0,0,-.08),(1.42,1.1,.53),dark,.09)
        for side in [-1,1]:
            box((side*.59,0,.13),(.23,1.08,.33),armour,.04)
            for y in [-.36,-.12,.12,.36]:box((side*.6,y,.31),(.20,.065,.055),metal,.008)
            box((side*.34,0,.31),(.07,.77,.05),hot)
        sphere((0,0,.20),(.42,.45,.28),metal)
        torus(.35,.39,.07,dark);torus(.36,.43,.025,hot)
        sphere((0,0,.42),(.24,.24,.07),hot)
        for side in [-1,1]:
            box((side*.25,-.50,.14),(.15,.29,.18),metal)
            box((side*.25,-.63,.20),(.08,.055,.08),dark)
        if forge:
            for y in [-.35,.35]:box((0,y,-.23),(1.3,.10,.08),armour)
    else:
        # Gravity nodes: dense central mass, armoured spines, blue containment
        # coil and a warm hazard lens. Baked plates retain all this depth.
        sphere((0,0,0),(.67,.67,.57),dark)
        torus(.7,0,.035,hot);torus(.54,.31,.045,metal)
        for i in range(10):
            a=i*math.tau/10
            radial_box(.65,a,.10,(.25,.12,.26),metal)
            strut((.70*math.cos(a),.70*math.sin(a),.02),(.96*math.cos(a),.96*math.sin(a),.16),.06,armour)
            radial_box(.72,a,.27,(.15,.03,.03),hot)
        sphere((0,0,.50),(.23,.23,.12),hot);torus(.27,.50,.04,metal)
    # Apply bevels, join for <=5 material draws, retain the true mesh axes.
    meshes=export(name);bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join()
    bpy.context.scene.cursor.location=(0,0,0);bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    export(name);setup(2.7)
    bpy.context.scene.render.resolution_x=bpy.context.scene.render.resolution_y=512
    plate(name);print('ULTRA BOSS HARDWARE',name,flush=True)
