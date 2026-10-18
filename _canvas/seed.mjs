// 《博士国》项目画布 · 种子数据（分层节点图：左入右出 + 相关性连线）
// 原始数据来源：制作/10秒锁定单.md、制作/第一回_分镜表_v1_已算.xlsx、制作/音频层设计与交付标准_v1.md、制作/视频提示词_18镜_v1.md
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const CANVAS_DIR = __dirname;
export const DATA_DIR = path.join(CANVAS_DIR, 'data');
// MULTI_BOARD：一个项目里可挂多块画布，数据分别落在 _canvas/boards/<id>/ 下。
// 这两个路径是可变的“当前画布”活动路径；server.mjs 通过 ESM live binding 直接读 import 绑定，
// 切换画布时调用 setActivePaths() 即可，所有既有引用（ensureSeed / relayout / applyGraph）自动跟随。
export let BOARD_FILE = path.join(CANVAS_DIR, 'board.json');
export let TIMELINE_FILE = path.join(DATA_DIR, 'timelines.json');
export const THUMB_DIR = path.join(CANVAS_DIR, 'thumbs');

export function setActivePaths(boardFile, timelineFile) {
  if (boardFile) BOARD_FILE = boardFile;
  if (timelineFile) TIMELINE_FILE = timelineFile;
}
export function activePaths() {
  return { board: BOARD_FILE, timeline: TIMELINE_FILE };
}

export const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
export const IGNORE_TOP = new Set(['_canvas', '_timeline_web', '.short-drama', '.git', 'node_modules']);

let seq = 0;
export function newId(prefix = 'n') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${(seq % 1000).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
export function toRel(abs) { return path.relative(ROOT, abs).split(path.sep).join('/'); }

export function listImages(dir = ROOT, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dir === ROOT && IGNORE_TOP.has(e.name)) continue;
      if (e.name === 'thumbs') continue;
      listImages(abs, out);
    } else if (IMG_EXT.has(path.extname(e.name).toLowerCase())) out.push(toRel(abs));
  }
  return out;
}

/** 图片 + 视频（视频节点用） */
export function listMedia(dir = ROOT, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dir === ROOT && IGNORE_TOP.has(e.name)) continue;
      if (e.name === 'thumbs') continue;
      listMedia(abs, out);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (IMG_EXT.has(ext) || VIDEO_EXT.has(ext)) out.push(toRel(abs));
    }
  }
  return out;
}
export function fileSize(rel) {
  try { return fs.statSync(path.join(ROOT, rel)).size; } catch { return 0; }
}
export function promptFor(imgRel) {
  const abs = path.join(ROOT, imgRel);
  const cand = abs.slice(0, abs.length - path.extname(abs).length) + '.prompt.txt';
  return fs.existsSync(cand) ? toRel(cand) : null;
}

