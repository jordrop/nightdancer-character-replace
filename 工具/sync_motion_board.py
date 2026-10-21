"""画布运镜联动：镜头参数.json ⇄ 画布 out:K## 卡的 camera 字段

画布（_canvas/server.mjs）里每张成片卡 `out:K##` 自带 `motion` 字段（人话运镜），
本脚本把结构化 `camera` 参数推进去 / 从画布拉回来，打通：

    画布改运镜 → pull → validate → compile → 一键渲染

设计约束（遵守项目铁律）：
  * 只改已有 `out:K##` 卡的字段，**不新增/删除任何卡**；
  * 不覆盖人工维护的 `motion` 文本，运镜参数写在新字段 `camera`，人话摘要写 `motion_camera`；
  * push/pull 默认 dry-run，必须显式 `--write` 才落盘；
  * HTTP 模式只操作服务端“当前画布”；离线模式直接改 board.json（写前备份，不碰 board.bak.json）。

用法（项目根执行）：
  python 工具/sync_motion_board.py check                      # 只读对比
  python 工具/sync_motion_board.py push --write               # 参数 → 画布
  python 工具/sync_motion_board.py pull --write --apply       # 画布 → 参数（写回 + 校验）

常用参数：
  --canvas-url http://127.0.0.1:17800   HTTP 服务地址
  --file      <镜头参数.json>            默认自动探测（分析/ 或 宗门新功法/）
  --project   <项目根>                   离线模式用；默认从 --file 向上找 _canvas/boards
  --board     <画布 id>                  离线模式指定画布；默认 index.json 的 current
  --no-http                               强制离线文件模式
  --apply                                 pull 后把 camera 写回 --file 并跑 schema+语义校验
  --allow-invalid                         pull 校验失败仍写回（不建议）
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request

if hasattr(sys.stdout, "buffer") and not str(getattr(sys.stdout, "encoding", "")).lower().startswith("utf-8"):
    sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJ, "工具"))
import shot_params as sp  # noqa: E402  复用 schema/语义校验

OUT_KEY_RE = re.compile(r"^out:(K\d{2})$")

# 人话运镜 → 相机方向（与 项目记忆 第 5 节 / render_one_shot.py 的 sign 语义一致）
TEXT_DIRECTIONS = [
    ("从上往下", ("y", +1)),   # 相机下移
    ("从下往上", ("y", -1)),   # 相机上移
    ("从左往右", ("x", +1)),   # 相机右移
    ("从右往左", ("x", -1)),   # 相机左移
]
STATIC_TOKENS = ("不动", "固定", "静帧", "静止")
DIRECTIONS_HUMAN = {
    ("x", +1): "相机右移（从左往右）",
    ("x", -1): "相机左移（从右往左）",
    ("y", +1): "相机下移（从上往下）",
    ("y", -1): "相机上移（从下往上）",
}


# ---------------------------------------------------------------- 参数 ↔ 卡片
def camera_of_shot(shot):
    """镜头参数里的 camera → 画布卡片的精简 camera（只留渲染用字段）"""
    cam = shot.get("camera") or {}
    out = {"mode": cam.get("mode", "static"), "source": cam.get("source", "measured")}
    if out["mode"] == "pan":
        travel = cam.get("travel_px") or [0, 0]
        out.update(axis=cam.get("axis"), sign=int(cam.get("sign", 1)),
                   px=int(round(cam.get("px", 0))),
                   x_px=int(round(travel[0])), y_px=int(round(travel[1])))
    else:
        out.update(px=0, x_px=0, y_px=0)
    return out


def motion_camera_of(camera):
    if camera.get("mode") == "static":
        return "不动"
    return "%s %dpx" % (DIRECTIONS_HUMAN.get((camera.get("axis"), int(camera.get("sign", 1))), "运镜"),
                        int(camera.get("px", 0)))


def card_camera_matches(card_cam, param_cam):
    if not isinstance(card_cam, dict) or card_cam.get("mode") != param_cam.get("mode"):
        return False
    if param_cam["mode"] == "static":
        return True
    return (card_cam.get("axis") == param_cam.get("axis")
            and int(card_cam.get("sign", 0)) == int(param_cam.get("sign", 0))
            and int(card_cam.get("px", -1)) == int(param_cam.get("px", -2)))


def parse_motion_text(text):
    """从人话运镜文本推断方向（不含行程 px）"""
    t = text or ""
    if any(tok in t for tok in STATIC_TOKENS):
        return {"mode": "static"}
    for token, (axis, sign) in TEXT_DIRECTIONS:
        if token in t:
            return {"mode": "pan", "axis": axis, "sign": sign}
    # 兼容「内容右移（相机左摇）」这类测量描述
    if "内容右移" in t or "相机左摇" in t:
        return {"mode": "pan", "axis": "x", "sign": -1}
    if "内容左移" in t or "相机右摇" in t:
        return {"mode": "pan", "axis": "x", "sign": +1}
    if "内容下移" in t or "相机上摇" in t:
        return {"mode": "pan", "axis": "y", "sign": -1}
    if "内容上移" in t or "相机下摇" in t:
        return {"mode": "pan", "axis": "y", "sign": +1}
    return None


def card_to_override(card, shot, default_px=180.0):
    """画布卡片 → 覆盖参数：优先结构化 camera，回退解析 motion 文本"""
    cam = card.get("camera")
    if isinstance(cam, dict) and cam.get("mode"):
        if cam["mode"] == "static":
            return {"mode": "static"}
        px = cam.get("px")
        if px is None:
            px = (shot.get("camera") or {}).get("px") or default_px
        if int(px) <= 0:
            px = default_px
        return {"mode": "pan", "axis": cam.get("axis", "x"),
                "sign": int(cam.get("sign", 1)), "px": float(px)}
    parsed = parse_motion_text(card.get("motion") or "")
    if parsed is None:
        return None
    if parsed["mode"] == "static":
        return parsed
    px = (shot.get("camera") or {}).get("px") or 0
    if not px or float(px) <= 0:
        px = default_px
    parsed["px"] = float(px)
    return parsed


def apply_override_to_shot(shot, override):
    cam = shot.setdefault("camera", {})
    before = json.dumps(cam, ensure_ascii=False, sort_keys=True)
    if override.get("mode") == "static":
        cam.update(mode="static", px=0.0, travel_px=[0.0, 0.0], diagonal=False, approx=False, source="manual")
        for k in ("axis", "sign"):
            cam.pop(k, None)
    else:
        axis = override["axis"]
        sign = int(override["sign"])
        px = float(override["px"])
        cam.update(mode="pan", axis=axis, sign=sign, px=px,
                   travel_px=[sign * px, 0.0] if axis == "x" else [0.0, sign * px],
                   diagonal=False, approx=False, source="manual")
    return json.dumps(cam, ensure_ascii=False, sort_keys=True) != before


# ---------------------------------------------------------------- 画布访问层
class HttpBoard:
    kind = "http"

    def __init__(self, url):
        self.url = url.rstrip("/")

    def _req(self, path, data=None, method=None):
        body = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(self.url + path, data=body, method=method or ("POST" if data else "GET"),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    def get(self):
        return self._req("/api/board")

    def patch_card(self, key, patch):
        return self._req("/api/board/card", {"key": key, "patch": patch, "_by": "sync_motion_board"})

    def board_label(self):
        try:
            idx = self._req("/api/boards")
            return "HTTP 当前画布 " + str(idx.get("current")) + "（共 %d 块）" % len(idx.get("boards", []))
        except Exception:
            return "HTTP " + self.url


class FileBoard:
    kind = "file"

    def __init__(self, project, board_id=None):
        self.project = os.path.abspath(project)
        self.boards_dir = os.path.join(self.project, "_canvas", "boards")
        index_path = os.path.join(self.boards_dir, "index.json")
        if not os.path.exists(index_path):
            raise SystemExit("找不到画布目录：%s（用 --project 指定项目根，或改用 HTTP 模式）" % self.boards_dir)
        self.index = sp.load_json(index_path)
        self.board_id = board_id or self.index.get("current")
        self.path = os.path.join(self.boards_dir, str(self.board_id), "board.json")
        if not os.path.exists(self.path):
            raise SystemExit("找不到画布文件：%s" % self.path)
        self._board = sp.load_json(self.path)

    def get(self):
        return self._board

    def patch_card(self, key, patch):
        hit = None
        for card in self._board.get("cards", []):
            if card.get("key") == key:
                hit = card
                break
        if hit is None:
            return {"ok": False, "error": "card not found: " + key}
        hit.update(patch)
        self._dirty = True
        return {"ok": True}

    def flush(self):
        if not getattr(self, "_dirty", False):
            return
        bak = self.path + ".before-sync-%s" % time.strftime("%Y%m%d-%H%M%S")
        shutil.copyfile(self.path, bak)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._board, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)
        self._dirty = False
        print("  已写画布：%s（备份 %s）" % (sp.rel(self.path, self.project), os.path.basename(bak)))

    def board_label(self):
        return "文件画布 %s（%s）" % (self.board_id, sp.rel(self.path, self.project))


def open_board(args):
    if not args.no_http:
        try:
            b = HttpBoard(args.canvas_url)
            b.get()
            return b
        except Exception as e:
            print("  HTTP 不可用（%s），改用离线文件模式" % e)
    if not args.project:
        raise SystemExit("HTTP 不可用且未给 --project，无法离线读画布")
    return FileBoard(args.project, args.board)


# ---------------------------------------------------------------- 三件事
def collect(shots, board):
    """返回 [(shot, card)]（只取 key=out:K## 的卡）"""
    cards = {}
    for card in board.get().get("cards", []):
        m = OUT_KEY_RE.match(str(card.get("key") or ""))
        if m:
            cards[m.group(1)] = card
    pairs, missing = [], []
    for shot in shots:
        key = shot["key"]
        if key in cards:
            pairs.append((shot, cards[key]))
        else:
            missing.append(key)
    return pairs, missing


