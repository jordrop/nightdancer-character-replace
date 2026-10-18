// 《博士国》项目画布 · 本地服务（127.0.0.1）
// 实时同步（fs.watch → SSE）＋ 文件读写 ＋ 缩略图 ＋ 内置 AI 代理（工具循环，Key 不落盘）
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, CANVAS_DIR, DATA_DIR, BOARD_FILE, TIMELINE_FILE, THUMB_DIR,
  IMG_EXT, IGNORE_TOP, listImages, toRel, ensureSeed, relayout, relayoutAll, buildGraph, computeStats,
  setActivePaths,
} from './seed.mjs';
import { createPipeline } from './pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THUMB_INDEX = path.join(THUMB_DIR, 'index.json');
const CONFIG_FILE = path.join(CANVAS_DIR, 'config.json');

// ------------------------------------------------------------------ 多画布（MULTI_BOARD）
// 一块画布 = _canvas/boards/<id>/ 下的 board.json + timelines.json（+ 自动备份）
// _canvas/boards/index.json 记录当前画布与全部画布；老数据在首次启动时自动迁成画布，原文件一律保留不动。
const BOARDS_DIR = path.join(CANVAS_DIR, 'boards');
const BOARDS_INDEX = path.join(BOARDS_DIR, 'index.json');
const BOARDS_TRASH = path.join(BOARDS_DIR, '_trash');
const LEGACY_BOARD = path.join(CANVAS_DIR, 'board.json');
const LEGACY_TIMELINE = path.join(DATA_DIR, 'timelines.json');
const ARCHIVE_BOARD = path.join(CANVAS_DIR, 'board.存档_博士国_20261016-190858.json');
const ARCHIVE_TIMELINE = path.join(DATA_DIR, 'timelines.存档_20261016-190858.json');

let BOARD_IDX = null;      // { current, boards: [{ id, name, created }] }
let CURRENT_BOARD = null;  // 当前画布对象

const boardDir = (id) => path.join(BOARDS_DIR, String(id));
const boardFileOf = (id) => path.join(boardDir(id), 'board.json');
const timelineFileOf = (id) => path.join(boardDir(id), 'timelines.json');
const boardBakOf = (id) => path.join(boardDir(id), 'board.bak.json');
const EMPTY_BOARD = () => ({ version: 2, layout: 'free', noSeed: true, cards: [], edges: [], columns: [], layers: [], updated: new Date().toISOString() });

async function writeJSONFile(p, obj) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}
function newBoardId() {
  const used = new Set((BOARD_IDX?.boards || []).map((b) => b.id));
  let n = 1; while (used.has('b' + n)) n++;
  return 'b' + n;
}
function applyActiveBoard(id) {
  const b = (BOARD_IDX?.boards || []).find((x) => x.id === id);
  if (!b) return null;
  CURRENT_BOARD = b;
  BOARD_IDX.current = b.id;
  setActivePaths(boardFileOf(b.id), timelineFileOf(b.id));   // ESM live binding：server.mjs 里的 BOARD_FILE/TIMELINE_FILE 同步改指向
  return b;
}
async function saveBoardsIndex() {
  await writeJSONFile(BOARDS_INDEX, BOARD_IDX);
}
async function createEmptyBoard(name) {
  const id = newBoardId();
  const b = { id, name: String(name || '新画布').replace(/[\r\n]/g, ' ').slice(0, 40), created: new Date().toISOString() };
  await fsp.mkdir(boardDir(id), { recursive: true });
  await writeJSONFile(boardFileOf(id), EMPTY_BOARD());
  await writeJSONFile(timelineFileOf(id), {});
  BOARD_IDX.boards.push(b);
  return b;
}
async function ensureBoardFiles(b) {
  await fsp.mkdir(boardDir(b.id), { recursive: true });
  if (!fs.existsSync(boardFileOf(b.id))) await writeJSONFile(boardFileOf(b.id), EMPTY_BOARD());
  if (!fs.existsSync(timelineFileOf(b.id))) await writeJSONFile(timelineFileOf(b.id), {});
}
async function boardSummary(b) {
  const board = await loadJSON(boardFileOf(b.id), { cards: [], edges: [] });
  return {
    id: b.id, name: b.name, created: b.created || null,
    cards: (board.cards || []).length, edges: (board.edges || []).length,
    updated: board.updated || null, size: (board.cards || []).length,
  };
}
async function initBoards() {
  await fsp.mkdir(BOARDS_DIR, { recursive: true });
  const idx = await loadJSON(BOARDS_INDEX, null);
  BOARD_IDX = (idx && Array.isArray(idx.boards) && idx.boards.length) ? idx : { current: '', boards: [] };
  if (!idx || !Array.isArray(idx.boards) || !idx.boards.length) {
    // ① 现有画布（_canvas/board.json + data/timelines.json）→ 变成第一块画布，原文件不动
    const legacy = await loadJSON(LEGACY_BOARD, null);
    if (legacy && Array.isArray(legacy.cards)) {
      const nhj = JSON.stringify(legacy.cards.slice(0, 8)).includes('女红军');
      const b = { id: 'b1', name: nhj ? '《女红军》EP001 · 44镜' : '现有画布', created: new Date().toISOString(), migratedFrom: 'board.json' };
      await fsp.mkdir(boardDir(b.id), { recursive: true });
      await writeJSONFile(boardFileOf(b.id), legacy);
      await writeJSONFile(timelineFileOf(b.id), (await loadJSON(LEGACY_TIMELINE, null)) || {});
      BOARD_IDX.boards.push(b);
    }
    // ② 《博士国》老画布存档 → 恢复成第二块画布，随时可切回去看
    const arch = await loadJSON(ARCHIVE_BOARD, null);
    if (arch && Array.isArray(arch.cards)) {
      const b = { id: 'b2', name: '《博士国》第一回 · 10秒验证', created: new Date().toISOString(), migratedFrom: 'board.存档_博士国_20261016-190858.json' };
      await fsp.mkdir(boardDir(b.id), { recursive: true });
      await writeJSONFile(boardFileOf(b.id), arch);
      await writeJSONFile(timelineFileOf(b.id), (await loadJSON(ARCHIVE_TIMELINE, null)) || {});
      BOARD_IDX.boards.push(b);
    }
    // ③ 一块空画布（本次“新建画布”的体验位）
    const nb = await createEmptyBoard('空画布 1');
    BOARD_IDX.current = nb.id;
    await saveBoardsIndex();
    console.log('[boards] 首次迁移 → ' + BOARD_IDX.boards.map((b) => b.id + '=' + b.name).join(' · '));
  } else {
    for (const b of BOARD_IDX.boards) await ensureBoardFiles(b);
  }
  if (!BOARD_IDX.current || !BOARD_IDX.boards.some((b) => b.id === BOARD_IDX.current)) BOARD_IDX.current = BOARD_IDX.boards[0].id;
  applyActiveBoard(BOARD_IDX.current);
  await saveBoardsIndex();
  console.log('[boards] 当前画布：' + (CURRENT_BOARD ? CURRENT_BOARD.id + ' · ' + CURRENT_BOARD.name : '（无）') + `（共 ${BOARD_IDX.boards.length} 块）`);
}
const PORT = Number(process.env.CANVAS_PORT || 17800);
const HOST = '127.0.0.1';
const PY = process.env.DSH_PYTHON
  || process.env.DSH_PYTHON
  || (() => { const p = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python'); return fs.existsSync(p) ? p : 'python'; })();
const TEXT_EXT = new Set(['.txt', '.md', '.json', '.jsonl', '.srt', '.csv', '.mjs', '.js', '.html', '.py', '.ps1', '.yml', '.yaml', '.cmd', '.bat']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const THUMB_W = 720;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------------ 工具
function safeAbs(relOrAbs) {
  const abs = path.resolve(ROOT, String(relOrAbs || ''));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('路径越界（只允许项目根目录内）：' + relOrAbs);
  return abs;
}
function isThumbPath(abs) { return abs.startsWith(THUMB_DIR + path.sep); }
function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

/** 读原始字节（上传用） */
async function readRaw(req, limit = 96 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('文件过大（上限 96MB）');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function safeFileName(s) {
  return String(s || 'upload.bin').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'upload.bin';
}
function uniqueRelPath(dir, name) {
  const base = safeFileName(name);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let rel = `${dir}/${base}`;
  let i = 2;
  while (fs.existsSync(path.join(ROOT, rel))) { rel = `${dir}/${stem} (${i})${ext}`; i++; }
  return rel;
}

// ------------------------------------------------------------------ SSE
const clients = new Set();
function broadcast(type, payload = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { /* ignore */ } }
}

// ------------------------------------------------------------------ 缩略图
let thumbIndex = {};
const pending = new Set();
let generating = false;

async function loadThumbIndex() {
  try {
    thumbIndex = JSON.parse(await fsp.readFile(THUMB_INDEX, 'utf8'));
  } catch { thumbIndex = {}; }
}
async function saveThumbIndex() {
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  await fsp.writeFile(THUMB_INDEX, JSON.stringify(thumbIndex, null, 2), 'utf8');
}
function thumbName(rel) { return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16) + '.jpg'; }

function runPyThumbs(items) {
  return new Promise((resolve) => {
    const specPath = path.join(THUMB_DIR, `_spec_${Date.now()}.json`);
    fs.writeFileSync(specPath, JSON.stringify({ width: THUMB_W, items }, null, 2), 'utf8');
    const p = spawn(PY, [path.join(__dirname, 'py', 'thumbs.py'), specPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', async () => {
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(specPath + '.result.json', 'utf8')); } catch { /* ignore */ }
      try { fs.unlinkSync(specPath); } catch { /* ignore */ }
      try { fs.unlinkSync(specPath + '.result.json'); } catch { /* ignore */ }
      resolve({ payload, err });
    });
    p.on('error', (e) => resolve({ payload: null, err: String(e) }));
  });
}

async function generateThumbs(rels) {
  if (generating) { rels.forEach((r) => pending.add(r)); return; }
  generating = true;
  try {
    const items = [];
    for (const rel of rels) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      items.push({ rel, src: abs, dst: path.join(THUMB_DIR, thumbName(rel)), mtime: st.mtimeMs });
    }
    if (!items.length) return;
    const { payload } = await runPyThumbs(items.map(({ rel, src, dst }) => ({ rel, src, dst })));
    if (payload) {
      let ok = 0;
      for (const it of payload.items) {
        if (!it.ok) { console.error('[thumb] fail', it.rel, it.err); continue; }
        const src = items.find((x) => x.rel === it.rel);
        thumbIndex[it.rel] = {
          file: path.basename(it.dst), mtime: src ? src.mtime : Date.now(),
          src_w: it.src_w, src_h: it.src_h, out_w: it.out_w, out_h: it.out_h,
        };
        ok++;
      }
      await saveThumbIndex();
      if (ok) { broadcast('thumbs', { count: ok, at: Date.now() }); console.log(`[thumb] 生成 ${ok} 张`); }
    }
    if (pending.size) {
      const next = [...pending];
      pending.clear();
      generating = false;
      return generateThumbs(next);
    }
  } finally {
    generating = false;
  }
}

