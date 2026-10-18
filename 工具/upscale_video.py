# -*- coding: utf-8 -*-
"""视频超分管线：720p → Real-ESRGAN(animevideov3-x2) → 2560×1440 → 降采样 1920×1080

用法:
  python upscale_video.py --in 720p.mp4 --out 1080p.mp4 [--model realesr-animevideov3-x2] [--target 1920x1080]

依赖:
  - Real-ESRGAN ncnn-vulkan（默认从 PATH 找 `realesrgan-ncnn-vulkan`，可用 ESRGAN_EXE 指定完整路径）
  - ffmpeg / ffprobe（默认从 PATH 找，可用 FFMPEG / FFPROBE 指定完整路径）
环境变量: FFMPEG / FFPROBE / ESRGAN_EXE / UPSCALE_WORK
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time

FF = os.environ.get('FFMPEG', 'ffmpeg')
FPROBE = os.environ.get('FFPROBE', 'ffprobe')
ESRGAN = os.environ.get('ESRGAN_EXE', 'realesrgan-ncnn-vulkan')
WORK = os.environ.get('UPSCALE_WORK', os.path.join(tempfile.gettempdir(), 'upscale_work'))


def probe(path):
    out = subprocess.run([FPROBE, '-v', 'error', '-select_streams', 'v:0',
                          '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,duration',
                          '-of', 'default=nw=1', path], capture_output=True, text=True, encoding='utf-8').stdout
    d = {}
    for line in out.strip().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            d[k] = v
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', dest='dst', required=True)
    ap.add_argument('--model', default='realesr-animevideov3-x2')
    ap.add_argument('--scale', type=int, default=2)
    ap.add_argument('--target', default='1920x1080')
    ap.add_argument('--crf', type=int, default=16)
    ap.add_argument('--keep-work', action='store_true')
    a = ap.parse_args()

    tw, th = [int(x) for x in a.target.lower().split('x')]
    info = probe(a.src)
    sw, sh = int(info.get('width', 0)), int(info.get('height', 0))
    fps = info.get('avg_frame_rate') or info.get('r_frame_rate', '24/1')
    print(f'输入：{sw}x{sh} @ {fps} → 目标 {tw}x{th} · 模型 {a.model} x{a.scale}')

    os.makedirs(WORK, exist_ok=True)
    work = tempfile.mkdtemp(prefix='up_', dir=WORK)
    frames = os.path.join(work, 'frames')
    up = os.path.join(work, 'up')
    os.makedirs(frames, exist_ok=True)
    os.makedirs(up, exist_ok=True)

    t0 = time.time()
    # 1) 抽帧
    subprocess.run([FF, '-hide_banner', '-loglevel', 'error', '-y', '-i', a.src,
                    '-fps_mode', 'passthrough', os.path.join(frames, 'f_%06d.png')], check=True)
    n = len(os.listdir(frames))
    print(f'抽帧 {n} 张 · {time.time()-t0:.1f}s')

    # 2) 超分（GPU）
    t1 = time.time()
    cmd = [ESRGAN, '-i', frames, '-o', up, '-n', a.model, '-s', str(a.scale), '-f', 'png']
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if p.returncode != 0:
        print('ESRGAN 失败：', (p.stderr or p.stdout)[-1500:])
        sys.exit(1)
    print(f'超分 {n} 帧 · {time.time()-t1:.1f}s（{((time.time()-t1)/max(1,n)):.2f}s/帧）')

    # 3) 合帧 + 降采样到目标分辨率（超采样降采样，细节更锐）
    t2 = time.time()
    vf = f'scale={tw}:{th}:flags=lanczos,cas=0.5,format=yuv420p'
    cmd = [FF, '-hide_banner', '-loglevel', 'error', '-y', '-framerate', fps,
           '-i', os.path.join(up, 'f_%06d.png'), '-vf', vf,
           '-c:v', 'libx264', '-preset', 'slow', '-crf', str(a.crf), '-pix_fmt', 'yuv420p', a.dst]
    subprocess.run(cmd, check=True)
    # 音轨（若有）原样保留
    has_audio = subprocess.run([FPROBE, '-v', 'error', '-select_streams', 'a', '-show_entries',
                                'stream=index', '-of', 'csv=p=0', a.src], capture_output=True, text=True).stdout.strip()
    if has_audio:
        tmp = a.dst + '.mux.mp4'
        subprocess.run([FF, '-hide_banner', '-loglevel', 'error', '-y', '-i', a.dst, '-i', a.src,
                        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                        '-shortest', tmp], check=True)
        os.replace(tmp, a.dst)
    print(f'编码·{time.time()-t2:.1f}s · 总耗时 {time.time()-t0:.1f}s')
    print('输出：', a.dst, round(os.path.getsize(a.dst) / 1048576, 2), 'MB')

    if not a.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    else:
        print('工作目录保留：', work)


if __name__ == '__main__':
    main()
