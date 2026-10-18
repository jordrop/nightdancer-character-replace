# 制作流水线（自研移植版）

> 页面：<http://127.0.0.1:17800/pipeline> · 画布顶栏「🎬 制作流水线」按钮可进入
> 实现：`_canvas/pipeline.mjs`（引擎）+ `_canvas/pipeline.html`（界面）+ `server.mjs` 里的 `/api/pipeline/*` 路由
> 定位：把「小说 → 剧本 → 资产 → 情绪锚点 → 分镜 → 提示词 → 即梦任务」这条流程自动化，作为画布的配套工作台。
> 版权说明：本流水线的界面、代码与提示词均为本项目自写，不含任何第三方项目代码；UI 风格为通用深色工作台设计。

## 一、5 个步骤

| 步骤 | 产出 | 依赖 |
|---|---|---|
| ① 剧本改写 `script` | 分场剧本：内外/地点/时辰、动作、对白、旁白、音效、转场、连续性锁 | — |
| ② 资产提取 `assets` | 角色 / 场景 / 道具 / 群像清单，每项写「只控制什么、不控制什么」 | ① |
| ③ 情绪锚点 · 机位锁 `emotion` | 80/15/5 机位配比、E01… 情绪锚点表、情绪强度曲线 | ① |
| ④ 分镜拆分 `storyboard` | 4–30 秒剪辑镜：时长/目的/景别机位/运镜/起点动作终点/声音/视觉依据/关键帧提示词 | ①②③ |
| ⑤ 提示词生成 `prompts` | 图片 15 维提示词 + Seedance 2.5 时间轴式视频提示词（含声音时间线） | ④② |

每步产物在页面里可直接编辑保存；「导出全部文稿」会把 8 份 md 写进项目目录（剧本/人物设定/场景资产提示词/道具资产提示词/情绪锚点表/分镜/图片提示词/视频提示词），与 `女红军/剧集/EP001/` 的文档结构对齐。

## 二、内置工艺铁律（写在 pipeline.mjs 的 `CRAFT` 常量里）

- 台词 `{角色说："逐字台词"}`；音效 `<声音>…</声音>`；提示词正文禁 `【】`；全程无字幕
- 一段一个主动作 + 一个次要动作，写清「起点 → 动作 → 终点」；一种运镜
- 物理解剖：单光源投影一致、接触阴影、五指四肢数量、不穿插、液面水平
- 时长预算：台词字数 ÷ 4.5 字/秒，`max(动作, 台词) + 0.5s`；单镜 4–30 秒
- **历史人物红线**：真实历史人物不出正面标准像，只给背影 / 侧 3/4 / 手部
- 构图雷区：横线不切头颈、不贴边、不倾斜地平线、对话不用中轴正反打
- 剧本层禁镜头语言（action 里不得出现景别/运镜），引擎侧还有确定性清洗兜底

## 三、即梦任务台账

「⑤ 提示词生成」完成后点「从提示词批量建任务」：每镜 1 条图片任务 + 每个生成单位 1 条视频任务（条目含 prompt、时长、首帧、比例）。
任务可「提交 / 轮询 / 重试 / 下载」，结果落到 `即梦产物/` 并自动挂画布。

- 提交命令由 `server.mjs` 的 `pipeImageArgs` / `pipeVideoArgs` 拼装（**以 `dreamina <cmd> -h` 实测为准，CLI v1.4.20**）：
  - 图片：`dreamina text2image --prompt=… --model_version=5.0 --resolution_type=2k --ratio=… --poll=0`
  - 视频（有首帧）：`dreamina image2video --image=<绝对路径> --prompt=… --model_version=<mv> --video_resolution=720p --duration=N --poll=0`
    - **seedance2.5 不接受 `--ratio`**（跟随首帧）；其它模型 ratio 可省略
  - 视频（无首帧时自动降级）：`dreamina text2video --prompt=… --model_version=<mv> --video_resolution=720p --duration=N --ratio=… --poll=0`
  - 视频模型默认 `seedance2.0fast`（`seedance2.5` 为 VIP-only，普通会员提交会被拒）；可在项目 `input.videoModel` 里改
- **免费预检**：`POST /api/pipeline/tasks {id,action:'dry',taskId}` 只返回将执行的命令行，不扣积分。
- 本机没装即梦 CLI 时：服务启动会探测并显示「即梦未连接」，任务只能建台账、不能提交（界面会提示）。
- 安装/登录（官方）：
  ```bash
  # 官方一键安装（macOS/Linux/Git Bash）；Windows 直接下二进制：
  # https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe
  dreamina login --headless     # 打印授权链接与 device_code
  dreamina login checklogin --device_code=<...> --poll=10   # 手机/浏览器授权后确认
  dreamina user_credit          # 余额 + 会员档位
  ```

## 三·补、图片怎么"对上"（不花积分也行）