async function scanThumbs({ log = false } = {}) {
  await loadThumbIndex();
  // 清理已删除图片留下的孤儿条目
  let pruned = 0;
  for (const rel of Object.keys(thumbIndex)) {
    if (!fs.existsSync(path.join(ROOT, rel))) { delete thumbIndex[rel]; pruned++; }
  }
  if (pruned) { await saveThumbIndex(); if (log) console.log(`[thumb] 清理孤儿条目 ${pruned} 条`); }
  const all = listImages();
  const need = [];
  for (const rel of all) {
    const abs = path.join(ROOT, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    const rec = thumbIndex[rel];
    const fileOk = rec && fs.existsSync(path.join(THUMB_DIR, rec.file));
    if (!rec || !fileOk || Math.abs((rec.mtime || 0) - st.mtimeMs) > 1) need.push(rel);
  }
  if (log) console.log(`[thumb] 图片 ${all.length} 张，需生成 ${need.length} 张`);
  const CH = 8;
  for (let i = 0; i < need.length; i += CH) {
    await generateThumbs(need.slice(i, i + CH));
  }
  return { total: all.length, generated: need.length };
}

// ------------------------------------------------------------------ 文件监听
let fsQueue = new Set();
let fsTimer = null;
let thumbTimer = null;

function scheduleThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => { scanThumbs().catch((e) => console.error('[thumb]', e)); }, 1500);
}

function onFsEvent(eventType, filename) {
  if (!filename) return;
  const rel = String(filename).split(path.sep).join('/');
  if (rel.startsWith('_canvas/thumbs') || rel.startsWith('_canvas/data/_spec')) return;
  if (rel.includes('_blender_out') || rel.startsWith('成片/blender')) return; // 渲染中间帧不入画布扫描
  fsQueue.add(rel);
  clearTimeout(fsTimer);
  fsTimer = setTimeout(() => {
    const paths = [...fsQueue];
    fsQueue = new Set();
    broadcast('fs', { paths, at: Date.now() });
    if (paths.some((p) => IMG_EXT.has(path.extname(p).toLowerCase()) || p.endsWith('/'))) scheduleThumbs();
  }, 1200);
}

// ------------------------------------------------------------------ 即梦生成进度监听
const DREAMINA_BIN = process.env.DREAMINA_BIN
  || (process.env.DREAMINA_BIN
        || (fs.existsSync(path.join(os.homedir(), 'bin', process.platform === 'win32' ? 'dreamina.exe' : 'dreamina'))
            ? path.join(os.homedir(), 'bin', process.platform === 'win32' ? 'dreamina.exe' : 'dreamina')
            : 'dreamina'));
const GEN_DIR = '即梦产物';
const DESKTOP_DIR = process.env.DESKTOP_DIR || path.join(os.homedir(), 'Desktop');
const genWatch = { on: false, interval: 8000, autoDownload: true, timer: null, prev: null, last: null, busy: false };

function runCli(args, timeout = 90000) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(DREAMINA_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, out: '', err: String(e) }); }
    let out = ''; let err = ''; let done = false;
    const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } fin({ ok: false, out, err: err + '（超时 ' + timeout + 'ms）' }); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => fin({ ok: false, out, err: String(e) }));
    p.on('close', (code) => fin({ ok: code === 0, out, err, code }));
  });
}
function parseJsonLoose(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 继续 */ }
  const i = t.search(/[[{]/);
  if (i < 0) return null;
  try { return JSON.parse(t.slice(i)); } catch { return null; }
}
async function cliJson(args, timeout) {
  const r = await runCli(args, timeout);
  const j = parseJsonLoose(r.out);
  if (j) return j;
  throw new Error((r.err || r.out || 'CLI 无输出').replace(/\s+/g, ' ').slice(0, 300));
}

let genCache = { at: 0, data: null };
async function dreaminaState({ force = false } = {}) {
  const now = Date.now();
  if (!force && genCache.data && now - genCache.at < 4000) return genCache.data;
  const credit = await cliJson(['user_credit'], 60000);
  let raw = [];
  try { raw = await cliJson(['list_task', '--limit=50'], 90000); } catch { raw = []; }
  const tasks = (Array.isArray(raw) ? raw : []).map((t) => ({
    submit_id: t.submit_id, type: t.gen_task_type || '', status: t.gen_status || '',
    fail_reason: t.fail_reason || '', credits: t.commerce_info?.credit_count ?? t.credit_count ?? null,
    images: (t.result_json?.images || []).length, videos: (t.result_json?.videos || []).length,
    sizes: (t.result_json?.images || []).map((i) => `${i.width}×${i.height}`),
    started: t.create_time || t.create_at || t.submit_time || '',
  }));
  const data = {
    at: now, credit: credit.total_credit ?? null, vip: credit.vip_level || '', user: credit.user_id || '',
    tasks,
    counts: {
      total: tasks.length,
      running: tasks.filter((t) => t.status && t.status !== 'success' && t.status !== 'fail').length,
      success: tasks.filter((t) => t.status === 'success').length,
      fail: tasks.filter((t) => t.status === 'fail').length,
    },
    watch: { on: genWatch.on, interval: genWatch.interval, autoDownload: genWatch.autoDownload },
    bin: DREAMINA_BIN, genDir: GEN_DIR,
  };
  genCache = { at: now, data };
  return data;
}

/** 给刚落盘的文件在画布上补节点 */
// ------------------------------------------------------------------ 生图任务（节点 ↔ submit_id）
const JOBS_FILE = path.join(DATA_DIR, 'genjobs.json');
const GEN_MODELS = ['3.0', '3.1', '4.0', '4.1', '4.5', '4.6', '4.7', '5.0', '5.0Pro'];
const GEN_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];
function resOptions(model) {
  if (model === '5.0Pro') return ['1.5k', '2k', '4k'];
  if (['3.0', '3.1'].includes(model)) return ['1k', '2k'];
  return ['2k', '4k'];
}
async function loadJobs() { return (await loadJSON(JOBS_FILE, { jobs: [] })).jobs || []; }
async function saveJobs(jobs) { await fsp.writeFile(JOBS_FILE, JSON.stringify({ jobs }, null, 2), 'utf8'); }

