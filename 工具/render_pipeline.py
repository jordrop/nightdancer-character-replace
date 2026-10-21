"""一键渲染流水线（并发版）：同步画布选择 → 并发 Blender GPU 渲染 → ffmpeg 合成 → 清理

用法:
  python render_pipeline.py            # 全流程（默认读 分析/镜头参数.json）
  python render_pipeline.py --keep     # 保留渲染帧（调试用）
  python render_pipeline.py --no-params  # 强制回退硬编码 MOTION 字典
环境变量:
  SHOT_PARAMS  镜头参数.json 路径（默认 <项目>/分析/镜头参数.json）
  RENDER_OUT / FFMPEG / BLENDER / CANVAS_URL / SOURCE_VIDEO / RENDER_STATUS
状态写到 _canvas/data/render_status.json，供画布轮询。
"""
import json, os, sys, time, subprocess, shutil, urllib.request, tempfile

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(PROJ, '工具')
V7 = os.path.join(PROJ, '关键帧_替换_v7')
SEL = os.path.join(PROJ, '成片帧_画布选定')
OUTBASE = os.environ.get('RENDER_OUT', os.path.join(tempfile.gettempdir(), '_blender_out', 'render_job'))
FF = os.environ.get('FFMPEG', 'ffmpeg')
BLENDER = os.environ.get('BLENDER', 'blender')
CANVAS_URL = os.environ.get('CANVAS_URL', 'http://127.0.0.1:17800')
STATUS = os.environ.get('RENDER_STATUS', os.path.join(tempfile.gettempdir(), 'render_status.json'))
FPS = 30
MAX_PARALLEL = 3                     # 并发 Blender 进程数（GPU 1080Ti 实测 3 路最优）
W, H = 1920, 1080
SHOT_PARAMS = os.environ.get('SHOT_PARAMS', os.path.join(PROJ, '分析', '镜头参数.json'))

# 运镜表（用户指定）：axis/sign/px
MOTION = {
    'K01': ('y', +1, 380), 'K02': ('x', -1, 180), 'K03': None,
    'K04': ('y', +1, 180), 'K05': ('x', +1, 180), 'K06': ('y', -1, 180),
    'K07': ('x', +1, 180), 'K08': ('x', -1, 180), 'K09': None,
    'K10': ('x', +1, 180), 'K11': None,
}
MOTION_DESC = {
    'K01': '从上往下', 'K02': '从右往左', 'K03': '不动', 'K04': '从上往下', 'K05': '从左往右',
    'K06': '从下往上', 'K07': '从左往右', 'K08': '从右往左', 'K09': '不动（3图动作待做）',
    'K10': '从左往右', 'K11': '不动',
}

def load_shot_durations():
    """镜头分组.json → {K##: 时长秒}（params 缺失时的帧数回退来源）"""
    groups = json.load(open(os.path.join(PROJ, '分析', '镜头分组.json'), encoding='utf-8'))
    return {'K%02d' % g['k']: g['end'] - g['start'] for g in groups}


def load_shot_params(path=SHOT_PARAMS):
    """镜头参数.json → (motion, frames, info)。

    motion[K##] = None（静帧）或 (axis, sign, px, x_px, y_px)；
    x_px/y_px 是相机位移（图像坐标：右 + / 下 +），供 render_one_shot.py 双轴渲染。
    文件不存在返回 (None, None, None)，调用方回退到 MOTION 字典。
    """
    if not os.path.exists(path):
        return None, None, None
    with open(path, encoding='utf-8-sig') as f:
        doc = json.load(f)
    motion, frames = {}, {}
    for s in doc.get('shots', []):
        key = s.get('key')
        if not key:
            continue
        frames[key] = int(s.get('frames') or 0) or None
        cam = s.get('camera') or {}
        if cam.get('mode') == 'pan':
            travel = cam.get('travel_px') or [0, 0]
            axis = cam.get('axis')
            if axis not in ('x', 'y'):
                axis = 'x' if abs(travel[0]) >= abs(travel[1]) else 'y'
            motion[key] = (axis, int(cam.get('sign', 1)), int(round(cam.get('px', 0))),
                           int(round(travel[0])), int(round(travel[1])))
        else:
            motion[key] = None
    return motion, frames, {'path': path, 'shots': len(motion)}