def cmd_check(args, doc, board):
    shots = doc["shots"]
    pairs, missing = collect(shots, board)
    diffs, ok = [], 0
    print("| 镜头 | 参数 camera | 画布 camera | 画布 motion | 状态 |")
    print("|---|---|---|---|---|")
    for shot, card in pairs:
        pcam = camera_of_shot(shot)
        ccam = card.get("camera")
        if card_camera_matches(ccam, pcam):
            ok += 1
            state = "一致"
        else:
            parse = parse_motion_text(card.get("motion") or "")
            if isinstance(ccam, dict) and ccam.get("mode"):
                state = "camera 不同"
            elif parse and ((parse.get("mode") == pcam["mode"]) and
                            (pcam["mode"] == "static" or
                             (parse.get("axis") == pcam.get("axis") and
                              (parse.get("sign") is None or parse.get("sign") == pcam.get("sign"))))):
                state = "缺 camera（motion 文本方向一致）"
            else:
                state = "缺 camera / 文本方向不符"
        print("| %s | %s | %s | %s | %s |" % (
            shot["key"], json.dumps(pcam, ensure_ascii=False),
            json.dumps(ccam, ensure_ascii=False) if ccam else "—",
            card.get("motion") or "—", state))
        if state != "一致":
            diffs.append(shot["key"])
    if missing:
        print("\n画布中没有这些 out 卡：%s" % ", ".join(missing))
    print("\n%s：%d 镜一致 / %d 镜待同步（%s）" % (
        board.board_label(), ok, len(diffs), ", ".join(diffs) if diffs else "无"))
    return 0 if not diffs and not missing else 1


