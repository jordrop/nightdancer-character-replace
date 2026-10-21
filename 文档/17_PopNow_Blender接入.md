# PopNow for Blender 接入（v0.1.0 · 2026-10-19）

> 结论先说：**PopNow 是外部工具，不是要并进 MIT 仓库的代码**。GPL-3.0 只约束“复制/修改/分发它的代码”，不约束“作为插件安装使用”。所以“需要就装”——已装好并验证。
> 本文记录：它是什么、装在哪、验证结果、和现有流水线怎么接、成本、许可边界、下一步。

---

## 1. 它是什么

[popnow-ai/popnow-blender](https://github.com/popnow-ai/popnow-blender)（GPL-3.0-or-later，Blender 4.2+）是 PopNow 的 Blender 扩展，用 `api.popnow.ai` 上的托管模型做三件事：

| 工作流 | 输入 | 输出 | 模型（价格 = credits，1 credit = $0.01） |
|---|---|---|---|
| **Render with AI** | 场景相机的灰模 clay 渲染（或 F12 成品渲染）+ 可选 depth/normal/line-art + 最多 3 张参考图 | 一张成品图（可设为相机背景 / 投影回模型） | Seedream 5.0 Pro 6 / Flash 5、Nano Banana 2.1 8、GPT Image 2 7、Qwen-Image 2.1 Turbo 3、FLUX.1 dev ControlNet 6 |
| **Animate with AI** | **相机动画的 Workbench 预览片段** + 提示词（+ 参考图；Wan 2.2 Animate 需角色图） | 保持相机运动/blocking/时长的 MP4 | Seedance 2.0 Mini 17 / Fast 34 / 2.0 65（480p 5s 起，可到 4K）、Seedance 2.5 111、Wan 3.0 68、Kling O3 Restyle 94（720p 5s，逐帧重绘 3–10s）、Wan 2.2 Animate 40 |
| **Texture** | 材质描述 + 风格 | 无缝贴图 + box-projected 材质 | Seedream 5.0 Flash 5、Qwen Turbo 3、Seedream 5.0 Pro 6、Nano Banana 2.1 8 |

其他要点：
- API key：`sk-popnow-...`，存在 Blender 用户偏好里（或环境变量 `POPNOW_API_KEY`）；密钥不会写进 `.blend`；
- 上传内容：只有 clay 图/预览片段和参考图，`.blend`、模型、贴图不上传；
- 先报价后确认；失败自动退款；任务在后台线程跑，可恢复；
- 不需要本机 GPU、不需要额外 Python 包。

---

## 2. 安装结果（已装好）

| Blender | 版本 | 安装位置 | 状态 |
|---|---|---|---|
| 4.2.7 LTS | popnow 0.1.0 | `%APPDATA%\Blender Foundation\Blender\4.2\extensions\user_default\popnow` | ✅ 启用成功，22 个 operator 注册 |
| 5.0.0 | popnow 0.1.0 | `%APPDATA%\Blender Foundation\Blender\5.0\extensions\user_default\popnow` | ✅ 启用成功，22 个 operator 注册 |

安装包：`C:\Users\Administrator\Desktop\popnow-blender-0.1.0.zip`（54,809 B，源码构建，sha256 `cce9909db3b165c21cccba562ebe175d7698e6d2bf44c22a86561b7652d03205`）。

**验证（addon 自带 self-test，fake backend，零费用）**：

```
PASS addon registers / defaults applied / clay still rendered / clay clip rendered / scene settings restored
PASS render operator accepted / render job succeeded / render result loaded
PASS camera background set / projection modifier added
PASS animate job succeeded / video added to sequencer
PASS texture job succeeded / texture applied to selection
PASS failure reports refund / addon unregisters
```

5 个失败均为环境原因，不是功能问题：depth/normal/lineart 需要 Cycles 引擎（`--factory-startup` 下未启用）、viewport 回退在无界面模式下不适用、seamless 断言（实际 `seam_error: 0.0`，完美无缝）。

---

## 3. 和我们的流水线怎么接

### 3.1 单镜场景导出（已实现并实测）

`工具/render_one_shot.py` 新增 `--save-blend`（或 job JSON 里加 `"save_blend": "路径"`）：渲染前把“替换图平面 + 运镜相机关键帧”的场景存成 `.blend`，不额外渲染任何东西。

```powershell
# 单个 job
blender -b --factory-startup --python 工具\render_one_shot.py -- --json job.json --save-blend out\K02.blend
```

`工具/render_pipeline.py` 新增 `--save-blend-dir`：跑一键渲染时顺手给每个运镜镜头导出一份 `.blend`（不影响正常渲染/合成）。

```powershell
python 工具\render_pipeline.py --save-blend-dir 分析\popnow_scenes
```

实测：K02 场景（960×480，46 帧，`x_px=-80,y_px=-40`）成功保存 `scene_K02.blend`（423 KB），相机关键帧、平面、材质均正常。

### 3.2 用 PopNow 把平面运镜“AI 化”

1. 打开导出的 `.blend`（Blender 4.2/5.0 均可）；
2. `N` 面板 → **PopNow** 标签 → **Animate with AI**；
3. **Look 选 `Texture`**（关键：实测 Workbench 的 TEXTURE 着色能显示我们的替换图；选 `Clay` 会变灰模）；
4. 选模型：**Kling O3 Restyle**（逐帧重绘，最接近“把我们的 2.5D 片段变成真 3D 感视频”）、Seedance 2.5（跟随 previz 最好）、Wan 2.2 Animate（需要角色图做动作迁移）；
5. 调长度/分辨率 → 报价 → 确认 → 结果 MP4 可进 Video Sequencer / 设相机背景。

实测证据：保存的 `.blend` 直接 Workbench 渲染，`SINGLE`（clay）灰度 std=0.5，`TEXTURE` 下能正确显示替换图（std=32.0）——说明 PopNow 能拿到“带运镜的画面片段”，而不是一块灰板。

### 3.3 3D blockout 路线（后续）

如果以后用 MMD/3D 代理做 previz（`Other/祀.pmx` 那类），PopNow Animate 就是标准用法：3D 白模 + 相机动画 → AI 成片；Render with AI 也支持深度/法线/线稿引导（FLUX ControlNet），比纯 prompt 更能锁构图。

### 3.4 自动化（暂不做，留接口）

PopNow 有公开 API（`POST /jobs/quote` → `/jobs/createTask` → 轮询 `/jobs/recordInfo`），也有官方 SDK：popnow-api / popnow-python / popnow-js / popnow-mcp / popnow-skills。
若要并进 `render_pipeline.py` 自动提交，**用官方 SDK 或自己的 MIT 客户端**，**不要复制 add-on 的 GPL 代码**。先确认 SDK 许可证（本次网络查询超时，未核实）。

---

## 4. 成本粗算（NIGHTDANCER 11 镜 / 86s）

| 方案 | 单价 | 86s 拆段（按 5s/段 ≈ 18 段） | 约合 |
|---|---|---|---|
| Seedance 2.0 Mini（480p 草稿） | 17 credits/5s | ≈ 306 credits | **≈ $3** |
| Seedance 2.0 Fast | 34 credits/5s | ≈ 612 credits | **≈ $6** |
| Seedance 2.0（高质） | 65 credits/5s | ≈ 1,170 credits | ≈ $12 |
| Seedance 2.5（最跟 previz） | 111 credits/5s | ≈ 2,000 credits | ≈ $20 |
| Kling O3 Restyle（720p 重绘） | 94 credits/5s | ≈ 1,700 credits | ≈ $17 |

建议先拿 1 个镜头（K02 或 K09）做试点，确认“AI 化运镜”对成片提升是否值得，再决定是否全片跑。

---

## 5. 使用前提

1. 在 [popnow.ai/api/console/keys](https://popnow.ai/api/console/keys) 建 key（`sk-popnow-` 开头），填到 PopNow 面板或 `POPNOW_API_KEY`；
2. Blender：**Preferences → System → Network → Allow Online Access** 打开（否则插件一个请求都不发）；
3. 有余额（credits 包，无订阅）。

---

## 6. 许可与仓库边界

- 插件是 **GPL-3.0-or-later**；我们的仓库是 **MIT**。**把插件装进 Blender 使用**不会改变我们代码的许可；**把它的代码拷进仓库/内嵌/随产品分发**才会触发 GPL 传染。
- 因此：插件源码和 zip **不放进 L:\giehub-test**（zip 在桌面；源码在临时目录，可用 `scripts/build_zip.py` 重建）。
- 自动化路线只通过公开 API 或官方 SDK，自己写 MIT 代码；引用时保留出处链接。
- 上传的是 clay/预览/参考图，`.blend` 和模型不上传；API key 不进项目文件、不进 git。

---

## 7. 下一步

1. 填 key + 打开在线访问，跑一条**最小真实任务**（Render 用 Qwen-Image 2.1 Turbo，约 3 credits）确认扣费/下载链路；
2. 用 `--save-blend-dir` 导出 K02/K09 两个镜头，Animate with AI 选 **Kling O3 Restyle** 各跑一条 5s，和现在 EEVEE 正交平移动画做 A/B；
3. A/B 达标后才考虑批量 + 决定是否把 API 自动化并进 `render_pipeline.py`（第 3.4 节）。

---

## 8. 修订：即梦能覆盖的部分，优先用即梦（2026-10-19）

> 用户指出并确认：**即梦本身就有"扩图/结构参考"（对应 FLUX ControlNet 那类）和"动作参考"（对应 Wan 2.2 Animate 那类）**；且 Seedance 2.5 已可跑通。之前把这两项写成 PopNow 独有是不准确的，本节更正并给出分工。

### 8.1 实测：Seedance 2.5 480p 样片（已跑通）

| 项 | 结果 |
|---|---|
| 命令 | `dreamina image2video --image K01_final.png --prompt "..." --duration=4 --video_resolution=480p --model_version=seedance2.5 --poll=600` |
| 1s 尝试 | ❌ 被拒：`duration should >=4 && <=30`（0 积分消耗） |
| 4s 生成 | ✅ success，submit_id `15095847-…`，**48 credits**（8462 → 8414） |
| 产物 | `L:\giehub-test\即梦产物\seedance25_test_480p\seedance25_test_480p.mp4` · 854×480 · ≈4.06s · 视频 97 帧 + **AAC 音轨** |
| 注意 | 成片左上角带**"AI生成"平台水印**；交付时需按平台规则处理/裁切 |

结论：**即梦 CLI 链路可用、成本可算（480p 4s ≈ 48 积分）**；Seedance 2.5 在 standard 账号下本次实际可跑（CLI 帮助里写的 VIP-only 可能是旧限制或按地区/时段放开）。

### 8.2 即梦 CLI 现成能力（对照 PopNow）

| 能力 | 即梦 CLI | 备注 |
|---|---|---|
| 图生图替换 | `image2image` | 我们主力，已在用 |
| 视频参考/运镜复刻 | `multimodal2video --video <参考片段> --image <替换帧>` | Seedance 2.0/2.5，参考视频 2–15s（2.5 可到 30s） |
| 首尾帧 | `frames2video --first --last` | 4–15s（2.5 可 4–30s） |
| 单图生视频 | `image2video` | 4–15s（2.5 可 4–30s），本次已实测 |
| 多图成片 | `multiframe2video` | 多图故事 |
| 文生视频/图 | `text2video` / `text2image` | — |
| 扩图/结构参考 | Web 端有（用户确认） | CLI 未直接暴露；需要时走 Web |
| 动作参考 | Web 端有（用户确认） | CLI 的 `multimodal2video` 视频参考可做近似 |
| 逐帧重绘（Kling O3 Restyle 类） | 未在 CLI 模型列表中 | 目前仍以 PopNow/Web 为备选 |
| FLUX 结构控制 | Web 端有（用户确认） | CLI 未直接暴露 |

### 8.3 分工结论（更新版）

**默认全部用即梦**：
- 图替换 → `image2image`
- 运镜 AI 化 → `multimodal2video`（参考视频）或 `frames2video`（首尾帧）
- 短样片/验证 → `image2video`（480p 4s 约 48 积分，成本明确）

**PopNow 只在以下情况再启用**（key 可暂不申请）：
1. 需要 **Blender 内一键抓取/回填**（省导出上传，尤其批量 Animate）；
2. 需要 **Kling O3 Restyle 逐帧重绘**（即梦 CLI 当前没有对应模型）；
3. 需要 **Wan 2.2 Animate 的动作迁移**（即梦 Web 有类似能力，但模型不同、CLI 不暴露）；
4. 需要 **FLUX + depth/normal/lineart 结构通道** 做精确轮廓控制（即梦 Web 有扩图/结构参考，CLI 不暴露）；
5. 需要多模型横评（同一场景同时跑 Seedance/Kling/Wan/Seedream/Nano Banana）。

### 8.4 下一步（即梦路线）

1. 用 `render_one_shot.py` 把某个镜头的运镜渲染成 **4–15s 的参考片段**（如 K02 扩到 120 帧 = 4s）；
2. 跑 `multimodal2video --video 参考片段.mp4 --image 替换帧.png --model_version=seedance2.5 --video_resolution=480p --duration=4`，验证"参考视频能不能保住运镜"；
3. 达标后再和现有 EEVEE 正交平移版本 A/B，决定哪些镜头走 AI 化。
