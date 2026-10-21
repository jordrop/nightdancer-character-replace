# -*- coding: utf-8 -*-
"""V4.0 字段补全 + 增强版提示词生成（0 积分，纯文件）。

给每个单元补：
  v4.identity_lock   角色/道具锚点锁定
  v4.constraints     4–8 条针对性约束
  v4.micro_perf      1 个可见微表演
  v4.space_coords    2–5 条空间坐标
  v4.continuity_full 10 项续接锚点
  seedance_prompt_v4 拼好的 V4.0 增强版提示词（保留原 seedance_prompt 不变）

输出：
  无归原_时间线.json（原地更新新增字段）
  07_视频生成/V4增强版提示词_全32单元.md
"""
import json
import os

ROOT = r"L:\giehub-test"
BASE = os.path.join(ROOT, "分析", "归墟选段")
TL = os.path.join(BASE, "无归原_时间线.json")
MD = os.path.join(BASE, "无归原_制作", "07_视频生成", "V4增强版提示词_全32单元.md")

CHARS = {
    "C1": "沈雾：黑短发束起、左眉旧疤、灰蓝围巾、深灰棉甲、左腰短刀",
    "C2": "赵岩：高个、旧皮帽、粗辫、猎弓、右手缺半指",
    "C3": "顾青：圆框裂镜、白口罩挂耳、旧药箱",
    "C4": "阿荞：双辫红绳、过长灰棉袄、腰间旧铜铃",
}
PROPS = {
    "P1": "铜铃：旧铜铃，凹痕与冰霜，挂石堆/阿荞腰间",
    "P2": "火种罐：旧铁皮罐，罐口灼痕，内里一点微火",
    "P3": "短刀：旧短刀，刀鞘缠粗布",
    "P4": "药箱：旧木药箱，铜扣生锈",
    "P5": "红绳绑带：旧布绑带，边缘起毛、有雪水痕",
}
SCENE_COORDS = {
    "S1": ["人物在画面下沿约 1/3，山脊占上方约 2/3", "队伍在中轴偏左，向右上方移动", "冷白主光来自左前上方"],
    "S2": ["雪墙占画面对角线，人影在左下", "固定远摄压缩空间", "冷白顶光，雪雾漫射"],
    "S3": ["前景枯草占画面下约 1/4，泥沼在中景", "人物在中轴，低机位贴地", "阴天漫射，无直射光"],
    "S4": ["篝火在画面中央偏下，三人围成半圆", "C1 在左、C4 在右、C3 居中（可微调）", "唯一暖光来自火堆底部，环境冷光"],
    "S5": ["三人背影在画面下沿约 1/3，灯火在远处中景", "人物在中轴偏右，向灯火方向走", "冷白天光为主，暖灯只是点光"],
}
SCENE_WEATHER = {"S1": "暴雪前", "S2": "雪崩", "S3": "阴天低雾", "S4": "夜/低雾", "S5": "薄雾"}
SCENE_LIGHT = {"S1": "6500K / 2500lux", "S2": "6500K / 5000lux", "S3": "5600K / 800lux",
               "S4": "1800K 火光 / 6000K 环境 / 100lux", "S5": "3200K / 200lux"}
SCENE_PEOPLE = {"S1": 5, "S2": 5, "S3": 4, "S4": 3, "S5": 3}


def pick_micro(u):
    b = u["beat"] + u["prompt"]
    if any(k in b for k in ("陷", "滑", "跌", "坠")):
        return "手指抓紧草皮/脚趾抓地，短促吸气，肩膀绷紧"
    if any(k in b for k in ("篝火", "分食", "炒面", "马皮")):
        return "吞咽一次，手指捏紧炒面/碗沿，视线短暂避开"
    if any(k in b for k in ("默哀", "牺牲", "清点")):
        return "肩膀内收，下颌绷紧，呼吸变浅后再缓缓呼出"
    if any(k in b for k in ("雾", "巨影", "低语")):
        return "脚步停住、后退半步，呼吸变浅，视线锁定雾中"
    if any(k in b for k in ("归途", "灯火", "背影")):
        return "脚步放缓，一只手摸向腰间铜铃，肩膀放松半寸"
    if any(k in b for k in ("雪崩", "雪墙", "奔跑")):
        return "瞳孔收紧、呼吸急促，手脚并用向前"
    return "呼吸变浅，视线停留 1–2 秒后移开"


def build_constraints(u):
    out = ["同一角色只出现一次，不出现重复人物", "不换装、锚点可辨（围巾/皮帽/裂镜/红绳铜铃）",
           "道具不得与人物头部、身体或服饰相交", "无文字、无 logo、无水印",
           "全程无字幕、无对白文字叠加", "人物脸部与手指清晰、不穿模"]
    scene = u["assets"]["scene"]
    if scene == "S3":
        out.append("泥水只增不减，裤脚沾泥不自动恢复")
    elif scene == "S4":
        out.append("火光为唯一暖色，衣物湿/脸有灰不恢复")
    elif scene == "S5":
        out.append("不露正脸，灯火不熄灭")
    else:
        out.append("雪/伤状态不恢复，人数只减不增")
    if u.get("emotion", 3) >= 4:
        out.append("动作幅度与情绪匹配，不夸张表情")
    if u["assets"]["chars"]:
        out.append("人物左右关系与上一单元一致")
    else:
        out.append("人物只作剪影或局部，不出现清晰人脸")
    if u["assets"]["props"]:
        out.append("道具状态与上一单元连续（不新增、不消失）")
    return out[:8]


