from playwright.sync_api import sync_playwright,expect
from pathlib import Path
import json,io,zipfile,os,sys
# Run after npm run build; optional argument is AppLauncher/workspace.css.
r=Path(__file__).resolve().parents[1]/'dist/standalone'
hostcss=Path(sys.argv[1]).read_text() if len(sys.argv)>1 else '.app-frame{max-width:650px;margin:auto;padding:0 22px 115px;position:relative}'
repos=[dict(name='Repository-'+str(i)+'-long-example',version='1.0.0',tag='v1.0.0.r1',head='a'*40,url='https://github.com/owner/repo') for i in range(20)]
updates=[dict(repository=x['name'],fromVersion='1.0.0',toVersion='1.0.1',baseCommit=x['head'],kind='patch',patch=f'p{i}.patch') for i,x in enumerate(repos)]
def archive(n):
 b=io.BytesIO()
 with zipfile.ZipFile(b,'w') as z:
  z.writestr('manifest.json',json.dumps(dict(schema=1,title='Workspace update '+str(n),updates=updates[:n])))
  for u in updates[:n]:z.writestr(u['patch'],'example')
 return {'name':'example.zip','mimeType':'application/zip','buffer':b.getvalue()}
job=dict(id='1'*36,mode='export',status='completed',createdAt='2026-11-25T08:00:00Z',plan={'title':'Repository export','updates':[]},exportSpec={'repositories':[x['name'] for x in repos[:10]],'format':'lightweight'},records=[],attempt={'runId':'123'},index=0)
telemetry=dict(enabled=True,pending=4,droppedEvents=0,failures=0,archiveBytes=54200,producer=dict(pending=2,sent=12,dropped=0,failures=0),workflowCollector=dict(enabled=True,scans=2,details=3,pendingDetails=1,enqueued=17,lastStage='scan-complete',lastRows=4,lastNewRuns=2))
count=0
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,hosted in [(320,False),(390,False),(430,True)]:
  page=browser.new_page(viewport={'width':width,'height':844},is_mobile=True,has_touch=True)
  state={'unlocked':False,'posts':0};errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  html='<meta name="viewport" content="width=device-width, initial-scale=1"><style>'+((hostcss if hosted else '')+(r/'styles.css').read_text())+'</style><div id="app" class="'+('app-frame' if hosted else '')+'"></div>'
  page.set_content(html)
  page.evaluate("""([repos,job,telemetry])=>{window.testState={unlocked:false,posts:0};window.fetch=async(url,opts={})=>{const name=String(url).split('?')[0].replace('/_git/v1','');let data={};if(name==='/admin/status')data={unlocked:testState.unlocked,expiresAt:'2099-01-01T00:00:00Z'};else if(name==='/admin/unlock'){testState.unlocked=true;data={unlocked:true}}else if(name==='/repos')data={repos,next:null};else if(name==='/jobs'&&opts.method==='POST'){testState.posts++;testState.body=JSON.stringify(Object.fromEntries(opts.body));data={id:'new'}}else if(name==='/jobs')data=[job];else if(name==='/telemetry/status')data=telemetry;else if(name==='/telemetry/probe')data={schema:1,repository:'PWA-GitRunner',startedAt:'2026-11-25T10:00:00Z',accepted:4,duplicates:1,rejected:0,rows:2,requests:4,stages:[{stage:'workflow-list',outcome:'success',count:2},{stage:'archive-workflows',outcome:'acknowledged'}]};return Response.json(data);}}""",[repos,job,telemetry])
  sources={name:(r/name).read_text() for name in ['app.js','version.js','zip.js','share-files.js','plan-validation.js']}
  page.evaluate("""async sources=>{for(const name of ['version.js','zip.js','share-files.js','plan-validation.js']){const uri=URL.createObjectURL(new Blob([sources[name]],{type:'text/javascript'}));sources['app.js']=sources['app.js'].replace('./'+name,uri);}sources['app.js']=sources['app.js'].replace("new URL('./icon-192.png',import.meta.url).href","'data:image/png;base64,'");await import(URL.createObjectURL(new Blob([sources['app.js']],{type:'text/javascript'})));}""",sources)
  page.locator('.gm-repo').first.wait_for()
  page.get_by_role('button',name='Export workspace',exact=False).click();page.locator('#gm-unlock').wait_for();expect(page.get_by_text('Unlock for 4 hours')).to_be_visible();
  page.locator('#gm-unlock').fill('test-password');page.get_by_text('Unlock for 4 hours').click();page.locator('.gm-admin.unlocked').wait_for();expect(page.get_by_text('GitHub Actions collector',exact=True)).to_be_visible();
  page.get_by_role('button',name='Test GitHub collection now').click();expect(page.get_by_text('Last direct collection test',exact=True)).to_be_visible();expect(page.get_by_text('PWA-GitRunner',exact=True)).to_be_visible();expect(page.get_by_role('button',name='Share telemetry status')).to_be_visible();assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1');
  page.get_by_role('button',name='Updates',exact=True).click();page.locator('#gm-upload').wait_for();assert page.locator('#gm-target').count()==0
  # Test 1, 6 and maximum 16, then explicit 20 rejection.
  for n in [1,6,16,20]:
   page.locator('#gm-upload').set_input_files(archive(n));page.get_by_text('example.zip',exact=True).wait_for();
   if n==20:expect(page.locator('#gm-plan-error')).to_contain_text('1–16');expect(page.get_by_role('button',name='Review update')).to_be_disabled();continue
   assert page.locator('#gm-target').count()==0;assert page.locator('#gm-advanced').evaluate('el=>!el.open');expect(page.locator('#gm-summary li')).to_have_count(n)
   page.get_by_role('button',name='Review update').click();d=page.locator('#gm-review');d.wait_for();expect(d.locator('li')).to_have_count(n);footer=d.locator('.gm-review-footer').bounding_box();assert footer['y']+footer['height']<=844 and footer['y']>=0
   page.get_by_role('button',name='Back',exact=True).click();assert page.evaluate('testState.posts')==0;assert page.locator('#gm-review').count()==0
  page.locator('#gm-upload').set_input_files(archive(6));page.locator('#gm-advanced summary').click();editor=page.locator('#gm-plan');editor.fill('{broken');expect(page.get_by_role('button',name='Review update')).to_be_disabled();edited=dict(schema=1,title='Edited plan',updates=updates[:6]);edited['updates'][0]=dict(edited['updates'][0],toVersion='1.1.0');editor.fill(json.dumps(edited));expect(page.locator('#gm-summary')).to_contain_text('1.1.0');page.locator('#gm-mode').select_option('dry');page.get_by_role('button',name='Review update').click();expect(page.locator('#gm-review')).to_contain_text('Dry run');page.get_by_role('button',name='Create draft').click();page.locator('[data-job-id]').wait_for();assert page.evaluate('testState.posts')==1;assert '1.1.0' in page.evaluate('testState.body') and 'Edited plan' in page.evaluate('testState.body') and 'dry' in page.evaluate('testState.body');assert page.locator('a.gm-external').count()>0
  # Equal columns, no horizontal overflow, and expanded export names.
  page.locator('.gm-job-details summary').first.click();expect(page.locator('.gm-job-details li')).to_have_count(10);assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1');
  # Actual delayed fetch with visible foreground busy state (browser-side test delay).
  page.evaluate('''()=>{const original=window.fetch;window.fetch=async(...args)=>{await new Promise(r=>setTimeout(r,600));return original(...args)}}''');page.get_by_role('button',name='Repos',exact=True).click();expect(page.locator('.gm-busy-layer')).to_be_visible();expect(page.locator('.gm-busy-layer')).to_have_count(0,timeout=7000);assert not errors,errors
  # standalone target and auto plan generation
  page.get_by_role('button',name='Updates',exact=True).click();page.locator('#gm-upload').set_input_files({'name':'manual.patch','mimeType':'text/plain','buffer':b'patch'});page.locator('#gm-target').wait_for();page.locator('#gm-target').select_option(repos[0]['name']);expect(page.locator('#gm-summary')).to_contain_text('1.0.1');assert not errors,errors
  page.close();count+=1
 browser.close()
print('Passed',count,'mobile viewport end-to-end scenarios (mock services; 1,6,16,20 update plans, locking, busy, share actions, edit/review/cancel, standalone file)')
