#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理即梦 CLI 任务库里长期卡在 querying 的记录（画布「即梦生成进度」面板的数据源）。

背景
----
画布右侧「即梦生成进度」面板读的是 `dreamina list_task`，数据来自本机
`~/.dreamina_cli/tasks.db`（SQLite，表 aigc_task）。异步提交后如果轮询进程
中途退出了，任务行会永远停在 gen_status='querying'，即使云端队列早已 Finish。
这种「没收尾」的行会一直挂在面板里，越积越多。

本脚本做的事
------------
1. 读出所有 gen_status='querying' 的任务行；
2. 跳过太新的行（--min-age-min，默认 20 分钟，避免误杀正在跑的任务）；
3. 逐条执行只读的 `dreamina query_result --submit_id=...`（不扣积分、不下载）：
   - 云端已终态（success/fail）→ 写回 DB（CLI 自己已更新则跳过）；
   - 仍在排队（queue_status=Queueing / 剩余时间>0）→ 保留，不删；
   - 队列已 Finish 但状态还是 querying，且超过 --stale-hours（默认 6 小时）
     → 判定为僵死，从 DB 删除；
4. 写入前先用 sqlite backup API 做一致性快照（WAL 也包含在内），
   并把被删除的行导出为 JSON 存档，便于对账。

用法
----
    python 工具/clean_dreamina_stuck.py                  # dry-run，只报告
    python 工具/clean_dreamina_stuck.py --apply          # 实际清理
    python 工具/clean_dreamina_stuck.py --apply --keep-queued false

参数
----
    --apply             真的写库（默认 dry-run）
    --min-age-min N     新于 N 分钟的任务不处理（默认 20）
    --stale-hours N     队列已结束但状态仍 querying 超过 N 小时才删除（默认 6）
    --keep-queued       云端仍在排队的任务保留（默认 true）
    --db PATH           任务库路径（默认 ~/.dreamina_cli/tasks.db）
    --dreamina PATH     dreamina 可执行文件（默认 ~/bin/dreamina.exe）
    --backup-dir PATH   备份目录（默认 <仓库根>/_canvas/data/dreamina_task_backup）
    --skip-remote       不调用 query_result，只按本地时间判定（离线兜底）
