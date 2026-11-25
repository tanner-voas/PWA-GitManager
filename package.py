#!/usr/bin/env python3
from pathlib import Path
import shutil,json
r=Path(__file__).resolve().parent
for target in [r/'dist/gitmanager',r/'dist/standalone']:
    if target.exists():shutil.rmtree(target)
    target.mkdir(parents=True)
    for name in ['app.js','styles.css','zip.js','workspace-export.js','share-files.js','viewport-lock.js','icon.svg','icon-192.png','icon-512.png']:shutil.copy2(r/'src'/name,target/name)
    shutil.copy2(r/'worker/protocol.js',target/'plan-validation.js')
    (target/'version.js').write_text('export const VERSION='+json.dumps(json.loads((r/'package.json').read_text())['version'])+';\n')
    if target.name=='standalone':
        for name in ['index.html','manifest.webmanifest','_headers']:shutil.copy2(r/'src'/name,target/name)
print('Built hosted and standalone Git Manager')