/** 从节点身上找提示词：优先显式传入 → 节点的 prompt 文件 → 节点内联台词 */
async function promptFromNode(card, given) {
  if (given && String(given).trim()) return String(given).trim();
  if (!card) return '';
  if (card.path && fs.existsSync(path.join(ROOT, card.path)) && TEXT_EXT.has(path.extname(card.path).toLowerCase())) {
    const t = await fsp.readFile(path.join(ROOT, card.path), 'utf8');
    const clean = t.split('\n').filter((l) => !/^\s*>/.test(l) && !/^#/.test(l)).join('\n').trim();
    if (clean) return clean.slice(0, 6000);
  }
  if (card.line) return String(card.line).slice(0, 6000);
  if (card.body) return String(card.body).slice(0, 6000);
  return '';
}

function buildImageArgs({ prompt, ratio, resolution_type, model_version, generate_num, width, height, session, poll }) {
  const model = GEN_MODELS.includes(String(model_version)) ? String(model_version) : '5.0';
  const res = resOptions(model).includes(String(resolution_type)) ? String(resolution_type) : resOptions(model)[0];
  const args = ['text2image', '--prompt=' + prompt, '--model_version=' + model, '--resolution_type=' + res];
  const w = Number(width) || 0; const h = Number(height) || 0;
  if (w > 0 && h > 0) { args.push('--width=' + Math.round(w), '--height=' + Math.round(h)); }
  else args.push('--ratio=' + (GEN_RATIOS.includes(String(ratio)) ? String(ratio) : '16:9'));
  const n = Math.min(10, Math.max(1, Number(generate_num) || 1));
  if (n > 1) args.push('--generate_num=' + n);
  if (session) args.push('--session=' + Number(session));
  args.push('--poll=' + (Number(poll) >= 0 ? Number(poll) : 0));
  return { args, model, res, n };
}

/** 生成结束后把结果回填到画布：无图节点就地填充，已有图的节点在旁边新建结果节点并连线 */
async function applyJobResult(submitId, files) {
  const jobs = await loadJobs();
  const job = jobs.find((j) => j.submit_id === submitId);
  if (!job) return { applied: false, reason: '没有登记过的任务（可能是网页端提交）' };
  job.status = 'done'; job.files = files; job.finishedAt = Date.now();
  await saveJobs(jobs);
  if (!files.length) return { applied: false };
  if (!job.nodeId) {                       // 没有绑定节点 → 直接按文件建节点
    const ids = await addNodesForFiles(files);
    return { applied: ids.length > 0, nodeId: ids[0] || '' };
  }
  const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
  board.cards = board.cards || [];
  const card = board.cards.find((c) => c.id === job.nodeId);
  if (!card) return { applied: false, reason: '节点已被删除' };
  const img = files.find((f) => IMG_EXT.has(path.extname(f).toLowerCase())) || files[0];
  let targetId = card.id;
  if (card.src) {
    // 原节点已有图 → 结果另起一个节点挂在右边
    const w = card.w || 290; const h = card.h || 340;
    const newNode = {
      id: 'ai_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      origin: 'ai', type: 'asset', title: (card.title || '生成结果') + ' · 即梦出图', src: img,
      badge: `${job.model} · ${job.ratio} · ${job.res}`, layer: card.layer || 'edit',
      w, h, x: (card.x || 0) + w + 170, y: card.y || 0,
      genJob: { id: job.id, submit_id: submitId, status: 'done', at: Date.now() },
    };
    board.cards.push(newNode);
    board.edges = board.edges || [];
    board.edges.push({ id: 'e_' + Date.now().toString(36), from: card.id, to: newNode.id, kind: 'flow', origin: 'ai' });
    targetId = newNode.id;
  } else {
    card.src = img;
    card.badge = `${job.model} · ${job.ratio} · ${job.res}`;
    card.genJob = { id: job.id, submit_id: submitId, status: 'done', at: Date.now(), prompt: (job.prompt || '').slice(0, 300) };
  }
  await saveBoard(board, 'dreamina');
  return { applied: true, nodeId: targetId, file: img };
}

/** 产物文件名以 submit_id 开头：从任务台账里找回那次提交用的提示词，挂到节点上 */
async function promptForFile(rel) {
  const m = /^([0-9a-f-]{36})/i.exec(path.basename(rel));
  if (!m) return '';
  const sid = m[1];
  try {
    const jobs = await loadJobs();
    const job = jobs.find((j) => j.submit_id === sid);
    if (job && job.prompt) return String(job.prompt).slice(0, 6000);
  } catch { /* ignore */ }
  try {
    if (PIPELINE && PIPELINE.promptBySubmit) return String((await PIPELINE.promptBySubmit(sid)) || '').slice(0, 6000);
  } catch { /* ignore */ }
  return '';
}

async function addNodesForFiles(rels) {
  const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
  board.cards = board.cards || [];
  const used = new Set(board.cards.flatMap((c) => [c.src, c.path]).filter(Boolean));
  const ids = [];
  for (const rel of rels) {
    if (used.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const ext = path.extname(abs).toLowerCase();
    const isImg = IMG_EXT.has(ext);
    const isVid = VIDEO_EXT.has(ext);
    if (!isImg && !isVid && !TEXT_EXT.has(ext)) continue;
    const w = isImg || isVid ? 290 : 330;
    const h = isImg ? 340 : (isVid ? 300 : 250);
    const base = path.basename(rel).replace(/\.[^.]+$/, '');
    const m = /^([0-9a-f-]{36})_image_(\d+)$/i.exec(base);
    const vm = /^([0-9a-f-]{36})_video_(\d+)$/i.exec(base);
    const promptText = (isImg || isVid) ? await promptForFile(rel) : '';
    const card = {
      id: 'ai_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      origin: 'ai',
      type: isImg ? 'asset' : (isVid ? 'video' : 'text'),
      badge: isImg ? '即梦产物' : (isVid ? '即梦视频' : '即梦文本'),
      title: isImg ? (m ? `即梦 · 图 ${m[2]}（${m[1].slice(0, 8)}）` : base)
        : isVid ? (vm ? `即梦 · 视频 ${vm[2]}（${vm[1].slice(0, 8)}）` : base)
          : base,
      path: (isImg || isVid) ? promptText : rel, layer: 'edit', w, h,
      ...nextFreeSpot(board, w, h),
    };
    if (isImg || isVid) { card.src = rel; if (!promptText) delete card.path; }
    board.cards.push(card); used.add(rel); ids.push(card.id);
  }
  if (ids.length) { await saveBoard(board, 'dreamina'); console.log('[dreamina] 补充节点 ' + ids.length + ' 个'); }
  return ids;
}

async function downloadTask(submitId, dir = GEN_DIR, opts = {}) {
  const absDir = path.join(ROOT, dir);
  await fsp.mkdir(absDir, { recursive: true });
  const before = new Set(fs.readdirSync(absDir));
  const r = await runCli(['query_result', '--submit_id=' + submitId, '--download_dir=' + absDir], 240000);
  const created = fs.readdirSync(absDir).filter((f) => !before.has(f)).map((f) => `${dir}/${f}`);
  // 用户要求：出片后下载到桌面。视频产物在项目内留一份（供画布节点用），再复制一份到桌面。
  const desktop = [];
  for (const rel of created) {
    if (!/\.(mp4|mov|webm|mkv)$/i.test(rel)) continue;
    try {
      const dest = path.join(DESKTOP_DIR, path.basename(rel));
      await fsp.copyFile(path.join(ROOT, rel), dest);
      desktop.push(dest);
      console.log('[dreamina] 已复制到桌面：' + dest);
    } catch (e) { console.error('[dreamina] 复制到桌面失败：' + String(e.message || e)); }
  }
  if (created.length) {
    created.forEach((rel) => broadcast('fs', { paths: [rel], at: Date.now(), by: 'dreamina' }));
    scheduleThumbs();
  }
  // 有登记任务时，节点由 applyJobResult 负责创建／回填，避免同一张图建两个节点
  const nodes = opts.skipNodes ? [] : await addNodesForFiles(created);
  return { submitId, files: created, nodes, desktop, ok: created.length > 0, cli: r.ok, err: r.ok ? '' : (r.err || '').slice(0, 300) };
}

/** 该 submit_id 是否已经有落盘产物 */
function genFilesOf(submitId) {
  const absDir = path.join(ROOT, GEN_DIR);
  if (!fs.existsSync(absDir)) return [];
  return fs.readdirSync(absDir).filter((f) => f.startsWith(submitId)).map((f) => `${GEN_DIR}/${f}`);
}

async function genTick({ force = false } = {}) {
  if (genWatch.busy) return genWatch.last;
  genWatch.busy = true;
  try {
    const st = await dreaminaState({ force: true });
    const prev = genWatch.prev;
    const events = [];
    if (prev) {
      for (const t of st.tasks) {
        const p = prev.tasks.find((x) => x.submit_id === t.submit_id);
        if (!p) events.push({ kind: 'new', task: t });
        else if (p.status !== t.status) events.push({ kind: t.status === 'success' ? 'success' : (t.status === 'fail' ? 'fail' : 'status'), task: t, from: p.status });
      }
      if (st.credit != null && prev.credit != null && st.credit !== prev.credit) {
        events.push({ kind: 'credit', delta: st.credit - prev.credit, credit: st.credit });
      }
    }
    genWatch.prev = st; genWatch.last = st;
    for (const e of events) {
      broadcast('dreamina', { ...e, at: Date.now() });
      console.log('[dreamina] 事件 ' + e.kind + ' ' + (e.task ? e.task.submit_id + ' ' + e.task.status : '') + (e.delta ? ' 积分 ' + e.delta : ''));
      if (e.kind === 'success') {
        const jobs = await loadJobs();
        const job = jobs.find((j) => j.submit_id === e.task.submit_id);
        if (!genWatch.autoDownload && !job) continue;
        if (job && job.status === 'done' && (job.files || []).length) continue;   // 已下载并回填过，不重复拉
        try {
          let files = genFilesOf(e.task.submit_id);
          if (!files.length) {
            const r = await downloadTask(e.task.submit_id, GEN_DIR, { skipNodes: !!job });
            files = r.files;
            broadcast('dreamina', { kind: 'downloaded', ...r, at: Date.now() });
            if (r.files.length) console.log('[dreamina] 已下载 ' + r.files.join('、'));
          }
          const ap = await applyJobResult(e.task.submit_id, files);
          if (ap.applied) {
            broadcast('dreamina', { kind: 'filled', submit_id: e.task.submit_id, nodeId: ap.nodeId, file: ap.file, at: Date.now() });
            console.log('[dreamina] 已回填节点 ' + ap.nodeId);
          }
        } catch (err) {
          broadcast('dreamina', { kind: 'download-error', error: String(err.message || err), at: Date.now() });
        }
      }
      if (e.kind === 'fail') {
        const jobs = await loadJobs();
        const job = jobs.find((j) => j.submit_id === e.task.submit_id);
        if (job) {
          job.status = 'fail'; job.error = e.task.fail_reason || ''; job.finishedAt = Date.now();
          await saveJobs(jobs);
          const board = await loadJSON(BOARD_FILE, { cards: [] });
          const card = (board.cards || []).find((c) => c.id === job.nodeId);
          if (card) { card.genJob = { id: job.id, submit_id: job.submit_id, status: 'fail', error: job.error, at: Date.now() }; await saveBoard(board, 'dreamina'); }
        }
      }
    }
    return st;
  } catch (e) {
    broadcast('dreamina', { kind: 'error', error: String(e.message || e), at: Date.now() });
    return genWatch.last;
  } finally {
    genWatch.busy = false;
  }
}
function setGenWatch({ on, interval, autoDownload }) {
  if (interval) genWatch.interval = Math.min(120000, Math.max(3000, Number(interval) || 8000));
  if (autoDownload !== undefined) genWatch.autoDownload = !!autoDownload;
  if (on !== undefined) genWatch.on = !!on;
  if (genWatch.timer) { clearInterval(genWatch.timer); genWatch.timer = null; }
  if (genWatch.on) {
    genWatch.timer = setInterval(() => { genTick().catch(() => {}); }, genWatch.interval);
    genTick().catch(() => {});
  }
  return { on: genWatch.on, interval: genWatch.interval, autoDownload: genWatch.autoDownload };
}

// ------------------------------------------------------------------ AI 工具
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'canvas_state',
      description: '读取画布当前状态摘要：卡片数量与类型分布、三条时间线的时长与镜头数、项目根目录。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_list',
      description: '列出画布卡片（可选按 type 过滤）。返回 id/type/title/位置/尺寸/引用路径。用于先看再改。',
      parameters: {
        type: 'object',
        properties: { type: { type: 'string', description: 'image|text|timeline|note|section，留空为全部' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_add_card',
      description: '在画布上新增一张卡片。type=image 需给 src；type=text 需给 path（项目内已有的文本文件）；type=note 需给 body；type=timeline 需给 section(beats|shots|audio)。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'asset|kf|vprompt|text|image|note|timeline|file' }, title: { type: 'string' },
          x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
          src: { type: 'string', description: '图片相对路径，如 关键帧/01_开场·军士阻拦.png' },
          path: { type: 'string', description: '文本文件相对路径（asset/kf 节点可同时带 path 作为内嵌提示词）' },
          body: { type: 'string', description: '便签正文' },
          section: { type: 'string', description: 'beats|shots|audio' },
          badge: { type: 'string', description: '角标文字' },
          layer: { type: 'string', description: 'input|asset|kf|vprompt|edit|out' },
        },
        required: ['type'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_update_card',
      description: '修改一张卡片：位置、尺寸、标题、图片路径、便签正文等。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: { type: 'object', description: '要覆盖的字段，如 {x:0,y:0,w:300,h:400,title:"...",body:"...",src:"..."}' },
        },
        required: ['id', 'patch'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_remove_card',
      description: '删除一张卡片（只影响画布，不删文件）。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_relayout',
      description: '按分层（左→右）重排画布，保留 AI／手工节点的当前位置。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_auto_layout',
      description: '按分层（左→右：输入→设定资产→关键帧→视频提示词→时间线→成片）强制重排全部节点，并重建相关性连线。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_connect',
      description: '连接两个节点（左出右入的有向边），表示依赖关系。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起点节点 id（输出侧）' },
          to: { type: 'string', description: '终点节点 id（输入侧）' },
          kind: { type: 'string', description: 'rel|flow|appear|doc|candidate|deprecated' },
        },
        required: ['from', 'to'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_disconnect',
      description: '断开连线：给 id 删单条；给 node 删该节点全部进出线。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, node: { type: 'string', description: '节点 id' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timeline_get',
      description: '读取时间线数据。section=beats（10 秒节拍）|shots（18 镜）|audio（音频）|meta。',
      parameters: { type: 'object', properties: { section: { type: 'string' } }, required: ['section'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timeline_set',
      description: '整体替换某一段时间线的数据（先 timeline_get 取回，改完再整体写回）。shots 的每项形如 {n,dur,size,cam,line,sfx,cut,note,kf}；beats 每项 {start,end,name,txt,snd}；audio 含 events/bgm/voice/loudness。',
      parameters: {
        type: 'object',
        properties: { section: { type: 'string' }, value: { description: '该段的完整新数据（对象或数组）' } },
        required: ['section', 'value'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出项目内的文件（可按目录前缀与扩展名过滤）。',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: '相对目录，如 关键帧；留空为全项目' }, ext: { type: 'string', description: '如 .png / .txt' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_text',
      description: '读取项目内文本文件（提示词、剧本、分镜、SRT、JSON 等）的完整内容。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_text',
      description: '写入项目内文本文件（覆盖写入）。用于改提示词、改剧本、写 SRT、写 JSON。会自动同步到画布。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string', description: '一句话说明改动原因' } },
        required: ['path', 'content'], additionalProperties: false,
      },
    },
  },
];

const READONLY_TOOLS = new Set(['canvas_state', 'board_list', 'timeline_get', 'list_files', 'read_text']);

async function loadJSON(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
let CONFIG = {};
let PIPELINE = null;
async function loadConfig() {
  // 分层配置：config.json（可提交，无密钥） → config.local.json（本机私有，gitignore） → 环境变量（最高优先）
  CONFIG = await loadJSON(CONFIG_FILE, {});
  const localFile = path.join(CANVAS_DIR, 'config.local.json');
  try {
    if (fs.existsSync(localFile)) Object.assign(CONFIG, await loadJSON(localFile, {}));
  } catch { /* ignore */ }
  if (process.env.DEEPSEEK_API_KEY) CONFIG.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.AI_API_KEY) CONFIG.apiKey = process.env.AI_API_KEY;
  if (process.env.AI_BASE_URL) CONFIG.baseUrl = process.env.AI_BASE_URL;
  if (process.env.AI_MODEL) CONFIG.model = process.env.AI_MODEL;
  if (CONFIG.apiKey) console.log('[config] 已载入 API 配置：' + CONFIG.baseUrl + ' · ' + CONFIG.model + ' · key ' + String(CONFIG.apiKey).slice(0, 7) + '…（来源：本地/环境变量）');
  else console.log('[config] 未配置 API Key（可在画布 ⚙ 配置 填入，或设置 DEEPSEEK_API_KEY 环境变量）');
}
async function saveBoard(board, by) {
  board.updated = new Date().toISOString();
  delete board._by;
  board.rev = (Number(board.rev) || 0) + 1;
  try {
    const outs = (board.cards || []).filter((c) => c.key && String(c.key).startsWith('out:')).map((c) => ({ key: c.key, src: String(c.src || '').split('/').pop(), badge: c.badge, locked: !!c.locked }));
    await fsp.appendFile(path.join(CANVAS_DIR, 'data', 'save_log.jsonl'), JSON.stringify({ at: board.updated, by: by || '-', rev: board.rev, cards: (board.cards || []).length, outs }) + '\n', 'utf8');
  } catch { /* 日志失败不影响保存 */ }
  const prev = await loadJSON(BOARD_FILE, null);
  const rate = (b) => {
    if (!b || !Array.isArray(b.cards)) return 1;
    const ps = b.cards.map((c) => c.src || (TEXT_EXT.has(path.extname(String(c.path || '')).toLowerCase()) ? c.path : null)).filter(Boolean);
    if (!ps.length) return 1;
    return ps.filter((p) => fs.existsSync(path.join(ROOT, String(p)))).length / ps.length;
  };
  const rn = rate(board); const ro = prev ? rate(prev) : 1;
  if (by === 'user-save') { /* 用户手动保存：不做引用率拒绝，直接落盘 */ }
  else if (prev && rn < 0.5 && ro > 0.8) {
    const bad = `${BOARD_FILE}.rejected-${Date.now()}.json`;
    await fsp.writeFile(bad, JSON.stringify(board, null, 2), 'utf8');
    throw new Error(`拒绝写入画布：新数据里 ${Math.round((1 - rn) * 100)}% 的引用路径不存在，而当前画布只有 ${Math.round((1 - ro) * 100)}% 失效——几乎肯定是编码把中文写坏了（问号化）。可疑数据已另存为 ${path.basename(bad)}，原画布未改动。`);
  }
  if (prev) await fsp.writeFile(boardBakOf(CURRENT_BOARD.id), JSON.stringify(prev, null, 2), 'utf8');
  await fsp.writeFile(BOARD_FILE, JSON.stringify(board, null, 2), 'utf8');
  broadcast('board', { at: Date.now(), by });
  return board;
}
async function saveTimelines(tl, by) {
  tl.meta = tl.meta || {};
  tl.meta.updated = new Date().toISOString();
  delete tl._by;
  await fsp.writeFile(TIMELINE_FILE, JSON.stringify(tl, null, 2), 'utf8');
  broadcast('timelines', { at: Date.now(), by });
  return tl;
}

function compactCards(board) {
  return (board.cards || []).map((c) => ({
    id: c.id, type: c.type, title: c.title, x: c.x, y: c.y, w: c.w, h: c.h,
    src: c.src, path: c.path, section: c.section, layer: c.layer, shot: c.shot, origin: c.origin || 'user',
  }));
}
function shotsSummary(tl) {
  const total = (tl.shots?.items || []).reduce((a, s) => a + (Number(s.dur) || 0), 0);
  return { shots: (tl.shots?.items || []).length, total_sec: total, beats_total: tl.beats?.total, audio_events: (tl.audio?.events || []).length };
}

async function runTool(name, args) {
  switch (name) {
    case 'canvas_state': {
      const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
      const tl = await loadJSON(TIMELINE_FILE, {});
      return {
        root: ROOT, cards: computeStats(board), images: listImages().length,
        timelines: shotsSummary(tl), updated: board.updated,
        layout: board.layout || 'free', layers: (board.layers || []).map((l) => `${l.key}:${l.count}`),
      };
    }
    case 'board_list': {
      const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
      const list = compactCards(board);
      const cards = args?.type ? list.filter((c) => c.type === args.type) : list;
      return { count: cards.length, edges: (board.edges || []).length, cards };
    }
    case 'board_add_card': {
      const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
      const TYPES = ['asset', 'kf', 'vprompt', 'text', 'image', 'note', 'timeline', 'file'];
      const type = TYPES.includes(args.type) ? args.type : 'note';
      const card = {
        id: 'ai_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
        origin: 'ai',
        type,
        title: args.title || '',
        x: Number(args.x ?? 0), y: Number(args.y ?? 0),
        w: Number(args.w ?? (type === 'asset' || type === 'kf' ? 290 : type === 'timeline' ? 1120 : 330)),
        h: Number(args.h ?? (type === 'asset' ? 340 : type === 'kf' ? 360 : type === 'timeline' ? 520 : type === 'file' ? 118 : 250)),
      };
      for (const k of ['src', 'path', 'body', 'section', 'caption', 'badge', 'layer', 'shot', 'line', 'group']) {
        if (args[k] !== undefined) card[k] = args[k];
      }
      if (card.src) { safeAbs(card.src); card.src = card.src.replace(/\\/g, '/'); }
      if (card.path) { safeAbs(card.path); card.path = card.path.replace(/\\/g, '/'); }
      board.cards = board.cards || [];
      if (!args.x && !args.y) Object.assign(card, nextFreeSpot(board, card.w, card.h));
      board.cards.push(card);
      await saveBoard(board);
      return { ok: true, id: card.id, type: card.type };
    }
    case 'board_update_card': {
      const board = await loadJSON(BOARD_FILE, { cards: [] });
      const card = (board.cards || []).find((c) => c.id === args.id);
      if (!card) return { error: '找不到卡片 ' + args.id };
      Object.assign(card, args.patch || {});
      if (card.src) card.src = String(card.src).replace(/\\/g, '/');
      if (card.path) card.path = String(card.path).replace(/\\/g, '/');
      await saveBoard(board);
      return { ok: true, card };
    }
    case 'board_remove_card': {
      const board = await loadJSON(BOARD_FILE, { cards: [] });
      const before = (board.cards || []).length;
      board.cards = (board.cards || []).filter((c) => c.id !== args.id);
      if (board.cards.length === before) return { error: '找不到卡片 ' + args.id };
      await saveBoard(board);
      return { ok: true, removed: args.id };
    }
    case 'board_relayout': {
      const out = await relayout();
      broadcast('board', { at: Date.now() });
      return { ok: true, cards: out.cards.length, edges: out.edges.length };
    }
    case 'board_auto_layout': {
      const out = await relayoutAll();
      broadcast('board', { at: Date.now() });
      return { ok: true, cards: out.cards.length, edges: out.edges.length, layout: out.layout };
    }
    case 'board_connect': {
      const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
      const has = (id) => (board.cards || []).some((c) => c.id === id);
      if (!has(args.from) || !has(args.to)) return { error: '节点不存在：' + (has(args.from) ? args.to : args.from) };
      board.edges = board.edges || [];
      if (board.edges.some((e) => e.from === args.from && e.to === args.to)) return { ok: true, duplicated: true };
      const e = { id: 'e_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), from: args.from, to: args.to, kind: args.kind || 'rel', origin: 'ai' };
      board.edges.push(e);
      await saveBoard(board);
      return { ok: true, edge: e };
    }
    case 'board_disconnect': {
      const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
      const before = (board.edges || []).length;
      board.edges = (board.edges || []).filter((e) => e.id !== args.id && !(args.node && (e.from === args.node || e.to === args.node)));
      if (board.edges.length === before) return { error: '没有匹配的连线' };
      await saveBoard(board);
      return { ok: true, removed: before - board.edges.length };
    }
    case 'timeline_get': {
      const tl = await loadJSON(TIMELINE_FILE, {});
      if (args.section === 'meta') return tl.meta || {};
      return tl[args.section] ?? { error: '未知段落 ' + args.section };
    }
    case 'timeline_set': {
      const tl = await loadJSON(TIMELINE_FILE, {});
      if (!['beats', 'shots', 'audio', 'meta'].includes(args.section)) return { error: '未知段落 ' + args.section };
      tl[args.section] = args.value;
      await saveTimelines(tl);
      return { ok: true, section: args.section, summary: shotsSummary(tl) };
    }
    case 'list_files': {
      const all = listImages();
      const others = [];
      const walk = (dir) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (dir === ROOT && IGNORE_TOP.has(e.name)) continue;
            if (e.name === 'thumbs') continue;
            walk(abs);
          } else onFile(abs);
        }
      };
      const onFile = (abs) => {
        const rel = toRel(abs);
        if (TEXT_EXT.has(path.extname(abs).toLowerCase())) others.push(rel);
      };
      walk(ROOT);
      let out = [...all, ...others];
      if (args?.dir) out = out.filter((p) => p.startsWith(String(args.dir).replace(/\\/g, '/').replace(/\/$/, '') + '/'));
      if (args?.ext) out = out.filter((p) => p.toLowerCase().endsWith(String(args.ext).toLowerCase()));
      return { count: out.length, files: out.slice(0, 400) };
    }
    case 'read_text': {
      const abs = safeAbs(args.path);
      if (!fs.existsSync(abs)) return { error: '文件不存在：' + args.path };
      const ext = path.extname(abs).toLowerCase();
      if (IMG_EXT.has(ext)) return { error: '这是图片文件，不能按文本读取。图片已在视觉通道里，或改读它同名的 .prompt.txt' };
      if (!TEXT_EXT.has(ext)) return { error: '不是文本类文件（' + ext + '），可用 list_files 查看，或用 /api/open 由系统程序打开' };
      const st = fs.statSync(abs);
      if (st.size > 400 * 1024) return { error: '文件过大（>400KB），请分段读取', size: st.size };
      return { path: args.path, size: st.size, content: await fsp.readFile(abs, 'utf8') };
    }
    case 'write_text': {
      const abs = safeAbs(args.path);
      const ext = path.extname(abs).toLowerCase();
      if (!TEXT_EXT.has(ext)) return { error: '只允许写文本类文件，收到 ' + ext };
      if (isThumbPath(abs)) return { error: '不允许写缩略图目录' };
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const content = String(args.content ?? '').replace(/\r\n/g, '\n');
      await fsp.writeFile(abs, content, 'utf8');
      broadcast('fs', { paths: [String(args.path).replace(/\\/g, '/')], at: Date.now(), by: 'ai' });
      return { ok: true, path: args.path, bytes: Buffer.byteLength(content, 'utf8'), reason: args.reason || '' };
    }
    default:
      return { error: '未知工具 ' + name };
  }
}

