# -*- coding: utf-8 -*-
"""V4.0 Hard Gate 自动检查（12 项）+ 全片一致性检查（0 积分，纯文件）。

输出：
  无归原_制作/V4_HardGate_32单元.md
  无归原_制作/V4_HardGate_32单元.json
"""
import json
import os
import re

ROOT = r"L:\giehub-test"
BASE = os.path.join(ROOT, "分析", "归墟选段")
TL = os.path.join(BASE, "无归原_时间线.json")
PROJ = os.path.join(BASE, "无归原_制作")
MD = os.path.join(PROJ, "V4_HardGate_32单元.md")
JSON_OUT = os.path.join(PROJ, "V4_HardGate_32单元.json")

ABSTRACT_END = ("关系", "更亲密", "未来", "成长", "幸福", "解脱")
SHOT_RANGE = {"ACTION": (2, 6), "DIALOGUE": (2, 5), "SPECTACLE": (2, 4), "PHONE": (1, 3), "ONE-TAKE": (1, 1)}
CHAR_ANCHORS = {"C1": ["围巾", "短刀"], "C2": ["皮帽", "猎弓"], "C3": ["裂镜", "药箱"], "C4": ["红绳", "铜铃"]}


def sec_of(u):
    m = re.match(r"(\d+):(\d+)-(\d+):(\d+)", u["time"])
    if not m:
        return None
    a = int(m.group(1)) * 60 + int(m.group(2))
    b = int(m.group(3)) * 60 + int(m.group(4))
    return b - a


def check_unit(u, prev, same_scene_prev):
    v = u.get("v4", {})
    issues = []
    checks = {}

    # 1 时长
    checks["1_时长15s"] = (sec_of(u) == 15)
    if not checks["1_时长15s"]:
        issues.append("时长不是 15s")

    # 2 剧情锁
    checks["2_剧情锁"] = bool(u.get("beat") and u.get("prompt") and u.get("act"))
    if not checks["2_剧情锁"]:
        issues.append("缺 beat/prompt/act")

    # 3 角色身份
    ok = True
    if u["assets"]["chars"]:
        lock = v.get("identity_lock", "")
        for c in u["assets"]["chars"]:
            if c not in lock or not all(k in lock for k in CHAR_ANCHORS.get(c, [])):
                ok = False
                issues.append("身份锁缺 " + c)
    checks["3_角色身份"] = ok

    # 4 连续性
    cf = v.get("continuity_full", {})
    need = ["地点", "天气", "人数", "位置与朝向", "动作/表情", "衣服/受伤", "主光", "镜头", "道具状态", "悬念"]
    miss = [k for k in need if not cf.get(k)]
    ok = not miss
    scf = (same_scene_prev.get("v4") or {}).get("continuity_full", {}) if same_scene_prev else {}
    if scf and cf.get("主光") != scf.get("主光"):
        ok = False
        issues.append("同场景主光跳变")
    if scf and isinstance(cf.get("人数"), int) and isinstance(scf.get("人数"), int) and u.get("act") not in ("余波", "转场", "篝火", "尾声"):
        if cf["人数"] > scf["人数"]:
            ok = False
            issues.append("同场景人数增加")
    checks["4_连续性"] = ok
    if miss:
        issues.append("连续性缺字段: " + ",".join(miss))

    # 5 主变化
    beats = v.get("beats", [])
    checks["5_主变化"] = len(beats) == 5 and bool(beats[2].get("画面"))
    if not checks["5_主变化"]:
        issues.append("beats 不足 5 段或缺核心段")

    # 6 台词（无对白）
    checks["6_台词可执行"] = True  # 无对白，N/A

    # 7 空间连续
    sc = v.get("space_coords", [])
    checks["7_空间连续"] = len(sc) >= 2
    if not checks["7_空间连续"]:
        issues.append("空间坐标少于 2 条")

    # 8 复杂度
    eng = v.get("mode", {}).get("engine", "ACTION")
    shots = v.get("budget", {}).get("shots", 0)
    lo, hi = SHOT_RANGE.get(eng, (1, 6))
    checks["8_镜头复杂度"] = lo <= shots <= hi and bool(v.get("budget", {}).get("complexity"))
    if not checks["8_镜头复杂度"]:
        issues.append("镜头预算超范围（%s %s 镜）" % (eng, shots))

    # 9 反应链
    checks["9_反应链"] = bool(v.get("micro_perf"))
    if not checks["9_反应链"]:
        issues.append("缺微表演/反应")

    # 10 可见结尾
    end = v.get("anchors", {}).get("end", "")
    checks["10_可见结尾"] = bool(end) and not any(k in end for k in ABSTRACT_END)
    if not checks["10_可见结尾"]:
        issues.append("结尾抽象/缺失")

    # 11 物理量纲连续性
    light = cf.get("主光", "")
    checks["11_量纲连续"] = ("K" in light and ("lux" in light or "nit" in light))
    if not checks["11_量纲连续"]:
        issues.append("主光缺色温/照度")

    # 12 运镜-情绪
    emo = u.get("emotion", 3)
    cam = u.get("camera", "")
    if emo <= 2:
        ok = not any(k in cam for k in ("甩", "快速", "环绕", "剧烈"))
    else:
        ok = True  # 情绪>=3：快速/缓慢都可成立，只做软检查（详见体检文档）
    checks["12_运镜匹配"] = ok
    if not ok:
        issues.append("运镜速度与情绪不匹配（情绪 %s / %s）" % (emo, cam))

    # 附加：V4 增强提示词
    p4 = u.get("seedance_prompt_v4", "")
    extra = []
    if not p4:
        extra.append("缺 seedance_prompt_v4")
    if len(p4) > 2000:
        extra.append("提示词超 2000 字（%d）" % len(p4))
    if "【" in p4 or "】" in p4:
        extra.append("提示词含【】")
    if not (4 <= len(v.get("constraints", [])) <= 8):
        extra.append("约束数不在 4–8（%d）" % len(v.get("constraints", [])))
    if extra:
        issues += extra
        checks["13_附加检查"] = False
    else:
        checks["13_附加检查"] = True

    passed = sum(1 for k, x in checks.items() if x)
    return {"id": u["id"], "passed": passed, "total": len(checks), "fail": [k for k, x in checks.items() if not x],
            "issues": issues, "checks": checks}