def cmd_push(args, doc, board):
    shots = doc["shots"]
    pairs, missing = collect(shots, board)
    if missing:
        print("WARN 画布缺卡：%s" % ", ".join(missing))
    changed = 0
    for shot, card in pairs:
        pcam = camera_of_shot(shot)
        patch = {}
        if not card_camera_matches(card.get("camera"), pcam):
            patch["camera"] = pcam
        mtext = motion_camera_of(pcam)
        if card.get("motion_camera") != mtext:
            patch["motion_camera"] = mtext
        if not patch:
            continue
        changed += 1
        print("  %s  %s" % (shot["key"], json.dumps(patch, ensure_ascii=False)))
        if args.write:
            r = board.patch_card("out:" + shot["key"], patch)
            if not r.get("ok") and args.write:
                print("    ↳ 失败：%s" % r.get("error"))
    if isinstance(board, FileBoard):
        if args.write:
            board.flush()
    print("\n%s：%d/%d 镜%s" % (board.board_label(), changed, len(pairs), "已更新" if args.write else "待更新（dry-run，加 --write 落盘）"))
    return 0


def cmd_pull(args, doc, board):
    shots = {s["key"]: s for s in doc["shots"]}
    pairs, missing = collect(doc["shots"], board)
    changed, skipped = [], []
    for shot, card in pairs:
        override = card_to_override(card, shot, default_px=args.default_px)
        if override is None:
            skipped.append(shot["key"])
            continue
        # 只在“画布与参数不一致”时覆盖，避免无意义改写
        pcam = camera_of_shot(shot)
        same = (override.get("mode") == pcam["mode"] and
                (pcam["mode"] == "static" or
                 (override.get("axis") == pcam.get("axis") and
                  int(override.get("sign", 0)) == int(pcam.get("sign", 0)) and
                  int(override.get("px", -1)) == int(pcam.get("px", -2)))))
        if same:
            continue
        if apply_override_to_shot(shot, override):
            changed.append((shot["key"], override))
    for key, ov in changed:
        print("  %s ← %s" % (key, json.dumps(ov, ensure_ascii=False)))
    if skipped:
        print("  （无法解析的卡，已跳过：%s）" % ", ".join(skipped))
    if not changed:
        print("\n%s：画布与参数已一致，无需更新" % board.board_label())
        return 0
    if not args.write:
        print("\n%s：%d 镜待更新（dry-run，加 --write 落盘）" % (board.board_label(), len(changed)))
        return 0
    if args.apply:
        errors, warnings = [], []
        schema = sp.load_json(args.schema or sp.SCHEMA_DEFAULT)
        sp.validate_schema(doc, schema, schema, "$", errors)
        if not errors:
            sp.semantic_checks(doc, args, errors, warnings)
        for w in warnings:
            print("  WARN %s" % w)
        if errors and not args.allow_invalid:
            for e in errors[:10]:
                print("  ERROR %s" % e)
            print("\n校验失败，未写回参数文件（修画布或加 --allow-invalid）")
            return 2
        bak = args.file + ".before-pull-%s" % time.strftime("%Y%m%d-%H%M%S")
        shutil.copyfile(args.file, bak)
        sp.dump_json(args.file, doc)
        print("\n已写回参数：%s（备份 %s）" % (args.file, os.path.basename(bak)))
        print("下一步：python 工具/shot_params.py validate --file \"%s\"" % args.file)
    else:
        print("\n检测到 %d 镜差异；加 --apply 才会写回参数文件" % len(changed))
    return 0


