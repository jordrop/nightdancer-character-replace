# -*- coding: utf-8 -*-
"""把生成出来的图自动链接到画布（N×N 网格模块化），并可选清理自动导入的 edit 重复卡。

用法：
  python 工具/canvas_link_images.py --dir "参考上传/无归原_资产/关键帧_三锚点" --layer anchors --cols 5 --badge 三锚点
  python 工具/canvas_link_images.py --prune-edit
  # 默认端口 17801，可用 --base 指定；--dry-run 只报告不写

规则：
- 扫描目录内所有 png/jpg/jpeg/webp，跳过已在画布上的同名 src；
- 按文件 hash 去重（同一张图不重复上画布）；
- 新增卡片 type=asset，标题取文件名，badge 取 --badge；
- 重新布局所有模块：每个模块按 N×N 网格排布，模块之间 shelf 排列，0 重叠。
"""
import argparse
import hashlib
import json
import os
import re
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get(base, p):
    with urllib.request.urlopen(base + p, timeout=30) as r:
        return json.loads(r.read().decode())


def post(base, p, o):
    req = urllib.request.Request(base + p, data=json.dumps(o, ensure_ascii=False).encode("utf-8"),
                                 method="POST", headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")


# 模块顺序与网格列数（与当前 b2 资产板一致）
MODULES = [
    ("overview", "⓪ 项目总览 · 资产规则", "《无归原》第三章 · 32×15s · 纯虚构", 2),
    ("chars", "① 人物设定 · C1–C4", "先出锚点图，锁定后引用", 2),
    ("props", "② 道具设定 · P1–P5", "铜铃/火种罐/短刀/药箱/绑带", 2),
    ("crowd", "③ 群像 · 配角", "重演者装束 / 搀扶姿态参考", 2),
    ("scene", "④ 场景设定 · S1–S5", "灰岭→无归原→篝火→南屿", 2),
    ("test", "⑤ 测试门", "T1 / V1000 A/B / 记录", 2),
    ("kf", "⑥ 关键帧 · 8 旗舰（三锚点条带）", "U01/U02/U04/U13/U19/U22/U24/U32", 3),
    ("anchors", "⑦ 三锚点 · 24 张（open/mid/end）", "每单元 3 张备选，全部展示", 5),
    ("history", "⑧ 备选 / 历史版本", "旧版关键帧、C3 v1、S1 v1、即梦产物", 5),
    ("nj_src", "⑩ 女红军·夹金山 源文/结构", "18×20s=6:00；真实领袖不露正脸", 2),
    ("nj_char", "⑪ 角色原型 · 夹金山", "李坚真/王泉媛/刘英/蔡畅/刘彩香/小红军/老爷爷/群像", 3),
    ("nj_props", "⑫ 道具 · 夹金山", "辣椒/辣子汤/木棍/搪瓷碗/糖精/担架/骡子/快板", 3),
    ("nj_shot", "⑬ 分镜 · 18 单元（20s）", "N01–N18 有对白/钩子", 3),
    ("nj_keys", "⑭ 关键帧占位 · 8 张", "待出图", 3),
    ("nj_video", "【女红军】⑥ 视频生成预设（15 单元）", "2.5 / 480p / 16:9 / 20s；未跑", 3),
    ("video", "⑨ 视频生成（待发令）", "U19 2.5 480p 首帧已备好", 1),
]
CW, CH, GAP, HEADER, MGAP, MAXW, X0, Y0 = 300, 210, 18, 64, 70, 4600, 20, 20


def card_h(c):
    return 240 if c.get("type") in ("text", "note") else 210


def layout(board, module_cols):
    cards = board["cards"]
    order = []
    for key, title, sub, cols in MODULES:
        order.append((key, title, sub, cols))
    # 新 layer 插到 video 前
    known = {m[0] for m in MODULES}
    extra_layers = []
    for c in cards:
        lay = c.get("layer", "overview")
        if lay not in known and lay != "edit":
            if lay not in extra_layers:
                extra_layers.append(lay)
    for lay in extra_layers:
        order.insert(-1, (lay, "⑩ " + lay, "自动链接", module_cols))
    by = {}
    for c in cards:
        if c.get("layer") == "edit":
            continue
        by.setdefault(c.get("layer", "overview"), []).append(c)
    cx, cy, row_h = X0, Y0, 0
    layers = []
    for key, title, sub, cols in order:
        items = sorted(by.get(key, []), key=lambda c: c.get("title", ""))
        if not items:
            continue
        rows = (len(items) + cols - 1) // cols
        # 每行高度按该行最高卡片计算（text/note 240，图片 210）
        row_heights = []
        for r in range(rows):
            row_cards = items[r * cols:(r + 1) * cols]
            row_heights.append(max(card_h(c) for c in row_cards) if row_cards else CH)
        bw = cols * (CW + GAP) - GAP
        bh = HEADER + sum(row_heights) + GAP * (rows - 1)
        if cx + bw > MAXW and cx > X0:
            cy += row_h + MGAP
            cx = X0
            row_h = 0
        y_cursor = cy + HEADER
        for i, c in enumerate(items):
            r, col = divmod(i, cols)
            if col == 0 and r > 0:
                y_cursor += row_heights[r - 1] + GAP
            c["x"] = cx + col * (CW + GAP)
            c["y"] = y_cursor
            c["w"] = CW
            c["h"] = card_h(c)
            c["col"] = col
        layers.append({"key": key, "title": title, "sub": sub, "count": len(items)})
        cx += bw + MGAP
        row_h = max(row_h, bh)
    board["layers"] = layers
    return board


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", help="图片目录（可递归），如 参考上传/无归原_资产/关键帧_三锚点")
    ap.add_argument("--layer", default="history", help="归入哪一层（默认 history）")
    ap.add_argument("--cols", type=int, default=5)
    ap.add_argument("--badge", default="生成图")
    ap.add_argument("--base", default="http://127.0.0.1:17801")
    ap.add_argument("--prune-edit", action="store_true", help="清掉自动导入的 edit 层重复卡")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    board = get(args.base, "/api/board")
    cards = board["cards"]
    existing_src = {c.get("src") for c in cards if c.get("src")}
    hashes = {}
    for c in cards:
        s = c.get("src")
        if s:
            p = os.path.join(ROOT, s)
            if os.path.exists(p):
                try:
                    hashes[sha(p)] = s
                except Exception:
                    pass

    added = []
    if args.dir:
        d = args.dir if os.path.isabs(args.dir) else os.path.join(ROOT, args.dir)
        for root, dirs, files in os.walk(d):
            for f in sorted(files):
                if f.startswith("_"):
                    continue  # 跳过联络图/条带汇总等
                if not f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    continue
                p = os.path.join(root, f)
                r = rel(p)
                if r in existing_src:
                    continue
                h = sha(p)
                if h in hashes:
                    continue
                cid = "gen_%s_%s" % (args.layer, re.sub(r"\W+", "_", os.path.splitext(os.path.basename(p))[0]).lower())
                cid = cid[:80]
                if any(c["id"] == cid for c in cards):
                    continue
                card = {"id": cid, "type": "asset", "origin": "user", "layer": args.layer,
                        "title": os.path.splitext(f)[0], "badge": args.badge,
                        "src": r, "caption": r, "x": 0, "y": 0, "w": CW, "h": CH, "col": 0}
                cards.append(card)
                existing_src.add(r)
                hashes[h] = r
                added.append(cid)

    removed = []
    if args.prune_edit:
        removed = [c["id"] for c in cards if c.get("layer") == "edit"]
        cards = [c for c in cards if c.get("layer") != "edit"]
    board["cards"] = cards
    board = layout(board, args.cols)

    if args.dry_run:
        print("DRY-RUN added:", len(added), "removed edit:", len(removed), "cards:", len(cards))
        return
    post(args.base, "/api/board", {"_by": "asset-build", **board})
    # 校验重叠
    cs = board["cards"]
    def ov(a, b):
        return not (a["x"] + a["w"] <= b["x"] or b["x"] + b["w"] <= a["x"] or
                    a["y"] + a["h"] <= b["y"] or b["y"] + b["h"] <= a["y"])
    n = sum(1 for i in range(len(cs)) for j in range(i + 1, len(cs)) if ov(cs[i], cs[j]))
    print("ADDED:", len(added), "REMOVED edit:", len(removed), "CARDS:", len(cs), "OVERLAPS:", n)
    print("LAYERS:", [(l["key"], l["count"]) for l in board["layers"]])


if __name__ == "__main__":
    main()
