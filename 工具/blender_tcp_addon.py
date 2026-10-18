bl_info = {
    "name": "DSH TCP Bridge (Blender 接入)",
    "author": "nightdancer-character-replace",
    "version": (1, 0, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > DSH",
    "description": "本地 TCP(9876) 桥：外部脚本发送 Python 代码，在 Blender 主线程执行并回传结果",
    "category": "Development",
}

"""
接入方式（与 DSH 的 blender_rt 同一个思路）：

  [外部脚本/Agent] --TCP 127.0.0.1:9876--> [本插件 server 线程]
        JSON 行协议:  {"id":1,"cmd":"exec","code":"print(len(bpy.data.objects))"}
        回包:        {"id":1,"ok":true,"stdout":"...","stderr":"","result":123}

  - 网络线程只负责收包 + 入队
  - bpy.app.timers 每 10ms 取任务，在主线程 exec（bpy 只能在主线程用）
  - 结果回写队列，网络线程发送

启动：
  1. 把本文件复制到 Blender 的 scripts/addons/
  2. Edit > Preferences > Add-ons > 搜索 "DSH TCP Bridge" 勾选启用
  3. 3D 视图右侧边栏 (N) → DSH 标签 → Start Server
  4. 外部: python blender_tcp_client.py "print(bpy.app.version_string)"

安全：只监听 127.0.0.1，且只在手动启用插件+点 Start 后监听；不用时点 Stop。
"""

import bpy
import json
import queue
import socket
import threading
import traceback
import io
import contextlib

HOST = "127.0.0.1"
PORT = 9876

_server = None
_server_thread = None
_running = False
_tasks = queue.Queue()      # 网络线程 -> 主线程
_replies = {}               # id -> queue.Queue
_reply_lock = threading.Lock()


def _exec_code(code: str):
    """在 Blender 主线程执行代码，返回 (stdout, stderr, result, error)"""
    out, err = io.StringIO(), io.StringIO()
    ns = {"bpy": bpy}
    result = None
    error = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            lines = code.strip().splitlines()
            if not lines:
                pass
            elif len(lines) == 1 and not lines[0].strip().endswith(":") and not lines[0].startswith((" ", "\t")):
                try:
                    result = eval(compile(code, "<tcp>", "eval"), ns, ns)
                except SyntaxError:
                    exec(compile(code, "<tcp>", "exec"), ns, ns)
            else:
                exec(compile(code, "<tcp>", "exec"), ns, ns)
    except Exception:
        error = traceback.format_exc()
    return out.getvalue(), err.getvalue(), result, error


def _handle_task(task):
    cmd = task.get("cmd", "exec")
    tid = task.get("id")
    if cmd == "ping":
        return {"id": tid, "ok": True, "result": "pong", "stdout": "", "stderr": ""}
    if cmd == "scene_info":
        sc = bpy.context.scene
        info = {
            "blender": bpy.app.version_string,
            "scene": sc.name,
            "objects": len(bpy.data.objects),
            "camera": sc.camera.name if sc.camera else None,
            "engine": sc.render.engine,
            "resolution": [sc.render.resolution_x, sc.render.resolution_y],
        }
        return {"id": tid, "ok": True, "stdout": "", "stderr": "", "result": info}
    if cmd == "exec":
        code = task.get("code", "")
        out, err, result, error = _exec_code(code)
        try:
            json.dumps(result)
        except Exception:
            result = repr(result)
        return {"id": tid, "ok": error is None, "stdout": out, "stderr": err, "error": error, "result": result}
    return {"id": tid, "ok": False, "error": "unknown cmd: " + str(cmd)}


def _client_loop(conn):
    f = conn.makefile("rwb")
    try:
        while _running:
            line = f.readline()
            if not line:
                break
            try:
                task = json.loads(line.decode("utf-8"))
            except Exception:
                f.write((json.dumps({"ok": False, "error": "bad json"}) + "\n").encode())
                f.flush()
                continue
            q = queue.Queue()
            with _reply_lock:
                _replies[task.get("id")] = q
            _tasks.put(task)
            try:
                reply = q.get(timeout=600)
            except queue.Empty:
                reply = {"id": task.get("id"), "ok": False, "error": "timeout in Blender main thread"}
            f.write((json.dumps(reply, ensure_ascii=False) + "\n").encode())
            f.flush()
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _accept_loop(server):
    while _running:
        try:
            conn, _ = server.accept()
        except OSError:
            break
        threading.Thread(target=_client_loop, args=(conn,), daemon=True).start()


def _timer_poll():
    """主线程定时器：取任务执行、回填结果"""
    for _ in range(8):
        try:
            task = _tasks.get_nowait()
        except queue.Empty:
            break
        reply = _handle_task(task)
        with _reply_lock:
            q = _replies.pop(task.get("id"), None)
        if q:
            q.put(reply)
    return 0.01


class DSH_OT_start(bpy.types.Operator):
    bl_idname = "dsh_tcp.start"
    bl_label = "Start Server"

    def execute(self, context):
        global _server, _server_thread, _running
        if _running:
            self.report({"INFO"}, "server already running")
            return {"FINISHED"}
        _running = True
        _server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        _server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        _server.bind((HOST, PORT))
        _server.listen(8)
        _server_thread = threading.Thread(target=_accept_loop, args=(_server,), daemon=True)
        _server_thread.start()
        if not bpy.app.timers.is_registered(_timer_poll):
            bpy.app.timers.register(_timer_poll, persistent=True)
        self.report({"INFO"}, "DSH TCP bridge listening on %s:%d" % (HOST, PORT))
        return {"FINISHED"}


class DSH_OT_stop(bpy.types.Operator):
    bl_idname = "dsh_tcp.stop"
    bl_label = "Stop Server"

    def execute(self, context):
        global _server, _running
        _running = False
        try:
            if _server:
                _server.close()
        except Exception:
            pass
        _server = None
        self.report({"INFO"}, "DSH TCP bridge stopped")
        return {"FINISHED"}


class DSH_PT_panel(bpy.types.Panel):
    bl_label = "DSH TCP Bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "DSH"

    def draw(self, context):
        layout = self.layout
        layout.label(text="127.0.0.1:%d" % PORT)
        layout.label(text="状态：" + ("运行中" if _running else "已停止"))
        row = layout.row(align=True)
        row.operator("dsh_tcp.start", text="Start")
        row.operator("dsh_tcp.stop", text="Stop")


classes = (DSH_OT_start, DSH_OT_stop, DSH_PT_panel)


def register():
    for c in classes:
        bpy.utils.register_class(c)
    # 可选：启动 Blender 时自动起服务（默认关闭，避免端口冲突）
    if False:
        bpy.app.timers.register(lambda: (bpy.ops.dsh_tcp.start(), None)[1], first_interval=1.0)


def unregister():
    for c in reversed(classes):
        bpy.utils.unregister_class(c)
