"""镜头参数表工具（参数化视频语言的本地落地实现）

把「镜头分组 + 运镜位移测量 + 人工指定运镜」统一成一份带 schema 的 镜头参数.json，
再编译成 render_one_shot.py 可直接消费的 job JSON。纯标准库，无第三方依赖。

数据流：
  镜头分组.json ─┐
  运镜位移.json ─┼─> build ─> 镜头参数.json ─> validate（schema + 语义）
  人工指定覆盖 ─┘                             └─> compile ─> 渲染作业/K##.json → render_one_shot.py

用法（在项目根执行）：
  python 工具/shot_params.py build
  python 工具/shot_params.py validate
  python 工具/shot_params.py report
  python 工具/shot_params.py compile
  python 工具/shot_params.py compile --images 人物替换_NIGHTDANCER/成片帧_画布选定 --suffix ""

符号约定（与 render_one_shot.py 对齐）：
  content_shift_px  内容位移（图像坐标：右 +，下 +），来自帧差/相位相关测量。
  camera.travel_px 相机位移 = -content_shift_px（相机反向移动才让内容朝测量方向走）。
  camera.sign/axis  单轴渲染器参数：axis=x 时 sign=+1 相机向右、-1 向左；
                    axis=y 时 sign=+1 相机向下、-1 向上。
"""
import argparse
import copy
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone

if hasattr(sys.stdout, "buffer") and not str(getattr(sys.stdout, "encoding", "")).lower().startswith("utf-8"):
    sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TOOL_VERSION = "1.0"
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT_DEFAULT = os.path.join(PROJ, "人物替换_NIGHTDANCER")
SHOTDIR_DEFAULT = os.path.join(ROOT_DEFAULT, "分析", "宗门新功法")
SCHEMA_DEFAULT = os.path.join(PROJ, "工具", "镜头参数.schema.json")
STATIC_TOL_PX = 8.0          # 主轴位移小于该值视为静帧
DIAGONAL_RATIO = 0.25        # 次轴/主轴 >= 该值视为斜向运动
FRAME_TOL = 1                # 帧数校验容差

CAMERA_KEYS = ("mode", "axis", "sign", "px", "travel_px", "speed_px_s", "diagonal", "approx", "source")


# ---------------------------------------------------------------- 基础工具
def load_json(path):
    # utf-8-sig：兼容 Windows PowerShell 写出的带 BOM 的 JSON
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def dump_json(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")


def rel(path, base):
    try:
        return os.path.relpath(os.path.abspath(path), os.path.abspath(base)).replace("\\", "/")
    except ValueError:
        return os.path.abspath(path).replace("\\", "/")


def norm_key(value):
    """'K1'/'k01'/1/'S3' -> 'K01'/'K01'/'K01'/'S03'"""
    if isinstance(value, int):
        return "K%02d" % value
    s = str(value).strip().upper()
    m = re.fullmatch(r"([KS])?(\d{1,2})", s)
    if not m:
        raise ValueError("无法识别的镜头 key: %r" % (value,))
    letter = m.group(1) or "K"
    return "%s%02d" % (letter, int(m.group(2)))


def round_frames(seconds, fps):
    return max(1, int(round(seconds * fps)))


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _near(a, b, tol=1.0):
    return abs(float(a) - float(b)) <= tol


# ---------------------------------------------------------------- 读取输入
def load_group(path):
    """返回 (meta, shots)；兼容两种格式：
    A) 宗门新功法：{video,width,height,fps,duration,shots:[{key,start,end,file,shift_px,...}]}
    B) NIGHTDANCER：[{k,start,end,mid}, ...]
    """
    data = load_json(path)
    if isinstance(data, dict):
        meta = {k: data.get(k) for k in ("video", "source", "width", "height", "fps", "duration", "method") if data.get(k) is not None}
        shots = data.get("shots") or []
    elif isinstance(data, list):
        meta, shots = {}, data
    else:
        raise ValueError("镜头分组文件格式不认识: %s" % path)
    if not shots:
        raise ValueError("镜头分组没有 shots 数据: %s" % path)
    return meta, shots


def load_motion(path):
    """返回 {key: {shift:[dx,dy], per_sec:[..], motion:str}}；无文件返回 {}。"""
    if not path or not os.path.exists(path):
        return {}
    data = load_json(path)
    result = {}
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict) or "k" not in item:
                continue
            key = norm_key(item["k"])
            shift = item.get("shift_px")
            if not isinstance(shift, list) or len(shift) != 2:
                shift = [item.get("dx_1920", 0) or 0, item.get("dy_1920", 0) or 0]
            per_sec = item.get("per_sec_px")
            if not isinstance(per_sec, list) or len(per_sec) != 2:
                t0, t1 = item.get("t0"), item.get("t1")
                dur = (t1 - t0) if _is_num(t0) and _is_num(t1) and t1 > t0 else None
                per_sec = [shift[0] / dur, shift[1] / dur] if dur else [0.0, 0.0]
            result[key] = {
                "shift": [float(shift[0]), float(shift[1])],
                "per_sec": [float(per_sec[0]), float(per_sec[1])],
                "motion": item.get("motion", ""),
            }
    elif isinstance(data, dict):
        for item in data.get("shots", []):
            key = norm_key(item.get("key") or item.get("k"))
            shift = item.get("shift_px") or [0, 0]
            result[key] = {
                "shift": [float(shift[0]), float(shift[1])],
                "per_sec": [float(x) for x in (item.get("per_sec_px") or [0, 0])],
                "motion": item.get("motion", ""),
            }
    return result


