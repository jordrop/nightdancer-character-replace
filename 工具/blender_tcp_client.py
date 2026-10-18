# -*- coding: utf-8 -*-
"""Blender TCP 客户端：给已启用 DSH TCP Bridge 插件的 Blender 发 Python 代码并收结果。

用法:
  python 工具/blender_tcp_client.py "print(bpy.app.version_string)"
  python 工具/blender_tcp_client.py --file some_script.py
  python 工具/blender_tcp_client.py --ping
  python 工具/blender_tcp_client.py --scene

协议（换行分隔的 JSON）:
  请求 {"id": 1, "cmd": "exec", "code": "..."} / {"cmd":"ping"} / {"cmd":"scene_info"}
  响应 {"id": 1, "ok": true, "stdout": "...", "stderr": "...", "result": ..., "error": null}
"""
import json
import socket
import sys
import time

HOST, PORT = "127.0.0.1", 9876


def call(payload, timeout=600):
    with socket.create_connection((HOST, PORT), timeout=10) as s:
        s.settimeout(timeout)
        s.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        line = buf.split(b"\n", 1)[0].decode("utf-8", "replace")
        return json.loads(line)


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 1
    if args[0] == "--ping":
        print(json.dumps(call({"id": 1, "cmd": "ping"}), ensure_ascii=False))
        return 0
    if args[0] == "--scene":
        print(json.dumps(call({"id": 1, "cmd": "scene_info"}), ensure_ascii=False))
        return 0
    if args[0] == "--file":
        with open(args[1], encoding="utf-8") as f:
            code = f.read()
    else:
        code = " ".join(args)
    t0 = time.time()
    r = call({"id": 1, "cmd": "exec", "code": code})
    if r.get("stdout"):
        print(r["stdout"], end="")
    if r.get("stderr"):
        print("[stderr]", r["stderr"], end="")
    if r.get("error"):
        print("[error]", r["error"], end="")
    print("[%s] %.2fs" % ("OK" if r.get("ok") else "FAIL", time.time() - t0))
    if r.get("result") is not None:
        print("[result]", json.dumps(r["result"], ensure_ascii=False)[:2000])
    return 0 if r.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
