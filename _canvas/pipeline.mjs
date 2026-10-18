// ============================================================================
// 制作流水线（自研移植版 · pipeline）
// 4 个 Agent：剧本改写 / 资产提取 / 情绪锚点与机位锁 / 分镜拆分 + 提示词生成
// 全部提示词与实现为本项目自写（借鉴「小说→剧本→资产→分镜→提示词→成片」的流程思路，
// 不包含任何第三方项目代码，无 CC 协议传染）。
//
// 用法：server.mjs 启动时 const PIPE = createPipeline({ ROOT, DATA_DIR, getConfig, dreamina, onEvent, log })
// 数据：_canvas/data/pipeline/<id>/state.json（每个流水线项目一份，含各步 md/data 与任务台账）
// ============================================================================
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ------------------------------------------------------------------ 步骤定义
export const STEPS = [
  { key: 'script', name: '① 剧本改写', needs: [], hint: '把小说原文改写成可分镜的剧本（分场/对白/音效/连续性）' },
  { key: 'assets', name: '② 资产提取', needs: ['script'], hint: '提取角色 / 场景 / 道具，给每个素材写清"只控制什么、不控制什么"' },
  { key: 'emotion', name: '③ 情绪锚点 · 机位锁', needs: ['script'], hint: '钉死每一拍要让观众处于什么情绪，并约束 80/15/5 机位配比' },
  { key: 'storyboard', name: '④ 分镜拆分', needs: ['script', 'assets', 'emotion'], hint: '拆成 4–30 秒的生成单位与剪辑镜，逐镜写冻结关键帧提示词' },
  { key: 'prompts', name: '⑤ 提示词生成', needs: ['storyboard', 'assets'], hint: '图片 15 维提示词 + Seedance 2.5 时间轴式视频提示词（含声音时间线）' },
];
export const STEP_KEYS = STEPS.map((s) => s.key);

// ------------------------------------------------------------------ 工艺铁律（自本项目方法文档提炼）
const CRAFT = [
  '【通用铁律】',
  '1. 所有输出是纯 JSON，不要解释、不要 Markdown 代码块围栏。',
  '2. 台词写成 {角色名说："逐字台词"}；音效写成 <声音>音效名</声音>；提示词正文中不得出现【】；不得出现字幕或任何文字叠加。',
  '3. 一段只写一个主动作 + 一个次要动作，写清「起点 → 唯一动作 → 终点」；一个生成单位只写一种运镜（固定／缓推／横移跟拍／环绕升格／缓慢后拉），不写复合运镜。',
  '4. 物理与解剖：单一光源投影一致；接触点有接触阴影；五指与四肢数量正确；不穿插、不穿模；液面水平。',
  '5. 时长预算：台词时长 = 台词字数 ÷ 4.5 字/秒；单镜时长 = max(动作时长, 台词时长) + 0.5 秒余量；单镜 4–30 秒（Seedance 2.5 上限 30 秒）。',
  '6. 除了负面约束字段，正文一律正面陈述，不写「不要…」式否定。',
  '7. 真人实拍写实历史片质感；不出现现代物件、不出现画面内文字（除非该镜明确是标语/招牌）。',
  '8. 【历史人物红线】真实历史人物（毛泽东、朱德、董必武、周恩来等有真实姓名者）不得生成正面标准像特写：只给背影、侧 3/4 或手部；生图/生视频提示词中不得以该人物正脸为主体，也不得出现可辨识的标准像式正脸。',
  '9. 【构图雷区】背景横线不切头切颈；人物不贴画面边缘；无理由不倾斜地平线；对话戏不用中轴正反打（走越肩/斜轴）；同一画面里同一角色只出现一次。',
].join('\n');

const SCRIPT_SCHEMA = {
  seriesTitle: '剧名',
  episodes: [{
    episode: 'EP001',
    title: '本集标题',
    logline: '一句话讲清本集讲什么',
    estSec: 330,
    scenes: [{
      id: 'EP001-SC001',
      interior: true,
      location: '地点（如：茅台镇富商宅院 · 院子）',
      time: '午后',
      summary: '本场一句话',
      elements: [
        { type: 'action', text: '客观可拍的动作/环境描写' },
        { type: 'dialogue', character: '金维映', mode: '说', line: '台词（≤20 字）' },
        { type: 'vo', line: '旁白' },
        { type: 'sfx', text: '音效名' },
        { type: 'transition', text: '转场方式' },
        { type: 'continuity', text: '服装/道具/光向/空间连续性锁' },
        { type: 'onScreenText', text: '画面文字' },
      ],
    }],
  }],
};
const ASSETS_SCHEMA = {
  characters: [{ id: 'IMG-CHR-01', name: '角色名', historical: false, identity: '脸部身份特征（历史人物则写：仅背影／侧 3/4／手部，禁止正面标准像）', look: '造型/服装/道具随身物', controls: '只控制什么', notControls: '不控制什么' }],
  scenes: [{ id: 'IMG-SCN-01', name: '场景名', controls: '只控制什么（空间结构/材质/光向色温）', notControls: '不控制什么' }],
  props: [{ id: 'IMG-PRP-01', name: '道具名', controls: '只控制什么（形制/数量/质感）', notControls: '不控制什么' }],
  groups: [{ name: '群像名', members: ['角色名'] }],
};
const EMOTION_SCHEMA = {
  pct: { normal: 80, emphasis: 15, extreme: 5 },
  anchors: [{ id: 'E01', name: '情境名', scenes: ['EP001-SC001'], goal: '观众情绪目标', means: '实现手段', gear: '常规|强调|极端' }],
  curve: [{ at: '0:00', intensity: 2, anchor: 'E01' }],
  disciplines: ['峰值前后留白', '不许连续两拍同为高强度'],
};
const STORYBOARD_SCHEMA = {
  shots: [{
    id: 'SHOT-EP001-001', sceneId: 'EP001-SC001', dur: 6, emotion: 'E01',
    purpose: '这一镜为什么存在（叙事作用）',
    size: '景别（大远景/远景/全景/中景/中近景/近景/特写）',
    cam: '机位与角度（含视线方向/占画比/切点等显式取景信息）',
    move: '运镜（固定/缓推/横移跟拍/环绕升格/缓慢后拉 之一）',
    start: '起点画面状态', action: '唯一动作（主动作）', end: '终点画面状态',
    sound: '声音（含台词/音效/旁白，写清落在第几秒）',
    visualBasis: '视觉依据（引用了哪些资产 id 与它们控制什么）',
    refs: ['IMG-CHR-01'],
    kfPrompt: '冻结关键帧提示词：写实电影剧照，150–300 字，含显式取景字段、光色、服饰、道具、材质、空气、技术规格',
  }],
};
const PROMPTS_SCHEMA = {
  images: [{
    shotId: 'SHOT-EP001-001',
    prompt: '15 维图片提示词（画种风格/时间/文本关系/参考图/构图与显式取景/光线/色彩/人物比例与面部/服饰考据/建筑考据/器物考据/材质质感/氛围空气/技术规格）',
    negative: '负面约束（至少两条：同一角色在本画面中只出现一次；道具不得与人物头部、身体或服饰相交或穿插）',
  }],
  units: [{
    id: 'MOTION-01', title: '生成单位标题', covers: ['SHOT-EP001-001'], dur: 14,
    firstFrame: '首帧来源（镜头 id）', lastFrame: '末帧锚定说明',
    prompt: '时间轴式提示词：0-6 秒：…；6-10 秒：…；10-14 秒：…（每段写清主体+场景+光色+动作+运镜）',
    env: '环境运动（风/水/烟/光斑）', camera: '运镜（一种）', lip: '口型说明',
    physics: '物理与解剖重点（针对本段最易穿模的地方点名）',
    sound: '声音时间线（台词/音效/旁白，写清秒点）',
  }],
};

