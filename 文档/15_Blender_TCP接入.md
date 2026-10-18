# Blender TCP 接入方法（项目内置）

> 目标：让外部脚本 / Agent 能像本地函数一样驱动 Blender —— 发一段 Python 代码进去，在 Blender 主线程执行，拿回 stdout/结果。
> 本项目把 DSH 里用的那套「TCP 9876 + 主线程队列执行」思路，做成可独立安装的两个文件，随项目一起分发。

---

## 1. 架构

```
外部脚本 / Agent
      │  TCP 127.0.0.1:9876（换行分隔 JSON）
      ▼
Blender 插件（blender_tcp_addon.py）
      │  网络线程：收包 → 任务队列
      │  bpy.app.timers(10ms)：主线程取任务 → exec(code) → 回填结果
      ▼
Blender 主线程（bpy 只能在这里调用）
```

关键点：**网络线程绝不直接碰 bpy**，所有 `bpy.*` 都在主线程执行，避免崩溃。

---

## 2. 协议（换行分隔 JSON）

请求：
```json
{"id": 1, "cmd": "exec", "code": "print(len(bpy.data.objects))"}
{"id": 2, "cmd": "ping"}
{"id": 3, "cmd": "scene_info"}
```

响应：
```json
{"id": 1, "ok": true, "stdout": "123\n", "stderr": "", "error": null, "result": null}
```

| cmd | 作用 | 返回 |
|---|---|---|
| `ping` | 连通性探测 | `result: "pong"` |
| `scene_info` | 场景概要 | `result: {blender, scene, objects, camera, engine, resolution}` |
| `exec` | 执行任意 Python（可用 `bpy`） | `stdout/stderr/error/result` |

超时：单次 600s；连接空闲由客户端决定。

---

## 3. 安装（一次性）

1. 复制 `工具/blender_tcp_addon.py` 到 Blender 的 `scripts/addons/`
   - Windows 常见路径：`C:\Users\<你>\AppData\Roaming\Blender Foundation\Blender\<版本>\scripts\addons\`
   - 或 Blender 内 `Edit > Preferences > File Paths > Scripts` 自定义目录
2. `Edit > Preferences > Add-ons` → 搜索 **DSH TCP Bridge** → 勾选启用
3. 3D 视图按 `N` → 侧栏 **DSH** 标签 → **Start**（状态显示"运行中"）
4. 验证：
   ```powershell
   python 工具\blender_tcp_client.py --ping
   python 工具\blender_tcp_client.py --scene
   ```

---

## 4. 使用示例

```powershell
# 查版本
python 工具\blender_tcp_client.py "print(bpy.app.version_string)"

# 清空场景并建一个平面
python 工具\blender_tcp_client.py --file 工具\你的脚本.py

# 一行命令渲染一帧（示例）
python 工具\blender_tcp_client.py "bpy.context.scene.render.filepath=r'E:\伊雪的活\_blender_out\test.png'; bpy.ops.render.render(write_still=True)"
```

Python 里当客户端用：
```python
import sys; sys.path.insert(0, r'E:\伊雪的活\ptest\ptest\人物替换_NIGHTDANCER\工具')
from blender_tcp_client import call
r = call({"id": 1, "cmd": "exec", "code": "bpy.context.scene.render.engine"})
print(r["result"])
```

---

## 5. 与 DSH 自带 blender_rt 的关系

| 方式 | 端口 | 特点 | 本项目的用法 |
|---|---|---|---|
| DSH `blender_rt`（MCP/插件） | addon 9876 + backend 9877 | 功能全（视口截图/选中/事务/作业队列），与 Agent 深度集成 | 开发期主要用这个 |
| 本项目 `blender_tcp_addon.py` | 9876 | 极简、零依赖、可独立分发 | 交付时让任何人能复现「Agent 驱动 Blender」 |

两者端口默认相同，**不要同时启动**；换端口改 `blender_tcp_addon.py` 里的 `PORT` 与客户端 `PORT` 即可。

---

## 6. 安全

- 仅绑定 `127.0.0.1`，不对外网
- 插件默认**不自动启动**，需手动点 Start；不用时 Stop
- `exec` 能执行任意代码 = 拿到 Blender 进程权限，只在自己机器/信任环境用
- 不建议把它暴露到局域网或公网

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `ConnectionRefusedError` | 插件没启动 / 端口不同 | 侧栏点 Start；核对 PORT |
| 客户端一直等 | 代码在 Blender 里卡住（如死循环） | Blender 里 Esc 中断，重连；避免长耗时同步操作 |
| 返回 `timeout in Blender main thread` | 主线程被占（渲染/模态操作） | 等操作结束再发 |
| 多客户端同时连 | 支持（每连接一线程），但任务串行执行 | 批量任务建议排队发送 |

---

*文件：`工具/blender_tcp_addon.py`、`工具/blender_tcp_client.py`；文档：`文档/15_Blender_TCP接入.md`*
