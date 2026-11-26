"""R8 UI smoke test with mocked services and native share (Chromium)."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import datetime, os
r=Path(__file__).resolve().parents[1]/'dist/standalone'
now=datetime.datetime.now(datetime.timezone.utc)
job=dict(id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',mode='export',status='completed',createdAt=(now-datetime.timedelta(minutes=5)).isoformat(),updatedAt=(now-datetime.timedelta(minutes=3)).isoformat(),plan={'title':'Test export','updates':[]},exportSpec={'repositories':['PWA-GitManager'],'format':'lightweight'},records=[],index=0)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox','--disable-dev-shm-usage'])
 for width in (320,390,430):
  page=browser.new_page(viewport={'width':width,'height':844},is_mobile=True,has_touch=True)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content('<meta name="viewport" content="width=device-width,initial-scale=1"><style>'+(r/'styles.css').read_text()+'</style><div id="app"></div>')
  fixtures={'/admin/status':{'unlocked':True,'workerVersion':'0.1.19'},'/jobs':[job],'/jobs/'+job['id']:job,'/repos':{'repos':[],'next':None},'/telemetry/status':{'enabled':False,'pending':0,'workflowCollector':{'paused':True,'pendingDetails':57,'pausedAt':now.timestamp()*1000,'expiresAt':(now+datetime.timedelta(days=2)).timestamp()*1000}},'/telemetry/prepare-upload':{'outcome':'disabled'},'/telemetry/query':{'events':[],'chunks':[],'issues':[],'listedComplete':True,'next':None}}
  page.evaluate("""fixtures=>{window.calls=[];window.fetch=async url=>{let path=String(url).split('?')[0].replace('/_git/v1','');calls.push(path);return Response.json(fixtures[path]||{});};Object.defineProperty(navigator,'canShare',{value:()=>true});Object.defineProperty(navigator,'share',{value:async data=>{window.shared=JSON.parse(await data.files[0].text());}});}""",fixtures)
  sources={file.name:file.read_text() for file in r.glob('*.js')}
  page.evaluate("""async sources=>{for(const name of ['version.js','zip.js','share-files.js','plan-validation.js','telemetry-export.js','job-recovery.js','workspace-export.js']){const uri=URL.createObjectURL(new Blob([sources[name]],{type:'text/javascript'}));sources['app.js']=sources['app.js'].replace('./'+name,uri);}sources['app.js']=sources['app.js'].replace("new URL('./icon-192.png',import.meta.url).href","'data:image/png;base64,'");await import(URL.createObjectURL(new Blob([sources['app.js']],{type:'text/javascript'})));}""",sources)
  expect(page.get_by_role('button',name='Check for app updates')).to_be_visible();page.get_by_role('button',name='Telemetry',exact=True).click()
  expect(page.get_by_text('Developer archive disabled',exact=True)).to_be_visible();expect(page.get_by_text('57',exact=True)).to_be_visible();expect(page.get_by_role('button',name='Upload pending now')).to_have_count(0)
  page.get_by_role('button',name='Share telemetry status').click();dialog=page.get_by_role('button',name='Share file',exact=True)
  if dialog.is_visible():dialog.click()
  page.wait_for_function('window.shared?.status?.workflowCollector?.pendingDetails===57');assert page.evaluate('shared.workerVersion')=='0.1.19'
  page.get_by_role('button',name='Activity',exact=True).last.click();page.get_by_role('button',name='Upload & prepare telemetry').click();expect(page.get_by_text('Telemetry file ready',exact=True)).to_be_visible();expect(page.get_by_text('Collection disabled; reading existing archive only.',exact=True)).to_be_visible();expect(page.get_by_text('No matching records have been archived yet.',exact=True)).to_be_visible();assert page.evaluate("calls.indexOf('/telemetry/prepare-upload')<calls.indexOf('/telemetry/query')");assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1');assert not errors,errors
  page.close()
 browser.close()
print('R8 UI smoke passed at 320, 390, 430 px')