function buildSystemPrompt(ctx) {
  return [
    '你是《博士国》短剧项目的画布助手（中文）。用户在一个可拖拽的画布上看项目全部素材、提示词与时间线编排，你就是画布内置的操作手。',
    '',
    '画布结构（分层节点图，左入右出）：① 输入·剧本与规范（文本/docx/xlsx 节点）→ ② 设定资产（角色锚点/场景/道具/群像，节点下半部内嵌该图提示词）→ ③ 分镜关键帧 18 镜 → ④ 视频提示词（按镜拆分，制作/视频提示词_分镜/镜NN_*.txt）→ ⑤ 时间线编排（beats/shots/audio）→ ⑥ 成片与取证。节点之间用有向连线表示依赖（kind：appear 出场、flow 流程、doc 来源、candidate 候选、deprecated 已淘汰）。',
    '',
    '项目事实：',
    '· 项目根目录：' + ROOT,
    '· 三条时间线：（a）10 秒锁定镜——当前唯一在制作的时间线，单镜不切，节拍 0–2／2–3／3–7／7–10 秒；（b）18 镜完整版——挂起，每镜 5 秒、共 90 秒；（c）音频时间线——不用满铺 BGM，只两段共 3.8 秒，17 条音效，三个听觉重音（镜 4 枪落地／镜 15 铜钱落盘／镜 18 鞭梢破空）。',
    '· 已知矛盾：对白落点在视频提示词里是 3–7 秒，在字幕与音频设计里是 5.5–9.8 秒；归档完整版剧本 159.8 秒 vs 18 镜 90 秒。',
    '· 关键目录：关键帧/（18 张已出图）、收尾20张/（道具 7／场景 4／群像 2／首尾帧 5／锚点补 2）、锚点/（7 张）、制作/（台本、分镜表、提示词、音频设计）、成片/、_历史版本/。每张图旁边常有同名 .prompt.txt 提示词。',
    '· 用户可以直接把文件拖进画布窗口：文件会存到 参考上传/ 并以附件形式内联给你（图片走视觉通道，文本直接贴内容）。回复时把附件当作参考素材使用。',
    '',
    '工作规则：',
    '1. 先读后写：改任何东西之前，先用 canvas_state / board_list / timeline_get / read_text 看清现状。',
    '2. 改文件用 write_text（覆盖写入，必须给完整内容，不要用省略号）。改画布节点用 board_* 工具，连线用 board_connect / board_disconnect，重排用 board_auto_layout。改时间线用 timeline_get 取回 → 改 → timeline_set 整体写回。',
    '3. 只能操作项目根目录内的文件；路径一律用相对路径、正斜杠。',
    '4. 用户说「改时长」「重排」时，改 shots 里每项的 dur 字段即可，时间码由画布自动重排。',
    '5. 提示词用中文，保留原有的明制服饰／连续性锁等术语；不要引入画面内文字（镜 13 标语镜除外）。',
    '6. 干完活回报：改了哪些文件／卡片、为什么、还有什么没做。不要空谈，不要说「我可以帮你」。',
    ctx ? '\n画布当前上下文（由前端提供）：\n' + ctx : '',
  ].join('\n');
}

