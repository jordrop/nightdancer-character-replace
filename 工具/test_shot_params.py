"""镜头参数表回归测试（无第三方依赖）

运行：
  python 工具/test_shot_params.py

覆盖：
  1) 宗门新功法：build → schema 校验 + 语义校验 全绿
  2) NIGHTDANCER 旧数据（[list] 镜头分组 + 运镜位移 + 人工运镜覆盖）→ 编译参数与
     render_pipeline.py 里现行 MOTION 字典完全一致（迁移不回归）
  3) compile：18 个 pan job + 2 个 static，index.json 结构正确
"""
import json
import os
import shutil
import tempfile

import shot_params as sp

PROJ = sp.PROJ
ROOT = sp.ROOT_DEFAULT
SHOTDIR = sp.SHOTDIR_DEFAULT

# render_pipeline.py 里现行的手写运镜表（迁移基准，不得改变）
LEGACY_MOTION = {
    "K01": ("y", +1, 380), "K02": ("x", -1, 180), "K03": None,
    "K04": ("y", +1, 180), "K05": ("x", +1, 180), "K06": ("y", -1, 180),
    "K07": ("x", +1, 180), "K08": ("x", -1, 180), "K09": None,
    "K10": ("x", +1, 180), "K11": None,
}


def _build_args(**kw):
    class A:
        pass
    a = A()
    a.root = kw.get("root", ROOT)
    a.group = kw.get("group", os.path.join(SHOTDIR, "镜头分组.json"))
    a.motion = kw.get("motion", os.path.join(SHOTDIR, "运镜位移.json"))
    a.overrides = kw.get("overrides", "")
    a.out = kw["out"]
    a.fps = kw.get("fps", 0)
    a.width = kw.get("width", 0)
    a.height = kw.get("height", 0)
    a.duration = kw.get("duration", 0)
    a.source = kw.get("source", "")
    return a


def _validate_args(file_path, check_files=False):
    class A:
        pass
    a = A()
    a.file = file_path
    a.schema = sp.SCHEMA_DEFAULT
    a.root = ROOT
    a.check_files = check_files
    return a