// ------------------------------------------------------------------ 工具
function nowISO() { return new Date().toISOString(); }
function rid(prefix = 'p') { return prefix + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
function fmtTC(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function pick(obj, keys, dft = '') {
  for (const k of keys) if (obj && obj[k] != null && String(obj[k]).trim()) return obj[k];
  return dft;
}
function asArray(v) { return Array.isArray(v) ? v : []; }
function str(v, dft = '') { return v == null ? dft : String(v); }
function clean(text) { return String(text || '').replace(/\r\n/g, '\n').trim(); }

function extractJson(text) {
  let t = clean(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('输出中找不到 JSON 对象');
  return JSON.parse(t.slice(s, e + 1));
}

function chunkText(text, maxChars = 6000) {
  const paras = clean(text).split(/\n{1,}/).filter(Boolean);
  const chunks = []; let buf = '';
  for (const p of paras) {
    if ((buf + '\n' + p).length > maxChars && buf) { chunks.push(buf); buf = p; }
    else buf = buf ? buf + '\n' + p : p;
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [clean(text)];
}

function emptySteps() {
  const o = {};
  for (const s of STEPS) o[s.key] = { status: 'idle', md: '', data: null, error: '', at: null, progress: 0, message: '' };
  return o;
}

// ------------------------------------------------------------------ 工厂
export function createPipeline({ ROOT, DATA_DIR, getConfig, dreamina, log = console.log, onEvent = () => {} }) {
  const PIPE_DIR = path.join(DATA_DIR, 'pipeline');
  const TRASH_DIR = path.join(PIPE_DIR, '_trash');
  const running = new Set();     // `${id}:${step}`

  const statePath = (id) => path.join(PIPE_DIR, String(id), 'state.json');
  async function readJSON(p, dft) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return dft; } }
  async function writeJSON(p, obj) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, JSON.stringify(obj, null, 2), 'utf8'); }
  async function loadState(id) { return readJSON(statePath(id), null); }
  async function saveState(st) { st.updatedAt = nowISO(); await writeJSON(statePath(st.id), st); }

  // ---------------------------------------------------------------- 步骤备份（重跑前自动留档，可一键恢复）
  const BACKUP_KEEP = 5;
  const backupDirOf = (id) => path.join(PIPE_DIR, String(id), 'backups');
  async function listBackups(id, step) {
    const dir = backupDirOf(id);
    let files = [];
    try { files = (await fsp.readdir(dir)).filter((f) => f.indexOf(step + '-') === 0 && f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      const m = /-(\d+)\.json$/.exec(f);
      out.push({ file: f, at: m ? Number(m[1]) : 0, step: step });
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }
  /** 把某一步"当前结果"存成备份；空步骤（第一次运行）不产生备份 */
  async function backupStep(st, step, tag) {
    const s = (st.steps || {})[step];
    if (!s) return null;
    const hasData = s.data && Object.keys(s.data || {}).length > 0;
    if (!hasData && !str(s.md)) return null;
    const at = Date.now();
    const downstream = {};
    for (const k of downstreamOf(step)) {
      const ds = st.steps[k];
      if (ds) downstream[k] = { status: ds.status || '', message: ds.message || '', progress: ds.progress };
    }
    const rec = {
      step: step, at: at, tag: tag || 'rerun',
      status: s.status || 'done', message: s.message || '', progress: Number.isFinite(Number(s.progress)) ? Number(s.progress) : 100,
      data: s.data || null, md: s.md || '', downstream: downstream,
    };
    const dir = backupDirOf(st.id);
    await fsp.mkdir(dir, { recursive: true });
    const file = step + '-' + at + '.json';
    await fsp.writeFile(path.join(dir, file), JSON.stringify(rec), 'utf8');
    const all = await listBackups(st.id, step);
    for (const x of all.slice(BACKUP_KEEP)) { try { await fsp.unlink(path.join(dir, x.file)); } catch { /* ignore */ } }
    return { file: file, at: at, step: step };
  }
  /** 恢复某一步重跑前的结果（同时把下游状态一起恢复；当前结果会先备份，可再切回） */
  async function restoreStep(id, step) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    if (!STEP_KEYS.includes(step)) throw new Error('未知步骤：' + step);
    const list = await listBackups(id, step);
    if (!list.length) throw new Error('这一步还没有可恢复的备份（重跑前会自动备份）');
    const rec = await readJSON(path.join(backupDirOf(id), list[0].file), null);
    if (!rec) throw new Error('备份文件读取失败：' + list[0].file);
    // 先把当前结果留档，恢复也能反悔
    await backupStep(st, step, 'before-restore');
    st.steps[step] = {
      status: 'done', data: rec.data, md: rec.md, error: '',
      at: nowISO(), progress: 100,
      message: '已恢复 ' + new Date(rec.at).toLocaleString('zh-CN', { hour12: false }) + ' 的版本',
      restoredFrom: rec.at,
    };
    for (const [k, v] of Object.entries(rec.downstream || {})) {
      if (!st.steps[k]) continue;
      st.steps[k].status = v.status || 'done';
      st.steps[k].message = v.message || '';
      st.steps[k].progress = v.progress;
      st.steps[k].error = '';
    }
    await saveState(st);
    emit(st, step, 'done', 100, '已恢复上次结果');
    let images = { shots: {}, assets: {} };
    try { images = await buildImageIndex(st); } catch { /* ignore */ }
    return { ok: true, step: step, restoredAt: rec.at, images: images, backups: await listBackups(id, step) };
  }

  function emit(st, step, status, progress, message) {
    try {
      onEvent({ id: st.id, step, status, progress, message: message || '', at: Date.now() });
    } catch { /* ignore */ }
  }
  async function setStepProgress(st, step, progress, message) {
    const s = st.steps[step];
    s.progress = Math.max(0, Math.min(100, Math.round(progress)));
    if (message) s.message = message;
    emit(st, step, 'running', s.progress, s.message);
  }

  // ---------------------------------------------------------------- LLM
  function cfg() {
    const c = (typeof getConfig === 'function' ? getConfig() : {}) || {};
    return { baseUrl: c.baseUrl || 'https://api.deepseek.com', apiKey: c.apiKey || '', model: c.model || 'deepseek-flash' };
  }
  async function chat({ system, user, maxTokens = 8000, temperature = 0.35, json = true, timeoutMs = 300000 }) {
    const c = cfg();
    if (!c.apiKey) throw new Error('没有配置 API Key：请先在画布右侧「AI 助手」填入 Key（写在 _canvas/config.json）');
    const url = String(c.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    const send = async (useJson) => {
      const body = {
        model: c.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature, stream: false, max_tokens: maxTokens,
      };
      if (useJson) body.response_format = { type: 'json_object' };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
          body: JSON.stringify(body), signal: ctrl.signal,
        });
        const text = await r.text();
        if (!r.ok) {
          const err = new Error('上游 ' + r.status + '：' + text.slice(0, 400));
          err.status = r.status;
          throw err;
        }
        const d = JSON.parse(text);
        return str(d.choices?.[0]?.message?.content, '');
      } finally { clearTimeout(timer); }
    };
    try {
      return await send(json);
    } catch (e) {
      // 上游不支持 response_format 时回退一次
      if (json && e.status === 400) return await send(false);
      throw e;
    }
  }
  async function askJson({ system, user, maxTokens, temperature, validate }) {
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const u = attempt === 0 ? user
        : user + '\n\n【上一次输出不合规，必须修正】\n错误：' + lastErr + '\n请只输出一个合法 JSON 对象，不要任何解释或代码块围栏。';
      const raw = await chat({ system, user: u, maxTokens, temperature });
      try {
        const obj = extractJson(raw);
        if (validate) validate(obj);
        return obj;
      } catch (e) {
        lastErr = str(e.message || e).slice(0, 500);
        log('[pipeline] JSON 不合规，重试 ' + (attempt + 1) + '：' + lastErr);
        log('[pipeline] 原始输出长度 ' + raw.length + '，末尾：' + String(raw).slice(-200).replace(/\s+/g, ' '));
      }
    }
    throw new Error('模型连续 3 次未给出合规 JSON：' + lastErr);
  }

  // ---------------------------------------------------------------- Agent 1 剧本改写
  async function agentScript(st, onProgress) {
    const src = clean(st.input.source);
    if (!src) throw new Error('缺少小说原文（source 为空）');
    const chunks = chunkText(src, st.input.maxChunk || 7000);
    const sys = [
      '你是短剧编剧 Agent（剧本改写）。把小说原文改写成可直接分镜的剧本。',
      '要求：① 忠实原文情节、人物与关键台词，不新增重大情节；② 按场（scene）组织，写清 内/外、地点、时辰；③ 每场用 elements 数组按可拍摄顺序输出；④ 台词尽量短（单句 ≤ 20 字），保留年代感与方言；⑤ 场与场之间写清转场；⑥ 每场给一条 continuity 连续性锁（服装/道具/光向/空间），这是后续生图生视频不出错的依据。',
      '⚠ 剧本层严禁镜头语言：action 只写客观可拍的人物动作、环境与器物状态，不得出现景别/机位/运镜/焦段/剪辑词（如"特写/近景/缓推/横移/固定/跟拍/切到"），这些全部留给分镜层；台词与旁白里也不写镜头提示。',
      '正例 action：河滩上一排低矮的酿酒作坊，几只大缸半埋在土里，缸口封着黄泥，河风把晾布吹得微微摆动。',
      '误例 action：固定镜头。画面下方是砾石河滩 → 几只大缸顺坡排成一列，镜头始终固定。',
      'action 用完整叙事句，禁止用「→」箭头连接，禁止以"固定/缓推/横移跟拍/特写"开头。',
      'elements.type 只能取：action / dialogue / vo / sfx / transition / continuity / onScreenText。',
      CRAFT,
      '输出 JSON schema（字段名必须一致，只输出 JSON）：',
      JSON.stringify(SCRIPT_SCHEMA, null, 1),
    ].join('\n');

    const episodes = [];
    let prevTail = '';
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(Math.round((i / chunks.length) * 90), `剧本改写：第 ${i + 1}/${chunks.length} 段原文`);
      const u = [
        '项目信息：剧名《' + st.input.project + '》，集号 ' + st.input.episode + '，画面 ' + st.input.ratio + '，风格：' + st.input.style + '。',
        i > 0 ? '【前情（上一段原文结尾，仅用于承接，不要重复写）】\n' + prevTail : '',
        '【本段原文】\n' + chunks[i],
        chunks.length > 1 ? '这是全文第 ' + (i + 1) + '/' + chunks.length + ' 段。只改写本段内容；如本段是中间段，直接从当前情节继续。' : '',
        '请输出 JSON：{"seriesTitle":"…","episodes":[{"episode":"' + st.input.episode + '","title":"本集标题","logline":"…","scenes":[…]}]}',
      ].filter(Boolean).join('\n\n');
      const obj = await askJson({
        system: sys, user: u, maxTokens: 8000, temperature: 0.4,
        validate: (o) => {
          const eps = asArray(o.episodes);
          if (!eps.length) throw new Error('缺少 episodes');
          for (const ep of eps) if (!asArray(ep.scenes).length) throw new Error('某集缺少 scenes');
        },
      });
      for (const ep of asArray(obj.episodes)) episodes.push(ep);
      const lastEp = episodes[episodes.length - 1];
      const lastScene = asArray(lastEp?.scenes).slice(-1)[0];
      const lastEls = asArray(lastScene?.elements);
      prevTail = lastEls.slice(-3).map((e) => str(e.text || e.line)).join(' ').slice(-400);
    }
    // 合并同一集：按集号归并 scenes，并统一重编号
    const byEp = new Map();
    for (const ep of episodes) {
      const key = str(ep.episode, st.input.episode);
      if (!byEp.has(key)) byEp.set(key, { ...ep, episode: key, scenes: [] });
      byEp.get(key).scenes.push(...asArray(ep.scenes));
    }
    const outEps = [...byEp.values()];
    for (const ep of outEps) {
      ep.scenes = asArray(ep.scenes).map((sc, i) => ({
        ...sc,
        id: ep.episode + '-SC' + String(i + 1).padStart(3, '0'),
      }));
    }
    const cleaned = sanitizeScript({ episodes: outEps });
    return {
      seriesTitle: str(episodes[0]?.seriesTitle, st.input.project),
      episodes: cleaned.episodes,
      chunkCount: chunks.length,
    };
  }

  // ---------------------------------------------------------------- Agent 2 资产提取
  // 分批策略：角色每 6 人一批 + 场景/道具单独一批。
  // 原因：整集一次输出 14 角色 + 6 场景 + 6 道具会超单次输出上限，被截断后 JSON 不合规（老实现实测重试 2 次）。
  async function agentAssets(st, onProgress) {
    const script = st.steps.script.data;
    if (!script) throw new Error('请先生成「① 剧本改写」');
    onProgress?.(5, '资产提取：整理剧本人物 / 场景 / 道具清单');
    const scenesAll = asArray(script.episodes).flatMap((ep) => asArray(ep.scenes));
    const names = [];
    const seenName = new Set();
    const props = [];
    const locations = [];
    const seenLoc = new Set();
    const sceneDigest = [];
    for (const sc of scenesAll) {
      const loc = str(sc.location).trim();
      if (loc && !seenLoc.has(loc)) { seenLoc.add(loc); locations.push(loc); }
      const beats = [];
      for (const el of asArray(sc.elements)) {
        const t = str(el.type);
        if (t === 'dialogue') {
          const who = str(el.character).trim();
          if (who && !seenName.has(who)) { seenName.add(who); names.push(who); }
          beats.push((who || '？') + '：' + str(el.line).slice(0, 50));
        } else if (t === 'action') {
          const txt = str(el.text);
          beats.push(txt.slice(0, 70));
          const q = txt.match(/[《「"]([^》」"]{2,12})[》」"]/g) || [];
          for (const x of q) {
            const nm = x.replace(/[《「"》」]/g, '').trim();
            if (nm && props.indexOf(nm) < 0) props.push(nm);
          }
        }
      }
      sceneDigest.push({ id: str(sc.id), location: loc, time: str(sc.time), summary: str(sc.summary).slice(0, 70), beats: beats.slice(0, 14) });
    }
    const craftAssets = [
      '你是短剧美术资产 Agent（资产提取与去重）。只输出 JSON，不要解释、不要 Markdown 围栏。',
      '要求：① 同一人物/场景/道具只出现一次，合并同义项；② 每个素材必须写清"只控制什么、不控制什么"——锚点只控制"是谁/空间/形制"，不控制动作、景别、运镜、光向、情绪强度；③ 角色必须给脸部身份特征与随身物（后续不串脸的关键）；④ 场景给空间结构（门/缸/墙在哪个方向）与光向色温；⑤ 道具给形制、数量、材质；⑥ 真实历史人物（有真实姓名者）historical=true，identity 写"仅背影／侧 3/4／手部，禁止正面标准像"，只写服装形制与体态，不写正脸五官；⑦ 不要编造剧本里不存在的人物。',
      CRAFT,
    ].join('\n');
    const projectLine = '【项目】' + str(script.seriesTitle) + ' ' + st.input.episode + '，画面 ' + st.input.ratio + '，风格：' + st.input.style + '。';

    // ① 角色：按出场顺序分批生成（每批 ≤6 人）
    const charSchema = { characters: [{ name: '角色名', historical: false, identity: '脸部身份特征', look: '造型/服装/随身物', controls: '只控制什么', notControls: '不控制什么' }] };
    const chars = [];
    const per = 6;
    for (let i = 0; i < names.length; i += per) {
      const batch = names.slice(i, i + per);
      onProgress?.(10 + Math.round((i / Math.max(1, names.length)) * 45), '资产提取：角色 ' + (i + 1) + '–' + Math.min(i + per, names.length) + '/' + names.length);
      const obj = await askJson({
        system: craftAssets + '\n输出 JSON schema（字段名必须一致）：\n' + JSON.stringify(charSchema, null, 1),
        user: [
          projectLine,
          '【全部角色（按出场顺序，仅供参考，不要输出本批之外的）】' + JSON.stringify(names),
          '【本批要写的角色】' + JSON.stringify(batch),
          '【场景摘要（供理解人物关系与造型）】\n' + JSON.stringify(sceneDigest),
          '只输出 {"characters":[…]}，本批 ' + batch.length + ' 人必须全部覆盖，顺序与本批名单一致。',
        ].join('\n\n'),
        maxTokens: 4000, temperature: 0.3,
        validate: (o) => { if (!asArray(o.characters).length) throw new Error('缺少 characters'); },
      });
      for (const c of asArray(obj.characters)) {
        const nm = str(c.name).trim();
        if (!nm || chars.some((x) => str(x.name) === nm)) continue;
        chars.push(c);
      }
    }
    // 漏掉的角色补占位，保证下游引用不断
    for (const nm of names) {
      if (!chars.some((c) => str(c.name) === nm)) {
        chars.push({ name: nm, historical: false, identity: '（本批模型未给出，需人工补）', look: '', controls: '身份特征与造型', notControls: '动作、景别、运镜、光向、情绪强度' });
      }
    }

    // ② 场景 + 道具：一次出（输出量小），场景按剧本地点清单对齐
    onProgress?.(65, '资产提取：场景与道具');
    const spSchema = {
      scenes: [{ name: '场景名（对应给定地点清单）', controls: '只控制空间结构/材质/光向色温', notControls: '不控制什么' }],
      props: [{ name: '道具名', controls: '只控制形制/数量/质感', notControls: '不控制什么' }],
    };
    const spObj = await askJson({
      system: craftAssets + '\n输出 JSON schema（字段名必须一致）：\n' + JSON.stringify(spSchema, null, 1),
      user: [
        projectLine,
        '【场景地点清单（按出场顺序，必须每个地点一条，名称用清单原文）】' + JSON.stringify(locations),
        '【道具线索（可能不全，请按剧情补全；同义项合并）】' + JSON.stringify(props),
        '【场景剧情摘要】\n' + JSON.stringify(sceneDigest),
        '只输出 {"scenes":[…],"props":[…]}。',
      ].join('\n\n'),
      maxTokens: 4500, temperature: 0.3,
      validate: (o) => { if (!asArray(o.scenes).length) throw new Error('缺少 scenes'); },
    });
    const scList = asArray(spObj.scenes);
    const scenes = locations.map((loc, i) => {
      const hit = scList.find((s) => str(s.name) && (str(s.name).includes(loc) || loc.includes(str(s.name))));
      return {
        id: 'IMG-SCN-' + String(i + 1).padStart(2, '0'),
        name: str(hit && hit.name) || loc,
        controls: str(hit && hit.controls) || '空间结构与材质（门/墙/器物方位）',
        notControls: str(hit && hit.notControls) || '动作、景别、运镜、光向、情绪强度',
      };
    });
    // 模型额外给的场景（清单里没有的）也保留，编号顺延
    for (const s of scList) {
      const nm = str(s.name).trim();
      if (!nm || scenes.some((x) => x.name.indexOf(nm) >= 0 || nm.indexOf(x.name) >= 0)) continue;
      scenes.push({
        id: 'IMG-SCN-' + String(scenes.length + 1).padStart(2, '0'), name: nm,
        controls: str(s.controls) || '空间结构与材质', notControls: str(s.notControls) || '动作、景别、运镜、光向、情绪强度',
      });
    }
    const propList = asArray(spObj.props).filter((p) => str(p.name));
    const propsOut = propList.map((p, i) => ({
      id: 'IMG-PRP-' + String(i + 1).padStart(2, '0'), name: str(p.name),
      controls: str(p.controls) || '形制/数量/质感', notControls: str(p.notControls) || '动作、景别、运镜、光向、情绪强度',
    }));
    // 线索里有、模型没给的道具补一条，避免漏资产
    for (const hint of props) {
      if (propsOut.some((p) => p.name.indexOf(hint) >= 0 || hint.indexOf(p.name) >= 0)) continue;
      propsOut.push({
        id: 'IMG-PRP-' + String(propsOut.length + 1).padStart(2, '0'), name: hint,
        controls: '形制/数量/质感', notControls: '动作、景别、运镜、光向、情绪强度',
      });
    }
    const characters = chars.map((c, i) => ({
      id: 'IMG-CHR-' + String(i + 1).padStart(2, '0'),
      name: str(c.name).trim(),
      historical: !!c.historical,
      identity: str(c.identity),
      look: str(c.look),
      controls: str(c.controls) || '身份特征与造型',
      notControls: str(c.notControls) || '动作、景别、运镜、光向、情绪强度',
    }));
    // 群像：同一类角色（女红军/战士等）≥2 人时成组，供分镜引用
    const groupNames = characters.filter((c) => /女红军|战士|红军|群像/.test(c.name)).map((c) => c.name);
    const groups = groupNames.length > 1 ? [{ name: '群像', members: groupNames }] : [];
    onProgress?.(95, '资产提取：完成');
    return { characters: characters, scenes: scenes, props: propsOut, groups: groups };
  }

  // ---------------------------------------------------------------- Agent 3 情绪锚点 / 机位锁
  async function agentEmotion(st, onProgress) {
    const script = st.steps.script.data;
    if (!script) throw new Error('请先生成「① 剧本改写」');
    onProgress?.(25, '情绪锚点：计算机位配比与情绪曲线');
    const scenesAll = asArray(script.episodes).flatMap((ep) => asArray(ep.scenes));
    const compact = scenesAll.map((s) => ({ id: s.id, summary: s.summary, elements: asArray(s.elements).map((e) => ({ type: e.type, text: str(e.text || e.line).slice(0, 90) })) }));
    const sys = [
      '你是短剧导演 Agent（情绪锚点与机位锁）。为整集设计「每一拍要让观众处于什么情绪」，并用 80/15/5 机位锁约束机位配比，防止全片平铺直叙。',
      '要求：① 机位分三档：常规（固定/平视/横移跟拍）≥80%、强调（缓推/缓慢后拉/俯拍偏侧）≈15%、极端（环绕升格/越肩俯看/空镜留白）≈5%；② 全片极端机位只用在真正的情绪峰值上（通常 1–2 处）；③ 情绪锚点表 E01… 每行写：情境名、对应场、观众情绪目标、实现手段、机位档；④ 给出文字版情绪强度曲线（0–5 级，标出峰值位置与"留白"位置）；⑤ 纪律：峰值前后必须有留白，不许连续两拍同为高强度。',
      CRAFT,
      '输出 JSON schema（字段名必须一致）：',
      JSON.stringify(EMOTION_SCHEMA, null, 1),
    ].join('\n');
    const user = [
      '【剧本场次摘要】\n' + JSON.stringify(compact, null, 1),
      '【目标时长】' + st.input.targetSec + ' 秒；画面 ' + st.input.ratio + '。',
      '请输出 JSON：{"pct":{"normal":80,"emphasis":15,"extreme":5},"anchors":[…],"curve":[…],"disciplines":[…]}',
    ].join('\n');
    const obj = await askJson({ system: sys, user, maxTokens: 5000, temperature: 0.35, validate: (o) => { if (!asArray(o.anchors).length) throw new Error('缺少 anchors'); } });
    onProgress?.(95, '情绪锚点：完成');
    return {
      pct: obj.pct || { normal: 80, emphasis: 15, extreme: 5 },
      anchors: asArray(obj.anchors),
      curve: asArray(obj.curve),
      disciplines: asArray(obj.disciplines),
    };
  }

  // ---------------------------------------------------------------- Agent 4 分镜拆分
  // 先出镜头表（字段短、可分批），再单独补冻结关键帧提示词（长文本单独成批）——
  // 这样单次输出不会超上限被截断。
  async function fillKfPrompts(st, shots, onProgress) {
    const per = 3;
    for (let i = 0; i < shots.length; i += per) {
      const batch = shots.slice(i, i + per);
      onProgress?.(90 + Math.round((i / Math.max(1, shots.length)) * 8), `关键帧提示词：${i + 1}–${Math.min(i + per, shots.length)}/${shots.length}`);
      const obj = await askJson({
        system: [
          '你是短剧摄影指导 Agent。为分镜写「冻结关键帧提示词」（用于文生图/图生视频首帧）。',
          '每条 150–220 字：写实电影剧照；必须含显式取景字段（人物占画面高度约 X%、画面下沿切在胸口/腰、头顶距上沿约 Y%、机位与距离约 Z 米）、光线方向与色温、色彩、服饰状态、道具状态、材质质感、空气（浮尘/水汽）、技术规格（35mm 定焦/浅景深/电影级实拍剧照）。',
          '不要写镜头运动与后续动作（这是静止的一格）；不要写负面约束；历史人物只写背影/侧 3/4/手部，不写正脸。',
          '只输出 JSON，不要解释。',
        ].join('\n'),
        user: [
          '【项目】' + st.input.episode + '，画面 ' + st.input.ratio + '，风格：' + st.input.style + '。',
          '【本批镜头】\n' + JSON.stringify(batch.map((s) => ({
            id: s.id, size: s.size, cam: s.cam, start: s.start, action: s.action,
            refs: s.refs, costumerie: s.costume || '',
          })), null, 1),
          '【输出格式】{"prompts":[{"shotId":"…","kfPrompt":"…"}]}',
        ].join('\n\n'),
        maxTokens: 6000, temperature: 0.35,
        validate: (o) => { if (!asArray(o.prompts).length) throw new Error('缺少 prompts'); },
      });
      for (const p of asArray(obj.prompts)) {
        const shot = shots.find((s) => s.id === p.shotId) || batch[0];
        if (shot && str(p.kfPrompt)) shot.kfPrompt = str(p.kfPrompt);
      }
    }
    // 兜底：没拿到关键帧提示词的镜头，用分镜字段自动拼一条，保证流程不断
    for (const s of shots) {
      if (!str(s.kfPrompt)) {
        s.kfPrompt = '写实电影剧照，' + str(s.size) + '，' + str(s.cam) + '。' + str(s.start) + ' ' + str(s.action) +
          ' 35mm 定焦浅景深，自然光，低饱和偏暖，空气中有浮尘与水汽，电影级实拍质感，服装与器物表面素净平整。';
      }
    }
    return shots;
  }

  async function agentStoryboard(st, onProgress) {
    const script = st.steps.script.data;
    const assets = st.steps.assets.data;
    const emotion = st.steps.emotion.data;
    if (!script) throw new Error('请先生成「① 剧本改写」');
    if (!emotion) throw new Error('请先生成「③ 情绪锚点 · 机位锁」');
    const scenesAll = asArray(script.episodes).flatMap((ep) => asArray(ep.scenes));
    const assetDigest = assets ? {
      characters: asArray(assets.characters).map((c) => ({ id: c.id, name: c.name, identity: c.identity, look: c.look })),
      scenes: asArray(assets.scenes).map((c) => ({ id: c.id, name: c.name })),
      props: asArray(assets.props).map((c) => ({ id: c.id, name: c.name })),
    } : {};
    const emotionDigest = {
      anchors: asArray(emotion.anchors).map((a) => ({ id: a.id, name: a.name, scenes: a.scenes, gear: a.gear, goal: a.goal })),
      pct: emotion.pct,
      disciplines: emotion.disciplines,
    };
    const sys = [
      '你是短剧导演 Agent（分镜拆分）。把剧本场次拆成"剪辑镜"，并为每镜写出冻结关键帧提示词。',
      '要求：',
      '① 单镜时长 4–30 秒，按 CRAFT 的时长预算公式算，并向上取整留 0.5 秒余量；相邻镜的时长总和应接近目标总时长。',
      '② 机位配比遵守情绪锚点给的 80/15/5，不要连续三镜同机位/同景别。',
      '③ 每镜必须有唯一的「主动作」；起点、动作、终点三段写清楚；有台词时在 sound 里写清台词落在第几秒（字数÷4.5 估算）。',
      '④ 每镜必须引用视觉依据：把用到的资产 id 写进 refs 与 visualBasis（角色锚点只锁"是谁"，不要重描脸型五官；脸的特征让参考图去管）。',
      '⑤ kfPrompt 这一轮先留空字符串 ""（关键帧提示词会单独成批生成）；本轮其它字段要短小精炼，不要写长段落。',
      '⑥ 冷开场/峰值镜要单独拆得短一些，降低崩镜重做成本。',
      CRAFT,
      '输出 JSON schema（字段名必须一致）：',
      JSON.stringify(STORYBOARD_SCHEMA, null, 1),
    ].join('\n');

    // 按场分批：一场一批（单次输出更短，避免被截断；关键帧提示词后续单独成批生成）
    const batches = [];
    const per = 1;
    for (let i = 0; i < scenesAll.length; i += per) batches.push(scenesAll.slice(i, i + per));
    const shotsAll = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      onProgress?.(Math.round((i / batches.length) * 92), `分镜拆分：第 ${i + 1}/${batches.length} 批场次`);
      const u = [
        '【项目】剧名《' + script.seriesTitle + '》，集号 ' + st.input.episode + '，画面 ' + st.input.ratio + '，风格：' + st.input.style + '，目标总时长 ' + st.input.targetSec + ' 秒。',
        '【情绪锚点与机位锁】\n' + JSON.stringify(emotionDigest, null, 1),
        '【资产清单】\n' + JSON.stringify(assetDigest, null, 1),
        '【本批场次】\n' + JSON.stringify(batch, null, 1),
        '【已生成的上一批镜头（仅供衔接参考，不要重复）】\n' + JSON.stringify(shotsAll.slice(-4).map((s) => ({ id: s.id, sceneId: s.sceneId, end: s.end })), null, 1),
        '请输出 JSON：{"shots":[…]}，只含本批场次的镜头。镜号先用 SHOT-XX-001 这样的占位，我会统一重编号。',
      ].join('\n');
      const obj = await askJson({
        system: sys, user: u, maxTokens: 8000, temperature: 0.35,
        validate: (o) => {
          const shots = asArray(o.shots);
          if (!shots.length) throw new Error('缺少 shots');
          for (const s of shots) {
            const d = Number(s.dur);
            if (!(d >= 4 && d <= 30)) throw new Error('镜头时长必须在 4–30 秒：' + JSON.stringify(s).slice(0, 120));
            if (!str(s.action)) throw new Error('镜头缺少 action');
          }
        },
      });
      shotsAll.push(...asArray(obj.shots));
    }
    const shots = shotsAll.map((s, i) => ({
      ...s,
      id: st.input.episode + '-SHOT' + String(i + 1).padStart(3, '0'),
      dur: Math.min(30, Math.max(4, Math.round(Number(s.dur) || 6))),
      refs: asArray(s.refs),
    }));
    await fillKfPrompts(st, shots, onProgress);
    onProgress?.(96, '分镜拆分：合计 ' + shots.length + ' 镜 / ' + shots.reduce((a, s) => a + s.dur, 0) + ' 秒');
    return { shots, totalSec: shots.reduce((a, s) => a + s.dur, 0) };
  }

  // ---------------------------------------------------------------- Agent 5 提示词生成
  async function agentPrompts(st, onProgress) {
    const sb = st.steps.storyboard.data;
    const assets = st.steps.assets.data;
    if (!sb) throw new Error('请先生成「④ 分镜拆分」');
    const shots = asArray(sb.shots);
    const assetDigest = {
      characters: asArray(assets?.characters).map((c) => ({ id: c.id, name: c.name, identity: c.identity, look: c.look, controls: c.controls })),
      scenes: asArray(assets?.scenes).map((c) => ({ id: c.id, name: c.name, controls: c.controls })),
      props: asArray(assets?.props).map((c) => ({ id: c.id, name: c.name, controls: c.controls })),
    };

    // 5a) 图片 15 维提示词
    const sysImg = [
      '你是短剧提示词 Agent（图片/关键帧）。为每个分镜写「冻结关键帧提示词」，用于文生图/图生视频首帧。',
      '必须遵守 15 维模板：①画种与风格锚点 ②时间（时辰/季候/年代/叙事时刻）③文本关系 ④参考图与借鉴点 ⑤构图与镜头（含显式取景字段：人物占画面高度约X%、下沿切在…、头顶距上沿约Y%、机位与距离）⑥光线 ⑦色彩 ⑧人物比例与面部 ⑨服饰考据 ⑩建筑考据 ⑪器物与道具考据 ⑫材质与质感 ⑬氛围与空气 ⑭技术规格（写实电影剧照/35mm/浅景深等）⑮负面约束。',
      '负面约束必带两条：同一角色在本画面中只出现一次，不出现重复人物；道具不得与人物头部、身体或服饰相交或穿插。',
      '参考图只控制"是谁/空间/形制"，提示词正文不要重描参考图里的脸型五官，只写动作、景别、运镜、光、服装状态。',
      CRAFT,
      '输出 JSON schema：',
      JSON.stringify(PROMPTS_SCHEMA.images ? { images: PROMPTS_SCHEMA.images } : {}, null, 1),
    ].join('\n');
    const images = [];
    const perImg = 4;
    for (let i = 0; i < shots.length; i += perImg) {
      const batch = shots.slice(i, i + perImg);
      onProgress?.(Math.round((i / Math.max(1, shots.length)) * 45), `图片提示词：第 ${Math.floor(i / perImg) + 1} 批`);
      const obj = await askJson({
        system: sysImg,
        user: [
          '【资产清单】\n' + JSON.stringify(assetDigest, null, 1),
          '【本批分镜】\n' + JSON.stringify(batch.map((s) => ({ id: s.id, sceneId: s.sceneId, size: s.size, cam: s.cam, move: s.move, start: s.start, action: s.action, end: s.end, kfPrompt: s.kfPrompt, refs: s.refs })), null, 1),
          '【项目】画面 ' + st.input.ratio + '，风格：' + st.input.style + '。',
          '【篇幅】每条 prompt 控制在 260–380 字，negative 40–80 字；只输出 JSON，不要解释。',
          '请输出 JSON：{"images":[{"shotId":"…","prompt":"…","negative":"…"}]}',
        ].join('\n\n'),
        maxTokens: 7000, temperature: 0.35,
        validate: (o) => { if (!asArray(o.images).length) throw new Error('缺少 images'); },
      });
      images.push(...asArray(obj.images));
    }

    // 5b) 视频生成单位（代码先按规则合并，LLM 只写每单位的提示词）
    const units = [];
    let cur = null;
    for (const s of shots) {
      if (!cur) { cur = { covers: [s], dur: s.dur, sceneId: s.sceneId }; continue; }
      const sameScene = cur.sceneId === s.sceneId;
      const nextDur = cur.dur + s.dur;
      if (sameScene && nextDur <= (st.input.unitSec || 15) && cur.covers.length < 4) { cur.covers.push(s); cur.dur = nextDur; }
      else { units.push(cur); cur = { covers: [s], dur: s.dur, sceneId: s.sceneId }; }
    }
    if (cur) units.push(cur);
    units.forEach((u, i) => { u.id = 'MOTION-' + String(i + 1).padStart(2, '0'); });

    const sysVid = [
      '你是短剧提示词 Agent（视频/Seedance 2.5）。为每个生成单位写时间轴式视频提示词。',
      '格式硬要求：',
      '① 提示词主体是"0-6 秒：…；6-10 秒：…"这种时间轴分段，每段写清 主体 + 场景 + 光色 + 动作（按先后与触发）+ 运镜；',
      '② 一个生成单位只用一种运镜，不写复合运镜；一段只写一个主动作 + 一个次要动作；',
      '③ 有台词时写成 {角色名说："逐字台词"} 并标出秒点；音效写成 <声音>音效名</声音>；全程无字幕、无文字叠加；',
      '④ 环境运动必须写明（风、水、烟、光斑），否则画面会"死"；',
      '⑤ 物理与解剖重点要点名本段最易穿模的地方（手/道具/水/衣摆）；',
      '⑥ lip 写清口型：有台词者"嘴唇张合与台词字数匹配、下颌自然"；无正脸者只写侧影/背影。',
      CRAFT,
      '输出 JSON schema：',
      JSON.stringify({ units: PROMPTS_SCHEMA.units }, null, 1),
    ].join('\n');

    const outUnits = [];
    const perUnit = 2;
    for (let i = 0; i < units.length; i += perUnit) {
      const batch = units.slice(i, i + perUnit);
      onProgress?.(50 + Math.round((i / Math.max(1, units.length)) * 45), `视频提示词：第 ${Math.floor(i / perUnit) + 1} 批生成单位`);
      const compact = batch.map((u) => ({
        id: u.id, dur: u.dur,
        shots: u.covers.map((s) => ({ id: s.id, size: s.size, cam: s.cam, move: s.move, start: s.start, action: s.action, end: s.end, sound: s.sound })),
      }));
      const obj = await askJson({
        system: sysVid,
        user: [
          '【本批生成单位】\n' + JSON.stringify(compact, null, 1),
          '【项目】画面 ' + st.input.ratio + '，风格：' + st.input.style + '。',
          '【篇幅】每个单位 prompt 控制在 300–450 字；只输出 JSON，不要解释。',
          '请输出 JSON：{"units":[{"id":"MOTION-01","title":"…","dur":14,"firstFrame":"…","lastFrame":"末帧 → 下一单位首帧","prompt":"0-6 秒：…；6-14 秒：…","env":"…","camera":"…","lip":"…","physics":"…","sound":"…"}]}',
        ].join('\n\n'),
        maxTokens: 7000, temperature: 0.4,
        validate: (o) => {
          const arr = asArray(o.units);
          if (!arr.length) throw new Error('缺少 units');
          for (const u of arr) if (str(u.prompt).length < 80) throw new Error('视频提示词过短：' + str(u.id));
        },
      });
      for (const u of asArray(obj.units)) {
        const ref = units.find((x) => x.id === u.id) || batch[0];
        outUnits.push({
          ...u,
          id: str(u.id, ref.id),
          dur: Number(u.dur) || ref.dur,
          covers: ref.covers.map((s) => s.id),
          firstFrame: str(u.firstFrame, ref.covers[0].id),
        });
      }
    }
    onProgress?.(97, `提示词生成：${images.length} 张关键帧 / ${outUnits.length} 个生成单位`);
    return { images, units: outUnits };
  }

  const AGENTS = { script: agentScript, assets: agentAssets, emotion: agentEmotion, storyboard: agentStoryboard, prompts: agentPrompts };

  /** 下游步骤（递归）：某一步重跑后，这些步骤的结果都应视为过期 */
  function downstreamOf(step) {
    const out = new Set();
    const walk = (k) => {
      for (const s of STEPS) {
        if (s.needs.includes(k) && !out.has(s.key)) { out.add(s.key); walk(s.key); }
      }
    };
    walk(step);
    return [...out];
  }

  // ---------------------------------------------------------------- md 渲染
  // 剧本层兜底清洗：模型仍可能把镜头语言写进 action，这里确定性剥掉（剧本层只留可拍内容）
  function sanitizeScript(data) {
    const CAM = /^(固定镜头|固定机位|固定|缓推镜头|缓推|横移跟拍|跟拍|环绕升格|缓慢后拉|后拉|俯拍|仰拍|特写|近景|中景|中近景|全景|远景|空镜|升格)[^。；;，,]*[。；;，,]?\s*/;
    const CAM_FRAG = /镜头|机位|运镜|取景|焦段|跟拍|推近|后拉|升格/;
    const cleanText = (t) => {
      let s = str(t).replace(/→/g, '，');
      for (let i = 0; i < 4; i++) { const n = s.replace(CAM, ''); if (n === s) break; s = n; }
      const parts = s.split(/(?<=[。；;])|\n/).map((x) => x.trim()).filter(Boolean).filter((x) => !CAM_FRAG.test(x));
      s = parts.join('').replace(/，{2,}/g, '，').replace(/^[，。；;\s]+/, '').trim();
      return s;
    };
    for (const ep of asArray(data.episodes)) {
      for (const sc of asArray(ep.scenes)) {
        sc.elements = asArray(sc.elements).map((el) => {
          if (el.type === 'action') {
            const t = cleanText(el.text);
            return t ? { ...el, text: t } : null;
          }
          return el;
        }).filter(Boolean);
      }
    }
    return data;
  }

  function renderScriptMd(st, data) {
    const lines = [];
    lines.push('# ' + str(data.seriesTitle, st.input.project));
    lines.push('');
    for (const ep of asArray(data.episodes)) {
      lines.push('## ' + str(ep.episode) + ' ' + str(ep.title, ''));
      if (ep.logline) lines.push('', '> ' + ep.logline);
      lines.push('');
      for (const sc of asArray(ep.scenes)) {
        const io = sc.interior ? '内' : '外';
        lines.push('## ' + str(sc.id) + ' ' + io + ' · ' + str(sc.location) + ' · ' + str(sc.time));
        lines.push('');
        for (const el of asArray(sc.elements)) {
          const t = el.type;
          if (t === 'action') lines.push(str(el.text), '');
          else if (t === 'dialogue') {
            const mode = str(el.mode);
            lines.push(str(el.character) + (mode && mode !== '说' ? '（' + mode + '）' : '') + '：' + str(el.line), '');
          } else if (t === 'vo') lines.push('[VO] 旁白：' + str(el.line), '');
          else if (t === 'sfx') lines.push('[SFX] ' + str(el.text), '');
          else if (t === 'transition') lines.push('[转场] ' + str(el.text), '');
          else if (t === 'continuity') lines.push('[连续性] ' + str(el.text), '');
          else if (t === 'onScreenText') lines.push('[画面文字] ' + str(el.text), '');
          else if (t === 'action') lines.push(str(el.text), '');
        }
        lines.push('');
      }
    }
    return lines.join('\n').trim() + '\n';
  }

  function renderAssetsMd(st, data) {
    return {
      characters: [
        '# 人物设定 · ' + st.input.episode,
        '',
        '> 锚点只控制「是谁」，不控制「在做什么」。参考图 ≤2 张/次；挂锚点后提示词不重描脸型五官。',
        '',
        '| id | 角色 | 历史人物 | 脸部身份 | 造型 / 随身物 | 只控制 | 不控制 |',
        '|---|---|---|---|---|---|---|',
        ...asArray(data.characters).map((c) => '| ' + [c.id, c.name, c.historical ? '是（仅背影/侧3/4）' : '否', c.identity, c.look, c.controls, c.notControls].map((x) => str(x)).join(' | ') + ' |'),
        ...(asArray(data.groups).length ? ['', '## 群像', '', '| 群像 | 成员 |', '|---|---|', ...asArray(data.groups).map((g) => '| ' + str(g.name) + ' | ' + asArray(g.members).join('、') + ' |')] : []),
        '',
      ].join('\n'),
      scenes: [
        '# 场景资产提示词 · ' + st.input.episode, '',
        '| id | 场景 | 只控制 | 不控制 |', '|---|---|---|---|',
        ...asArray(data.scenes).map((c) => '| ' + [c.id, c.name, c.controls, c.notControls].map((x) => str(x)).join(' | ') + ' |'), '',
      ].join('\n'),
      props: [
        '# 道具资产提示词 · ' + st.input.episode, '',
        '| id | 道具 | 只控制 | 不控制 |', '|---|---|---|---|',
        ...asArray(data.props).map((c) => '| ' + [c.id, c.name, c.controls, c.notControls].map((x) => str(x)).join(' | ') + ' |'), '',
      ].join('\n'),
    };
  }

  function renderEmotionMd(st, data) {
    const pct = data.pct || {};
    const lines = [
      '# 情绪锚点表 · ' + st.input.episode, '',
      '> 用途：把"每一拍要让观众处于什么情绪"钉死，并用 80/15/5 机位锁约束机位配比。', '',
      '## 一、80/15/5 机位锁', '',
      '| 档位 | 占比 |', '|---|---|',
      '| 常规（固定/平视/横移） | ' + str(pct.normal, '80') + '% |',
      '| 强调（缓推/缓慢后拉/俯拍偏侧） | ' + str(pct.emphasis, '15') + '% |',
      '| 极端（环绕升格/越肩俯看/空镜） | ' + str(pct.extreme, '5') + '% |', '',
      '## 二、情绪锚点表', '',
      '| 情境 ID | 情境名 | 所在场 | 观众情绪目标 | 手段 | 机位档 |', '|---|---|---|---|---|---|',
      ...asArray(data.anchors).map((a) => '| ' + [a.id, a.name, asArray(a.scenes).join('、'), a.goal, a.means, a.gear].map((x) => str(x)).join(' | ') + ' |'), '',
      '## 三、情绪曲线', '',
      '```',
      ...asArray(data.curve).map((c) => str(c.at) + '  ' + '█'.repeat(Math.max(0, Math.min(5, Number(c.intensity) || 0))) + '  ' + str(c.anchor) + ' ' + str(c.name || '')),
      '```', '',
      ...(asArray(data.disciplines).length ? ['**纪律**：' + asArray(data.disciplines).join('；')] : []),
      '',
    ];
    return lines.join('\n');
  }

  function renderStoryboardMd(st, data) {
    const lines = ['# ' + st.input.episode + ' 分镜', '',
      '> 共 ' + asArray(data.shots).length + ' 镜，合计 ' + str(data.totalSec) + ' 秒；画面 ' + st.input.ratio + '，风格：' + st.input.style + '。', ''];
    for (const s of asArray(data.shots)) {
      lines.push('## ' + str(s.id) + ' · ' + str(pick(s, ['title'], '')).trim());
      lines.push('- 来源：' + str(s.sceneId));
      lines.push('- 时长：' + str(s.dur) + 's');
      if (s.emotion) lines.push('- 情绪锚点：' + str(s.emotion));
      lines.push('- 目的：' + str(s.purpose));
      lines.push('- 景别/机位：' + str(s.size) + '，' + str(s.cam));
      lines.push('- 运镜：' + str(s.move));
      lines.push('- 起点：' + str(s.start));
      lines.push('- 唯一动作：' + str(s.action));
      lines.push('- 终点：' + str(s.end));
      lines.push('- 声音：' + str(s.sound));
      lines.push('- 视觉依据：' + str(s.visualBasis));
      lines.push('- 输入参考图：' + (asArray(s.refs).length ? asArray(s.refs).join('、') : '无'));
      lines.push('', '### 冻结关键帧提示词', '> ' + str(s.kfPrompt), '');
    }
    return lines.join('\n');
  }

  function renderPromptsMd(st, data) {
    const images = ['# 图片提示词 · ' + st.input.episode, '', '> 15 维模板；含显式取景字段与两条负面约束。', ''];
    for (const im of asArray(data.images)) {
      images.push('## ' + str(im.shotId), '', '> ' + str(im.prompt), '', '- 负面约束：' + str(im.negative), '');
    }
    const units = ['# 视频提示词 · ' + st.input.episode + '（' + asArray(data.units).length + ' 个生成单位）', '',
      '> 锁：Seedance 2.5 · ' + st.input.ratio + ' · 720p · 单条 4–30 秒；台词 {角色说："…"}，音效 <声音>…</声音>，全程无字幕。', ''];
    let t = 0;
    for (const u of asArray(data.units)) {
      const dur = Number(u.dur) || 0;
      units.push('## ' + str(u.id) + ' ' + str(u.title) + '｜' + fmtTC(t) + '–' + fmtTC(t + dur) + '｜' + dur + 's');
      units.push('- **覆盖**：' + asArray(u.covers).join(' ／ '));
      units.push('- **首帧**：' + str(u.firstFrame) + '｜**末帧锚定**：' + str(u.lastFrame));
      units.push('- **提示词**：', '  > ' + str(u.prompt));
      units.push('  > 环境运动：' + str(u.env) + '｜运镜：' + str(u.camera) + '｜口型：' + str(u.lip));
      units.push('  > 物理与解剖铁律：' + str(u.physics));
      units.push('- **声音**：' + str(u.sound), '');
      t += dur;
    }
    return { images: images.join('\n'), video: units.join('\n') };
  }

  function mdOf(st, step) {
    const data = st.steps[step]?.data;
    if (!data) return '';
    if (step === 'script') return renderScriptMd(st, data);
    if (step === 'assets') { const r = renderAssetsMd(st, data); return [r.characters, r.scenes, r.props].join('\n---\n\n'); }
    if (step === 'emotion') return renderEmotionMd(st, data);
    if (step === 'storyboard') return renderStoryboardMd(st, data);
    if (step === 'prompts') { const r = renderPromptsMd(st, data); return [r.images, r.video].join('\n---\n\n'); }
    return '';
  }

  // ---------------------------------------------------------------- 任务台账
  function taskSummary(tasks) {
    const a = asArray(tasks);
    return {
      total: a.length,
      pending: a.filter((t) => ['pending', 'submitted', 'querying', 'running'].includes(t.status)).length,
      success: a.filter((t) => t.status === 'success').length,
      fail: a.filter((t) => t.status === 'fail').length,
    };
  }
  function buildTasksFromPrompts(st) {
    const sb = st.steps.storyboard.data || { shots: [] };
    const pr = st.steps.prompts.data || { images: [], units: [] };
    const tasks = [];
    for (const im of asArray(pr.images)) {
      const shot = asArray(sb.shots).find((s) => s.id === im.shotId) || {};
      tasks.push({
        id: rid('t'), type: 'image', shotId: str(im.shotId), title: (str(shot.size) || '关键帧') + ' · ' + str(im.shotId),
        status: 'pending', attempts: 0, submitId: '', credits: null, files: [], error: '',
        prompt: str(im.prompt) + (im.negative ? '\n负面约束：' + im.negative : ''),
        params: { model: '5.0', resolution: '2k', ratio: st.input.ratio, n: 1 },
        at: Date.now(),
      });
    }
    for (const u of asArray(pr.units)) {
      tasks.push({
        id: rid('t'), type: 'video', shotId: str(asArray(u.covers)[0] || ''), title: str(u.id) + ' · ' + str(u.title),
        status: 'pending', attempts: 0, submitId: '', credits: null, files: [], error: '',
        prompt: str(u.prompt) + (u.sound ? '\n声音：' + str(u.sound) : ''),
        params: {
          model: st.input.videoModel || 'seedance2.0fast', resolution: '720p', ratio: st.input.ratio,
          duration: Math.min(30, Math.max(4, Math.round(Number(u.dur) || 10))),
          firstFrame: str(u.firstFrame),
          coverShots: asArray(u.covers),
          unitId: str(u.id),
        },
        at: Date.now(),
      });
    }
    return tasks;
  }

  /** 图片任务出图后，把该镜的图片自动挂成对应视频任务的首帧 */
  function linkVideoFirstFrames(st) {
    const imgByShot = new Map();
    for (const t of asArray(st.tasks)) {
      if (t.type !== 'image' || t.status !== 'success' || !asArray(t.files).length) continue;
      imgByShot.set(t.shotId, t.files[0]);
    }
    let linked = 0;
    for (const t of asArray(st.tasks)) {
      if (t.type !== 'video') continue;
      const covers = asArray(t.params?.coverShots);
      if (!covers.length) continue;
      const cur = String(t.params?.firstFrame || '');
      if (/\.(png|jpe?g|webp)$/i.test(cur)) continue;   // 已经是图片路径
      for (const sid of covers) {
        const f = imgByShot.get(sid);
        if (f) { t.params = { ...(t.params || {}), firstFrame: f }; linked++; break; }
      }
    }
    return linked;
  }

  async function submitTask(st, t) {    if (!dreamina || !dreamina.available) throw new Error('本机未检测到即梦 CLI，无法提交（可先把台账建好，换到有 CLI 的机器再提交）');
    const r = t.type === 'image'
      ? await dreamina.submitImage({ prompt: t.prompt, ratio: t.params?.ratio, model: t.params?.model, resolution: t.params?.resolution, n: t.params?.n })
      : await dreamina.submitVideo({ prompt: t.prompt, duration: t.params?.duration, model: t.params?.model, resolution: t.params?.resolution, image: t.params?.firstFrame, ratio: t.params?.ratio });
    if (!r || !r.submitId) throw new Error('提交未返回 submit_id：' + str(r && r.raw).slice(0, 300));
    t.status = 'submitted'; t.submitId = r.submitId; t.attempts = (t.attempts || 0) + 1;
    t.params = { ...(t.params || {}), args: r.args };
    t.error = '';
    return t;
  }

  // ---------------------------------------------------------------- 对外 API
  async function meta() {
    const c = cfg();
    return {
      ok: true,
      root: ROOT,
      model: c.model,
      models: Array.isArray((getConfig() || {}).models) ? getConfig().models : [c.model],
      defaultDir: '流水线/新剧EP001',
      ratios: ['9:16', '16:9'],
      videoModels: ['seedance2.5', 'seedance2.0_vip', 'seedance2.0', 'seedance2.0fast', 'seedance2.0mini'],
      defaultVideoModel: 'seedance2.0fast',
      dreamina: dreamina ? { available: !!dreamina.available, bin: str(dreamina.bin), reason: str(dreamina.reason) } : { available: false, bin: '', reason: '未接入' },
      steps: STEPS.map((s) => ({ key: s.key, name: s.name, needs: s.needs, hint: s.hint })),
    };
  }

  async function list() {
    let dirs = [];
    try { dirs = (await fsp.readdir(PIPE_DIR, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== '_trash').map((d) => d.name); } catch { dirs = []; }
    const items = [];
    for (const d of dirs) {
      const st = await loadState(d);
      if (!st) continue;
      items.push({
        id: st.id, name: st.name, dir: st.input?.dir || '', episode: st.input?.episode || '',
        createdAt: st.createdAt, updatedAt: st.updatedAt,
        stepStatus: Object.fromEntries(STEP_KEYS.map((k) => [k, st.steps?.[k]?.status || 'idle'])),
        tasks: taskSummary(st.tasks),
      });
    }
    items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return { ok: true, items };
  }

  async function create(body) {
    const name = clean(body.name) || ('流水线 ' + new Date().toISOString().slice(11, 19));
    const st = {
      id: rid('p'),
      name,
      createdAt: nowISO(), updatedAt: nowISO(),
      input: {
        project: clean(body.name) || '新剧',
        episode: clean(body.episode) || 'EP001',
        dir: clean(body.dir) || '流水线/新剧EP001',
        ratio: body.ratio === '16:9' ? '16:9' : '9:16',
        style: clean(body.style) || '真人实拍写实历史片',
        targetSec: Math.min(1800, Math.max(30, Number(body.targetSec) || 330)),
        unitSec: Math.min(20, Math.max(8, Number(body.unitSec) || 15)),
        model: clean(body.model) || cfg().model,
        source: clean(body.source),
        notes: clean(body.notes),
      },
      steps: emptySteps(),
      tasks: [],
      logs: [],
    };
    await saveState(st);
    log('[pipeline] 新建 ' + st.id + ' · ' + st.name);
    return { ok: true, id: st.id };
  }

  // ---------------------------------------------------------------- 图片索引（任务产物 + 手动绑定 + 文件名匹配）
  const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
  function bindsOf(st) {
    if (!st.input.binds || typeof st.input.binds !== 'object') st.input.binds = { shots: {}, assets: {} };
    if (!st.input.binds.shots) st.input.binds.shots = {};
    if (!st.input.binds.assets) st.input.binds.assets = {};
    return st.input.binds;
  }
  function histOf(st) {
    if (!Array.isArray(st.input.bindHistory)) st.input.bindHistory = [];
    return st.input.bindHistory;
  }
  /** 记一笔「这一项用过哪张图」：解绑后还能在选择器顶部找回来 */
  function pushHistory(st, rec) {
    if (!rec || !rec.path) return;
    const list = histOf(st);
    const same = (h) => h.kind === rec.kind && h.key === rec.key && h.path === rec.path;
    const rest = list.filter((h) => !same(h));
    rest.unshift({ kind: rec.kind, key: rec.key, path: rec.path, at: nowISO() });
    st.input.bindHistory = rest.slice(0, 200);
  }
  /** 用户主动解绑过的项：文件名自动匹配要尊重这个意图，不要悄悄又给他绑回去 */
  function unboundSet(st) {
    if (!st.input.unbound || typeof st.input.unbound !== 'object') st.input.unbound = { shots: {}, assets: {} };
    if (!st.input.unbound.shots) st.input.unbound.shots = {};
    if (!st.input.unbound.assets) st.input.unbound.assets = {};
    return st.input.unbound;
  }
  function assetListOf(st) {
    return [
      ...asArray(st.steps?.assets?.data?.characters),
      ...asArray(st.steps?.assets?.data?.scenes),
      ...asArray(st.steps?.assets?.data?.props),
    ];
  }
  function shotListOf(st) { return asArray(st.steps?.storyboard?.data?.shots); }
  function relName(rel) { const p = String(rel || '').replace(/\\/g, '/'); const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }
  function relDir(rel) { const p = String(rel || '').replace(/\\/g, '/'); const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; }
  /** 名称归一：去扩展名/小写/去空白与分隔符（04_酒厂老板.png → 酒厂老板） */
  function normName(v) {
    return String(v == null ? '' : v)
      .replace(/\.(png|jpe?g|webp|gif)$/i, '')
      .toLowerCase()
      .replace(/[\s_\-—–·•·.]+/g, '');
  }
  /** 文件名去掉编号前缀后和中文名比对（01_金维映 / S5_赤水河滩酒厂_午后 / A2_酒厂买酒_SHOT017） */
  function baseNameMatch(fileBase, name) {
    const nn = normName(name);
    if (!nn || nn.length < 2) return false;
    const b = String(fileBase || '').replace(/\.(png|jpe?g|webp|gif)$/i, '');
    if (normName(b) === nn) return true;
    const stripped = b.replace(/^[A-Za-z]{0,2}\d{1,4}[\s_\-.·]*/, '');
    if (stripped && stripped !== b) {
      const sn = normName(stripped);
      if (sn === nn) return true;
      if (sn.length <= nn.length + 6 && sn.endsWith(nn)) return true;   // 「酒厂老板_定妆」这类后缀
    }
    return false;
  }
  /** 项目里可能放图的目录：项目输出目录 + 即梦产物 + 已绑定/历史绑定/任务产物的所在目录 */
  function scanDirsOf(st, binds) {
    const set = new Set();
    const addFile = (v) => {
      const d = relDir(v);
      if (d && !/^_canvas\//.test(d) && !/^thumbs\//.test(d)) set.add(d);
    };
    const outDir = String(st.input.dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (outDir) set.add(outDir);
    set.add('即梦产物');
    for (const v of Object.values((binds && binds.shots) || {})) addFile(v);
    for (const v of Object.values((binds && binds.assets) || {})) addFile(v);
    for (const h of histOf(st)) addFile(h.path);
    for (const t of asArray(st.tasks)) for (const f of asArray(t.files)) addFile(f);
    for (const d of asArray(st.input.imageDirs)) {
      const p = String(d || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (p) set.add(p);
    }
    return [...set];
  }
  /** 递归列图片（限深度 4 / 总量 4000，避免扫到大目录卡住） */
  async function listImages(dirs) {
    const out = [];
    const seen = new Set();
    const MAX = 4000;
    const walk = async (relDirPath, depth) => {
      if (out.length >= MAX || depth > 4) return;
      const absDir = path.join(ROOT, relDirPath);
      if (!(absDir === ROOT || absDir.startsWith(ROOT + path.sep))) return;
      let ents = [];
      try { ents = await fsp.readdir(absDir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (out.length >= MAX) return;
        if (!ent.name || ent.name.startsWith('.')) continue;
        const rel = relDirPath ? relDirPath + '/' + ent.name : ent.name;
        if (ent.isDirectory()) { await walk(rel, depth + 1); continue; }
        if (!IMG_RE.test(ent.name) || seen.has(rel)) continue;
        seen.add(rel);
        out.push(rel);
      }
    };
    for (const d of dirs) await walk(d, 0);
    return out;
  }

  async function buildImageIndex(st) {
    const shots = {};
    const assets = {};
    const src = {};
    const binds = bindsOf(st);
    // ① 手动绑定优先级最高
    for (const [k, v] of Object.entries(binds.shots || {})) {
      if (v && fs.existsSync(path.join(ROOT, String(v).replace(/\\/g, '/')))) { shots[k] = v; src[k] = 'bind'; }
    }
    for (const [k, v] of Object.entries(binds.assets || {})) {
      if (v && fs.existsSync(path.join(ROOT, String(v).replace(/\\/g, '/')))) { assets[k] = v; src[k] = 'bind'; }
    }
    // ② 任务产物（出图成功即对上）
    for (const t of asArray(st.tasks)) {
      const f = asArray(t.files).find((x) => IMG_RE.test(String(x)));
      if (!f) continue;
      if (t.type === 'image' && t.shotId && !shots[String(t.shotId)]) { shots[String(t.shotId)] = f; src['shot:' + t.shotId] = 'task'; }
    }
    // ③ 文件名匹配（保守：完整镜头 ID / 短镜头号 / 资产中文名；同一项有多张候选则宁可不绑，留给选择器手选）
    const shotList = shotListOf(st);
    const assetList = assetListOf(st);
    const files = await listImages(scanDirsOf(st, binds));
    const unbound = unboundSet(st);
    const shotCands = new Map();
    const assetCands = new Map();
    const addCand = (map, k, rel) => {
      const list = map.get(k) || [];
      if (!list.includes(rel)) list.push(rel);
      map.set(k, list);
    };
    const shotShort = (sid) => {
      const m = /SHOT[-_]?0*(\d{1,4})$/i.exec(String(sid)) || /(\d{3,4})$/.exec(String(sid));
      return m ? m[1] : '';
    };
    const VAR_RE = /[_\-]v\d+(\.|$)/i;
    for (const rel of files) {
      const name = relName(rel);
      const low = name.toLowerCase();
      const base = name.replace(/\.(png|jpe?g|webp|gif)$/i, '');
      const inAuxDir = /(故事板|storyboard|候选|样片)/i.test(rel);
      for (const s of shotList) {
        const sid = String(s.id || '');
        if (!sid || shots[sid] || unbound.shots[sid]) continue;
        const shortId = shotShort(sid);
        const hitFull = low.includes(sid.toLowerCase());
        const hitShort = shortId && !inAuxDir && new RegExp('shot[-_]?0*' + shortId + '(?!\\d)', 'i').test(base);
        if (hitFull || hitShort) addCand(shotCands, sid, rel);
      }
      for (const a of assetList) {
        const aid = String(a.id || '');
        if (!aid || assets[aid] || unbound.assets[aid]) continue;
        if (low.includes(aid.toLowerCase()) || baseNameMatch(base, a.name)) addCand(assetCands, aid, rel);
      }
    }
    const takeUnique = (map, into, prefix) => {
      for (const [k, list] of map.entries()) {
        const plain = list.filter((r) => !VAR_RE.test(relName(r)));
        const pick = plain.length === 1 ? plain[0] : (list.length === 1 ? list[0] : '');
        if (pick) { into[k] = pick; src[prefix + k] = 'file'; }
      }
    };
    takeUnique(shotCands, shots, 'shot:');
    takeUnique(assetCands, assets, 'asset:');
    return { shots, assets };
  }

  async function getState(id) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    let images = { shots: {}, assets: {} };
    try { images = await buildImageIndex(st); } catch { /* ignore */ }
    const backups = {};
    for (const k of STEP_KEYS) {
      try { const list = await listBackups(id, k); if (list.length) backups[k] = list[0]; } catch { /* ignore */ }
    }
    return { ok: true, state: { ...st, images, backups } };
  }

  /** 手动绑定已有图片到镜头/资产：kind = shot | asset */
  async function bindImage(id, body) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    const kind = clean(body.kind);
    const key = clean(body.key);
    const rel = clean(body.path).replace(/\\/g, '/').replace(/^\/+/, '');
    if (kind !== 'shot' && kind !== 'asset') throw new Error('kind 只能是 shot 或 asset');
    if (!key) throw new Error('缺少 key（镜头 ID 或资产 ID）');
    if (!rel) throw new Error('缺少图片路径');
    const abs = path.resolve(ROOT, rel);
    if (!(abs === ROOT || abs.startsWith(ROOT + path.sep))) throw new Error('图片路径必须在项目目录内');
    if (!fs.existsSync(abs)) throw new Error('文件不存在：' + rel);
    if (!IMG_RE.test(rel)) throw new Error('不是图片文件：' + rel);
    const binds = bindsOf(st);
    (kind === 'shot' ? binds.shots : binds.assets)[key] = rel;
    delete unboundSet(st)[kind === 'shot' ? 'shots' : 'assets'][key];
    pushHistory(st, { kind, key, path: rel });
    await saveState(st);
    return { ok: true, kind, key, path: rel, images: await buildImageIndex(st) };
  }

  async function unbindImage(id, body) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    const binds = bindsOf(st);
    const kind = clean(body.kind);
    const key = clean(body.key);
    if (kind !== 'shot' && kind !== 'asset') throw new Error('kind 只能是 shot 或 asset');
    const prev = kind === 'shot' ? binds.shots[key] : binds.assets[key];
    if (kind === 'shot') delete binds.shots[key]; else delete binds.assets[key];
    // 解绑要可逆：记下这次解掉的图（选择器里置顶），并记住"这一项用户主动不要自动匹配"
    if (prev) pushHistory(st, { kind, key, path: prev });
    unboundSet(st)[kind === 'shot' ? 'shots' : 'assets'][key] = true;
    await saveState(st);
    return { ok: true, kind, key, prevPath: String(prev || ''), images: await buildImageIndex(st) };
  }

  /** 图片候选：给「绑定图片 / 换图」选择器用（项目里出现过的所有图 + 上次解绑的图 + 同名/ID 推荐） */
  async function imageCandidates(id, query) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    const kind = clean(query && query.kind) === 'shot' ? 'shot' : 'asset';
    const key = clean(query && query.key);
    const q = clean(query && query.q).toLowerCase();
    const binds = bindsOf(st);
    const hist = histOf(st);
    const curMap = kind === 'shot' ? binds.shots : binds.assets;
    const current = String(curMap[key] || '');
    const asset = kind === 'asset' ? assetListOf(st).find((a) => String(a.id) === key) : null;
    const shot = kind === 'shot' ? shotListOf(st).find((s) => String(s.id) === key) : null;
    const targetName = asset ? String(asset.name || '') : '';
    let targetLabel = targetName || key;
    if (kind === 'shot' && shot) {
      const n = (String(key).match(/SHOT[-_]?0*(\d{1,4})$/i) || [])[1] || '';
      targetLabel = '#' + (n || '?') + (shot.size ? ' · ' + shot.size : '') + (shot.dur ? ' · ' + shot.dur + 's' : '');
    }
    const files = await listImages(scanDirsOf(st, binds));
    const usedBy = new Map();
    for (const [k, v] of Object.entries(binds.shots || {})) if (v) usedBy.set(String(v), 'shot:' + k);
    for (const [k, v] of Object.entries(binds.assets || {})) if (v) usedBy.set(String(v), 'asset:' + k);
    const histHit = new Set(hist.filter((h) => h.kind === kind && h.key === key).map((h) => String(h.path)));
    const selfTag = kind + ':' + key;
    const lowKey = key.toLowerCase();
    const outDir = String(st.input.dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    // 排序加权：项目自己的产出目录 > 制作成果类目录 > 其它（即梦产物/画布缓存等）
    const dirBonus = (rel) => {
      let b = 0;
      if (outDir && (rel === outDir || rel.startsWith(outDir + '/'))) b += 80;
      if (/(制作成果|产出|成品|成片|锚点|故事板|样片)/i.test(rel)) b += 40;
      return b;
    };
    const shortId = kind === 'shot' ? ((String(key).match(/SHOT[-_]?0*(\d{1,4})$/i) || [])[1] || '') : '';
    const items = [];
    for (const rel of files) {
      const name = relName(rel);
      const low = name.toLowerCase();
      const base = name.replace(/\.(png|jpe?g|webp|gif)$/i, '');
      let score = 0;
      let reason = '';
      if (rel === current) { score = 1050; reason = '当前绑定'; }
      else if (histHit.has(rel)) { score = 1000; reason = '上次解绑的图'; }
      else if (lowKey && low.includes(lowKey)) { score = 800; reason = 'ID 匹配'; }
      else if (baseNameMatch(base, targetName)) { score = 700; reason = '同名匹配'; }
      else if (shortId && !/(故事板|storyboard|候选|样片)/i.test(rel)
        && new RegExp('shot[-_]?0*' + shortId + '(?!\\d)', 'i').test(base)) { score = 650; reason = '镜头号匹配'; }
      else if (shortId && new RegExp('(?:^|[^0-9])0*' + shortId + '(?!\\d)').test(base)) { score = 600; reason = '疑似同镜号'; }
      else score = dirBonus(rel);
      const owner = usedBy.get(rel) || '';
      const inUse = !!owner && owner !== selfTag;
      items.push({ path: rel, name: name, dir: relDir(rel), score: score, reason: reason, inUse: inUse, usedBy: inUse ? owner : '' });
    }
    items.sort((a, b) => (b.score - a.score)
      || ((a.inUse ? 1 : 0) - (b.inUse ? 1 : 0))
      || ((a.reason ? 0 : 1) - (b.reason ? 0 : 1))
      || a.path.localeCompare(b.path));
    const filtered = q ? items.filter((it) => it.path.toLowerCase().includes(q)) : items;
    return {
      ok: true, kind, key,
      target: { kind, key, name: targetName, label: targetLabel, current },
      dirs: scanDirsOf(st, binds),
      scanned: items.length, total: filtered.length,
      history: hist.filter((h) => h.kind === kind && h.key === key).slice(0, 8).map((h) => h.path),
      items: filtered.slice(0, 300),
    };
  }

  async function update(id, patch) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    if (patch.name) st.name = clean(patch.name).slice(0, 80) || st.name;
    if (patch.input && typeof patch.input === 'object') {
      for (const k of ['dir', 'episode', 'ratio', 'style', 'targetSec', 'model', 'videoModel', 'source', 'notes', 'project']) {
        if (patch.input[k] !== undefined) st.input[k] = patch.input[k];
      }
    }
    await saveState(st);
    return { ok: true };
  }

  async function remove(id) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    await fsp.mkdir(TRASH_DIR, { recursive: true });
    const dest = path.join(TRASH_DIR, st.id + '-' + Date.now());
    try { await fsp.rename(path.join(PIPE_DIR, st.id), dest); } catch { /* ignore */ }
    return { ok: true, trash: dest };
  }

  async function saveMd(id, step, md) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    if (!STEP_KEYS.includes(step)) throw new Error('未知步骤：' + step);
    st.steps[step].md = String(md ?? '');
    st.steps[step].at = nowISO();
    await saveState(st);
    return { ok: true };
  }

  function stepNameOf(k) { return (STEPS.find((x) => x.key === k) || {}).name || k; }

  /** 实际执行一步：标记 running → 调 Agent → 落盘 → 下游标 stale；返回 'done' / 'error' */
  async function executeStep(id, step, meta) {
    const label = (meta && meta.pos) ? ('批量 ' + meta.pos + '/' + meta.total + ' · ') : '';
    try {
      const fresh = await loadState(id);
      fresh.steps[step] = { ...fresh.steps[step], status: 'running', progress: 1, message: label + '开始…', error: '' };
      await saveState(fresh);
      emit(fresh, step, 'running', 1, fresh.steps[step].message);
      const onProgress = (p, m) => {
        const s = fresh.steps[step];
        s.progress = Math.max(0, Math.min(99, Math.round(Number(p) || 0)));
        if (m) s.message = label + String(m).slice(0, 300);
        emit(fresh, step, 'running', s.progress, s.message);
      };
      const data = await AGENTS[step](fresh, onProgress);
      fresh.steps[step].data = data;
      fresh.steps[step].md = mdOf(fresh, step);
      fresh.steps[step].status = 'done';
      fresh.steps[step].progress = 100;
      fresh.steps[step].message = '完成';
      fresh.steps[step].at = nowISO();
      // 下游已完成的步骤标记为 stale：上游数据变了，下游结果需要重跑（否则会拿旧数据继续生产）
      for (const dk of downstreamOf(step)) {
        const ds = fresh.steps[dk];
        if (ds && ds.status === 'done') {
          ds.status = 'stale';
          ds.progress = 0;
          ds.message = '上游「' + stepNameOf(step) + '」已更新，需重跑本步';
        }
      }
      fresh.logs = [{ at: nowISO(), step, event: 'done' }, ...(fresh.logs || [])].slice(0, 200);
      await saveState(fresh);
      emit(fresh, step, 'done', 100, '完成');
      log('[pipeline] ' + id + ' · ' + step + ' 完成');
      return 'done';
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).slice(0, 800);
      try {
        const cur = await loadState(id);
        if (cur) {
          cur.steps[step].status = 'error';
          cur.steps[step].error = msg;
          cur.steps[step].progress = 0;
          cur.steps[step].message = msg.slice(0, 300);
          cur.logs = [{ at: nowISO(), step, event: 'error', error: msg }, ...(cur.logs || [])].slice(0, 200);
          await saveState(cur);
          emit(cur, step, 'error', 0, msg);
        }
      } catch { /* ignore */ }
      log('[pipeline] ' + id + ' · ' + step + ' 失败：' + msg);
      return 'error';
    }
  }

  async function runStep(id, step) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    if (!STEP_KEYS.includes(step)) throw new Error('未知步骤：' + step);
    const def = STEPS.find((s) => s.key === step);
    for (const need of def.needs) {
      const ns = st.steps[need]?.status;
      if (ns !== 'done' && ns !== 'stale') throw new Error('前置步骤未完成：' + stepNameOf(need));
    }
    if (running.size) {
      for (const r of running) if (r.startsWith(id + ':')) throw new Error('该项目已有步骤在运行，请等它结束');
    }
    // 重跑前先给「当前结果」留档：整步重生成不可增量撤销，备份是唯一退路
    let backup = null;
    try { backup = await backupStep(st, step); } catch (e) { log('[pipeline] 备份失败（不影响运行）：' + e.message); }
    const key = id + ':' + step;
    running.add(key);
    // 异步跑，立即返回
    (async () => { try { await executeStep(id, step); } finally { running.delete(key); } })();
    return { ok: true, step, running: true, backup };
  }

  /** 勾选重跑：按流水线顺序依次执行多个步骤（每步仍是整步全量重生成，逐步自动备份；某步失败即中断后续） */
  async function runBatch(id, stepsInput) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    const wanted = [];
    for (const raw of asArray(stepsInput)) {
      const k = clean(raw);
      if (!STEP_KEYS.includes(k)) throw new Error('未知步骤：' + k);
      if (wanted.indexOf(k) < 0) wanted.push(k);
    }
    if (!wanted.length) throw new Error('请至少勾选一个要重跑的步骤');
    for (const r of running) if (r.startsWith(id + ':')) throw new Error('该项目已有步骤在运行，请等它结束');
    const plan = STEP_KEYS.filter((k) => wanted.indexOf(k) >= 0);
    const sel = new Set(plan);
    for (const step of plan) {
      const def = STEPS.find((s) => s.key === step);
      for (const need of def.needs) {
        const ns = st.steps[need] ? st.steps[need].status : 'idle';
        const earlier = sel.has(need) && plan.indexOf(need) < plan.indexOf(step);
        if (!earlier && ns !== 'done' && ns !== 'stale') {
          throw new Error('「' + stepNameOf(need) + '」还没完成，不能重跑「' + stepNameOf(step) + '」');
        }
      }
    }
    // 每步开始前各自留档（备份的是当前结果；批量里靠后的步骤此刻还是旧数据，正好是它要覆盖的那版）
    const backupLabels = [];
    for (const step of plan) {
      try { const b = await backupStep(st, step); if (b) backupLabels.push(step); } catch (e) { log('[pipeline] 备份失败（不影响运行）：' + e.message); }
    }
    (async () => {
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        const key = id + ':' + step;
        running.add(key);
        let status = 'error';
        try { status = await executeStep(id, step, { pos: i + 1, total: plan.length }); } finally { running.delete(key); }
        if (status !== 'done') {
          log('[pipeline] 批量重跑中断：' + id + ' · 「' + stepNameOf(step) + '」失败，后续步骤未执行');
          break;
        }
      }
    })();
    log('[pipeline] 批量重跑开始：' + id + ' · ' + plan.map(stepNameOf).join(' → '));
    return { ok: true, steps: plan, total: plan.length, backups: backupLabels.length, running: true };
  }

  async function exportDocs(id) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    const root = path.resolve(ROOT, String(st.input.dir || '').replace(/\\/g, '/'));
    if (!(root === ROOT || root.startsWith(ROOT + path.sep))) throw new Error('输出目录越界');
    await fsp.mkdir(root, { recursive: true });
    const files = [];
    const write = async (name, content) => {
      if (!content) return;
      const p = path.join(root, name);
      await fsp.writeFile(p, content, 'utf8');
      files.push((st.input.dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + name));
    };
    if (st.steps.script.data) await write('剧本.md', st.steps.script.md || renderScriptMd(st, st.steps.script.data));
    if (st.steps.assets.data) {
      const r = renderAssetsMd(st, st.steps.assets.data);
      await write('人物设定.md', r.characters);
      await write('场景资产提示词.md', r.scenes);
      await write('道具资产提示词.md', r.props);
    }
    if (st.steps.emotion.data) await write('情绪锚点表.md', st.steps.emotion.md || renderEmotionMd(st, st.steps.emotion.data));
    if (st.steps.storyboard.data) await write('分镜.md', st.steps.storyboard.md || renderStoryboardMd(st, st.steps.storyboard.data));
    if (st.steps.prompts.data) {
      const r = renderPromptsMd(st, st.steps.prompts.data);
      await write('图片提示词.md', r.images);
      await write('视频提示词.md', r.video);
    }
    st.logs = [{ at: nowISO(), event: 'export', files }, ...(st.logs || [])].slice(0, 200);
    await saveState(st);
    return { ok: true, dir: st.input.dir, files };
  }

  async function tasksOf(id) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    return {
      ok: true,
      tasks: asArray(st.tasks),
      dreamina: dreamina ? { available: !!dreamina.available, bin: str(dreamina.bin), reason: str(dreamina.reason) } : { available: false },
    };
  }

  async function taskAction(id, body) {
    const st = await loadState(id);
    if (!st) throw new Error('流水线项目不存在：' + id);
    const action = clean(body.action);
    const save = async () => { st.tasks = asArray(st.tasks); await saveState(st); };
    if (action === 'build') {
      const rows = buildTasksFromPrompts(st);
      if (!rows.length) throw new Error('请先生成「⑤ 提示词生成」');
      const old = asArray(st.tasks).filter((t) => t.status === 'success');
      st.tasks = [...rows, ...old];
      await save();
      return { ok: true, built: rows.length, tasks: st.tasks.length };
    }
    if (action === 'clear') { st.tasks = []; await save(); return { ok: true }; }
    if (action === 'clearFailed') { st.tasks = asArray(st.tasks).filter((t) => t.status !== 'fail'); await save(); return { ok: true }; }
    if (action === 'setVideoModel') {
      const mv = clean(body.model) || 'seedance2.0fast';
      st.input.videoModel = mv;
      let n = 0;
      for (const t of asArray(st.tasks)) {
        if (t.type !== 'video' || !['pending', 'fail'].includes(t.status)) continue;
        t.params = { ...(t.params || {}), model: mv };
        n++;
      }
      await save();
      return { ok: true, model: mv, updated: n };
    }
    if (action === 'attachFirstFrames') {
      const linked = linkVideoFirstFrames(st);
      await save();
      return { ok: true, linked };
    }
    const taskId = clean(body.taskId);
    const t = asArray(st.tasks).find((x) => x.id === taskId);
    if (!t) throw new Error('任务不存在：' + taskId);
    if (action === 'submit' || action === 'retry') {
      try { await submitTask(st, t); }
      catch (e) { t.status = 'fail'; t.error = String(e.message || e).slice(0, 500); await save(); throw e; }
      await save();
      return { ok: true, task: t };
    }
    if (action === 'dry') {
      if (!dreamina || !dreamina.preview) throw new Error('适配器不支持预检');
      const r = dreamina.preview({ type: t.type, prompt: t.prompt, params: t.params || {} });
      return { ok: true, task: t, dry: r };
    }
    if (action === 'poll') {
      if (!t.submitId) throw new Error('该任务还没有 submit_id');
      if (!dreamina || !dreamina.available) throw new Error('本机未检测到即梦 CLI，无法轮询');
      const r = await dreamina.query(t.submitId);
      t.status = r.status === 'success' ? 'success' : (r.status === 'fail' ? 'fail' : 'querying');
      t.credits = r.credits ?? t.credits;
      t.error = r.failReason || '';
      t.files = r.files || t.files || [];
      await save();
      return { ok: true, task: t, raw: r };
    }
    if (action === 'download') {
      if (!t.submitId) throw new Error('该任务还没有 submit_id');
      if (!dreamina || !dreamina.available) throw new Error('本机未检测到即梦 CLI，无法下载');
      const r = await dreamina.download(t.submitId, '即梦产物');
      t.files = r.files || t.files || [];
      t.status = t.files.length ? 'success' : t.status;
      const linked = linkVideoFirstFrames(st);   // 出图后自动给视频任务挂首帧
      await save();
      return { ok: true, task: t, files: t.files, linkedFirstFrames: linked };
    }
    throw new Error('未知操作：' + action);
  }

  /** 按 submit_id 找回提示词（画布把产物挂节点时用） */
  async function promptBySubmit(submitId) {
    if (!submitId) return '';
    try {
      const dirs = (await fsp.readdir(PIPE_DIR, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && d.name !== '_trash').map((d) => d.name);
      for (const d of dirs) {
        const st = await loadState(d);
        const t = asArray(st?.tasks).find((x) => String(x.submitId) === String(submitId));
        if (t && t.prompt) return String(t.prompt);
      }
    } catch { /* ignore */ }
    return '';
  }

  return { meta, list, create, getState, update, remove, runStep, runBatch, saveMd, exportDocs, tasksOf, taskAction, promptBySubmit, bindImage, unbindImage, imageCandidates, restoreStep, STEP_KEYS, STEPS };
}
