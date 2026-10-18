"""从画布导出当前选定的 11 张成片帧 → 成片帧_画布选定/ + manifest.json

用途：合成成片前必跑一次，确保用的是画布上保存/锁定的版本，而不是任何脚本里的默认路径。
"""
import json, os, shutil, urllib.request

ROOT = r'E:\伊雪的活\ptest\ptest'
PROJ = '人物替换_NIGHTDANCER'
OUT = os.path.join(ROOT, PROJ, '成片帧_画布选定')
os.makedirs(OUT, exist_ok=True)

board = json.load(urllib.request.urlopen('http://127.0.0.1:17800/api/board'))
sel, manifest = {}, {'exported': [], 'missing': [], 'at': None}
for c in board.get('cards', []):
    key = c.get('key') or ''
    if not key.startswith('out:') or not c.get('src'):
        continue
    shot = key[4:]
    rel = c['src']
    src = os.path.join(ROOT, rel)
    if not os.path.exists(src):
        manifest['missing'].append({'shot': shot, 'src': rel}); continue
    dst = os.path.join(OUT, shot + '.png')
    shutil.copyfile(src, dst)
    sel[shot] = {'file': os.path.join(PROJ, '成片帧_画布选定', shot + '.png'),
                 'src': rel, 'badge': c.get('badge'), 'locked': bool(c.get('locked'))}
    manifest['exported'].append(shot)

import datetime
manifest['at'] = datetime.datetime.now().isoformat(timespec='seconds')
manifest['shots'] = dict(sorted(sel.items()))
with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)
print('导出', len(manifest['exported']), '张 →', OUT)
for k, v in manifest['shots'].items():
    print(' ', k, '←', v['src'].split('/')[-1], '|', v['badge'], '| locked=', v['locked'])
if manifest['missing']:
    print('缺失：', manifest['missing'])