# ---------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="画布运镜联动（镜头参数.json ⇄ 画布 out:K##.camera）")
    ap.add_argument("mode", choices=["check", "push", "pull"])
    ap.add_argument("--canvas-url", default="http://127.0.0.1:17800")
    ap.add_argument("--file", default="")
    ap.add_argument("--project", default="")
    ap.add_argument("--board", default="")
    ap.add_argument("--no-http", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--allow-invalid", action="store_true")
    ap.add_argument("--default-px", type=float, default=180.0)
    ap.add_argument("--schema", default="")
    ap.add_argument("--check-files", action="store_true")
    args = ap.parse_args(argv)

    args.file = args.file or os.path.join(PROJ, "分析", "镜头参数.json")
    if not os.path.exists(args.file):
        alt = os.path.join(PROJ, "人物替换_NIGHTDANCER", "分析", "宗门新功法", "镜头参数.json")
        if os.path.exists(alt):
            args.file = alt
    if not os.path.exists(args.file):
        raise SystemExit("找不到镜头参数文件，用 --file 指定")
    args.root = os.path.dirname(os.path.dirname(os.path.abspath(args.file)))
    if not os.path.isdir(os.path.join(args.root, "_canvas")) and not args.project:
        args.project = PROJ
    if not args.project:
        p = os.path.dirname(os.path.abspath(args.file))
        while p and p != os.path.dirname(p):
            if os.path.isdir(os.path.join(p, "_canvas", "boards")):
                args.project = p
                break
            p = os.path.dirname(p)

    doc = sp.load_json(args.file)
    print("参数文件：%s（%d 镜）" % (args.file, len(doc["shots"])))
    board = open_board(args)
    print(board.board_label())
    if args.mode == "check":
        return cmd_check(args, doc, board)
    if args.mode == "push":
        return cmd_push(args, doc, board)
    return cmd_pull(args, doc, board)


if __name__ == "__main__":
    sys.exit(main())