# ---------------------------------------------------------------- 相机参数推导
def derive_camera(content_shift, duration, *, static_tol=STATIC_TOL_PX, diagonal_ratio=DIAGONAL_RATIO):
    dx, dy = float(content_shift[0]), float(content_shift[1])
    major = max(abs(dx), abs(dy))
    cam = {"travel_px": [-dx, -dy], "source": "measured"}
    if major < static_tol:
        cam.update(mode="static", px=0.0, diagonal=False, approx=False)
        return cam
    axis = "x" if abs(dx) >= abs(dy) else "y"
    primary = dx if axis == "x" else dy
    minor = min(abs(dx), abs(dy))
    cam.update(
        mode="pan",
        axis=axis,
        sign=-1 if primary > 0 else 1,   # 相机与内容反向
        px=round(abs(primary), 3),
        speed_px_s=round(abs(primary) / duration, 3) if duration > 0 else 0.0,
        diagonal=bool(major > 0 and minor / major >= diagonal_ratio),
    )
    cam["approx"] = cam["diagonal"]   # 单轴渲染器对斜向运动只能近似
    return cam


def apply_override(cam, override):
    """人工指定运镜：{"mode":"pan","axis":"y","sign":1,"px":380} 或 {"mode":"static"}

    只给 axis/sign/px（不给 mode）时按 pan 处理，方便只覆盖行程方向。
    """
    out = dict(cam)
    mode = override.get("mode")
    if mode is None:
        mode = "pan" if any(k in override for k in ("axis", "sign", "px")) else out.get("mode")
    out.update(source="manual")
    if mode == "static":
        out.update(mode="static", px=0.0, travel_px=[0.0, 0.0], diagonal=False, approx=False)
        for k in ("axis", "sign"):
            out.pop(k, None)
        return out
    axis = override.get("axis", out.get("axis", "x"))
    sign = int(override.get("sign", out.get("sign", 1)))
    px = float(override.get("px", out.get("px", 0)))
    if axis not in ("x", "y") or sign not in (-1, 1) or px < 0:
        raise ValueError("人工运镜参数非法: %r" % (override,))
    out.update(mode="pan", axis=axis, sign=sign, px=px,
               travel_px=[sign * px, 0.0] if axis == "x" else [0.0, sign * px],
               diagonal=False, approx=False)
    return out