async function callModel({ baseUrl, apiKey, model, messages, tools }) {
  const url = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
  const body = { model, messages, temperature: 0.3, stream: false };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`上游 ${r.status} ${r.statusText}：${text.slice(0, 600)}`);
    try { return JSON.parse(text); } catch { throw new Error('上游返回不是 JSON：' + text.slice(0, 300)); }
  } finally {
    clearTimeout(timer);
  }
}

/** 把附件（拖进窗口的文件）内联进最后一条用户消息：文本直接贴，图片转 data URL 交给视觉模型 */
async function buildMessages(messages, attachments, sendImages) {
  const out = (messages || []).map((m) => ({ role: m.role, content: m.content }));
  if (!attachments.length || !out.length) return out;
  const textBlocks = [];
  const imageParts = [];
  for (const a of attachments) {
    const rel = String(a.path || '').replace(/\\/g, '/');
    let abs;
    try { abs = safeAbs(rel); } catch { continue; }
    if (!fs.existsSync(abs)) { textBlocks.push(`【附件缺失：${rel}】`); continue; }
    const ext = path.extname(abs).toLowerCase();
    const size = fs.statSync(abs).size;
    if (IMG_EXT.has(ext)) {
      if (sendImages) {
        const rec = thumbIndex[rel];
        const thumbAbs = rec ? path.join(THUMB_DIR, rec.file) : null;
        const useThumb = thumbAbs && fs.existsSync(thumbAbs);
        const src = useThumb ? thumbAbs : abs;
        const buf = await fsp.readFile(src);
        if (buf.length <= 4 * 1024 * 1024) {
          const mime = path.extname(src).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
          imageParts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
          textBlocks.push(`【参考图：${rel}】${useThumb ? '（已按缩略图送入视觉通道）' : ''}`);
        } else {
          textBlocks.push(`【参考图：${rel}】（${Math.round(size / 1024)}KB，过大未送入视觉通道，可 read_text 读它的 .prompt.txt）`);
        }
      } else {
        textBlocks.push(`【参考图：${rel}】（当前关闭了「把图片发给模型」，只作为路径引用）`);
      }
    } else if (TEXT_EXT.has(ext)) {
      if (size <= 200 * 1024) textBlocks.push(`【附件：${rel}】\n${await fsp.readFile(abs, 'utf8')}`);
      else textBlocks.push(`【附件：${rel}】（${Math.round(size / 1024)}KB，过大未内联，可用 read_text 分段读）`);
    } else {
      textBlocks.push(`【附件：${rel}】（二进制，可用 list_files 处理）`);
    }
  }
  const last = out[out.length - 1];
  const base = typeof last.content === 'string' ? last.content : '';
  const full = [base, ...textBlocks].filter(Boolean).join('\n\n');
  out[out.length - 1] = imageParts.length
    ? { role: 'user', content: [{ type: 'text', text: full }, ...imageParts] }
    : { role: 'user', content: full };
  return out;
}

async function handleAITest(req, res) {
  const body = await readBody(req);
  const apiKey = body.apiKey || CONFIG.apiKey;
  const baseUrl = String(body.baseUrl || CONFIG.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = body.model || CONFIG.model;
  if (!apiKey) return json(res, 400, { ok: false, error: '缺少 API Key' });
  const out = { ok: false, baseUrl, model, models: [] };
  try {
    const rl = await fetch(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + apiKey } });
    if (rl.ok) {
      const d = await rl.json();
      out.models = (d.data || []).map((m) => ({ id: m.id, name: m.name || '', ctx: m.context_window || 0 }));
    }
  } catch { /* 有的中转不支持 /models，忽略 */ }
  try {
    const r = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回答两个字：可用' }], max_tokens: 8 }),
    });
    const t = await r.text();
    if (!r.ok) { out.error = `HTTP ${r.status}：${t.slice(0, 400)}`; return json(res, 200, out); }
    const d = JSON.parse(t);
    out.ok = true;
    out.resolved = d.model || model;
    out.reply = d.choices?.[0]?.message?.content || '';
    const hit = out.models.find((m) => m.id === out.resolved);
    out.resolved_name = hit ? hit.name : '';
    out.tools = true;
    return json(res, 200, out);
  } catch (e) {
    out.error = String(e.message || e);
    return json(res, 200, out);
  }
}

async function handleAI(req, res) {
  let body;
  try { body = await readBody(req, 4 * 1024 * 1024); } catch (e) { return json(res, 400, { error: String(e.message) }); }
  const apiKey = body.apiKey || CONFIG.apiKey;
  const baseUrl = body.baseUrl || CONFIG.baseUrl || 'https://api.deepseek.com';
  const model = body.model || CONFIG.model;
  const { messages = [], allowWrite = true, maxSteps = 10, clientContext = '' } = body;
  if (!apiKey) return json(res, 400, { error: '缺少 API Key' });
  if (!model) return json(res, 400, { error: '缺少模型名' });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* ignore */ } };
  const tools = allowWrite ? TOOLS : TOOLS.filter((t) => READONLY_TOOLS.has(t.function.name));
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const msgs = await buildMessages(messages, attachments, body.sendImages !== false);
  const convo = [{ role: 'system', content: buildSystemPrompt(clientContext) }, ...msgs];
  const changed = [];
  if (attachments.length) send({ type: 'attach', count: attachments.length, images: attachments.filter((a) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.path || '')).length });

  try {
    for (let step = 0; step < maxSteps; step++) {
      const r = await callModel({ baseUrl, apiKey, model, messages: convo, tools });
      const msg = r?.choices?.[0]?.message;
      if (!msg) throw new Error('上游没有返回 message：' + JSON.stringify(r).slice(0, 300));
      convo.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
      if (msg.content && String(msg.content).trim()) send({ type: 'text', text: msg.content });
      const calls = msg.tool_calls || [];
      if (!calls.length) break;
      for (const c of calls) {
        const name = c.function?.name;
        let args = {};
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* ignore */ }
        send({ type: 'step', name, args });
        let result;
        try {
          if (!tools.some((t) => t.function.name === name)) result = { error: '当前模式下不允许调用 ' + name };
          else result = await runTool(name, args);
        } catch (e) { result = { error: String(e.message || e) }; }
        const bad = result && result.error;
        if (!bad && ['write_text', 'board_add_card', 'board_update_card', 'board_remove_card',
          'board_relayout', 'board_auto_layout', 'board_connect', 'board_disconnect', 'timeline_set'].includes(name)) {
          const rec = { tool: name, target: args.path || args.id || args.section || '' };
          if (result && result.id) rec.id = result.id;
          if (args.id && (name === 'board_update_card' || name === 'board_remove_card')) rec.id = args.id;
          if (name === 'write_text' && args.path) rec.path = String(args.path).replace(/\\/g, '/');
          if (name === 'timeline_set' && args.section) rec.section = args.section;
          if (name === 'board_connect') rec.pair = [args.from, args.to];
          if (name === 'board_relayout' || name === 'board_auto_layout') rec.all = true;
          changed.push(rec);
        }
        send({ type: 'step-result', name, ok: !bad, summary: bad ? result.error : summarise(result) });
        convo.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 24000) });
      }
    }
    send({ type: 'done', changed, ...(await resolveFocus(changed)) });
  } catch (e) {
    send({ type: 'error', error: String(e.message || e) });
  } finally {
    try { res.end(); } catch { /* ignore */ }
  }
}

/** 给新节点找一个不重叠的位置：整张画布右侧另起一列，自上往下堆 */
function nextFreeSpot(board, w, h) {
  const cards = board.cards || [];
  const maxX = cards.reduce((m, c) => Math.max(m, (c.x || 0) + (c.w || 0)), 0);
  const x = maxX + 170;
  const sameCol = cards.filter((c) => Math.abs((c.x || 0) - x) < 40);
  const y = sameCol.length ? Math.max(...sameCol.map((c) => (c.y || 0) + (c.h || 0))) + 26 : 200;
  return { x, y };
}

/** 把「改了什么」换算成画布上要自动聚焦的节点 id；AI 新写出的文件会自动补一个节点 */
async function resolveFocus(changed) {
  const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
  board.cards = board.cards || [];
  const byPath = new Map(board.cards.filter((c) => c.path).map((c) => [c.path, c]));
  const focus = new Set();
  let focusAll = false;
  for (const c of changed) {
    if (c.all) focusAll = true;
    if (c.id) focus.add(c.id);
    if (c.path) { const hit = byPath.get(c.path); if (hit) focus.add(hit.id); }
    if (c.section) board.cards.filter((x) => x.type === 'timeline' && x.section === c.section).forEach((x) => focus.add(x.id));
    if (c.pair) c.pair.forEach((id) => focus.add(id));
  }
  // AI 新生成的文件 → 在画布上补一个节点，让「生成的内容」看得见也聚焦得到
  let added = 0;
  for (const c of changed) {
    if (c.tool !== 'write_text' || !c.path || byPath.has(c.path) || c.path.startsWith('_canvas/')) continue;
    const abs = path.join(ROOT, c.path);
    if (!fs.existsSync(abs)) continue;
    const ext = path.extname(abs).toLowerCase();
    const isImg = IMG_EXT.has(ext);
    if (!isImg && !TEXT_EXT.has(ext)) continue;
    const w = isImg ? 290 : 330; const h = isImg ? 340 : 250;
    const card = {
      id: 'ai_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      origin: 'ai', type: isImg ? 'asset' : 'text', title: path.basename(c.path).replace(/\.[^.]+$/, ''),
      path: c.path, layer: 'edit', badge: isImg ? 'AI 新图' : 'AI 新文件', w, h,
      ...nextFreeSpot(board, w, h),
    };
    if (isImg) card.src = c.path;
    board.cards.push(card); byPath.set(c.path, card); focus.add(card.id); added++;
    console.log('[focus] 为新文件补节点：' + c.path);
  }
  if (added) await saveBoard(board, 'ai');
  const live = new Set(board.cards.map((c) => c.id));
  const list = [...focus].filter((id) => live.has(id));
  if (focusAll) return { focus: board.cards.map((c) => c.id), focusAll: true, added };
  return { focus: list, focusAll: false, added };
}