def test_宗门新功法_build_validate():
    tmp = tempfile.mkdtemp(prefix="shotparams_")
    try:
        out = os.path.join(tmp, "镜头参数.json")
        doc = sp.build(_build_args(out=out))
        assert len(doc["shots"]) == 20, len(doc["shots"])
        assert sum(1 for s in doc["shots"] if s["camera"]["mode"] == "pan") == 18
        assert doc["width"] == 1920 and doc["height"] == 960 and doc["fps"] == 30.0
        schema = sp.load_json(sp.SCHEMA_DEFAULT)
        errors, warnings = [], []
        sp.validate_schema(doc, schema, schema, "$", errors)
        assert not errors, errors
        sp.semantic_checks(doc, _validate_args(out), errors, warnings)
        assert not errors, errors
        # 抽样核对方向：内容右移 → 相机 sign=-1；内容下移 → sign=-1（相机上摇）
        by = {s["key"]: s for s in doc["shots"]}
        assert by["K01"]["camera"]["axis"] == "x" and by["K01"]["camera"]["sign"] == -1
        assert by["K08"]["camera"]["axis"] == "y" and by["K08"]["camera"]["sign"] == -1
        assert by["K12"]["camera"]["axis"] == "y" and by["K12"]["camera"]["sign"] == 1
        assert by["K11"]["camera"]["mode"] == "static"
        print("PASS 宗门新功法 build+validate（20 镜 / 18 pan / 2 static）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_nightdancer_legacy_兼容():
    tmp = tempfile.mkdtemp(prefix="shotparams_legacy_")
    try:
        overrides = {k: ({"mode": "static"} if v is None else {"axis": v[0], "sign": v[1], "px": v[2]})
                     for k, v in LEGACY_MOTION.items()}
        ov = os.path.join(tmp, "overrides.json")
        with open(ov, "w", encoding="utf-8") as f:
            json.dump(overrides, f, ensure_ascii=False)
        out = os.path.join(tmp, "镜头参数.json")
        doc = sp.build(_build_args(
            root=PROJ,
            group=os.path.join(PROJ, "分析", "镜头分组.json"),
            motion=os.path.join(PROJ, "分析", "运镜位移.json"),
            overrides=ov, out=out, duration=91.0, width=1920, height=1080,
            source="素材/源视频.mp4"))
        assert len(doc["shots"]) == 11
        for shot in doc["shots"]:
            cam = shot["camera"]
            want = LEGACY_MOTION[shot["key"]]
            if want is None:
                assert cam["mode"] == "static", (shot["key"], cam)
            else:
                assert cam["mode"] == "pan", (shot["key"], cam)
                assert (cam["axis"], cam["sign"], int(cam["px"])) == want, (shot["key"], cam, want)
            dur = shot["end"] - shot["start"]
            assert shot["frames"] == int(round(dur * 30)), (shot["key"], shot["frames"], dur)
        schema = sp.load_json(sp.SCHEMA_DEFAULT)
        errors, warnings = [], []
        sp.validate_schema(doc, schema, schema, "$", errors)
        sp.semantic_checks(doc, _validate_args(out), errors, warnings)
        assert not errors, errors
        print("PASS NIGHTDANCER 旧数据兼容（11 镜，与 render_pipeline.MOTION 逐镜一致）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_compile():
    tmp = tempfile.mkdtemp(prefix="shotparams_jobs_")
    try:
        params = os.path.join(SHOTDIR, "镜头参数.json")
        assert os.path.exists(params), "先跑 build 生成 镜头参数.json"

        class A:
            pass
        a = A()
        a.file = params
        a.root = ROOT
        a.images = os.path.join(SHOTDIR, "帧")
        a.suffix = ""
        a.jobs_out = os.path.join(tmp, "jobs")
        a.allow_missing = False
        rc = sp.compile_jobs(a)
        assert rc == 0, rc
        idx = sp.load_json(os.path.join(a.jobs_out, "index.json"))
        assert len(idx["jobs"]) == 18, len(idx["jobs"])
        assert len(idx["static"]) == 2, len(idx["static"])
        job = sp.load_json(os.path.join(a.jobs_out, "K01.json"))
        assert job["frames"] == 45 and job["axis"] == "x" and job["sign"] == -1 and job["px"] == 220
        assert job["x_px"] == -220 and job["y_px"] == 0
        assert job["res"] == [1920, 960]
        # 斜向镜头：K02 内容 (+80,+40) → 相机 (-80,-40)，双轴参数都要带上
        job2 = sp.load_json(os.path.join(a.jobs_out, "K02.json"))
        assert (job2["x_px"], job2["y_px"]) == (-80, -40), job2
        print("PASS compile（18 job + 2 static，K01=45帧 x -1/220，K02 双轴 -80/-40）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_render_pipeline_参数接入():
    """render_pipeline 能读 镜头参数.json（与 MOTION 等价），缺文件时回退。"""
    import render_pipeline as rp

    root_params = os.path.join(PROJ, "分析", "镜头参数.json")
    assert os.path.exists(root_params), "先跑 build 生成 分析/镜头参数.json"
    motion, frames, info = rp.load_shot_params(root_params)
    assert info and info["shots"] == 11, info
    for key, want in LEGACY_MOTION.items():
        got = motion[key]
        if want is None:
            assert got is None, (key, got)
            continue
        axis, sign, px = want
        travel = (sign * px, 0) if axis == "x" else (0, sign * px)
        assert (got[0], got[1], got[2]) == want, (key, got, want)
        assert (got[3], got[4]) == travel, (key, got, travel)
    durations = rp.load_shot_durations()
    for key in motion:
        if motion[key]:
            assert frames[key] == int(round(durations[key] * rp.FPS)), (key, frames[key], durations[key])

    # 缺文件 → 回退
    assert rp.load_shot_params(os.path.join(PROJ, "分析", "不存在.json")) == (None, None, None)

    # plan_jobs：参数路径与 MOTION 路径产出的作业一致
    tmp = tempfile.mkdtemp(prefix="shotparams_plan_")
    try:
        v7 = os.path.join(tmp, "关键帧_替换_v7")
        os.makedirs(v7)
        for key, want in LEGACY_MOTION.items():
            if want:
                open(os.path.join(v7, key + "_v7.png"), "wb").close()
        out_params = os.path.join(tmp, "jobs_params")
        out_legacy = os.path.join(tmp, "jobs_legacy")
        jobs_p = rp.plan_jobs(motion, frames, durations, v7dir=v7, outbase=out_params)
        jobs_l = rp.plan_jobs(rp.MOTION, {}, durations, v7dir=v7, outbase=out_legacy)
        assert len(jobs_p) == len(jobs_l) == 8, (len(jobs_p), len(jobs_l))
        for (k1, f1), (k2, f2) in zip(jobs_p, jobs_l):
            j1, j2 = sp.load_json(f1), sp.load_json(f2)
            assert k1 == k2
            assert j1["frames"] == j2["frames"], (k1, j1["frames"], j2["frames"])
            assert (j1["x_px"], j1["y_px"]) == (j2["x_px"], j2["y_px"]), (k1, j1, j2)
        j01 = sp.load_json(jobs_p[0][1])
        assert j01["name"] == "K01" and j01["y_px"] == 380 and j01["frames"] == 240
        # save_blend_dir：给 PopNow for Blender 导出场景用
        blend_dir = os.path.join(tmp, "blends")
        jobs_b = rp.plan_jobs(motion, frames, durations, v7dir=v7,
                              outbase=os.path.join(tmp, "jobs_blend"), save_blend_dir=blend_dir)
        jb = sp.load_json(jobs_b[0][1])
        assert jb["save_blend"] == os.path.join(blend_dir, "K01.blend"), jb.get("save_blend")
        print("PASS render_pipeline 参数接入（11 镜等价 MOTION，plan_jobs 8 作业一致）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_画布运镜映射():
    """画布 ⇄ 参数 的纯函数映射（不需要 canvas 服务）"""
    import sync_motion_board as smb
    cases = {"从上往下": ("y", 1), "从下往上": ("y", -1), "从左往右": ("x", 1), "从右往左": ("x", -1)}
    for text, (axis, sign) in cases.items():
        r = smb.parse_motion_text(text)
        assert r == {"mode": "pan", "axis": axis, "sign": sign}, (text, r)
    assert smb.parse_motion_text("不动")["mode"] == "static"
    assert smb.parse_motion_text("不动（原片为3张图构成的动作）")["mode"] == "static"
    r = smb.parse_motion_text("内容右移（相机左摇）")
    assert (r["axis"], r["sign"]) == ("x", -1), r
    doc = sp.load_json(os.path.join(PROJ, "分析", "镜头参数.json"))
    k01 = [s for s in doc["shots"] if s["key"] == "K01"][0]
    cam = smb.camera_of_shot(k01)
    assert (cam["axis"], cam["sign"], cam["px"], cam["y_px"]) == ("y", 1, 380, 380), cam
    assert smb.motion_camera_of(cam).startswith("相机下移")
    card = {"key": "out:K01", "motion": "从上往下",
            "camera": {"mode": "pan", "axis": "y", "sign": 1, "px": 380, "x_px": 0, "y_px": 380}}
    assert smb.card_camera_matches(card["camera"], cam)
    ov = smb.card_to_override(card, k01)
    assert ov == {"mode": "pan", "axis": "y", "sign": 1, "px": 380.0}, ov
    assert smb.card_to_override({"motion": "不动"}, k01) == {"mode": "static"}
    print("PASS 画布运镜映射（文本→方向 / 参数→卡片 / 卡片→覆盖）")


if __name__ == "__main__":
    test_宗门新功法_build_validate()
    test_nightdancer_legacy_兼容()
    test_compile()
    test_render_pipeline_参数接入()
    test_画布运镜映射()
    print("ALL TESTS PASSED")
