"""Five reproducible alien silhouettes built on the approved hull and rotor."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from campaign_authoring import *

def wing(name, points, z, thickness, mat):
    verts=[(x,y,z+d) for d in (0,thickness) for x,y in points]
    n=len(points)
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,n*2))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj)
    return finish(obj,mat,.012)

def build_fleet():
    profiles=(ROOT/'src'/'ultra-materials.ts').read_text()
    accents=dict((kind,int(col,16)) for kind,col in re.findall(r"(cruiser|elite|tank|sniper|boss):\{asset:'[^']+',accent:0x([\da-f]+)",profiles))
    for kind in ['cruiser','elite','tank','sniper','boss']:
        bpy.ops.wm.open_mainfile(filepath=str(OUT/'ufo.blend'))
        for obj in list(bpy.context.scene.objects):
            if obj.type in ['CAMERA','LIGHT']:bpy.data.objects.remove(obj,do_unlink=True)
        upper=bpy.data.objects['Upper Rotor'];lower=bpy.data.objects['Alien Hull']
        # Class-coloured reactor and smoked canopy; preserve the common metal.
        for mat in list(bpy.data.materials):
            if mat.name in ['violet reactor','amethyst canopy']:
                p=mat.node_tree.nodes.get('Principled BSDF')
                col=rgb(accents[kind]);shade=.13 if mat.name=='amethyst canopy' else 1
                p.inputs['Base Color'].default_value=(*(c*shade for c in col),1)
                p.inputs['Emission Color'].default_value=(*col,1)
                p.inputs['Emission Strength'].default_value=.12 if shade<1 else 1.1
        metal=bpy.data.materials['silver armour facets'];dark=bpy.data.materials['black ceramic seams']
        trim=bpy.data.materials['warm iridium edges'];hot=bpy.data.materials['violet reactor']
        before=set(bpy.context.scene.objects)
        if kind=='cruiser':
            # Scout sensor arches and three flush dorsal targeting lenses.
            for i in range(3):
                x=(i-1)*.16
                box((x,-.60,.25),(.10,.18,.06),dark,.01)
                sphere((x,-.64,.29),(.03,.05,.018),hot)
        elif kind=='elite':
            # Four swept scimitar vanes: visibly agile even at 19px radius.
            for side in [-1,1]:
                for fore in [-1,1]:
                    pts=[(side*x,fore*y) for x,y in [(.55,.25),(.85,.30),(1.17,.73),(.99,.88),(.68,.55)]]
                    wing('Elite swept vane',pts,.12,.09,metal)
                    wing('Elite ceramic vane inset',[(side*x,fore*y) for x,y in [(.74,.42),(1.09,.73),(.99,.77)]],.218,.014,dark)
                    sphere((side*.99,fore*.75,.25),(.06,.045,.025),hot)
            upper.scale=(.92,.92,.9);lower.scale=(.92,.92,1)
        elif kind=='tank':
            # Eight thick overlapping shield plates with recessed vent beds.
            upper.scale.z=1.38;lower.scale.z=1.38
            for i in range(8):
                a=i*math.tau/8
                def radial(r,t,z):return (r*math.cos(a)-t*math.sin(a),r*math.sin(a)+t*math.cos(a),z)
                obj=box(radial(.91,0,.18),(.44,.52,.28),metal,.045);obj.rotation_euler.z=a
                obj=box(radial(1.01,0,.34),(.20,.37,.026),dark,.008);obj.rotation_euler.z=a
                for j in [-1,0,1]:
                    obj=box(radial(1.01,j*.09,.36),(.18,.025,.022),trim,.005);obj.rotation_euler.z=a
                sphere(radial(1.12,0,.23),(.045,.045,.025),hot)
            torus(.43,.39,.034,metal)
        elif kind=='sniper':
            # Long separated accelerator rails and a central cyan targeting eye.
            upper.scale=(.83,.90,.8);lower.scale=(.83,.90,.8)
            for side in [-1,1]:
                box((side*.57,-.25,.22),(.21,1.74,.18),metal,.018)
                box((side*.57,-.27,.32),(.115,1.52,.025),dark,.006)
                for i in range(6):
                    box((side*.57,.40-i*.18,.35),(.14,.035,.045),trim,.003)
                box((side*.57,-1.10,.23),(.12,.035,.08),hot,.004)
            sphere((0,-.73,.25),(.15,.11,.10),dark)
            sphere((0,-.80,.30),(.11,.07,.045),hot)
        else:
            # Command ship: four scalloped bastions, gold crown and dorsal array.
            upper.scale.z=1.2;lower.scale.z=1.3
            for i in range(4):
                a=i*math.tau/4+math.pi/4
                pts=[]
                for r,t in [(.61,-.24),(1.04,-.32),(1.22,-.12),(1.22,.12),(1.04,.32),(.61,.24)]:
                    pts.append((r*math.cos(a)-t*math.sin(a),r*math.sin(a)+t*math.cos(a)))
                wing('Command bastion',pts,.10,.20,metal)
                for j in [-1,1]:
                    sphere((1.08*math.cos(a)-j*.13*math.sin(a),1.08*math.sin(a)+j*.13*math.cos(a),.32),(.06,.06,.04),hot)
            torus(.57,.37,.045,trim);torus(.53,.39,.023,hot)
            for i in range(8):
                a=i*math.tau/8
                obj=box((.48*math.cos(a),.48*math.sin(a),.43),(.15,.05,.12),metal,.012);obj.rotation_euler.z=a
            sphere((0,0,.57),(.20,.20,.14),hot)
        # One added assembly, batched by shared materials in GLB export.
        added=[o for o in bpy.context.scene.objects if o not in before and o.type=='MESH']
        if added:
            bpy.ops.object.select_all(action='DESELECT')
            for obj in added:
                bpy.context.view_layer.objects.active=obj;obj.select_set(True)
                for mod in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
            bpy.context.view_layer.objects.active=added[0];bpy.ops.object.join()
            bpy.context.object.name='Class Hardware'
        name='ufo-cinematic' if kind=='cruiser' else 'ufo-'+kind
        meshes=export(name)
        setup(2.9);scene=bpy.context.scene;scene.cycles.samples=48
        # Match the live oblique bank, revealing the actual raised fittings.
        for obj in meshes:obj.rotation_euler.x+=.42
        plate('ufo-cruiser' if kind=='cruiser' else name)
        print('ULTRA FLEET',kind,flush=True)

if __name__=='__main__':build_fleet()