"""

import argparse
import datetime
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def now_ts():
    return time.time()


def ts2str(v):
    try:
        return datetime.datetime.fromtimestamp(float(v)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(v)


def default_db():
    return os.environ.get("DREAMINA_DB") or os.path.join(
        os.path.expanduser("~"), ".dreamina_cli", "tasks.db")


def default_bin():
    if os.environ.get("DREAMINA_BIN"):
        return os.environ["DREAMINA_BIN"]
    exe = "dreamina.exe" if os.name == "nt" else "dreamina"
    p = os.path.join(os.path.expanduser("~"), "bin", exe)
    return p if os.path.exists(p) else exe


def connect(db_path, readonly=True):
    if readonly:
        uri = "file:%s?mode=ro" % db_path.replace("\\", "/")
        con = sqlite3.connect(uri, uri=True, timeout=30)
    else:
        con = sqlite3.connect(db_path, timeout=30)
        con.execute("PRAGMA busy_timeout=30000")
    con.row_factory = sqlite3.Row
    return con


def backup_db(db_path, backup_dir):
    """备份任务库。

    Python 3.6 的 sqlite3 没有 Connection.backup（3.7 才有），所以这里用
    「原始文件拷贝 + 全表逻辑导出」双保险：JSON dump 是权威快照，文件拷贝
    用于出问题时原样回退（WAL/SHM 一并复制）。
    """
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = os.path.join(backup_dir, "tasks.db.%s.bak" % stamp)
    shutil.copy2(db_path, dst)
    for suffix in ("-wal", "-shm"):
        p = db_path + suffix
        if os.path.exists(p):
            try:
                shutil.copy2(p, dst + suffix)
            except Exception:
                pass
    # 逻辑快照（含所有表）
    con = connect(db_path, readonly=True)
    try:
        dump = {}
        for (name,) in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall():
            try:
                dump[name] = [dict(r) for r in con.execute(
                    'SELECT * FROM "%s"' % name).fetchall()]
            except Exception as e:
                dump[name] = {"error": str(e)}
        with open(dst + ".dump.json", "w", encoding="utf-8") as f:
            json.dump(dump, f, ensure_ascii=False, default=str)
    finally:
        con.close()
    return dst


def run_query_result(bin_path, submit_id, timeout=90):
    """调用 dreamina query_result（只读、不扣分），返回 (ok, data, raw_err)。"""
    cmd = [bin_path, "query_result", "--submit_id=" + submit_id]
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             creationflags=0x08000000 if os.name == "nt" else 0)
    except Exception as e:
        return False, None, "spawn failed: %s" % e
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        return False, None, "timeout %ss" % timeout
    text = (out or b"").decode("utf-8", "replace").strip()
    errt = (err or b"").decode("utf-8", "replace").strip()
    i = min([x for x in (text.find("{"), text.find("[")) if x >= 0] or [-1])
    if i < 0:
        return False, None, (errt or text or "empty output")[:300]
    try:
        data = json.loads(text[i:])
    except Exception as e:
        return False, None, "json parse failed: %s | %s" % (e, text[:200])
    if isinstance(data, list):
        data = data[0] if data else {}
    return True, data, ""


def classify(data, age_sec, min_age_sec, stale_sec, keep_queued):
    """返回 (action, reason)。action ∈ final / keep / stale / skip。"""
    if not data:
        return "skip", "no remote data"
    if age_sec < min_age_sec:
        return "skip", "too new (%.1f min)" % (age_sec / 60.0)
    st = str(data.get("gen_status") or "")
    q = data.get("queue_info") or {}
    qs = str(q.get("queue_status") or "")
    remain = q.get("estimated_remaining_seconds")
    if st in ("success", "fail"):
        return "final", st
    if st == "querying" or st == "":
        still_working = (qs.lower() not in ("finish", "finished", "", "none")) or (
            isinstance(remain, (int, float)) and remain > 0)
        if still_working:
            if keep_queued:
                return "keep", "queue=%s remain=%s" % (qs or "?", remain)
            if age_sec < stale_sec:
                return "keep", "queue working but young"
        if age_sec >= stale_sec:
            return "stale", "queue=%s remain=%s age=%.1fh" % (qs or "?", remain, age_sec / 3600.0)
        return "skip", "young & not clearly stale"
    # 其他未知状态：超过 stale 阈值按僵死处理
    if age_sec >= stale_sec:
        return "stale", "unknown status=%s age=%.1fh" % (st, age_sec / 3600.0)
    return "skip", "unknown status=%s" % st


def export_rows(rows, path):
    data = []
    for r in rows:
        d = dict(r)
        d["create_time_str"] = ts2str(d.get("create_time"))
        d["update_time_str"] = ts2str(d.get("update_time"))
        data.append(d)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def main():
    ap = argparse.ArgumentParser(description="清理即梦任务库里僵死的 querying 记录")
    ap.add_argument("--apply", action="store_true", help="真的写库（默认 dry-run）")
    ap.add_argument("--min-age-min", type=float, default=20.0)
    ap.add_argument("--stale-hours", type=float, default=6.0)
    ap.add_argument("--keep-queued", type=lambda x: str(x).lower() not in ("0", "false", "no"),
                    default=True)
    ap.add_argument("--db", default=default_db())
    ap.add_argument("--dreamina", default=default_bin())
    ap.add_argument("--backup-dir",
                    default=os.path.join(ROOT, "_canvas", "data", "dreamina_task_backup"))
    ap.add_argument("--skip-remote", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print("[ERR] 任务库不存在: %s" % args.db)
        return 2
    if not args.skip_remote and not (os.path.exists(args.dreamina) or shutil.which(args.dreamina)):
        print("[ERR] 找不到 dreamina CLI: %s（可用 --skip-remote）" % args.dreamina)
        return 2

    min_age = args.min_age_min * 60
    stale = args.stale_hours * 3600
    con = connect(args.db, readonly=True)
    rows = con.execute(
        "SELECT submit_id, gen_task_type, gen_status, create_time, update_time, "
        "fail_reason, commerce_info, request, result_json FROM aigc_task "
        "WHERE gen_status='querying' ORDER BY create_time ASC").fetchall()
    total = con.execute("SELECT COUNT(*) FROM aigc_task").fetchone()[0]
    con.close()

    print("=" * 72)
    print("DB: %s" % args.db)
    print("rows=%d querying=%d dry_run=%s" % (total, len(rows), not args.apply))
    print("=" * 72)

    plan = []          # (row, action, reason, data)
    now = now_ts()
    for r in rows:
        sid = r["submit_id"]
        age = now - float(r["create_time"] or 0)
        data = None
        err = ""
        if not args.skip_remote:
            ok, data, err = run_query_result(args.dreamina, sid)
            if not ok:
                print("  ! %s %s 远程查询失败: %s" % (sid[:8], r["gen_task_type"], err))
        action, reason = classify(data, age, min_age, stale, args.keep_queued)
        if args.skip_remote:
            # 离线模式：仅按时间判定，队列信息未知，保守阈值
            action = "stale" if age >= stale else "keep"
            reason = "offline age=%.1fh" % (age / 3600.0)
        plan.append((r, action, reason, data))
        print("  %-3s %s %-14s %-8s age=%5.1fh  %s" % (
            {"final": "OK", "keep": "keep", "stale": "STALE", "skip": "skip"}.get(action, "?"),
            sid[:8], r["gen_task_type"], (data or {}).get("gen_status", "?"),
            age / 3600.0, reason))

    finals = [p for p in plan if p[1] == "final"]
    stales = [p for p in plan if p[1] == "stale"]
    keeps = [p for p in plan if p[1] == "keep"]
    skips = [p for p in plan if p[1] == "skip"]
    print("-" * 72)
    print("可收尾(云端已终态): %d · 僵死待删: %d · 保留(在跑/排队): %d · 跳过: %d"
          % (len(finals), len(stales), len(keeps), len(skips)))

    if not args.apply:
        if finals or stales:
            print("\n(dry-run) 加 --apply 执行：写回终态 %d 行、删除僵死 %d 行（会先备份）"
                  % (len(finals), len(stales)))
        return 0

    if not finals and not stales:
        print("没有需要处理的行。")
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = os.path.join(args.backup_dir, stamp)
    os.makedirs(run_dir, exist_ok=True)
    bak = backup_db(args.db, run_dir)
    print("\n[备份] %s" % bak)
    if stales:
        p = export_rows([s[0] for s in stales], os.path.join(run_dir, "deleted_tasks.json"))
        print("[存档] 待删行 -> %s" % p)
    report = {
        "at": datetime.datetime.now().isoformat(timespec="seconds"),
        "db": args.db,
        "backup": bak,
        "final": [{"submit_id": f[0]["submit_id"], "status": f[3].get("gen_status") if f[3] else "?"}
                  for f in finals],
        "deleted": [{"submit_id": s[0]["submit_id"], "type": s[0]["gen_task_type"],
                     "reason": s[2], "age_h": round((now - float(s[0]["create_time"] or 0)) / 3600.0, 2)}
                    for s in stales],
        "kept": [{"submit_id": k[0]["submit_id"], "reason": k[2]} for k in keeps],
    }
    with open(os.path.join(run_dir, "cleanup_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    con = connect(args.db, readonly=False)
    ok_final = 0
    ok_del = 0
    try:
        for r, action, reason, data in finals:
            if not data:
                continue
            st = str(data.get("gen_status") or "")
            if st not in ("success", "fail"):
                continue
            cur = con.execute("SELECT gen_status FROM aigc_task WHERE submit_id=?", (r["submit_id"],))
            cur_row = cur.fetchone()
            if cur_row and cur_row["gen_status"] != "querying":
                continue  # CLI 已经自己写回了
            fr = data.get("fail_reason") or ""
            rj = data.get("result_json")
            rj = json.dumps(rj, ensure_ascii=False) if rj not in (None, "") else ""
            con.execute(
                "UPDATE aigc_task SET gen_status=?, fail_reason=?, result_json=?, update_time=? "
                "WHERE submit_id=? AND gen_status='querying'",
                (st, fr, rj, int(now), r["submit_id"]))
            ok_final += 1
        for r, action, reason, data in stales:
            con.execute("DELETE FROM aigc_task WHERE submit_id=? AND gen_status='querying'",
                        (r["submit_id"],))
            ok_del += 1
        con.commit()
    finally:
        con.close()

    print("[完成] 写回终态 %d 行 · 删除僵死 %d 行" % (ok_final, ok_del))
    print("[报告] %s" % os.path.join(run_dir, "cleanup_report.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