function summarise(r) {
  if (!r || typeof r !== 'object') return String(r).slice(0, 200);
  if (r.ok) return 'ok' + (r.path ? ' · ' + r.path : '') + (r.id ? ' · ' + r.id : '') + (r.bytes ? ' · ' + r.bytes + ' bytes' : '');
  if (r.count !== undefined) return 'count=' + r.count;
  if (Array.isArray(r.cards)) return 'cards=' + r.cards.length;
  if (r.cards && typeof r.cards === 'object') return 'cards=' + JSON.stringify(r.cards).slice(0, 200);
  if (r.items) return 'items=' + r.items.length;
  if (r.content) return 'read ' + r.content.length + ' chars';
  if (r.files) return 'files=' + r.files.length;
  return JSON.stringify(r).slice(0, 200);
}

// ------------------------------------------------------------------ 制作流水线：即梦适配器
// 参数以 `dreamina <cmd> -h` 实测为准（CLI v1.4.20）：
//   text2image  --prompt --model_version --resolution_type --ratio --generate_num --poll
//   image2video --image --prompt --model_version --video_resolution --duration --poll（2.5 不接受 --ratio）
//   text2video  --prompt --model_version --video_resolution --duration --ratio --poll
const PIPE_VIDEO_MODELS = ['seedance2.5', 'seedance2.0_vip', 'seedance2.0', 'seedance2.0fast', 'seedance2.0fast_vip', 'seedance2.0mini', 'seedance1.5pro', 'seedance1.0fast'];
let dreaminaProbe = { available: null, bin: DREAMINA_BIN, reason: '' };
async function probeDreamina() {
  if (dreaminaProbe.available !== null) return dreaminaProbe;
  const bin = DREAMINA_BIN;
  if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
    dreaminaProbe = { available: false, bin, reason: '找不到可执行文件：' + bin };
    return dreaminaProbe;
  }
  const r = await runCli(['--help'], 15000);
  const all = String((r.out || '') + (r.err || ''));
  const spawnFail = /ENOENT|is not recognized|无法将|找不到|not found|cannot find/i.test(all);
  const ok = !spawnFail && (r.ok || /usage|--help|命令|command/i.test(all));
  dreaminaProbe = {
    available: !!ok, bin,
    reason: ok ? '' : ('CLI 调不通：' + String(all || '无输出').replace(/\s+/g, ' ').slice(0, 220)),
  };
  return dreaminaProbe;
}

function pipeImageArgs({ prompt, ratio, model, resolution, n }) {
  const m = GEN_MODELS.includes(String(model)) ? String(model) : '5.0';
  const res = resOptions(m).includes(String(resolution)) ? String(resolution) : resOptions(m)[0];
  const args = ['text2image', '--prompt=' + prompt, '--model_version=' + m, '--resolution_type=' + res];
  args.push('--ratio=' + (GEN_RATIOS.includes(String(ratio)) ? String(ratio) : '9:16'));
  const num = Math.min(10, Math.max(1, Number(n) || 1));
  if (num > 1) args.push('--generate_num=' + num);
  args.push('--poll=0');
  return { args, model: m, res, n: num };
}
function resolveFirstFrame(image) {
  const s = String(image || '').trim();
  if (!s) return '';
  try {
    const abs = path.isAbsolute(s) ? s : path.join(ROOT, s.replace(/\\/g, '/'));
    return fs.existsSync(abs) ? abs : '';
  } catch { return ''; }
}
function pipeVideoArgs({ prompt, duration, model, resolution, image, ratio }) {
  const mvRaw = String(model || '');
  const mv = PIPE_VIDEO_MODELS.includes(mvRaw) ? mvRaw : 'seedance2.5';
  const maxDur = mv === 'seedance2.5' ? 30 : 15;
  const dur = Math.min(maxDur, Math.max(4, Math.round(Number(duration) || 10)));
  const res = ['480p', '720p', '1080p', '4k'].includes(String(resolution)) ? String(resolution) : '720p';
  const r = GEN_RATIOS.includes(String(ratio)) ? String(ratio) : '9:16';
  const img = resolveFirstFrame(image);
  if (img) {
    // 图生视频：2.5 跟随首帧、不接受 --ratio；其它模型 ratio 可省略（从首帧推断）
    const args = ['image2video', '--image=' + img, '--prompt=' + prompt,
      '--model_version=' + mv, '--video_resolution=' + res, '--duration=' + dur, '--poll=0'];
    return { args, model: mv, res, dur, mode: 'image2video', image: img };
  }
  // 没有可用首帧时退回文生视频（丢连续性但能出片）
  const args = ['text2video', '--prompt=' + prompt,
    '--model_version=' + mv, '--video_resolution=' + res, '--duration=' + dur,
    '--ratio=' + r, '--poll=0'];
  return { args, model: mv, res, dur, mode: 'text2video', image: '' };
}
const pipelineDreamina = {
  get available() { return dreaminaProbe.available === true; },
  get bin() { return DREAMINA_BIN; },
  get reason() { return dreaminaProbe.reason; },
  async submitImage({ prompt, ratio, model, resolution, n }) {
    const a = pipeImageArgs({ prompt, ratio, model, resolution, n });
    const r = await runCli(a.args, 300000);
    const j = parseJsonLoose(r.out);
    if (!j || !j.submit_id) throw new Error('提交失败：' + ((r.err || r.out || '无输出').replace(/\s+/g, ' ').slice(0, 300)));
    console.log('[pipeline] 提交图片 ' + j.submit_id + ' · ' + a.model + ' · ' + a.res);
    return { submitId: j.submit_id, args: a.args };
  },
  async submitVideo({ prompt, duration, model, resolution, image, ratio }) {
    const a = pipeVideoArgs({ prompt, duration, model, resolution, image, ratio });
    const r = await runCli(a.args, 300000);
    const j = parseJsonLoose(r.out);
    if (!j || !j.submit_id) throw new Error('提交失败：' + ((r.err || r.out || '无输出').replace(/\s+/g, ' ').slice(0, 300)));
    console.log('[pipeline] 提交视频 ' + j.submit_id + ' · ' + a.model + ' · ' + a.dur + 's · ' + a.mode + (a.image ? '' : '（无首帧，已退回文生视频）'));
    return { submitId: j.submit_id, args: a.args, mode: a.mode };
  },
  async query(submitId) {
    const raw = await cliJson(['query_result', '--submit_id=' + submitId], 120000);
    return {
      status: raw.gen_status || '',
      credits: raw.commerce_info?.credit_count ?? raw.credit_count ?? null,
      failReason: raw.fail_reason || '',
      files: genFilesOf(submitId),
      images: (raw.result_json?.images || []).length,
      videos: (raw.result_json?.videos || []).length,
    };
  },
  async download(submitId, dir) {
    const r = await downloadTask(submitId, dir || GEN_DIR);
    if (!r.files.length) {
      const existed = genFilesOf(submitId);
      if (existed.length) {
        // 文件之前已落盘：补建画布节点，避免"下载成功但画布没有"
        const nodes = await addNodesForFiles(existed);
        broadcast('fs', { paths: existed, at: Date.now(), by: 'pipeline-download' });
        scheduleThumbs();
        return { ...r, files: existed, nodes, reused: true };
      }
    }
    return r;
  },
  /** 只拼参数不提交（免费预检） */
  preview({ type, prompt, params = {} }) {
    if (type === 'image') {
      const a = pipeImageArgs({ prompt, ratio: params.ratio, model: params.model, resolution: params.resolution, n: params.n });
      return { cmd: DREAMINA_BIN, args: a.args, mode: 'text2image' };
    }
    const a = pipeVideoArgs({ prompt, duration: params.duration, model: params.model, resolution: params.resolution, image: params.firstFrame, ratio: params.ratio });
    return { cmd: DREAMINA_BIN, args: a.args, mode: a.mode, firstFrameFound: !!a.image };
  },
};