# ---------------------------------------------------------------- build
def build(args):
    root = os.path.abspath(args.root)
    group_path = os.path.abspath(args.group)
    motion_path = os.path.abspath(args.motion) if args.motion else None
    overrides_path = os.path.abspath(args.overrides) if args.overrides else None
    out_path = os.path.abspath(args.out)

    meta, raw_shots = load_group(group_path)
    motion_map = load_motion(motion_path)
    overrides = load_json(overrides_path) if overrides_path and os.path.exists(overrides_path) else {}
    overrides = {norm_key(k): v for k, v in overrides.items()}

    fps = float(args.fps or meta.get("fps") or 30.0)
    width = int(args.width or meta.get("width") or 1920)
    height = int(args.height or meta.get("height") or 1080)
    duration = float(args.duration or meta.get("duration") or 0.0)
    source = args.source or meta.get("video") or meta.get("source") or ""

    shots = []
    for raw in raw_shots:
        key = norm_key(raw.get("key") or raw.get("k"))
        start = float(raw.get("start", 0.0))
        end = float(raw.get("end", start))
        if end <= start:
            raise ValueError("%s 时间轴非法: start=%s end=%s" % (key, start, end))
        mid = float(raw["mid"]) if _is_num(raw.get("mid")) else round((start + end) / 2.0, 3)
        frames = int(raw["frames"]) if _is_num(raw.get("frames")) else round_frames(end - start, fps)
        measured = motion_map.get(key, {})
        shift = raw.get("shift_px")
        if not (isinstance(shift, list) and len(shift) == 2 and _is_num(shift[0])):
            shift = measured.get("shift", [0.0, 0.0])
        shift = [float(shift[0]), float(shift[1])]
        per_sec = raw.get("per_sec_px") or measured.get("per_sec") or [
            shift[0] / (end - start), shift[1] / (end - start)]
        camera = derive_camera(shift, end - start)
        if key in overrides:
            camera = apply_override(camera, overrides[key])
        shots.append({
            "key": key,
            "start": round(start, 3),
            "end": round(end, 3),
            "mid": round(mid, 3),
            "frames": frames,
            "file": raw.get("file") or "",
            "content_shift_px": [round(shift[0], 3), round(shift[1], 3)],
            "content_per_sec_px": [round(float(x), 3) for x in per_sec],
            "motion_desc": raw.get("motion") or measured.get("motion") or "",
            "camera": {k: v for k, v in camera.items() if k in CAMERA_KEYS},
        })

    shots.sort(key=lambda s: (s["start"], s["key"]))
    doc = {
        "schema_version": 1,
        "generated_by": "工具/shot_params.py build v%s" % TOOL_VERSION,
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": source,
        "width": width,
        "height": height,
        "fps": fps,
        "duration": round(duration, 3),
        "provenance": {
            "root": rel(root, PROJ) or ".",
            "shots": rel(group_path, PROJ),
            "motion": rel(motion_path, PROJ) if motion_path else "(内嵌)",
            "overrides": rel(overrides_path, PROJ) if overrides_path else "",
        },
        "shots": shots,
    }
    dump_json(out_path, doc)
    print("BUILD OK  %s" % out_path)
    print("  shots=%d  pan=%d  static=%d  fps=%s  %dx%d" % (
        len(shots),
        sum(1 for s in shots if s["camera"]["mode"] == "pan"),
        sum(1 for s in shots if s["camera"]["mode"] == "static"),
        fps, width, height))
    return doc


# ---------------------------------------------------------------- schema 校验（纯标准库子集实现）
def _json_type_ok(value, t):
    return {
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "string": lambda v: isinstance(v, str),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "number": _is_num,
        "boolean": lambda v: isinstance(v, bool),
        "null": lambda v: v is None,
    }.get(t, lambda v: True)(value)