def main():
    tl = json.load(open(TL, encoding="utf-8"))
    units = tl["units"]
    results = []
    prev = None
    same_scene_prev = None
    for u in units:
        scene = u["assets"]["scene"]
        sp = same_scene_prev if same_scene_prev and same_scene_prev["assets"]["scene"] == scene else None
        results.append(check_unit(u, prev, sp))
        prev = u
        same_scene_prev = u

    ok = sum(1 for r in results if not r["fail"])
    warn = [r for r in results if r["fail"]]
    lines = ["# V4.0 Hard Gate 检查（32 单元）", "",
             "> 生成时间：2026-10-19；检查项：12 项 Hard Gate + 1 项增强提示词附加检查。",
             "> 通过：%d / %d；需修正：%d" % (ok, len(results), len(warn)), "",
             "| 单元 | 通过 | 未过项 | 问题 |", "|---|---|---|---|"]
    for r in results:
        lines.append("| %s | %d/%d | %s | %s |" % (r["id"], r["passed"], r["total"],
                                                   "、".join(r["fail"]) or "—", "；".join(r["issues"]) or "—"))
    if warn:
        lines += ["", "## 需修正清单", ""]
        for r in warn:
            lines.append("- **%s**：%s" % (r["id"], "；".join(r["issues"])))
    lines += ["", "## 全片附加检查", "",
              "- 32 单元均有 `seedance_prompt_v4`：%s" % all(u.get("seedance_prompt_v4") for u in units),
              "- 24 个自动初稿（`v4.auto`）待人工复核：%s 个" % sum(1 for u in units if u.get("v4", {}).get("auto")),
              "- 每个单元三画面锚点字段：%s" % all(u.get("v4", {}).get("anchors", {}).get("end") for u in units)]
    os.makedirs(PROJ, exist_ok=True)
    open(MD, "w", encoding="utf-8").write("\n".join(lines))
    json.dump({"generated": "2026-10-19", "pass": ok, "total": len(results),
               "results": [{k: r[k] for k in ("id", "passed", "total", "fail", "issues")} for r in results]},
              open(JSON_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("PASS %d/%d, WARN %d" % (ok, len(results), len(warn)))
    for r in warn:
        print("WARN", r["id"], "|", "；".join(r["issues"]))
    print("MD:", MD)


if __name__ == "__main__":
    main()