// ---------------------------------------------------------------- 时间线数据
export const TIMELINES = {
  meta: {
    project: '《博士国》第一回',
    updated: new Date().toISOString(),
    note: '三条时间线：10 秒锁定镜（生效中）／18 镜完整版（挂起）／音频时间线。数据取自 10秒锁定单.md、第一回_分镜表_v1_已算.xlsx、音频层设计与交付标准_v1.md。',
    conflicts: [
      '对白落点：视频提示词写 3–7 秒，字幕与音频设计写 5.5–9.8 秒（TTS 约 4.15 秒），差 2.5 秒。',
      '总长：归档完整版剧本标注 159.8 秒，而 18 镜 × 5 秒 ＝ 90 秒；差的 69.8 秒需靠台词压缩（343 字 → 约 170 字）消解。',
    ],
  },
  beats: {
    title: '10 秒锁定镜 · 节拍时间线（生效中）',
    subtitle: 'EP001 / MOTION-EP001-001　单镜不切　720p 9:16　同轨音频',
    total: 10.0,
    items: [
      { start: 0, end: 2, name: '第一拍 · 逼近划鞭', txt: '教授向前迈出半步逼近，藤鞭自右上向左下划出一道弧线、鞭梢破空；师徒四人同时向后微退半步。', snd: '环境底声（街市远处人声＋微风，覆盖全镜）／藤鞭破空（弧线到位一次）／衣料摩擦（迈步时）' },
      { start: 2, end: 3, name: '第二拍 · 收鞭蓄势', txt: '他站定、把藤鞭收举至额前，头略偏、张口欲言；八戒长嘴前突、鼻孔张开、眼白微露。', snd: '音效余韵，环境底声' },
      { start: 3, end: 7, name: '第三拍 · 昂首呵斥', txt: '他昂首呵斥，口型与该句对白同步；鞭梢持续轻颤。', snd: '教授：这是教鞭！教鞭！看清楚了，这是教鞭！' },
      { start: 7, end: 10, name: '收束 · 倨傲定格', txt: '下巴微抬保持倨傲，画面停在他与鞭梢指向画面上方的姿态；微风扬起细尘，八戒仍梗颈不退。', snd: '回到环境底声，渐弱' },
    ],
    subtitles: [
      { start: 5.5, end: 7.6, text: '这是教鞭！教鞭！' },
      { start: 7.6, end: 9.8, text: '看清楚了，这是教鞭！' },
    ],
  },
  shots: {
    title: '18 镜完整版 · 画面时间线（挂起）',
    subtitle: '每镜独立 5 秒，无重叠、无变速；改时长即自动重排时间码',
    items: [
      { n: 1, dur: 5, size: '中近景', cam: '平视 · 微推', line: '军士（画外，冷硬）：没有文凭，此门甚是难进。', sfx: '环境风声', cut: '独立起镜（定场镜）', note: '冷开场钩子，全片最狠的一句前置', kf: '关键帧/01_开场·军士阻拦.png' },
      { n: 2, dur: 5, size: '全景', cam: '低机位仰拍 · 缓摇右', line: '旁白①：这话，是师徒进「博士国」听到的第一句。', sfx: '风声', cut: '独立起镜', note: '可复用 01 的画面语言', kf: '关键帧/02_师徒远眺博士国.png' },
      { n: 3, dur: 5, size: '中景', cam: '平视 · 固定', line: '八戒：敢问军爷，此是君子国否？', sfx: '—', cut: '接镜 2 尾帧', note: '八戒是礼貌发问，不是嬉笑', kf: '关键帧/03_八戒拱手问讯.png' },
      { n: 4, dur: 5, size: '中近景', cam: '略俯视 · 快推', line: '军士：妖——妖怪！', sfx: '长枪落地 · 铿锵（重音）', cut: '接镜 3 首帧', note: '全片第一个笑点，靠反差', kf: '关键帧/04_军士受惊扔枪.png' },
      { n: 5, dur: 5, size: '中景', cam: '平视 · 横移', line: '悟空：莫怕，我等是去西天取经的和尚。', sfx: '衣料摩擦', cut: '接镜 4 尾帧', note: '', kf: '关键帧/05_悟空揪住军士.png' },
      { n: 6, dur: 5, size: '近景', cam: '平视 · 固定', line: '军士：长老是何学历？可有文凭？／三藏：只有通关文牒，没有文凭。', sfx: '纸本轻响', cut: '独立起镜', note: '文牒绢面是画面唯一高光', kf: '关键帧/06_文凭之问.png' },
      { n: 7, dur: 5, size: '中近景', cam: '平视 · 固定', line: '军士乙：没有文凭，此门甚是难进！／军士：且去考试，通过了再来。', sfx: '券洞回声', cut: '接镜 6 尾帧', note: '峰值一', kf: '关键帧/07_众军士鄙夷.png' },
      { n: 8, dur: 5, size: '中景', cam: '平视 · 固定', line: '悟空：入城还要考试？真正岂有此理！／军士：这是博士国。过不了研究生入学考试，进不得此门。', sfx: '镜片反光一闪（心理音效）', cut: '接镜 7 尾帧', note: '', kf: '关键帧/08_入城还要考试.png' },
      { n: 9, dur: 5, size: '中景', cam: '平视 · 固定', line: '八戒：师父，肚里饥饿，还是化些斋饭要紧！／三藏：悟空，你去化些斋饭来。', sfx: '肚鸣（拟音）', cut: '独立起镜', note: '节奏转松', kf: '关键帧/09_八戒喊饿.png' },
      { n: 10, dur: 5, size: '全景', cam: '仰拍 · 快速上摇', line: '旁白②：大师兄去得快，回得也快。', sfx: '风声、云气', cut: '接镜 9 尾帧', note: '', kf: '关键帧/10_悟空驾云而去.png' },
      { n: 11, dur: 5, size: '中景', cam: '平视 · 固定', line: '八戒：还是大师兄有办法。', sfx: '咀嚼声', cut: '接镜 10 尾帧', note: '', kf: '关键帧/11_化斋归来分食.png' },
      { n: 12, dur: 5, size: '近景', cam: '平视 · 固定', line: '三藏：悟空，此去有何见闻？／悟空：此地尊师重教，学舍密布，墙上写着一行字——', sfx: '旷野风声', cut: '接镜 11 尾帧', note: '', kf: '关键帧/12_此去有何见闻.png' },
      { n: 13, dur: 5, size: '全景', cam: '平视略仰 · 缓推', line: '悟空（画外）：万般皆下品，唯有读书高。', sfx: '远处市声 · 纸角掀动', cut: '独立起镜', note: '全片唯一允许出现的画内文字', kf: '关键帧/13_万般皆下品标语.png' },
      { n: 14, dur: 5, size: '中远景', cam: '平视 · 横移', line: '悟空（画外）：墙外这些人，都是来给儿女交学费的。', sfx: '市声 · 布鞋摩擦石阶', cut: '接镜 13 尾帧', note: '', kf: '关键帧/14_缴学费的家长长队.png' },
      { n: 15, dur: 5, size: '特写', cam: '俯拍 · 固定', line: '悟空（画外）：学费奇昂。他们是从骨头里往外榨干了肉，才交得上。', sfx: '铜钱落盘（重音）', cut: '接镜 14 尾帧', note: '峰值二 · 全片情绪最重', kf: '关键帧/15_铜钱递进门内.png' },
      { n: 16, dur: 5, size: '中景', cam: '略仰视 · 跟移', line: '教授：靠边肃立，莫冲撞了斯文！', sfx: '鞭梢破空 · 街市人声', cut: '独立起镜（新序列）', note: '', kf: '关键帧/16_教授抽鞭登场.png' },
      { n: 17, dur: 5, size: '中景', cam: '平视 · 固定', line: '八戒：你是何方神圣，敢让我老猪为你让路？／旁白③：那人亮出身份——百中会馆资深教授。', sfx: '街市人声＋微风', cut: '接镜 16 尾帧', note: '', kf: '关键帧/17_八戒不让路.png' },
      { n: 18, dur: 5, size: '中近景', cam: '略仰视 · 缓推', line: '教授：这是教鞭！教鞭！看清楚了，这是教鞭！／教授：别忘了带束脩来。没有束脩，进门不得。／旁白④：万变不离钱左右，一去又逢鬼东西。', sfx: '鞭梢破空（收尾重音）', cut: '接镜 17 尾帧', note: '峰值三 · 本片最强台词，一字未改', kf: '关键帧/18_这是教鞭！.png' },
    ],
  },
  audio: {
    title: '音频时间线（挂载在 18 镜版上）',
    subtitle: '不用满铺 BGM：总量约 3.8 秒，占全片 4%',
    events: [
      { shot: 1, name: '城墙下风声', kind: '环境', note: '底声，-28 LUFS 左右' },
      { shot: 2, name: '旷野风声 / 旌旗翻动', kind: '环境', note: '带远山回声感' },
      { shot: 4, name: '长枪落地', kind: '重音', note: '听觉符号一：冲突' },
      { shot: 5, name: '衣料摩擦', kind: '点效', note: '近场、干声' },
      { shot: 6, name: '纸本轻响', kind: '点效', note: '极轻' },
      { shot: 8, name: '镜片反光一闪', kind: '心理音效', note: '一声高频叮，极短' },
      { shot: 9, name: '肚鸣', kind: '拟音', note: '憨感，不低俗' },
      { shot: 11, name: '咀嚼声', kind: '拟音', note: '轻，不抢台词' },
      { shot: 13, name: '纸角掀动', kind: '点效', note: '极轻' },
      { shot: 14, name: '布鞋摩擦石阶', kind: '点效', note: '多人、细碎' },
      { shot: 15, name: '铜钱落盘', kind: '重音', note: '听觉符号二：压榨' },
      { shot: 16, name: '鞭梢破空', kind: '点效', note: '听觉符号三：威压' },
      { shot: 18, name: '鞭梢破空（收尾）', kind: '重音', note: '与镜 16 同一素材，音高略高' },
    ],
    bgm: [
      { shot: 15, len: 2.0, name: '低频弦乐长音（单音、无节拍）', io: '铜钱落盘后 0.2s 淡入 → 镜 16 台词前 0.3s 淡出' },
      { shot: 18, len: 1.8, name: '三声短促拨弦（每声 0.25s，间隔 0.4s）', io: '首声与第一个「教鞭」同步，末声后立即结束' },
    ],
    voice: [
      { role: '旁白', tone: '男声中年 · 中低音区 · 偏干 · 略带书场鼻腔共鸣', speed: '4.3 字/秒', mood: '平静略冷 · 看透世情的旁观者' },
      { role: '唐僧', tone: '清亮偏薄 · 中高音区', speed: '4.0 字/秒', mood: '慈和克制 · 被拒时不带怒气' },
      { role: '悟空', tone: '明亮、脆、带鼻音', speed: '4.8 字/秒', mood: '不服、急、锋利' },
      { role: '八戒', tone: '厚、钝、带喉音', speed: '4.2 字/秒', mood: '憨贪委屈 · 喊饿拖长音' },
      { role: '沙僧', tone: '低、沉、木讷', speed: '3.8 字/秒', mood: '平稳无起伏' },
      { role: '教授', tone: '中低音区 · 偏薄带沙', speed: '4.6 字/秒', mood: '倨傲被冒犯后的急辩 · 先重后急' },
      { role: '军士甲／乙', tone: '年轻、实、带市井气', speed: '4.5 字/秒', mood: '甲：戒备→受惊；乙：轻慢' },
    ],
    loudness: [
      { k: '采样率／位深', v: '48 kHz / 24 bit' },
      { k: '成片响度', v: '−16 LUFS，真峰值 ≤ −1.5 dBTP' },
      { k: '对白／旁白', v: '−16 ～ −14 LUFS，句间差不超 1.5 LU' },
      { k: '音效', v: '重音可比对白高 3–6 dB；环境比对白低 18–22 dB' },
      { k: '音乐', v: '峰值不超过对白 −6 dB（不得盖台词）' },
    ],
  },
};