def _resolve_ref(schema, root_schema):
    ref = schema["$ref"]
    if not ref.startswith("#/"):
        raise ValueError("只支持本地 $ref: %s" % ref)
    node = root_schema
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def validate_schema(node, schema, root_schema, path, errors):
    if "$ref" in schema:
        return validate_schema(node, _resolve_ref(schema, root_schema), root_schema, path, errors)
    if "type" in schema:
        types = [schema["type"]] if isinstance(schema["type"], str) else list(schema["type"])
        if not any(_json_type_ok(node, t) for t in types):
            errors.append("%s: 期望类型 %s，实际 %s" % (path or "$", types, type(node).__name__))
            return
    if "const" in schema and node != schema["const"]:
        errors.append("%s: 期望常量 %r，实际 %r" % (path or "$", schema["const"], node))
    if "enum" in schema and node not in schema["enum"]:
        errors.append("%s: 期望枚举 %r，实际 %r" % (path or "$", schema["enum"], node))
    if isinstance(node, dict):
        for req in schema.get("required", []):
            if req not in node:
                errors.append("%s: 缺少必填字段 %r" % (path or "$", req))
        props = schema.get("properties", {})
        addl = schema.get("additionalProperties", True)
        for k, v in node.items():
            child = props.get(k)
            if child is not None:
                validate_schema(v, child, root_schema, "%s.%s" % (path, k), errors)
            elif addl is False:
                errors.append("%s: 未知字段 %r" % (path or "$", k))
            elif isinstance(addl, dict):
                validate_schema(v, addl, root_schema, "%s.%s" % (path, k), errors)
    elif isinstance(node, list):
        if "minItems" in schema and len(node) < schema["minItems"]:
            errors.append("%s: 元素数 %d < minItems %d" % (path, len(node), schema["minItems"]))
        if "maxItems" in schema and len(node) > schema["maxItems"]:
            errors.append("%s: 元素数 %d > maxItems %d" % (path, len(node), schema["maxItems"]))
        item_schema = schema.get("items")
        if item_schema:
            for i, item in enumerate(node):
                validate_schema(item, item_schema, root_schema, "%s[%d]" % (path, i), errors)
    elif isinstance(node, str) and "pattern" in schema:
        if re.fullmatch(schema["pattern"], node) is None:
            errors.append("%s: 不匹配 pattern %r（实际 %r）" % (path, schema["pattern"], node))
    if _is_num(node):
        if "minimum" in schema and node < schema["minimum"]:
            errors.append("%s: %r < minimum %r" % (path, node, schema["minimum"]))
        if "exclusiveMinimum" in schema and node <= schema["exclusiveMinimum"]:
            errors.append("%s: %r <= exclusiveMinimum %r" % (path, node, schema["exclusiveMinimum"]))


def semantic_checks(doc, args, errors, warnings):
    root = os.path.abspath(args.root)
    fps = float(doc["fps"])
    keys = set()
    prev_start = -1.0
    total_frames = 0
    for shot in doc["shots"]:
        key, start, end, frames = shot["key"], shot["start"], shot["end"], shot["frames"]
        p = "shots[%s]" % key
        if key in keys:
            errors.append("%s: key 重复" % p)
        keys.add(key)
        if start < prev_start - 1e-6:
            errors.append("%s: 时间轴未按 start 升序" % p)
        prev_start = start
        if not (end > start):
            errors.append("%s: end(%s) <= start(%s)" % (p, end, start))
        if not (start - 1e-6 <= shot.get("mid", start) <= end + 1e-6):
            errors.append("%s: mid 不在 [start,end] 内" % p)
        expect = round_frames(end - start, fps)
        if abs(frames - expect) > FRAME_TOL:
            errors.append("%s: frames=%d 与 时长×fps=%.2f 不符（容差 %d）" % (p, frames, (end - start) * fps, FRAME_TOL))
        total_frames += frames

        cam = shot["camera"]
        shift = shot["content_shift_px"]
        mode = cam["mode"]
        if mode == "static":
            if cam.get("px", 0):
                errors.append("%s: static 镜头的 px 必须为 0" % p)
            if any(abs(x) > STATIC_TOL_PX for x in cam["travel_px"]):
                errors.append("%s: static 镜头的 travel_px 必须接近 0" % p)
        else:
            for field in ("axis", "sign", "px"):
                if field not in cam:
                    errors.append("%s: pan 镜头缺字段 %s" % (p, field))
            if cam.get("axis") not in ("x", "y"):
                errors.append("%s: axis 必须为 x/y" % p)
            if cam.get("sign") not in (-1, 1):
                errors.append("%s: sign 必须为 -1/1" % p)
            if cam.get("px", 0) <= 0:
                errors.append("%s: pan 镜头 px 必须 > 0" % p)
            if cam.get("source") == "measured":
                major = max(abs(shift[0]), abs(shift[1]))
                if abs(cam.get("px", 0) - major) > 1.0:
                    errors.append("%s: measured 相机 px(%.2f) 应等于主轴位移(%.2f)" % (p, cam.get("px", 0), major))
                want_axis = "x" if abs(shift[0]) >= abs(shift[1]) else "y"
                if cam.get("axis") != want_axis:
                    errors.append("%s: measured 相机 axis 应为 %s" % (p, want_axis))
                primary = shift[0] if want_axis == "x" else shift[1]
                want_sign = -1 if primary > 0 else 1
                if cam.get("sign") != want_sign:
                    errors.append("%s: measured 相机 sign 应为 %d（相机与内容反向）" % (p, want_sign))
                if not (_near(cam["travel_px"][0], -shift[0]) and _near(cam["travel_px"][1], -shift[1])):
                    errors.append("%s: travel_px 应等于 -content_shift_px" % p)
        # 运镜描述自洽（只对「内容X移/固定」这类可解析描述）
        desc = shot.get("motion_desc", "")
        if desc and cam.get("source") == "measured":
            checks = [("内容右移", shift[0] > 0), ("内容左移", shift[0] < 0),
                      ("内容下移", shift[1] > 0), ("内容上移", shift[1] < 0),
                      ("固定", mode == "static")]
            for token, ok in checks:
                if token in desc and not ok:
                    errors.append("%s: 描述「%s」与位移 %r 不一致" % (p, token, shift))
        # 文件存在性（可选）
        if args.check_files and shot.get("file"):
            fp = os.path.join(root, shot["file"])
            if not os.path.exists(fp):
                warnings.append("%s: 文件不存在 %s" % (p, rel(fp, root)))
    if doc.get("duration"):
        sum_dur = sum(s["end"] - s["start"] for s in doc["shots"])
        expect_total = round_frames(sum_dur, fps)
        if abs(total_frames - expect_total) > FRAME_TOL:
            errors.append("总帧数 %d 与 Σ各镜时长×fps %d 不符" % (total_frames, expect_total))
        if abs(sum_dur - doc["duration"]) > 0.1:
            warnings.append("镜头总时长 %.3fs 与 source duration %.3fs 不等（存在切镜空隙，正常）" % (sum_dur, doc["duration"]))


