"""Blender GPU：渲染单个镜头的运镜帧（由并行调度器调用）

用法:
  blender -b --python render_one_shot.py -- --json "E:\\...\\job.json"
job.json（单轴兼容）: {"name":"K05","image":"...","frames":225,"axis":"x","sign":1,"px":180,"out":"...","res":[1920,1080]}
job.json（双轴）:      额外带 "x_px"/"y_px"（相机位移，图像坐标：右 + / 下 +），同时保留 axis/sign/px 兼容旧调用。
渲染：正交相机 + 图片平面，相机在 x / z（屏幕 y）上做线性关键帧；双轴可同时移动。
"""
import bpy, math, os, sys, json

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
args = {}
for i in range(0, len(argv) - 1, 2):
    args[argv[i].lstrip('-')] = argv[i + 1]
job = json.load(open(args['json'], encoding='utf-8-sig'))
p = job['image']; n = int(job['frames']); outdir = job['out']; W_OUT, H_OUT = job.get('res', [1920, 1080])
axis = job.get('axis', 'x'); sign = int(job.get('sign', 1)); px = int(job.get('px', 0))
# 双轴支持：x_px / y_px 是相机位移（图像坐标：右 + / 下 +）；旧 job 只有 axis/sign/px 时自动换算
xv = job.get('x_px'); yv = job.get('y_px')
if xv is None and yv is None:
    xv, yv = (0.0, float(sign * px)) if axis == 'y' else (float(sign * px), 0.0)
xv, yv = float(xv), float(yv)
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
travel = math.hypot(xv, yv) * unit
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
# 双轴相机位移（图像坐标：右 + / 下 +）→ 世界坐标：x 同向，屏幕 y 下 = 世界 -Z
travel_x = xv * unit
travel_y = yv * unit
cam.location = (-travel_x / 2.0, -3, travel_y / 2.0)
cam.keyframe_insert('location', frame=1)
cam.location = (travel_x / 2.0, -3, -travel_y / 2.0)
cam.keyframe_insert('location', frame=n)
sc.frame_start = 1; sc.frame_end = n
# 可选：把配置好的场景另存为 .blend（给 PopNow Animate 等外部工具接手；不影响渲染）
save_blend = job.get('save_blend') or args.get('save-blend')
if save_blend:
    save_blend = os.path.abspath(save_blend)
    os.makedirs(os.path.dirname(save_blend), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=save_blend)
    print('SAVED_BLEND ' + save_blend)
for fr in range(1, n + 1):
    sc.frame_set(fr)
    sc.render.filepath = os.path.join(outdir, 'f_%04d.png' % (fr - 1))
    bpy.ops.render.render(write_still=True)
print('HEADLESS ' + json.dumps({'ok': True, 'shot': job['name'], 'frames': n,
                                 'x_px': xv, 'y_px': yv,
                                 'engine': sc.render.engine}, ensure_ascii=False))