// ---------------------------------------------------------------- 相关性表
// 出自 分镜表「素材命名表」的出场镜次
export const APPEARS = {
  '锚点/锚01_唐僧.png': [2, 3, 6, 9, 11, 12, 17, 18],
  '锚点/锚02_悟空.png': [2, 5, 8, 9, 10, 11, 12, 17, 18],
  '锚点/锚03_八戒.png': [2, 3, 9, 11, 17, 18],
  '锚点/锚04_沙僧.png': [2, 11, 18],
  '锚点/锚05_教授.png': [16, 17, 18],
  '锚点/锚06_军士甲.png': [1, 4, 5, 6, 7, 8],
  '锚点/锚07_师徒四人合影.png': [2, 11, 18],
  '收尾20张/D1_锚点_军士甲.png': [1, 4, 5, 6, 7, 8],
  '收尾20张/D2_锚点_军士乙.png': [7],
  '收尾20张/C1_场景_城门券洞.png': [1, 4],
  '收尾20张/C2_场景_城外望城楼.png': [1, 2],
  '收尾20张/C3_场景_学舍外墙.png': [13, 14],
  '收尾20张/C4_场景_博士国街市.png': [16, 17, 18],
  '收尾20张/B1_道具_通关文牒.png': [6],
  '收尾20张/B2_道具_长枪.png': [4],
  '收尾20张/B3_道具_藤鞭.png': [16, 18],
  '收尾20张/B4_道具_标语纸.png': [13],
  '收尾20张/B5_道具_铜钱串.png': [15],
  '收尾20张/B6_道具_斋饭.png': [11],
  '收尾20张/B7_道具_家长之手.png': [15],
  '收尾20张/E1_群像_缴学费家长长队.png': [14],
  '收尾20张/E2_群像_守门军士群.png': [1, 4, 7],
};