def validate(args):
    doc = load_json(args.file)
    schema = load_json(args.schema)
    errors, warnings = [], []
    validate_schema(doc, schema, schema, "$", errors)
    if not errors:
        semantic_checks(doc, args, errors, warnings)
    for w in warnings:
        print("WARN  %s" % w)
    if errors:
        for e in errors:
            print("ERROR %s" % e)
        print("VALIDATE FAIL  %d error(s), %d warning(s)" % (len(errors), len(warnings)))
        return 1
    print("VALIDATE OK  %s" % args.file)
    print("  schema=%s  语义检查通过（%d 镜）  warnings=%d" % (
        rel(os.path.abspath(args.schema), PROJ), len(doc["shots"]), len(warnings)))
    return 0


# ---------------------------------------------------------------- 编译渲染作业
def guess_images_dir(root):
    candidates = [
        os.path.join(root, "成片帧_画布选定"),
        os.path.join(root, "关键帧_替换_v7"),
        os.path.join(root, "关键帧_替换_全部"),
        os.path.join(root, "分析", "宗门新功法", "帧"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return candidates[0]


def compile_jobs(args):
    doc = load_json(args.file)
    root = os.path.abspath(args.root)
    images = os.path.abspath(args.images) if args.images else guess_images_dir(root)
    out_dir = os.path.abspath(args.jobs_out) if args.jobs_out else os.path.join(os.path.dirname(os.path.abspath(args.file)), "渲染作业")
    os.makedirs(out_dir, exist_ok=True)
    res = [int(doc["width"]), int(doc["height"])]
    index = {"generated_by": "工具/shot_params.py compile v%s" % TOOL_VERSION,
             "params": rel(os.path.abspath(args.file), PROJ),
             "images": rel(images, PROJ),
             "resolution": res, "jobs": [], "static": []}
    made, missing = 0, []
    for shot in doc["shots"]:
        cam = shot["camera"]
        key = shot["key"]
        if cam["mode"] == "static":
            index["static"].append({"key": key, "frames": shot["frames"], "mid": shot.get("mid")})
            continue
        image = os.path.join(images, key + (args.suffix or "") + ".png")
        if not os.path.exists(image):
            missing.append(rel(image, root))
            continue
        job = {
            "name": key,
            "image": os.path.abspath(image).replace("\\", "/"),
            "frames": shot["frames"],
            "axis": cam["axis"],
            "sign": int(cam["sign"]),
            "px": int(round(cam["px"])),
            "x_px": int(round(cam["travel_px"][0])),
            "y_px": int(round(cam["travel_px"][1])),
            "out": os.path.abspath(os.path.join(out_dir, key)).replace("\\", "/"),
            "res": res,
        }
        dump_json(os.path.join(out_dir, key + ".json"), job)
        index["jobs"].append({"key": key, "file": key + ".json", "frames": job["frames"],
                              "axis": job["axis"], "sign": job["sign"], "px": job["px"],
                              "x_px": job["x_px"], "y_px": job["y_px"],
                              "approx": cam.get("approx", False)})
        made += 1
    dump_json(os.path.join(out_dir, "index.json"), index)
    print("COMPILE %s" % out_dir)
    print("  jobs=%d  static=%d  images=%s" % (made, len(index["static"]), rel(images, PROJ)))
    if missing:
        print("  WARN 缺图 %d 张（未生成 job）：%s" % (len(missing), ", ".join(missing[:6]) + (" ..." if len(missing) > 6 else "")))
    print("  下一步：blender -b --python 工具/render_one_shot.py -- --json <job>.json")
    return 0 if not missing or args.allow_missing else 2


# ---------------------------------------------------------------- 报告
def report(args):
    doc = load_json(args.file)
    print("| 镜头 | 时间 | 帧 | 内容位移(px) | 模式 | 相机 axis/sign/px | 斜向近似 | 描述 |")
    print("|---|---|---|---|---|---|---|---|")
    for s in doc["shots"]:
        cam = s["camera"]
        motion = "%s %+d/%d" % (cam["axis"], cam["sign"], int(round(cam["px"]))) if cam["mode"] == "pan" else "静帧"
        approx = "是" if cam.get("approx") else ""
        print("| {key} | {start:.2f}–{end:.2f} | {frames} | [{dx:+.0f}, {dy:+.0f}] | {mode} | {motion} | {approx} | {desc} |".format(
            key=s["key"], start=s["start"], end=s["end"], frames=s["frames"],
            dx=s["content_shift_px"][0], dy=s["content_shift_px"][1],
            mode=cam["mode"], motion=motion, approx=approx, desc=s.get("motion_desc") or ""))
    total = sum(s["frames"] for s in doc["shots"])
    print("\n合计 %d 镜 / %d 帧 / %.2fs @ %.2ffps" % (len(doc["shots"]), total, doc.get("duration") or total / doc["fps"], doc["fps"]))
    return 0


# ---------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="镜头参数表：build / validate / compile / report")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--root", default=ROOT_DEFAULT, help="项目素材根（相对路径基准）")
        p.add_argument("--file", default=os.path.join(SHOTDIR_DEFAULT, "镜头参数.json"), help="镜头参数.json")

    p_build = sub.add_parser("build", help="合并输入并生成 镜头参数.json")
    common(p_build)
    p_build.add_argument("--group", default=os.path.join(SHOTDIR_DEFAULT, "镜头分组.json"))
    p_build.add_argument("--motion", default=os.path.join(SHOTDIR_DEFAULT, "运镜位移.json"))
    p_build.add_argument("--out", default=os.path.join(SHOTDIR_DEFAULT, "镜头参数.json"))
    p_build.add_argument("--overrides", default="", help="人工指定运镜 JSON（key -> camera 覆盖）")
    p_build.add_argument("--fps", type=float, default=0)
    p_build.add_argument("--width", type=int, default=0)
    p_build.add_argument("--height", type=int, default=0)
    p_build.add_argument("--duration", type=float, default=0)
    p_build.add_argument("--source", default="")

    p_val = sub.add_parser("validate", help="按 schema + 语义校验")
    common(p_val)
    p_val.add_argument("--schema", default=SCHEMA_DEFAULT)
    p_val.add_argument("--check-files", action="store_true")

    p_cmp = sub.add_parser("compile", help="编译成 render_one_shot.py 的 job")
    common(p_cmp)
    p_cmp.add_argument("--images", default="", help="替换图目录（默认自动探测）")
    p_cmp.add_argument("--suffix", default="", help="图片后缀，如 _v7")
    p_cmp.add_argument("--jobs-out", default="")
    p_cmp.add_argument("--allow-missing", action="store_true")

    p_rep = sub.add_parser("report", help="打印镜头参数表")
    common(p_rep)

    args = ap.parse_args(argv)
    if args.cmd == "build":
        build(args)
        return 0
    if args.cmd == "validate":
        return validate(args)
    if args.cmd == "compile":
        return compile_jobs(args)
    if args.cmd == "report":
        return report(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