// ------------------------------------------------------------------ 路由
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      const buf = await fsp.readFile(path.join(CANVAS_DIR, 'canvas.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      return res.end(buf);
    }

    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now(), root: ROOT })}\n\n`);
      clients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* ignore */ } }, 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    if (p === '/api/state') {
      const board = await loadJSON(BOARD_FILE, { cards: [] });
      const tl = await loadJSON(TIMELINE_FILE, {});
      const missing = (board.cards || []).map((c) => {
        const q = c.src || (/\.(png|jpe?g|webp|gif|bmp|md|txt|srt|json|jsonl|csv)$/i.test(String(c.path || '')) ? c.path : null);
        return q && !fs.existsSync(path.join(ROOT, q)) ? { id: c.id, title: c.title, path: q, type: c.type } : null;
      }).filter(Boolean);
      return json(res, 200, {
        root: ROOT, updated: board.updated, stats: computeStats(board),
        board: CURRENT_BOARD ? { id: CURRENT_BOARD.id, name: CURRENT_BOARD.name } : null,
        boards: BOARD_IDX ? BOARD_IDX.boards.map((b) => ({ id: b.id, name: b.name })) : [],
        images: listImages().length, thumbs: Object.keys(thumbIndex).length,
        timeline: shotsSummary(tl), cards: compactCards(board),
        missingCount: missing.length, missing: missing.slice(0, 60),
      });
    }

    if (p === '/api/upload') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const dir = String(url.searchParams.get('dir') || '参考上传').replace(/[\\:]+/g, '/').replace(/\.\./g, '').replace(/^\/+|\/+$/g, '');
      const name = url.searchParams.get('name') || 'upload.bin';
      const buf = await readRaw(req);
      if (!buf.length) return json(res, 400, { error: '空文件' });
      const absDir = safeAbs(dir);
      await fsp.mkdir(absDir, { recursive: true });
      const rel = uniqueRelPath(dir, name);
      await fsp.writeFile(path.join(ROOT, rel), buf);
      const ext = path.extname(rel).toLowerCase();
      const kind = IMG_EXT.has(ext) ? 'image' : (VIDEO_EXT.has(ext) ? 'video' : (TEXT_EXT.has(ext) ? 'text' : 'binary'));
      broadcast('fs', { paths: [rel], at: Date.now(), by: 'upload' });
      if (kind === 'image') scheduleThumbs();
      return json(res, 200, { ok: true, path: rel, name: path.basename(rel), size: buf.length, kind });
    }

    if (p === '/api/dreamina' || p.startsWith('/api/dreamina/')) {
      if (p === '/api/dreamina') {
        if (req.method === 'GET') {
          const force = url.searchParams.has('force');
          const now = Date.now();
          // 10 分钟缓存：CLI 查询很慢（~35s），面板不应每次等它
          if (!force && globalThis.__dstate && globalThis.__dstate.at && now - globalThis.__dstate.at < 600000) {
            return json(res, 200, Object.assign({}, globalThis.__dstate.data, { cached: true, cacheAge: Math.round((now - globalThis.__dstate.at) / 1000) }));
          }
          if (!force && globalThis.__dstatePromise) {
            try { return json(res, 200, Object.assign({}, await globalThis.__dstatePromise, { cached: true })); } catch { /* fallthrough */ }
          }
          globalThis.__dstatePromise = (async () => {
            try { const d = await dreaminaState({ force }); globalThis.__dstate = { at: Date.now(), data: d }; return d; }
            catch (e) { return { error: String(e.message || e), bin: DREAMINA_BIN, tasks: [], credit: null }; }
            finally { globalThis.__dstatePromise = null; }
          })();
          try { return json(res, 200, await globalThis.__dstatePromise); }
          catch (e) { return json(res, 200, { error: String(e.message || e), bin: DREAMINA_BIN, tasks: [], credit: null }); }
        }
        return json(res, 405, { error: 'GET only' });
      }
      const body = await readBody(req);
      if (p === '/api/dreamina/watch') {
        const w = setGenWatch(body || {});
        broadcast('dreamina', { kind: 'watch', ...w, at: Date.now() });
        return json(res, 200, { ok: true, ...w });
      }
      if (p === '/api/dreamina/tick') {
        const st = await genTick({ force: true });
        return json(res, 200, { ok: true, state: st });
      }
      if (p === '/api/dreamina/query') {
        if (!body.submit_id) return json(res, 400, { error: '缺少 submit_id' });
        const raw = await cliJson(['query_result', '--submit_id=' + body.submit_id], 90000);
        return json(res, 200, {
          ok: true, submit_id: raw.submit_id, status: raw.gen_status, credit: raw.credit_count,
          queue: raw.queue_info || null,
          images: (raw.result_json?.images || []).map((i) => ({ w: i.width, h: i.height, url: i.image_url })),
          videos: (raw.result_json?.videos || []),
          fail_reason: raw.fail_reason || '',
        });
      }
      if (p === '/api/dreamina/submit') {
        const board = await loadJSON(BOARD_FILE, { cards: [], edges: [] });
        const card = body.nodeId ? (board.cards || []).find((c) => c.id === body.nodeId) : null;
        if (body.nodeId && !card) return json(res, 404, { error: '找不到节点 ' + body.nodeId });
        const prompt = await promptFromNode(card, body.prompt);
        if (!prompt) return json(res, 400, { error: '没有提示词：请先填 prompt，或让该节点挂一个 .prompt.txt' });
        const { args, model, res: resType, n } = buildImageArgs({ ...body, prompt });
        if (body.dry) return json(res, 200, { ok: true, dry: true, cmd: DREAMINA_BIN, args, model, resolution_type: resType, generate_num: n, promptChars: prompt.length });
        const creditBefore = (await cliJson(['user_credit'], 60000).catch(() => ({}))).total_credit ?? null;
        const t0 = Date.now();
        const r = await runCli(args, 180000);
        const j = parseJsonLoose(r.out);
        if (!j || !j.submit_id) {
          return json(res, 502, { error: '提交失败：' + ((r.err || r.out || '无输出').replace(/\s+/g, ' ').slice(0, 400)), args });
        }
        const job = {
          id: 'j_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
          nodeId: body.nodeId || '', submit_id: j.submit_id, status: j.gen_status || 'querying',
          prompt: prompt.slice(0, 4000), model, ratio: args.find((a) => a.startsWith('--ratio='))?.slice(8) || '',
          res: resType, n, at: t0, creditBefore, args,
        };
        const jobs = await loadJobs(); jobs.unshift(job); await saveJobs(jobs.slice(0, 200));
        if (card) {
          card.genJob = { id: job.id, submit_id: job.submit_id, status: 'queued', at: t0, model, ratio: job.ratio, res: resType, prompt: prompt.slice(0, 300) };
          card.badge = '生成中…';
          await saveBoard(board, 'dreamina');
        }
        console.log('[dreamina] 已提交 ' + job.submit_id + ' · ' + model + ' · ' + job.ratio + ' · ' + resType + ' ×' + n);
        genCache = { at: 0, data: null };
        try { genTick().catch(() => {}); } catch { /* ignore */ }
        broadcast('dreamina', { kind: 'submitted', job, at: Date.now() });
        return json(res, 200, { ok: true, job, creditBefore, cmd: DREAMINA_BIN, args });
      }
      if (p === '/api/dreamina/jobs') {
        return json(res, 200, { jobs: (await loadJobs()).slice(0, 60) });
      }
      if (p === '/api/dreamina/options') {
        const models = {};
        for (const m of GEN_MODELS) models[m] = resOptions(m);
        return json(res, 200, { models, ratios: GEN_RATIOS, default: { model: '5.0', resolution_type: '2k', ratio: '9:16' },
          priceHint: '参考价：5.0 + 2k + 1 张 ≈ 3 积分（H1 实测账单）；其它组合未实测，以 user_credit 前后差为准。' });
      }
      if (p === '/api/dreamina/download') {
        if (!body.submit_id) return json(res, 400, { error: '缺少 submit_id' });
        const r = await downloadTask(body.submit_id, body.dir || GEN_DIR);
        return json(res, 200, r);
      }
      return json(res, 404, { error: '未知的 dreamina 接口' });
    }

    if (p === '/api/config') {
      return json(res, 200, {
        baseUrl: CONFIG.baseUrl || 'https://api.deepseek.com',
        model: CONFIG.model || 'deepseek-flash',
        apiKey: '', serverKey: !!CONFIG.apiKey,
        models: CONFIG.models || [],
        note: CONFIG.note || '',
        configFile: CONFIG_FILE,
      });
    }

    if (p === '/api/ai-test') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      return handleAITest(req, res);
    }

    if (p === '/api/thumbs') return json(res, 200, thumbIndex);

    // 多画布：列表 / 新建 / 切换 / 改名 / 删除（删除=挪进 _trash，不物理删）
    if (p === '/api/boards') {
      if (req.method === 'GET') {
        const boards = [];
        for (const b of BOARD_IDX.boards) boards.push(await boardSummary(b));
        return json(res, 200, { current: BOARD_IDX.current, boards });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET/POST only' });
      const body = await readBody(req);
      const action = String(body.action || 'create');
      if (action === 'create') {
        const name = String(body.name || '').trim() || ('新画布 ' + (BOARD_IDX.boards.length + 1));
        const b = await createEmptyBoard(name);
        applyActiveBoard(b.id);
        await saveBoardsIndex();
        broadcast('boards', { at: Date.now(), current: b.id, by: 'create' });
        broadcast('board', { at: Date.now(), by: 'create' });
        broadcast('timelines', { at: Date.now(), by: 'create' });
        return json(res, 200, { ok: true, id: b.id, name: b.name, total: BOARD_IDX.boards.length });
      }
      const id = String(body.id || '');
      const b = BOARD_IDX.boards.find((x) => x.id === id);
      if (!b) return json(res, 404, { error: '画布不存在：' + id });
      if (action === 'select') {
        applyActiveBoard(b.id);
        await saveBoardsIndex();
        broadcast('boards', { at: Date.now(), current: b.id, by: 'select' });
        broadcast('board', { at: Date.now(), by: 'select' });
        broadcast('timelines', { at: Date.now(), by: 'select' });
        return json(res, 200, { ok: true, id: b.id, name: b.name });
      }
      if (action === 'rename') {
        const name = String(body.name || '').trim();
        if (!name) return json(res, 400, { error: '名称不能为空' });
        b.name = name.slice(0, 40);
        await saveBoardsIndex();
        broadcast('boards', { at: Date.now(), current: BOARD_IDX.current, by: 'rename' });
        return json(res, 200, { ok: true, id: b.id, name: b.name });
      }
      if (action === 'delete') {
        if (BOARD_IDX.boards.length <= 1) return json(res, 400, { error: '这是最后一块画布，不能删' });
        await fsp.mkdir(BOARDS_TRASH, { recursive: true });
        const trashName = `${b.id}-${Date.now()}`;
        try { await fsp.rename(boardDir(b.id), path.join(BOARDS_TRASH, trashName)); }
        catch (e) { return json(res, 500, { error: '移入回收站失败：' + String(e.message || e) }); }
        BOARD_IDX.boards = BOARD_IDX.boards.filter((x) => x.id !== b.id);
        if (BOARD_IDX.current === b.id) applyActiveBoard(BOARD_IDX.boards[0].id);
        await saveBoardsIndex();
        broadcast('boards', { at: Date.now(), current: BOARD_IDX.current, by: 'delete' });
        broadcast('board', { at: Date.now(), by: 'delete' });
        broadcast('timelines', { at: Date.now(), by: 'delete' });
        return json(res, 200, { ok: true, id: b.id, trash: trashName, current: BOARD_IDX.current });
      }
      return json(res, 400, { error: '未知操作：' + action });
    }

    // ---------------------------------------------------------------- 制作流水线（pipeline）
    if (p === '/pipeline' || p === '/pipeline.html') {
      try {
        const buf = await fsp.readFile(path.join(CANVAS_DIR, 'pipeline.html'));
        // HTML_GUARD：标签未闭合会让整个 body 被当成 CSS 吞掉（页面纯黑的经典原因），这里直接报错而不是静默发黑屏
        const html = buf.toString('utf8');
        const pair = (tag) => [ (html.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) || []).length, (html.match(new RegExp('</' + tag + '>', 'g')) || []).length ];
        const bad = ['style', 'script'].filter((t) => { const [a, b] = pair(t); return a !== b; });
        if (bad.length) {
          console.error('[pipeline] pipeline.html 标签未闭合：' + bad.join(','));
          return json(res, 500, { error: 'pipeline.html 结构损坏（未闭合标签：' + bad.join(',') + '），请检查最近一次编辑；页面为避免黑屏已拒绝输出' });
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Content-Length': buf.length });
        return res.end(buf);
      } catch (e) { return json(res, 404, { error: 'pipeline.html 不存在：' + String(e.message || e) }); }
    }
    if (p.startsWith('/api/pipeline')) {
      if (!PIPELINE) return json(res, 503, { error: '流水线未就绪' });
      const route = p.slice('/api/pipeline'.length) || '/';
      try {
        if (route === '/meta' && req.method === 'GET') return json(res, 200, await PIPELINE.meta());
        if (route === '/list' && req.method === 'GET') return json(res, 200, await PIPELINE.list());
        if (route === '/state' && req.method === 'GET') return json(res, 200, await PIPELINE.getState(url.searchParams.get('id') || ''));
        if (route === '/create' && req.method === 'POST') return json(res, 200, await PIPELINE.create(await readBody(req)));
        if (route === '/update' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await PIPELINE.update(b.id, b)); }
        if (route === '/run' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await PIPELINE.runStep(b.id, b.step)); }
        if (route === '/run-batch' && req.method === 'POST') {
          const b = await readBody(req);
          return json(res, 200, await PIPELINE.runBatch(b.id, b.steps));
        }
        if (route === '/restore-step' && req.method === 'POST') {
          const b = await readBody(req);
          const r = await PIPELINE.restoreStep(b.id, b.step);
          broadcast('pipeline', { id: b.id, step: b.step, status: 'done', message: '已恢复上次结果', at: Date.now() });
          return json(res, 200, r);
        }
        if (route === '/save' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await PIPELINE.saveMd(b.id, b.step, b.md)); }
        if (route === '/export' && req.method === 'POST') {
          const b = await readBody(req);
          const r = await PIPELINE.exportDocs(b.id);
          if (r.files && r.files.length) { broadcast('fs', { paths: r.files, at: Date.now(), by: 'pipeline' }); scheduleThumbs(); }
          return json(res, 200, r);
        }
        if (route === '/bind-image' && req.method === 'POST') {
          const b = await readBody(req);
          const r = await PIPELINE.bindImage(b.id, b);
          broadcast('pipeline', { id: b.id, step: 'images', status: 'done', message: '图片索引已更新', at: Date.now() });
          return json(res, 200, r);
        }
        if (route === '/unbind-image' && req.method === 'POST') {
          const b = await readBody(req);
          const r = await PIPELINE.unbindImage(b.id, b);
          broadcast('pipeline', { id: b.id, step: 'images', status: 'done', message: '图片索引已更新', at: Date.now() });
          return json(res, 200, r);
        }
        if (route === '/image-candidates' && req.method === 'GET') {
          return json(res, 200, await PIPELINE.imageCandidates(url.searchParams.get('id') || '', {
            kind: url.searchParams.get('kind') || 'asset',
            key: url.searchParams.get('key') || '',
            q: url.searchParams.get('q') || '',
          }));
        }
        if (route === '/tasks') {
          if (req.method === 'GET') return json(res, 200, await PIPELINE.tasksOf(url.searchParams.get('id') || ''));
          const b = await readBody(req);
          const r = await PIPELINE.taskAction(b.id || '', b);
          if (r && r.task && r.task.files && r.task.files.length) { broadcast('fs', { paths: r.task.files, at: Date.now(), by: 'pipeline' }); scheduleThumbs(); }
          return json(res, 200, r);
        }
        if (route === '/' || route === '') {
          if (req.method === 'DELETE') return json(res, 200, await PIPELINE.remove(url.searchParams.get('id') || ''));
          return json(res, 405, { error: 'GET /list · /state；POST /create /run /save /export /tasks；DELETE ?id=' });
        }
        return json(res, 404, { error: '未知的流水线接口：' + p });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    if (p === '/api/board') {
      if (req.method === 'GET') return json(res, 200, await loadJSON(BOARD_FILE, { cards: [] }));
      const body = await readBody(req);
      const board = body.cards ? body : { cards: [] };
      try { await saveBoard(board, body._by); }
      catch (e) { return json(res, 409, { error: String(e.message || e) }); }
      return json(res, 200, { ok: true, cards: board.cards.length });
    }

    if (p === '/api/render/start') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (globalThis.__renderProc && globalThis.__renderProc.exitCode === null) return json(res, 200, { ok: true, running: true });
      const statusFile = path.join(CANVAS_DIR, 'data', 'render_status.json');
      try { await fsp.mkdir(path.dirname(statusFile), { recursive: true }); await fsp.writeFile(statusFile, JSON.stringify({ state: 'starting', stage: 'spawn', progress: 0, at: new Date().toISOString() }), 'utf8'); } catch {}
      const script = path.join(ROOT, '人物替换_NIGHTDANCER', '工具', 'render_pipeline.py');
      const py = process.env.DSH_PYTHON || 'python';
      const logDir = path.join(CANVAS_DIR, 'data'); await fsp.mkdir(logDir, { recursive: true });
      const out = fs.openSync(path.join(logDir, 'render_pipeline.log'), 'a');
      const proc = spawn(py, [script], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true });
      proc.unref();
      globalThis.__renderProc = proc;
      return json(res, 200, { ok: true, started: true, pid: proc.pid });
    }
    if (p === '/api/render/status') {
      const statusFile = path.join(CANVAS_DIR, 'data', 'render_status.json');
      let st = { state: 'idle' };
      try { st = JSON.parse(await fsp.readFile(statusFile, 'utf8')); } catch {}
      st.processRunning = !!(globalThis.__renderProc && globalThis.__renderProc.exitCode === null);
      return json(res, 200, st);
    }
    if (p === '/api/board/card') {
      // 单卡补丁：只改一张卡（避免整板覆盖导致别人刚做的选择被冲掉）
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const body = await readBody(req);
      const board = await loadJSON(BOARD_FILE, { cards: [] });
      const key = String(body.key || '');
      const id = String(body.id || '');
      const card = (board.cards || []).find((c) => (id && c.id === id) || (key && c.key === key));
      if (!card) return json(res, 404, { error: '找不到卡片：' + (key || id) });
      Object.assign(card, body.patch || {});
      board.cards = board.cards || [];
      await saveBoard(board, body._by || 'card-patch');
      return json(res, 200, { ok: true, key: card.key, src: card.src, badge: card.badge });
    }

    if (p === '/api/board/restore') {
      const bak = boardBakOf(CURRENT_BOARD.id);
      if (!fs.existsSync(bak)) return json(res, 404, { error: '当前画布没有可用于回滚的 board.bak.json' });
      const cur = await loadJSON(BOARD_FILE, null);
      if (cur) await fsp.writeFile(`${BOARD_FILE}.before-restore-${Date.now()}.json`, JSON.stringify(cur, null, 2), 'utf8');
      await fsp.copyFile(bak, BOARD_FILE);
      broadcast('board', { at: Date.now(), by: 'restore' });
      const b = await loadJSON(BOARD_FILE, { cards: [] });
      return json(res, 200, { ok: true, cards: (b.cards || []).length });
    }

    if (p === '/api/timelines') {
      if (req.method === 'GET') return json(res, 200, await loadJSON(TIMELINE_FILE, {}));
      const body = await readBody(req);
      await saveTimelines(body, body._by);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/relayout') {
      // NO_SEED_ROUTE_GUARD：本画布已属于创作者自己的项目，禁止再用内置种子图覆盖
      { const cur = await loadJSON(BOARD_FILE, null); if (cur && cur.noSeed) return json(res, 200, { ok: true, skipped: 'noSeed', cards: (cur.cards || []).length, edges: (cur.edges || []).length }); } const out = await relayout(); broadcast('board', { at: Date.now() }); return json(res, 200, { ok: true, cards: out.cards.length }); }
    if (p === '/api/relayout-all') {
      // NO_SEED_ROUTE_GUARD：本画布已属于创作者自己的项目，禁止再用内置种子图覆盖
      { const cur = await loadJSON(BOARD_FILE, null); if (cur && cur.noSeed) return json(res, 200, { ok: true, skipped: 'noSeed', cards: (cur.cards || []).length, edges: (cur.edges || []).length }); } const out = await relayoutAll(); broadcast('board', { at: Date.now() }); return json(res, 200, { ok: true, cards: out.cards.length, edges: out.edges.length }); }
    if (p === '/api/reseed') {
      // NO_SEED_ROUTE_GUARD：本画布已属于创作者自己的项目，禁止再用内置种子图覆盖
      { const cur = await loadJSON(BOARD_FILE, null); if (cur && cur.noSeed) return json(res, 200, { ok: true, skipped: 'noSeed', cards: (cur.cards || []).length, edges: (cur.edges || []).length }); } await ensureSeed({ force: true }); broadcast('board', { at: Date.now() }); broadcast('timelines', { at: Date.now() }); return json(res, 200, { ok: true }); }

    if (p === '/api/reveal' || p === '/api/open') {
      const body = await readBody(req);
      const abs = safeAbs(body.path);
      if (!fs.existsSync(abs)) return json(res, 404, { error: '文件不存在：' + body.path });
      if (p === '/api/reveal') spawn('explorer.exe', ['/select,' + abs], { detached: true, stdio: 'ignore' }).unref();
      else spawn('cmd.exe', ['/c', 'start', '', abs], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false }).unref();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/file') {
      const rel = url.searchParams.get('p') || '';
      const abs = safeAbs(rel);
      const ext = path.extname(abs).toLowerCase();
      if (req.method === 'GET') {
        if (!fs.existsSync(abs)) return json(res, 404, { error: '文件不存在' });
        // API_FILE_GUARD：媒体文件不是文本，绝不把二进制当提示词返回（会造成画布显示乱码）
        if (IMG_EXT.has(ext) || VIDEO_EXT.has(ext)) {
          res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('');
        }
        const buf = await fsp.readFile(abs);
        // 前端契约：读的是 JSON 的 content / mtime，不是裸文本
        return json(res, 200, {
          content: buf.toString('utf8'),
          mtime: fs.statSync(abs).mtime.toISOString(),
          path: rel,
          bytes: buf.length,
        });
      }
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        let content = body;
        try {
          const o = JSON.parse(body);
          if (o && typeof o.content === 'string') content = o.content;
        } catch { /* 裸文本 */ }
        await fsp.writeFile(abs, content, 'utf8');
        broadcast('fs', { paths: [rel], at: Date.now() });
        return json(res, 200, { ok: true, path: rel, bytes: Buffer.byteLength(content) });
      }
      return json(res, 405, { error: 'GET or POST' });
    }

    if (p === '/api/scan-dir') {
      const relDir = url.searchParams.get('p') || '';
      const exts = String(url.searchParams.get('ext') || 'png,jpg,jpeg,webp,gif')
        .split(',').map((x) => '.' + String(x).replace(/^\./, '').toLowerCase());
      const absDir = safeAbs(relDir);
      if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return json(res, 404, { error: '目录不存在：' + relDir });
      let ents = [];
      try { ents = await fsp.readdir(absDir, { withFileTypes: true }); } catch { ents = []; }
      const files = [];
      for (const ent of ents) {
        if (!ent.isFile()) continue;
        if (!exts.includes(path.extname(ent.name).toLowerCase())) continue;
        const full = path.join(absDir, ent.name);
        let st = null;
        try { st = await fsp.stat(full); } catch { continue; }
        const rel = String(relDir).replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
        files.push({ name: ent.name, rel: rel + '/' + ent.name, size: st.size, mtime: st.mtimeMs });
      }
      files.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { ok: true, dir: relDir, files: files.slice(0, 800) });
    }

    if (p === '/raw') {
      const rel = url.searchParams.get('p') || '';
      const abs = safeAbs(rel);
      if (!fs.existsSync(abs)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
      const ext = path.extname(abs).toLowerCase();
      const st = fs.statSync(abs);
      if (req.headers.range && VIDEO_EXT.has(ext)) {
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range) || [];
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        res.writeHead(206, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-cache',
        });
        return fs.createReadStream(abs, { start, end }).pipe(res);
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(abs).pipe(res);
    }

    if (p === '/thumb') {
      const rel = url.searchParams.get('p') || '';
      const abs = safeAbs(rel);
      if (!fs.existsSync(abs)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
      const ext = path.extname(abs).toLowerCase();
      // 先找缓存缩略图（几种可能命名都试）；找不到就直接回原图，浏览器自己缩放
      // 走真正的缩略图缓存（thumbName = sha1(rel)[0:16].jpg），避免每次回 4MB 原图把首屏拖住
      const rec = (thumbIndex && thumbIndex[rel]) || null;
      const tAbs = rec && rec.file ? path.join(THUMB_DIR, rec.file) : path.join(THUMB_DIR, thumbName(rel));
      if (fs.existsSync(tAbs)) {
        const stt = fs.statSync(tAbs);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stt.size, 'Cache-Control': 'public, max-age=300' });
        return fs.createReadStream(tAbs).pipe(res);
      }
      const buf = await fsp.readFile(abs);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
      return res.end(buf);
    }

    if (p === '/api/ai') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      return handleAI(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + p);
  } catch (e) {
    console.error('[err]', p, e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else try { res.end(); } catch { /* ignore */ }
  }
});

// ------------------------------------------------------------------ 启动
(async () => {
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await initBoards();
  const seeded = await ensureSeed();
  console.log('[seed]', JSON.stringify(seeded));
  await loadConfig();
  await probeDreamina();
  PIPELINE = createPipeline({
    ROOT, DATA_DIR,
    getConfig: () => CONFIG,
    dreamina: pipelineDreamina,
    onEvent: (payload) => broadcast('pipeline', payload),
    log: (m) => console.log(m),
  });
  console.log('[pipeline] 就绪 · 即梦 CLI ' + (dreaminaProbe.available ? '已连接（' + DREAMINA_BIN + '）' : '未检测到（' + dreaminaProbe.reason + '）'));
  await loadThumbIndex();
  // 缩略图改为「按需生成」：启动时不再全量扫描（8673 张图会吃满 CPU/磁盘）
  console.log('[thumb] 跳过全量扫描，改为按需生成（/thumb 请求时生成）');

  try {
    fs.watch(ROOT, { recursive: true }, onFsEvent);
    console.log('[watch] 实时监听已开启：', ROOT);
  } catch (e) {
    console.error('[watch] 监听失败：', e.message);
  }

  server.listen(PORT, HOST, () => {
    console.log(`[canvas] http://${HOST}:${PORT}/`);
    console.log(`[canvas] 项目根目录 ${ROOT}`);
  });
})();
