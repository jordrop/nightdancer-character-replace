# -*- coding: utf-8 -*-
"""验证 render_one_shot.py 双轴运镜：测量首尾帧内容位移，与镜头参数目标对比。

用法：python verify_shift.py <shots_dir> <K01_dir> <K02_dir>
  K01 期望内容位移 (220, 0)   （相机 x_px=-220 左移）
  K02 期望内容位移 (80, 40)   （相机 x_px=-80, y_px=-40 上移）
"""
import json
import os
import sys

import numpy as np
from PIL import Image


def load_gray(path):
    return np.asarray(Image.open(path).convert("L"), dtype=np.float64)


def box_blur(a, r=8):
    """积分图快速盒式模糊（去低频，突出边缘，供相位相关使用）"""
    pad = np.pad(a, r, mode="edge")
    s = pad.cumsum(0).cumsum(1)
    s = np.pad(s, ((1, 0), (1, 0)), mode="constant")
    h, w = a.shape
    k = 2 * r + 1
    out = (s[k:k + h, k:k + w] - s[0:h, k:k + w] - s[k:k + h, 0:w] + s[0:h, 0:w]) / (k * k)
    return out


def high_pass(a):
    return a - box_blur(a, 8)


def phase_shift(a, b):
    """相位相关：返回使 b = a 平移 s 的 s（内容位移，图像坐标右+/下+）。"""
    A = np.fft.fft2(high_pass(a))
    B = np.fft.fft2(high_pass(b))
    R = A * np.conj(B)
    R /= (np.abs(R) + 1e-9)
    r = np.fft.ifft2(R).real
    dy, dx = np.unravel_index(np.argmax(r), r.shape)
    h, w = a.shape
    if dy > h // 2:
        dy -= h
    if dx > w // 2:
        dx -= w
    return -int(dy), -int(dx)   # 标定：b=np.roll(a,(sy,sx)) 时返回 (sy,sx)


def selftest():
    rng = np.random.default_rng(0)
    a = rng.normal(size=(240, 320))
    for sy, sx in [(7, -11), (-13, 5), (0, 0), (20, 30)]:
        b = np.roll(a, (sy, sx), axis=(0, 1))
        got = phase_shift(a, b)
        assert abs(got[0] - sy) <= 1 and abs(got[1] - sx) <= 1, (got, (sy, sx))
    print("selftest OK（相位相关符号已标定）")


def measure(frames_dir, key, n_frames, expect, tol=6):
    f0 = os.path.join(frames_dir, "f_0000.png")
    f1 = os.path.join(frames_dir, "f_%04d.png" % (n_frames - 1))
    assert os.path.exists(f0) and os.path.exists(f1), (f0, f1)
    a, b = load_gray(f0), load_gray(f1)
    got = phase_shift(a, b)
    ok = abs(got[0] - expect[0]) <= tol and abs(got[1] - expect[1]) <= tol
    print("%s  首尾帧内容位移=%-12s 期望=%-10s %s" % (key, str(got), str(expect), "PASS" if ok else "FAIL"))
    return ok


def main():
    selftest()
    shots_dir = sys.argv[1]
    tmp = sys.argv[2] if len(sys.argv) > 2 else None
    base = tmp or os.path.dirname(os.path.abspath(__file__))
    jobs = [
        ("TEST_K01", os.path.join(base, "test_k01"), 45, (0, 220)),
        ("TEST_K02", os.path.join(base, "test_k02"), 46, (40, 80)),
    ]
    results = []
    for key, d, n, expect in jobs:
        results.append(measure(d, key, n, expect))
    print("RESULT:", "ALL PASS" if all(results) else "SOME FAILED")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
