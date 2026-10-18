"""Blender GPU 运镜渲染助手（EEVEE + GPU，输出到画布目录之外）

用法（无头）:
  blender -b --python render_pan_gpu.py -- --out E:\伊雪的活\_blender_out\job1

配置在 JOBS 里：图片、帧数、运镜像素。渲染完由调用方（ffmpeg 合成后）删除 --out 目录。
"""
import bpy, math, os, sys, json, time

ROOT = r'E:\伊雪的活\ptest\ptest\人物替换_NIGHTDANCER'
V7 = os.path.join(ROOT, '关键帧_替换_v7')
OUT_DEFAULT = r'E:\伊雪的活\_blender_out\job'
JOBS = [
    ('K01', 'K01_v7.png', 240, -380),
    ('K06', 'K06_v7.png', 225, 186),
    ('K07', 'K07_v7.png', 240, 69),
]
FPS = 30

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
args = {}
for i in range(0, len(argv) - 1, 2):
    args[argv[i].lstrip('-')] = argv[i + 1]
OUT = args.get('out') or OUT_DEFAULT
os.makedirs(OUT, exist_ok=True)

def gpu_setup(sc):
    """优先 EEVEE + GPU；GPU 不可用时退回 Cycles GPU / Workbench"""
    info = {'engine': None}
    try:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    except Exception:
        try:
            sc.render.engine = 'BLENDER_EEVEE'
        except Exception:
            sc.render.engine = 'BLENDER_WORKBENCH'
    if 'EEVEE' in sc.render.engine:
        try:
            sc.eevee.taa_render_samples = 8
        except Exception:
            pass
    else:
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            prefs.compute_device_type = 'OPTIX'
            prefs.get_devices()
            for d in prefs.devices:
                d.use = (d.type != 'CPU')
            sc.render.engine = 'CYCLES'
            sc.cycles.device = 'GPU'
            sc.cycles.samples = 16
        except Exception:
            sc.render.engine = 'BLENDER_WORKBENCH'
    info['engine'] = sc.render.engine
    return info

log = {}
t_all = time.time()
for name, fn, n, pan in JOBS:
    p = os.path.join(V7, fn)
    if not os.path.exists(p):
        log[name] = 'missing'; continue
    outdir = os.path.join(OUT, name); os.makedirs(outdir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    g = gpu_setup(sc)
    sc.display.shading.light = 'FLAT' if sc.render.engine == 'BLENDER_WORKBENCH' else sc.display.shading.light
    sc.render.resolution_x = 1920
    sc.render.resolution_y = 840
    sc.render.fps = FPS
    sc.render.image_settings.file_format = 'PNG'
    sc.world = bpy.data.worlds.new('w')
    img = bpy.data.images.load(p)
    W, H = img.size
    scale = 1.92 / W
    extra = abs(pan) * scale
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    pl = bpy.context.active_object
    pl.scale = (1.92 + extra, 0.84 + extra, 1)
    pl.rotation_euler = (math.radians(90), 0, 0)
    mat = bpy.data.materials.new('img'); mat.use_nodes = True
    nt = mat.node_tree; nt.nodes.clear()
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img
    em = nt.nodes.new('ShaderNodeEmission'); em.inputs[0].default_value = (1, 1, 1, 1)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(tex.outputs[0], em.inputs[0]); nt.links.new(em.outputs[0], out.inputs[0])
    pl.data.materials.append(mat)
    cd = bpy.data.cameras.new('c'); cam = bpy.data.objects.new('c', cd)
    bpy.context.collection.objects.link(cam)
    cd.type = 'ORTHO'; cd.ortho_scale = 1.92
    cam.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = cam
    top = pan * scale / 2.0
    cam.location = (0, -3, top); cam.keyframe_insert('location', frame=1)
    cam.location = (0, -3, -top); cam.keyframe_insert('location', frame=n)
    sc.frame_start = 1; sc.frame_end = n
    for fr in range(1, n + 1):
        sc.frame_set(fr)
        sc.render.filepath = os.path.join(outdir, 'f_%04d.png' % (fr - 1))
        bpy.ops.render.render(write_still=True)
    log[name] = {'frames': n, 'pan_px': pan, 'engine': sc.render.engine}
print('HEADLESS ' + json.dumps({'ok': True, 'out': OUT, 'jobs': log, 'sec': round(time.time() - t_all, 1)}, ensure_ascii=False))