> 现成例子：`《女红军》EP001 · 真实项目` 就是用 `_canvas/_import_ep001.mjs` 从 EP001 既有工艺文档 + 图片导入的（未重新生成、未花积分）：
> 5 步全部 done，资产 20/20 有图（14 角色锚点 + 6 场景板），分镜 28/44 有图（7 张带 `SHOT###` + 21 张 `段D/E_NN` 按镜号），道具 0/6（文档标注"待出图"）。

`GET /api/pipeline/state` 会额外返回 `state.images = { shots: {镜头ID: 相对路径}, assets: {资产ID: 相对路径} }`，优先级：

1. **手动绑定**（最高）——镜头详情 / 资产卡上的「绑定图片」现在打开**可视化选择器**：缩略图墙 + 搜索 + 「刷新列表」，
   点一张即绑定，不用再手打路径；解绑后那张图会带「上次解绑的图」标签排在最前面，随时能选回来。
   选择器还会给候选图打推荐标签：`当前绑定` / `上次解绑的图` / `ID 匹配` / `同名匹配`（如 `04_酒厂老板.png` ↔ `IMG-CHR-04 酒厂老板`）/
   `镜头号匹配` / `疑似同镜号`（如 `段D_22_主人家早跑了.png` ↔ `EP001-SHOT022`）/ `已在用`。
   接口：`POST /api/pipeline/bind-image {id,kind:'shot'|'asset',key,path}` / `POST /api/pipeline/unbind-image {id,kind,key}`
   （返回 `prevPath`，前端据此给「撤销」按钮；`GET /api/pipeline/image-candidates?id&kind&key&q` 提供候选列表）。
2. **任务产物**——图片任务提交成功并下载后，`files[0]` 自动对上该任务的 `shotId`（画布/页面都显示）。
3. **文件名匹配**——递归扫描「项目输出目录」+ `即梦产物/` + 所有已绑定/历史绑定/任务产物所在目录（深度 4、上限 4000 张），
   命中规则：**完整镜头 ID**、**短镜头号**（`SHOT017`，唯一才用；`故事板/候选/样片` 目录不参与）、
   **资产中文名**（`01_金维映` ↔ `IMG-CHR-01 金维映`、`S5_赤水河滩酒厂_午后` ↔ `IMG-SCN-05`）。
   同一项有多张候选（含 `_v1` 变体）时**不自动绑**，留给选择器手选，避免串图。

对上的图会显示在：分镜列表缩略图、分镜详情大图、图片提示词卡缩略图、任务台账行缩略图、资产卡封面。
产物下载后自动挂到画布节点，并把提交时的提示词写进节点 `path`（画布点开即可看到提示词）。
**解绑是"记住"的**：`state.input.unbound` 会压制该项的文件名自动匹配，刷新页面也不会自己弹回来；
`state.input.bindHistory` 保留最近 200 条用过/解绑过的图（选择器推荐用）。

## 四、API（同源，无鉴权，仅本机）

```
GET    /api/pipeline/meta            能力/模型/即梦状态/步骤定义
GET    /api/pipeline/list            项目列表（含每步状态与任务统计）
GET    /api/pipeline/state?id=       单个项目全量状态（含各步 md/data/tasks + images 图片索引）
POST   /api/pipeline/create          新建 {name,source,dir,episode,ratio,style,targetSec,model}
POST   /api/pipeline/run             运行一步 {id,step}（异步，进度走 SSE pipeline 事件）
POST   /api/pipeline/run-batch       勾选重跑 {id,steps:[…]}（按流水线顺序依次执行，逐步自动备份，某步失败即停）
POST   /api/pipeline/restore-step    恢复某一步「重跑前」的结果 {id,step}（同时恢复下游状态；恢复前当前结果也会备份）
POST   /api/pipeline/save            保存人工编辑的 md {id,step,md}
POST   /api/pipeline/export          导出 8 份文稿到项目目录 {id}
POST   /api/pipeline/update          改名 {id,name} / 改视频模型 {id,input:{videoModel}}
POST   /api/pipeline/bind-image      手动绑图 {id,kind:'shot'|'asset',key,path}
POST   /api/pipeline/unbind-image    解绑 {id,kind,key}（返回 prevPath 供撤销）
GET    /api/pipeline/image-candidates?id&kind&key&q   候选图片（选择器用，含 score/reason/inUse）
DELETE /api/pipeline?id=             删除记录（挪进 _canvas/data/pipeline/_trash/）
GET    /api/pipeline/tasks?id=       任务台账
POST   /api/pipeline/tasks           {id,action:build|submit|retry|poll|download|dry|clearFailed|clear|setVideoModel|attachFirstFrames,taskId}
```

数据落在 `_canvas/data/pipeline/<id>/state.json`；引擎运行中的进度通过画布 SSE 的 `pipeline` 事件广播。