// ---------------------------------------------------------------- 视频提示词按镜拆分
export const VPROMPT_DIR = '制作/视频提示词_分镜';

function shotTitleFromKf(kf) {
  const base = path.basename(kf).replace(/\.[^.]+$/, '');
  return base.replace(/^\d+_/, '');
}
/** Windows 文件名安全化 */
function safeName(s) { return String(s).replace(/[\\/:*?"<>|\r\n]/g, '_').trim(); }

/** 从 制作/视频提示词_18镜_v1.md 按镜拆出 18 份可复制提示词（已存在则不覆盖） */
export async function splitVideoPrompts() {
  const src = path.join(ROOT, '制作', '视频提示词_18镜_v1.md');
  if (!fs.existsSync(src)) return { created: 0, skipped: 0 };
  const md = await fsp.readFile(src, 'utf8');
  const lines = md.split('\n');
  const chunks = [];
  let cur = null;
  for (const ln of lines) {
    const m = /^##\s*镜\s*(\d+)\s*·\s*(.+?)(?:（.*）)?\s*$/.exec(ln.trim());
    if (m) { cur = { n: Number(m[1]), title: m[2].trim(), buf: [] }; chunks.push(cur); continue; }
    if (cur) cur.buf.push(ln);
  }
  await fsp.mkdir(path.join(ROOT, VPROMPT_DIR), { recursive: true });
  let created = 0; let skipped = 0;
  for (const c of chunks) {
    const body = c.buf.join('\n').trim();
    const file = path.join(ROOT, VPROMPT_DIR, `镜${String(c.n).padStart(2, '0')}_${safeName(c.title)}.txt`);
    if (fs.existsSync(file)) { skipped++; continue; }
    const head = [
      `# 镜 ${c.n} · ${c.title}`,
      '',
      '> 来源：制作/视频提示词_18镜_v1.md（可在此直接改写，画布会实时同步）',
      '> 目标模型：seedance2.5 · 图生视频 · 起始帧取该镜关键帧',
      '',
      body,
      '',
    ].join('\n');
    await fsp.writeFile(file, head, 'utf8');
    created++;
  }
  return { created, skipped };
}

export function vpromptPathFor(n, title) {
  return `${VPROMPT_DIR}/镜${String(n).padStart(2, '0')}_${safeName(title)}.txt`;
}

// ---------------------------------------------------------------- 节点尺寸
const SIZE = {
  text: { w: 320, h: 250 },
  file: { w: 320, h: 118 },
  asset: { w: 290, h: 340 },
  video: { w: 290, h: 300 },
  kf: { w: 290, h: 360 },
  vprompt: { w: 330, h: 270 },
  timeline: { w: 1120, h: 520 },
  note: { w: 340, h: 240 },
};
const GAP_X = 170;
const GAP_Y = 26;
const WRAP_AT = 3400;

// ---------------------------------------------------------------- 建图
export async function buildGraph() {
  const cards = [];
  const edges = [];
  const idOf = {};
  const put = (card, key) => { if (key) card.key = key; cards.push(card); if (key) idOf[key] = card.id; return card; };
  const link = (a, b, kind) => {
    const f = idOf[a]; const t = idOf[b];
    if (f && t) edges.push({ id: newId('e'), from: f, to: t, kind: kind || 'rel', origin: 'seed' });
  };
  const node = (type, o) => ({ id: newId(type[0]), origin: 'seed', type, ...SIZE[type], ...o });

  await splitVideoPrompts();
  const images = listImages();

  // ---- L0 输入与规范
  const L0 = [];
  const INPUT_TEXT = [
    ['10 秒锁定单', '制作/10秒锁定单.md'],
    ['EP001 剧本', '博士国/剧集/EP001/剧本.md'],
    ['EP001 分镜', '博士国/剧集/EP001/分镜.md'],
    ['EP001 视觉设定', '博士国/剧集/EP001/视觉设定.md'],
    ['EP001 图片提示词', '博士国/剧集/EP001/图片提示词.md'],
    ['EP001 视频提示词', '博士国/剧集/EP001/视频提示词.md'],
    ['音频层设计与交付标准', '制作/音频层设计与交付标准_v1.md'],
    ['字幕（10 秒）', '制作/字幕_10秒_v1.srt'],
    ['10 秒视频提示词 v3', '制作/视频提示词_10秒_v3.txt'],
    ['18 镜视频提示词（合并稿）', '制作/视频提示词_18镜_v1.md'],
    ['制作流程方法', '制作/方法_AI短剧制作流程.md'],
    ['成片复盘 · 对标行业标准', '制作/成片复盘_对标行业标准.md'],
    ['错误台账与经验总结', '制作/错误台账与经验总结.md'],
    ['完整版剧本（归档 159.8s）', '博士国/输入/第一回_完整版剧本_归档.md'],
  ];
  INPUT_TEXT.forEach(([t, p]) => { if (fs.existsSync(path.join(ROOT, p))) L0.push(put(node('text', { title: t, path: p, layer: 'input', badge: '文本' }), 'in:' + p)); });
  [[ '可拍台本 v1', '制作/第一回_可拍台本_v1.docx' ],
   [ '分镜表 v1（已算）', '制作/第一回_分镜表_v1_已算.xlsx' ],
   [ '参考视频对标 v1', '制作/第一回_参考视频对标_v1.docx' ],
   [ '10 秒验证片执行单', '制作/10秒验证片_执行单_v1.docx' ],
   [ '原著素材 · 女红军.docx', '女红军.docx' ]].forEach(([t, p]) => {
    if (fs.existsSync(path.join(ROOT, p))) L0.push(put(node('file', { title: t, path: p, size: fileSize(p), layer: 'input', badge: path.extname(p).slice(1) }), 'in:' + p));
  });
  // 备忘录等内容目录：自动收进画布，避免重排时丢失
  for (const dir of ['备忘录', '参考上传', '即梦产物', '制作/生成任务台账.md'].map((x) => x)) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const ext = path.extname(e.name).toLowerCase();
        if (!['.md', '.txt', '.srt', '.json'].includes(ext)) continue;
        const rel = toRel(p);
        if (idOf['in:' + rel]) continue;
        L0.push(put(node('text', { title: path.basename(rel).replace(/\.[^.]+$/, ''), path: rel, layer: 'input', badge: dir }), 'in:' + rel));
      }
    };
    walk(abs);
  }

  // ---- L1 设定资产（图 + 内嵌提示词）
  const GROUPS = [
    ['角色锚点', images.filter((p) => p.startsWith('锚点/')).sort()],
    ['场景板', images.filter((p) => p.startsWith('收尾20张/C')).sort()],
    ['道具板', images.filter((p) => p.startsWith('收尾20张/B')).sort()],
    ['群像与补锚点', images.filter((p) => /^收尾20张\/(D|E)/.test(p)).sort()],
    ['首尾帧候选', images.filter((p) => p.startsWith('收尾20张/')).filter((p) => /^收尾20张\/(A|F)/.test(p)).sort()],
    ['风格路线样张', images.filter((p) => !p.includes('/') && /^0\d_/.test(p)).sort()],
    ['其它素材', images.filter((p) => p.startsWith('博士国/')).sort()],
  ];
  const L1 = [];
  for (const [group, list] of GROUPS) {
    for (const rel of list) {
      const title = path.basename(rel).replace(/\.[^.]+$/, '');
      L1.push(put(node('asset', {
        title, src: rel, path: promptFor(rel) || '', caption: rel, group, layer: 'asset', badge: group,
      }), 'asset:' + rel));
    }
  }

  // ---- L2 关键帧（图 + 镜号 + 图片提示词）
  const L2 = [];
  TIMELINES.shots.items.forEach((s) => {
    const rel = s.kf;
    L2.push(put(node('kf', {
      title: `镜 ${String(s.n).padStart(2, '0')} · ${shotTitleFromKf(rel)}`,
      src: rel, path: promptFor(rel) || '', caption: rel, shot: s.n,
      layer: 'kf', badge: `${s.size} · ${s.dur}s`, line: s.line,
    }), 'kf:' + s.n));
  });

  // ---- L3 视频提示词（按镜）
  const L3 = [];
  TIMELINES.shots.items.forEach((s) => {
    const title = shotTitleFromKf(s.kf);
    const p = vpromptPathFor(s.n, title);
    if (fs.existsSync(path.join(ROOT, p))) {
      L3.push(put(node('vprompt', {
        title: `视频提示词 · 镜 ${String(s.n).padStart(2, '0')}`, path: p, shot: s.n, layer: 'vprompt', badge: 'Seedance 2.5',
      }), 'vp:' + s.n));
    }
  });

  // ---- L4 时间线编排
  const L4 = [];
  L4.push(put(node('timeline', { title: TIMELINES.beats.title, section: 'beats', layer: 'edit', badge: '10 秒 · 生效中' }), 'tl:beats'));
  L4.push(put(node('timeline', { title: TIMELINES.shots.title, section: 'shots', layer: 'edit', badge: '18 镜 · 挂起' }), 'tl:shots'));
  L4.push(put(node('timeline', { title: TIMELINES.audio.title, section: 'audio', layer: 'edit', badge: '音频 · 3.8s BGM' }), 'tl:audio'));
  if (fs.existsSync(path.join(ROOT, '制作/视频提示词_10秒_v3.txt'))) {
    L4.push(put(node('text', { title: '10 秒镜 · 视频提示词（定稿 v3）', path: '制作/视频提示词_10秒_v3.txt', layer: 'edit', badge: '对白轨' }), 'tl:ten'));
  }

  // ---- L5 成片与取证
  const L5 = [];
  images.filter((p) => p.startsWith('成片/')).sort().forEach((rel) => {
    L5.push(put(node('asset', {
      title: path.basename(rel).replace(/\.[^.]+$/, ''), src: rel, path: '', caption: rel,
      group: '成片取证', layer: 'out', badge: '成片', h: 300,
    }), 'out:' + rel));
  });
  images.filter((p) => p.startsWith('_历史版本/')).sort().forEach((rel) => {
    L5.push(put(node('asset', {
      title: path.basename(rel).replace(/\.[^.]+$/, ''), src: rel, path: promptFor(rel) || '',
      caption: rel, group: '历史版本', layer: 'out', badge: '已淘汰', h: 300,
    }), 'hist:' + rel));
  });
  // 即梦产物 / 参考上传：出片与手动上传的素材（视频走 video 节点，节点内嵌播放器）
  listMedia().filter((p) => p.startsWith('即梦产物/') || p.startsWith('参考上传/')).sort().forEach((rel) => {
    const isVid = VIDEO_EXT.has(path.extname(rel).toLowerCase());
    const base = path.basename(rel).replace(/\.[^.]+$/, '');
    L5.push(put(node(isVid ? 'video' : 'asset', {
      title: base.length > 28 ? base.slice(0, 28) + '…' : base,
      src: rel, path: promptFor(rel) || '', caption: rel,
      group: rel.startsWith('参考上传/') ? '上传素材' : '即梦产物',
      layer: 'out', badge: isVid ? '视频' : (rel.startsWith('参考上传/') ? '上传' : '即梦产物'),
      h: isVid ? 300 : 340,
    }), (isVid ? 'vid:' : 'prod:') + rel));
  });

  // ================= 相关性连线 =================
  // 1) 设定资产 → 关键帧（按出场镜次）
  for (const rel of Object.keys(APPEARS)) {
    const key = rel.startsWith('锚点/') ? 'asset:' + rel : 'asset:' + rel;
    if (!idOf[key]) continue;
    for (const n of APPEARS[rel]) link(key, 'kf:' + n, 'appear');
  }
  // 2) 关键帧 → 该镜视频提示词
  L3.forEach((c) => link('kf:' + c.shot, 'vp:' + c.shot, 'flow'));
  // 3) 视频提示词 → 18 镜时间线
  L3.forEach((c) => link('vp:' + c.shot, 'tl:shots', 'flow'));
  // 4) 输入文本 → 由其派生的编排
  link('in:制作/第一回_分镜表_v1_已算.xlsx', 'tl:shots', 'doc');
  link('in:制作/10秒锁定单.md', 'tl:beats', 'doc');
  link('in:制作/音频层设计与交付标准_v1.md', 'tl:audio', 'doc');
  link('in:博士国/剧集/EP001/视频提示词.md', 'tl:beats', 'doc');
  link('in:制作/字幕_10秒_v1.srt', 'tl:beats', 'doc');
  // 5) 编排 → 成片取证
  ['成片/帧/t0.jpg', '成片/帧/t2.jpg', '成片/帧/t4.jpg', '成片/帧/t6.jpg', '成片/帧/t9.jpg'].forEach((p) => {
    link('tl:beats', 'out:' + p, 'flow');
  });
  ['成片/穿模取证/kf_crop.jpg', '成片/穿模取证/video_crop.jpg', '成片/帧_补帧检查/原_t1.2.jpg', '成片/帧_补帧检查/A_t1.2.jpg'].forEach((p) => {
    if (idOf['out:' + p]) link('tl:beats', 'out:' + p, 'flow');
  });
  // 6) 10 秒镜的输入图 → 成片
  ['01_开场_师徒远眺博士国.png', '07_执鞭教授_真人版.png'].forEach((p) => {
    if (idOf['asset:' + p]) link('asset:' + p, 'out:成片/帧/t0.jpg', 'flow');
  });
  ['收尾20张/A1_首帧_鞭斜举体外.png', '收尾20张/A2_首帧_鞭横持腰际.png', '收尾20张/A3_首帧_鞭直立贴体侧.png'].forEach((p) => {
    if (idOf['asset:' + p]) link('asset:' + p, 'out:成片/帧/t0.jpg', 'candidate');
  });
  ['收尾20张/F1_尾帧_倨傲举鞭收束.png', '收尾20张/F2_尾帧_教授转身离去.png'].forEach((p) => {
    if (idOf['asset:' + p]) link('asset:' + p, 'out:成片/帧/t9.jpg', 'candidate');
  });
  // 7) 历史版本 → 选定的真人版
  L5.filter((c) => c.badge === '已淘汰').forEach((c) => {
    if (idOf['asset:07_执鞭教授_真人版.png']) edges.push({ id: newId('e'), from: c.id, to: idOf['asset:07_执鞭教授_真人版.png'], kind: 'deprecated', origin: 'seed' });
  });

  // ================= 分层排版（左→右，左入右出） =================
  const layers = [
    { key: 'input', title: '① 输入 · 剧本与规范', sub: '文本节点可编辑；docx/xlsx 双击用系统程序打开', items: L0 },
    { key: 'asset', title: '② 设定资产 · 角色 / 场景 / 道具 / 群像', sub: '节点下半部即该图的图片提示词', items: L1 },
    { key: 'kf', title: '③ 分镜关键帧 · 18 镜', sub: '左侧入线＝用到的设定资产；右侧出线＝该镜视频提示词', items: L2 },
    { key: 'vprompt', title: '④ 视频提示词 · 按镜拆分', sub: '由关键帧派生，直接改写即写回文件', items: L3 },
    { key: 'edit', title: '⑤ 时间线编排', sub: '三条时间线：10 秒锁定镜 / 18 镜完整版 / 音频', items: L4 },
    { key: 'out', title: '⑥ 成片与取证 · 输出', sub: '实拍帧、补帧对比、穿模取证、历史版本', items: L5 },
  ];

  const columns = [];
  let x = 0;
  let maxBottom = 0;
  for (const L of layers) {
    const rowsMax = Math.max(1, Math.floor(WRAP_AT / (Math.max(...L.items.map((c) => c.h), 200) + GAP_Y)));
    const chunks = [];
    for (let i = 0; i < L.items.length; i += rowsMax) chunks.push(L.items.slice(i, i + rowsMax));
    if (!chunks.length) chunks.push([]);
    const colW = Math.max(...L.items.map((c) => c.w), 240);
    chunks.forEach((chunk, ci) => {
      const height = chunk.reduce((a, c) => a + c.h + GAP_Y, 0) - GAP_Y;
      const y0 = Math.round((WRAP_AT - height) / 2);
      chunk.forEach((c, i) => {
        c.x = Math.round(x);
        c.y = Math.round(y0 + chunk.slice(0, i).reduce((a, b2) => a + b2.h + GAP_Y, 0));
        c.layer = L.key;
        c.col = ci;
      });
      maxBottom = Math.max(maxBottom, y0 + height);
      columns.push({ key: L.key, title: L.title, sub: ci === 0 ? L.sub : '', x: Math.round(x), y: 0, w: colW, h: WRAP_AT, col: ci });
      x += colW + GAP_X;
    });
  }

  // 顶部留出层标题的高度
  const HEAD = 96;
  cards.forEach((c) => { c.y += HEAD; });
  columns.forEach((c) => { c.y = 0; c.h = WRAP_AT + HEAD; });

  return {
    version: 2,
    updated: new Date().toISOString(),
    layout: 'layered-lr',
    layers: layers.map((l) => ({ key: l.key, title: l.title, sub: l.sub, count: l.items.length })),
    columns,
    cards,
    edges,
  };
}

