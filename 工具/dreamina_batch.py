# -*- coding: utf-8 -*-
"""即梦批量并发出图/出片工具（CLI 异步模式）。

核心思路：
  1) 提交阶段：所有任务用 `--poll=0` 只提交，拿到 submit_id；提交可并发（默认 2，避免 SQLite 写锁）。
  2) 轮询阶段：多个线程并发 `query_result --submit_id`，谁先完成谁先下载，互不阻塞。
  3) 续跑：manifest.json 记录每个任务状态，重跑时跳过已完成。

用法：
  python 工具/dreamina_batch.py --spec 批次.json --out-dir 参考上传/xxx
  可选：--submit-workers 2 --poll-workers 6 --poll-interval 3 --max-wait 1800
        --resume （跳过 manifest 里已成功的任务）
        --self-test（不调用 API，验证并发编排）

批次 JSON 格式：
{
  "defaults": {"model_version":"5.0", "ratio":"16:9", "resolution_type":"2k", "generate_num":1},
  "jobs": [
    {"name":"K_U20", "mode":"image2image", "refs":["a.png","b.png"], "prompt":"..."},
    {"name":"P6",    "mode":"text2image", "prompt":"..."}
  ]
}
mode: text2image | image2image | image2video（视频并发通常=1，并发收益小；仍支持）
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

EXE = os.environ.get("DREAMINA_EXE", r"C:\Users\Administrator\bin\dreamina.exe")
PRINT_LOCK = threading.Lock()


def log(*a):
    with PRINT_LOCK:
        print(*a, flush=True)


def run_cli(args, timeout=300):
    p = subprocess.run([EXE] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    txt = (p.stdout or "") + "\n" + (p.stderr or "")
    i, j = txt.find("{"), txt.rfind("}")
    data = {}
    if i >= 0 and j > i:
        try:
            data = json.loads(txt[i:j + 1])
        except Exception:
            data = {"_raw": txt[-1500:]}
    else:
        data = {"_raw": txt[-1500:]}
    return data, txt


def submit_one(job, defaults, out_dir):
    mode = job.get("mode", "text2image")
    d = {**defaults, **{k: v for k, v in job.items() if k not in ("name", "mode", "refs", "prompt", "out")}}
    ratio = d.pop("ratio", "16:9")
    res = d.pop("resolution_type", "2k")
    model = d.pop("model_version", "5.0")
    num = str(d.pop("generate_num", 1))
    duration = d.pop("duration", None)
    vres = d.pop("video_resolution", None)

    if mode == "text2image":
        args = ["text2image", "--prompt", job["prompt"], "--ratio", ratio,
                "--resolution_type", res, "--model_version", model,
                "--generate_num", num, "--poll", "0"]
    elif mode == "image2image":
        args = ["image2image", "--images", ",".join(job["refs"]), "--prompt", job["prompt"],
                "--ratio", ratio, "--resolution_type", res, "--model_version", model,
                "--generate_num", num, "--poll", "0"]
    elif mode == "image2video":
        args = ["image2video", "--image", job["refs"][0], "--prompt", job["prompt"],
                "--duration", str(duration or 5), "--video_resolution", vres or "720p",
                "--model_version", model, "--poll", "0"]
    else:
        raise ValueError("unknown mode: " + mode)

    for attempt in range(1, 5):
        try:
            data, raw = run_cli(args)
        except subprocess.TimeoutExpired:
            data, raw = {"fail_reason": "cli timeout"}, ""
        if data.get("submit_id"):
            return {"name": job["name"], "mode": mode, "submit_id": data["submit_id"],
                    "status": "submitted", "credit_count": data.get("credit_count"),
                    "submit_attempts": attempt, "raw_err": ""}
        err = str(data.get("fail_reason") or data.get("_raw") or raw)[-300:]
        # 并发超限 / SQLite 锁 / 网络抖动：退避重试
        if any(k in err for k in ("ExceedConcurrencyLimit", "database is locked", "timeout", "EOF")):
            time.sleep(min(30, 2 ** attempt) + random.random())
            continue
        return {"name": job["name"], "mode": mode, "status": "fail", "fail_reason": err}
    return {"name": job["name"], "mode": mode, "status": "fail", "fail_reason": "submit retries exhausted"}


def download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(path, "wb") as f:
        f.write(r.read())


def poll_one(rec, out_dir, stop_evt):
    sid = rec["submit_id"]
    t0 = time.time()
    while not stop_evt.is_set():
        try:
            data, _ = run_cli(["query_result", "--submit_id", sid], timeout=120)
        except subprocess.TimeoutExpired:
            time.sleep(3)
            continue
        st = data.get("gen_status")
        if st == "success":
            urls = []
            rj = data.get("result_json") or {}
            for it in (rj.get("images") or []):
                if it.get("image_url"):
                    urls.append(it["image_url"])
            for it in (rj.get("videos") or []):
                if it.get("video_url"):
                    urls.append(it["video_url"])
            files = []
            for k, u in enumerate(urls):
                ext = ".mp4" if ".mp4" in u.lower() else ".png"
                fn = rec["name"] + ("" if k == 0 else "_%d" % k) + ext
                p = os.path.join(out_dir, fn)
                try:
                    download(u, p)
                    files.append(p)
                except Exception as e:
                    rec["fail_reason"] = "download: %s" % e
            rec.update(status="success", files=files, credit_count=data.get("credit_count"),
                       poll_sec=round(time.time() - t0, 1), result_json=data.get("result_json"))
            return rec
        if st == "fail":
            rec.update(status="fail", fail_reason=data.get("fail_reason", ""),
                       credit_count=data.get("credit_count"), poll_sec=round(time.time() - t0, 1))
            return rec
        time.sleep(3)
    rec.update(status="timeout", poll_sec=round(time.time() - t0, 1))
    return rec


def self_test(workdir):
    """不调用 API：模拟提交/轮询/下载，验证并发编排。"""
    os.makedirs(workdir, exist_ok=True)
    jobs = [{"name": "T%d" % i, "mode": "text2image", "prompt": "x"} for i in range(8)]
    recs = []
    for i, j in enumerate(jobs):
        recs.append({"name": j["name"], "mode": "text2image", "submit_id": "fake-%d" % i,
                     "status": "submitted", "credit_count": 3})
    stop = threading.Event()

    def fake_poll(rec):
        time.sleep(0.3 + random.random() * 0.7)
        p = os.path.join(workdir, rec["name"] + ".png")
        open(p, "wb").write(b"\x89PNG\r\n\x1a\nfake")
        rec.update(status="success", files=[p], credit_count=3, poll_sec=0.5)
        return rec

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(fake_poll, r) for r in recs]
        for f in as_completed(futs):
            f.result()
    print("SELF_TEST ok: %d tasks in %.2fs -> %s" % (len(recs), time.time() - t0, workdir))
    return all(r["status"] == "success" for r in recs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", help="批次 JSON 路径")
    ap.add_argument("--out-dir", default="参考上传/批量出图")
    ap.add_argument("--submit-workers", type=int, default=2)
    ap.add_argument("--poll-workers", type=int, default=6)
    ap.add_argument("--poll-interval", type=float, default=3.0)
    ap.add_argument("--max-wait", type=int, default=1800)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(0 if self_test(os.path.join(args.out_dir, "_selftest")) else 1)

    spec = json.load(open(args.spec, encoding="utf-8"))
    defaults = spec.get("defaults", {})
    jobs = spec["jobs"]
    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, "_manifest.json")
    manifest = {"spec": args.spec, "out_dir": out_dir, "started": time.strftime("%Y-%m-%d %H:%M:%S"),
                "records": []}
    if args.resume and os.path.exists(manifest_path):
        old = json.load(open(manifest_path, encoding="utf-8"))
        manifest["records"] = old.get("records", [])
    done = {r["name"] for r in manifest["records"] if r.get("status") == "success"}

    t_wall = time.time()
    # 1) 提交
    t_sub = time.time()
    recs = []
    pending = [j for j in jobs if j["name"] not in done]
    with ThreadPoolExecutor(max_workers=max(1, args.submit_workers)) as ex:
        futs = {ex.submit(submit_one, j, defaults, out_dir): j for j in pending}
        for f in as_completed(futs):
            r = f.result()
            recs.append(r)
            log("SUBMIT", r["name"], r["status"], r.get("submit_id", ""), r.get("fail_reason", ""))
    submit_sec = time.time() - t_sub
    good = [r for r in recs if r["status"] == "submitted"]
    log("SUBMIT_DONE %d/%d in %.1fs" % (len(good), len(recs), submit_sec))

    # 2) 并发轮询
    t_poll = time.time()
    stop = threading.Event()
    with ThreadPoolExecutor(max_workers=max(1, args.poll_workers)) as ex:
        futs = [ex.submit(poll_one, r, out_dir, stop) for r in good]
        try:
            for f in as_completed(futs, timeout=args.max_wait):
                r = f.result()
                log("POLL", r["name"], r["status"], "credit=", r.get("credit_count"), "files=",
                    [os.path.basename(x) for x in r.get("files", [])])
        except Exception as e:
            stop.set()
            log("POLL_TIMEOUT/ERR", e)
    poll_sec = time.time() - t_poll

    manifest["records"].extend(recs)
    manifest["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    manifest["submit_sec"] = round(submit_sec, 1)
    manifest["poll_sec"] = round(poll_sec, 1)
    manifest["wall_sec"] = round(time.time() - t_wall, 1)
    manifest["ok"] = sum(1 for r in recs if r.get("status") == "success")
    manifest["fail"] = sum(1 for r in recs if r.get("status") == "fail")
    manifest["credits"] = sum(int(r.get("credit_count") or 0) for r in recs if r.get("status") == "success")
    json.dump(manifest, open(manifest_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("SUMMARY", json.dumps({k: manifest[k] for k in ("ok", "fail", "submit_sec", "poll_sec", "wall_sec", "credits")},
                                ensure_ascii=False))
    print("MANIFEST", manifest_path)


if __name__ == "__main__":
    main()