## 五、成本与限制

- 每步 1–n 次 LLM 调用（本项目用 `_canvas/config.json` 里的 deepseek-flash）。一次约 120 秒的集，5 步全跑实测 **5–8 分钟、约 20+ 次调用**（剧本按原文分块、分镜按场分批、提示词按批）。
- 单次输出上限是主要约束：分镜与提示词都做了「短字段分批 + 长文本单独成批」，不要一次性把整集塞给一个请求。
- **资产提取也改成了分批**（2026-10）：角色每 6 人一批 + 场景/道具单独一批。原因：整集一次输出 14 角色 + 6 场景 + 6 道具会超单次输出上限，实测被截断、JSON 不合规、连重试 2 次才成功（既慢又不稳）。分批后每批输出短、截断风险低，失败也能定位到是哪一批。
- 长篇小说会按 7000 字分块改写并合并场次；分集仍需人工在导出后调整。
- 生成质量取决于输入原文与参考资产；建议先跑通 1 集 100–150 秒做对照，再批量。

## 六、错误处理与健壮性（2026-10 更新）

| 场景 | 行为 |
|---|---|
| **上游步骤重跑** | 下游已完成的步骤自动标为 **待重跑（stale）**，步骤轨橙色刷新图标 + 工具条提示「上游已更新」，防止拿过期数据继续生产；待重跑状态可以正常作为下游前置 |
| **重跑不再"一点就跑"** | 工具条的「勾选重跑」会先开弹窗：勾选要重跑的步骤（可多选，快捷「只选本步 / 本步+下游 / 全选 / 清空」），必须再勾「我已知晓整步全量重生成」才能点确认；依赖不满足的步骤会自动取消勾选并提示；弹窗底部预览执行顺序 |
| **重跑前自动备份** | 每次重跑（单步或勾选批量）开始前把该步当前结果写入 `<项目>/backups/<step>-<时间戳>.json`（每步保留最近 5 份）；工具条出现「恢复上次结果」，一键退回（恢复前会把当前结果也备份，可来回切）；下游步骤的状态会一起恢复 |
| **批量重跑顺序与中断** | `run-batch` 按 `script → assets → emotion → storyboard → prompts` 的固定顺序执行勾选步骤（与勾选顺序无关），每步完成后才跑下一步；某步失败立即中断，不会拿失败的上游继续跑下游 |
| 步骤运行中 | SSE 事件驱动进度；若实时通道断开/丢失事件，前端每 8 秒兜底轮询，直到没有 running 步骤（最长约 13 分钟） |
| SSE 断线重连 | 重连成功后自动补拉一次状态与项目列表，避免错过断线期间的事件 |
| 请求超时 | 所有 API 15–30 秒超时（提交/轮询/下载等 CLI 操作 6 分钟）；超时给出明确文案，不会一直转圈 |
| 任务操作 | 批量「轮询全部 / 下载全部 / 同步首帧 / 清理失败」；单任务操作期间按钮互斥；操作完自动刷新状态与图片索引 |
| 图片索引 | 绑定/解绑图片通过 SSE `pipeline` 广播给其它标签页；任务产物下载后自动对上镜头并联动视频首帧 |
| 绑图选择器 | 打开时现场扫描磁盘（103 张约 1 秒），失败只在弹窗内给提示 + 可改手动路径，不影响页面；绑定中锁住缩略图墙防连点；`Esc` / 点遮罩关闭 |
| 解绑后悔 | 解绑后提示条带「撤销」（7 秒），一键恢复；`unbound` 记录让自动匹配不再弹回来 |
| 选图排错 | 「刷新列表」重新扫描目录；无图时给空态文案；缩略图加载失败不破版（`/thumb` 找不到缓存会回落原图） |
| 提示条 | 最多 3 条、1.5 秒内相同文案去重，避免 SSE/批量操作刷屏 |
| 内容渲染 | 单步数据异常只影响该步（显示错误卡片），不整页白屏；全量重绘保留滚动位置 |
| 项目切换/删除 | 竞态用 loadSeq 防串项目；切换时清掉自动轮询定时器；删除后自动选下一个项目或清 URL |
| 新建项目 | 防重复提交、目标时长夹紧 30–1800 秒、输出目录规范化、原文必填 |

## 七、已知边界

- 道具板 6 张在原始文档里就是「待出图」，不在导入范围；需要时生成后会自动对上。
- 段A/段B/段C 的 28 张是"生成单位图"（文件名无镜号），不做自动匹配；选择器里会以「疑似同镜号」推荐（如 `段D_22_…` ↔ `SHOT022`），人工点选即可。
- 未对短视频平台做兼容性测试；UI 回归用 jsdom（DOM/样式断言）+ headless Chrome（CDP 截图，`--headless` 经 `cmd /c` 调用可绕过策略拦截）。