def write_status(**kw):
    os.makedirs(os.path.dirname(STATUS), exist_ok=True)
    st = {'at': time.strftime('%H:%M:%S'), 'ts': time.time()}
    if os.path.exists(STATUS):
        try: st.update(json.load(open(STATUS, encoding='utf-8')))
        except Exception: pass
    st.update(kw)
    json.dump(st, open(STATUS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

def api(path):
    last = None
    for _ in range(40):
        try:
            return json.load(urllib.request.urlopen(CANVAS_URL + path, timeout=10))
        except Exception as e:
            last = e
            time.sleep(1.5)
    raise last

def sync_board():
    """画布选择 → 关键帧_替换_v7（并按 md5 报变化）"""
    import hashlib
    def md5(p):
        h = hashlib.md5()
        with open(p, 'rb') as f:
            for c in iter(lambda: f.read(1 << 20), b''): h.update(c)
        return h.hexdigest()
    board = api('/api/board')
    changed = []
    sels = {}
    for card in board.get('cards', []):
        k = card.get('key') or ''
        if not k.startswith('out:') or not card.get('src'): continue
        shot = k[4:]
        src = os.path.join(os.path.dirname(PROJ), card['src'])
        if not os.path.exists(src): continue
        sels[shot] = card['src']
        dst = os.path.join(V7, shot + '_v7.png')
        if not os.path.exists(dst) or md5(dst) != md5(src):
            shutil.copyfile(src, dst); changed.append(shot)
    return sels, changed

def build_film():
    groups = json.load(open(os.path.join(PROJ, '分析', '镜头分组.json'), encoding='utf-8'))
    ins, ch, lab, ai = [], [], [], 0
    for g in groups:
        k = 'K%02d' % g['k']
        n = max(1, int(round((g['end'] - g['start']) * FPS))); dur = n / FPS
        if os.path.exists(os.path.join(OUTBASE, k, 'f_0000.png')):
            ins += ['-framerate', str(FPS), '-i', os.path.join(OUTBASE, k, 'f_%04d.png')]
            ch.append(f'[{ai}:v]trim=duration={dur:.4f},setpts=PTS-STARTPTS,fps={FPS},scale={W}:{H},setsar=1[v{ai}]')
        else:
            p = os.path.join(SEL, k + '.png')
            ins += ['-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.4f}', '-i', p]
            ch.append(f'[{ai}:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1,fps={FPS},trim=duration={dur:.4f},setpts=PTS-STARTPTS[v{ai}]')
        lab.append(f'[v{ai}]'); ai += 1
    fc = ';'.join(ch) + ';' + ''.join(lab) + f'concat=n={len(lab)}:v=1:a=0[vout]'
    dst = os.path.join(PROJ, '成片', '一键渲染_全运镜_1080p.mp4')
    subprocess.run([FF, '-y'] + ins + ['-i', os.environ.get('SOURCE_VIDEO', os.path.join(PROJ, '素材', '源视频.mp4')),
                    '-filter_complex', fc, '-map', '[vout]', '-map', f'{ai}:a:0',
                    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
                    '-r', str(FPS), '-c:a', 'aac', '-b:a', '192k', '-shortest', dst], check=True, capture_output=True)
    return dst

def run_blender(jobfile, outdir, logfile):
    cmd = [BLENDER, '-b', '--factory-startup', '--python', os.path.join(TOOLS, 'render_one_shot.py'),
           '--', '--json', jobfile]
    with open(logfile, 'w', encoding='utf-8') as lf:
        return subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT)

def plan_jobs(motion, param_frames, durations, v7dir=None, outbase=None, res=(W, H),
              exists=os.path.exists, save_blend_dir=None):
    """运镜参数 → 渲染作业列表 [(K##, job.json)]（供 main 与测试共用）

    save_blend_dir：给每个作业额外写 save_blend 路径，渲染时顺手把场景存成 .blend
    （供 PopNow for Blender 的 Animate with AI 等外部工具接手）。
    """
    v7dir = v7dir or V7
    outbase = outbase or OUTBASE
    os.makedirs(outbase, exist_ok=True)
    jobs = []
    for k, mv in motion.items():
        if not mv:
            continue
        if not exists(os.path.join(v7dir, k + '_v7.png')):
            continue
        axis, sign, px = mv[0], mv[1], mv[2]
        x_px = mv[3] if len(mv) > 3 else (sign * px if axis == 'x' else 0)
        y_px = mv[4] if len(mv) > 4 else (sign * px if axis == 'y' else 0)
        n = (param_frames or {}).get(k)
        if not n:
            n = max(1, int(round(durations.get(k, 0) * FPS)))
        job = {'name': k, 'image': os.path.join(v7dir, k + '_v7.png'),
               'frames': n, 'axis': axis, 'sign': sign, 'px': px,
               'x_px': x_px, 'y_px': y_px, 'res': list(res),
               'out': os.path.join(outbase, k)}
        if save_blend_dir:
            os.makedirs(save_blend_dir, exist_ok=True)
            job['save_blend'] = os.path.join(save_blend_dir, k + '.blend')
        jf = os.path.join(outbase, k + '.json')
        json.dump(job, open(jf, 'w', encoding='utf-8'))
        jobs.append((k, jf))
    return jobs


def main():
    keep = '--keep' in sys.argv
    t0 = time.time()
    shutil.rmtree(OUTBASE, ignore_errors=True)
    os.makedirs(OUTBASE, exist_ok=True)
    write_status(state='running', stage='sync', progress=0, started=time.strftime('%H:%M:%S'))

    sels, changed = sync_board()
    # 导出画布选定（静帧用）
    subprocess.run([sys.executable, os.path.join(TOOLS, 'export_board_frames.py')],
                   capture_output=True, text=True, encoding='utf-8')
    write_status(stage='render', changed=changed, shots=list(sels.keys()), progress=5)

    # 运镜参数：优先读 镜头参数.json，缺文件/--no-params 时回退硬编码 MOTION
    motion, param_frames, pinfo = (None, None, None)
    if '--no-params' not in sys.argv:
        motion, param_frames, pinfo = load_shot_params()
    if motion:
        print('SHOT_PARAMS', pinfo['path'], 'shots=%d' % pinfo['shots'])
        write_status(params=pinfo['path'], params_shots=pinfo['shots'])
    else:
        print('SHOT_PARAMS (fallback MOTION)')
        motion, param_frames = MOTION, {}
        write_status(params='(fallback MOTION)')

    # 有运镜的镜头
    durations = load_shot_durations()
    save_blend_dir = None
    if '--save-blend-dir' in sys.argv:
        try:
            save_blend_dir = sys.argv[sys.argv.index('--save-blend-dir') + 1]
        except IndexError:
            print('WARN --save-blend-dir 缺少路径参数，忽略')
    jobs = plan_jobs(motion, param_frames, durations, save_blend_dir=save_blend_dir)
    if save_blend_dir:
        print('SAVE_BLEND_DIR', save_blend_dir)
        write_status(save_blend_dir=save_blend_dir)

    running = []
    done = []
    queue = list(jobs)
    while queue or running:
        while queue and len(running) < MAX_PARALLEL:
            k, jf = queue.pop(0)
            p = run_blender(jf, os.path.join(OUTBASE, k), os.path.join(OUTBASE, k + '.log'))
            running.append((k, p))
        time.sleep(1.0)
        for k, p in list(running):
            if p.poll() is not None:
                running.remove((k, p)); done.append(k)
        write_status(stage='render', progress=5 + int(80 * len(done) / max(1, len(jobs))), done=done, total=len(jobs))

    write_status(stage='assemble', progress=88)
    film = build_film()
    if not keep:
        shutil.rmtree(OUTBASE, ignore_errors=True)
    write_status(state='done', stage='done', progress=100, film=os.path.relpath(film, ROOT),
                 sec=round(time.time() - t0, 1), finished=time.strftime('%H:%M:%S'))
    print('DONE', film, round(time.time() - t0, 1), 's')

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        write_status(state='error', stage='error', error=str(e))
        raise