export function computeStats(board) {
  const s = { total: 0, image: 0, text: 0, timeline: 0, note: 0, section: 0, asset: 0, kf: 0, vprompt: 0, file: 0 };
  for (const c of board.cards || []) { s.total++; if (s[c.type] !== undefined) s[c.type]++; }
  s.edges = (board.edges || []).length;
  return s;
}

export async function ensureSeed({ force = false } = {}) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  if (force || !fs.existsSync(TIMELINE_FILE)) {
    await fsp.writeFile(TIMELINE_FILE, JSON.stringify(TIMELINES, null, 2), 'utf8');
  }
  if (force || !fs.existsSync(BOARD_FILE)) {
    const board = await buildGraph();
    await fsp.writeFile(BOARD_FILE, JSON.stringify(board, null, 2), 'utf8');
    return { cards: board.cards.length, edges: board.edges.length, columns: board.columns.length };
  }
  return { cards: 0, edges: 0, columns: 0 };
}

/** 按 key 把新生成的图叠加到现有画布上：保留 id（连线不断）、保留手工节点与手工连线 */
async function applyGraph({ keepPositions }) {
  const board = JSON.parse(await fsp.readFile(BOARD_FILE, 'utf8'));
  const fresh = await buildGraph();
  const old = board.cards || [];
  const oldByKey = new Map(old.filter((c) => c.key).map((c) => [c.key, c]));

  const idMap = new Map();
  const cards = fresh.cards.map((c) => {
    const o = c.key ? oldByKey.get(c.key) : null;
    const id = o ? o.id : c.id;
    idMap.set(c.id, id);
    if (!o) return c;
    return keepPositions
      ? { ...c, id, x: o.x, y: o.y, w: o.w, h: o.h, origin: o.origin || c.origin }
      : { ...c, id, origin: o.origin || c.origin };
  });

  const keptIds = new Set(cards.map((c) => c.id));
  const extra = old.filter((c) => !keptIds.has(c.id) && c.origin && c.origin !== 'seed');
  const liveIds = new Set([...cards, ...extra].map((c) => c.id));

  const freshEdges = fresh.edges.map((e) => ({ ...e, from: idMap.get(e.from) || e.from, to: idMap.get(e.to) || e.to }))
    .filter((e) => liveIds.has(e.from) && liveIds.has(e.to));
  const freshPairs = new Set(freshEdges.map((e) => e.from + '>' + e.to));
  const userEdges = (board.edges || []).filter((e) => e.origin !== 'seed' && liveIds.has(e.from) && liveIds.has(e.to)
    && !freshPairs.has(e.from + '>' + e.to));

  const out = {
    ...board, version: 2, layout: 'layered-lr', updated: new Date().toISOString(),
    layers: fresh.layers, columns: fresh.columns, cards: [...cards, ...extra], edges: [...freshEdges, ...userEdges],
  };
  await fsp.writeFile(BOARD_FILE, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/** 重排：按分层重算位置，保留手工/AI 节点与其位置习惯 */
export async function relayout() { return applyGraph({ keepPositions: true }); }

/** 强制按分层重排全部节点，并重建相关性连线 */
export async function relayoutAll() { return applyGraph({ keepPositions: false }); }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const force = process.argv.slice(2).includes('--force');
  ensureSeed({ force }).then((r) => console.log('seed done:', JSON.stringify(r)));
}