def space_coords(u):
    sc = SCENE_COORDS[u["assets"]["scene"]][:]
    if u["assets"]["chars"]:
        sc.append("人物之间保持可辨认的前后/左右关系")
    return sc[:5]


def continuity_full(u):
    sc = u["assets"]["scene"]
    chars = [CHARS[c].split("：")[0] for c in u["assets"]["chars"]]
    return {
        "地点": "%s %s" % (sc, {"S1": "灰岭山口", "S2": "雪坡雪崩", "S3": "无归原沼泽", "S4": "篝火营地", "S5": "南屿灯火"}[sc]),
        "天气": SCENE_WEATHER[sc],
        "人数": (len(chars) if chars else "无清晰人物（剪影/局部/环境）"),
        "位置与朝向": "；".join(space_coords(u)[:2]),
        "动作/表情": u["beat"],
        "衣服/受伤": ("泥污，裤脚湿" if sc in ("S3", "S5") else ("衣物湿、脸有灰" if sc == "S4" else "雪/伤状态保持")),
        "主光": SCENE_LIGHT[sc],
        "镜头": "%s（%s）" % (u["camera"], u["shot"]),
        "道具状态": "、".join(PROPS[p].split("：")[0] for p in u["assets"]["props"]) or "无",
        "悬念": (u.get("v4", {}).get("continuity", {}) or {}).get("悬念", "按下一单元承接"),
    }


def build_prompt_v4(u):
    v = u["v4"]
    chars = [CHARS[c] for c in u["assets"]["chars"]]
    props = [PROPS[p] for p in u["assets"]["props"]]
    identity = "；".join(chars) if chars else "无主要角色；人物只作剪影/局部"
    if props:
        identity += "；道具：" + "；".join(props)
    micro = v["micro_perf"]
    cons = "；".join(v["constraints"])
    cont = v["continuity_full"]
    cont_txt = "；".join("%s：%s" % (k, val) for k, val in cont.items())
    space = "；".join(v["space_coords"])
    return (
        "写实电影感，冷灰低饱和，15.0 秒连续镜头。"
        "画面/场景：%s。"
        "空间坐标：%s。"
        "角色身份锁：%s。"
        "动作与因果：%s；微表演：%s。"
        "运镜与摄影：%s（%s）。"
        "光照：%s。"
        "音效：<声音>%s</声音>。"
        "连续性：%s。"
        "生成约束：%s。"
    ) % (u["prompt"], space, identity, u["beat"], micro, u["camera"], u["shot"],
         cont["主光"], u.get("audio", "环境底噪"), cont_txt, cons)


def main():
    tl = json.load(open(TL, encoding="utf-8"))
    for u in tl["units"]:
        v = u.setdefault("v4", {"auto": True, "note": "自动补全"})
        v["identity_lock"] = ("；".join("%s %s" % (c, CHARS[c]) for c in u["assets"]["chars"]) or "无主要角色") + \
                             ("；道具：" + "；".join("%s %s" % (p2, PROPS[p2]) for p2 in u["assets"]["props"]) if u["assets"]["props"] else "")
        v["constraints"] = build_constraints(u)
        v["micro_perf"] = pick_micro(u)
        v["space_coords"] = space_coords(u)
        v["continuity_full"] = continuity_full(u)
        u["seedance_prompt_v4"] = build_prompt_v4(u)

    json.dump(tl, open(TL, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    lines = ["# 《无归原》V4.0 增强版提示词（全 32 单元）", "",
             "> 生成时间：2026-10-19；在原 `seedance_prompt` 基础上拼入身份锁/空间坐标/连续性/约束/微表演。",
             "> 全部为文件层草稿，**未提交任何生成任务**。", ""]
    for u in tl["units"]:
        lines += ["---", "", "## %s · %s（%s）" % (u["id"], u["beat"], u["time"]), "",
                  "**模式**：%s / %s / %s；**镜头预算**：%s 镜；**情绪**：%s" % (
                      u["v4"]["mode"]["shell"], u["v4"]["mode"]["engine"], u["v4"]["mode"]["time"],
                      u["v4"]["budget"]["shots"], u["emotion"]), "",
                  "### V4.0 增强版提示词", "", "```text", u["seedance_prompt_v4"], "```", "",
                  "### 三画面锚点", "- 开场：%s\n- 中间关键：%s\n- 结尾：%s" % (
                      u["v4"]["anchors"]["open"], u["v4"]["anchors"]["mid"], u["v4"]["anchors"]["end"]), "",
                  "### 空间坐标", "\n".join("- " + x for x in u["v4"]["space_coords"]), "",
                  "### 微表演", "- " + u["v4"]["micro_perf"], "",
                  "### 约束", "\n".join("- " + x for x in u["v4"]["constraints"]), ""]
    os.makedirs(os.path.dirname(MD), exist_ok=True)
    open(MD, "w", encoding="utf-8").write("\n".join(lines))
    print("UNITS:", len(tl["units"]), "| MD:", MD, os.path.getsize(MD), "bytes")
    print("SAMPLE U19:", tl["units"][18]["seedance_prompt_v4"][:500])


if __name__ == "__main__":
    main()
