"""Blender GPU：渲染单个镜头的运镜帧（由并行调度器调用）

用法:
  blender -b --python render_one_shot.py -- --json "E:\\...\\job.json"
job.json: {"name":"K05","image":"...\\K05_v7.png","frames":225,"axis":"x","sign":1,"px":180,"out":"...\\K05","res":[1920,1080]}
"""
import bpy, math, os, sys, json

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
args = {}
for i in range(0, len(argv) - 1, 2):
    args[argv[i].lstrip('-')] = argv[i + 1]
job = json.load(open(args['json'], encoding='utf-8'))
p = job['image']; n = int(job['frames']); axis = job['axis']; sign = int(job['sign'])
px = int(job['px']); outdir = job['out']; W_OUT, H_OUT = job.get('res', [1920, 1080])
FPS = 30
os.makedirs(outdir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
try:
    sc.render.engine = 'BLENDER_EEVEE_NEXT'
except Exception:
    sc.render.engine = 'BLENDER_EEVEE'
try:
    sc.eevee.taa_render_samples = 8
except Exception:
    pass
sc.render.resolution_x = W_OUT; sc.render.resolution_y = H_OUT; sc.render.fps = FPS
sc.render.image_settings.file_format = 'PNG'
sc.world = bpy.data.worlds.new('w')
img = bpy.data.images.load(p)
iw, ih = img.size
unit = 1.92 / W_OUT
win_w, win_h = 1.92, 1.92 * H_OUT / W_OUT
img_w = 1.92
img_h = img_w * ih / iw
travel = abs(px) * unit
k = max(win_w / img_w, win_h / img_h) * (1.0 + travel / min(img_w, img_h) * 0.6)
k = max(k, 1.0 + travel / img_h)
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
pl = bpy.context.active_object
pl.scale = (img_w * k, img_h * k, 1)
pl.rotation_euler = (math.radians(90), 0, 0)
mat = bpy.data.materials.new('img'); mat.use_nodes = True
nt = mat.node_tree; nt.nodes.clear()
tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img
em = nt.nodes.new('ShaderNodeEmission'); em.inputs[0].default_value = (1, 1, 1, 1)
outn = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(tex.outputs[0], em.inputs[0]); nt.links.new(em.outputs[0], outn.inputs[0])
pl.data.materials.append(mat)
cd = bpy.data.cameras.new('c'); cam = bpy.data.objects.new('c', cd)
bpy.context.collection.objects.link(cam)
cd.type = 'ORTHO'; cd.ortho_scale = win_w
cam.rotation_euler = (math.radians(90), 0, 0)
sc.camera = cam
half = sign * travel / 2.0
if axis == 'y':
    cam.location = (0, -3, half); cam.keyframe_insert('location', frame=1)
    cam.location = (0, -3, -half); cam.keyframe_insert('location', frame=n)
else:
    cam.location = (-half, -3, 0); cam.keyframe_insert('location', frame=1)
    cam.location = (half, -3, 0); cam.keyframe_insert('location', frame=n)
sc.frame_start = 1; sc.frame_end = n
for fr in range(1, n + 1):
    sc.frame_set(fr)
    sc.render.filepath = os.path.join(outdir, 'f_%04d.png' % (fr - 1))
    bpy.ops.render.render(write_still=True)
print('HEADLESS ' + json.dumps({'ok': True, 'shot': job['name'], 'frames': n}, ensure_ascii=False))
