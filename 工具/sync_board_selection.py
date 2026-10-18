"""同步画布选择 → 关键帧_替换_v7，并报告哪些镜头渲染图与选择不一致"""
import json, os, shutil, hashlib, urllib.request

ROOT = r'E:\伊雪的活\ptest\ptest'
PROJ = '人物替换_NIGHTDANCER'
V7 = os.path.join(ROOT, PROJ, '关键帧_替换_v7')
MOTION_DIR = r'E:\伊雪的活\_blender_out\job_motion'

def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

board = json.load(urllib.request.urlopen('http://127.0.0.1:17800/api/board'))
sel = {}
for c in board.get('cards', []):
    k = c.get('key') or ''
    if k.startswith('out:') and c.get('src'):
        sel[k[4:]] = c['src']

changed, same = [], []
for shot, rel in sorted(sel.items()):
    src = os.path.join(ROOT, rel)
    if not os.path.exists(src):
        print(shot, 'MISSING', rel); continue
    dst = os.path.join(V7, shot + '_v7.png')
    old = md5(dst) if os.path.exists(dst) else None
    new = md5(src)
    shutil.copyfile(src, dst)
    (changed if old != new else same).append(shot)
    print(shot, 'changed' if old != new else 'same', '←', rel.split('/')[-1])

print('\n有变化的镜头：', changed, '\n未变化：', same)
result = {'changed': changed, 'same': same, 'sel': sel}
with open(os.path.join(r'E:\伊雪的活\_blender_out', 'sync_report.json'), 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=1)
