"""Browser interaction checks. Install: pip install playwright; playwright install chromium.
Normal: python scripts/browser-test.py
Restricted navigation environment: python scripts/browser-test.py --embedded
The embedded mode loads the actual source in an about:blank document, bridges
HTTP via urllib to the real dev API, and runs the actual analysis code in a Blob
Worker. It does NOT test top-level navigation, CSP, native cookie handling or OAuth.
"""
import argparse, json, os, re, urllib.request, urllib.error, http.cookiejar
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('--url',default='http://127.0.0.1:8787');parser.add_argument('--embedded',action='store_true');args=parser.parse_args()
REPORTS=ROOT/'reports';REPORTS.mkdir(exist_ok=True)
def flatten(name):
    code=(ROOT/'public'/name).read_text()
    code=re.sub(r'^import .*;\n','',code,flags=re.M)
    return re.sub(r'\bexport\s+(?=(?:const|function|async function)\b)','',code)
with sync_playwright() as p:
    executable=os.environ.get('CHROMIUM_EXECUTABLE')
    browser=p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1440,'height':1080},device_scale_factor=1)
    page=context.new_page();errors=[];page.on('pageerror',lambda error:(errors.append(str(error)),print('PAGE ERROR:',error)))
    if args.embedded:
        opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        def bridge(source,data):
            headers=dict(data.get('headers',{}));method=data.get('method','GET')
            if method!='GET':headers['Origin']=args.url
            request=urllib.request.Request(args.url+data['url'],method=method,headers=headers,data=data.get('body','').encode() if method!='GET' else None)
            try: response=opener.open(request,timeout=40)
            except urllib.error.HTTPError as error:response=error
            return {'text':response.read().decode(),'status':response.code,'headers':dict(response.headers)}
        page.expose_binding('__httpBridge',bridge)
        html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html)
        page.set_content(html);page.add_style_tag(content=(ROOT/'public/brand/brand.css').read_text());page.add_style_tag(content=(ROOT/'public/game.css').read_text())
        workers='\n'.join(flatten(f) for f in ['games/dots-and-boxes/rules.js','games/dots-and-boxes/analysis.js','analysis-worker.js'])
        setup='''if(!crypto.randomUUID)crypto.randomUUID=()=>[...crypto.getRandomValues(new Uint8Array(16))].map((v,i)=>([4,6,8,10].includes(i)?'-':'')+v.toString(16).padStart(2,'0')).join('');
        window.fetch=async (url,init={})=>{const r=await window.__httpBridge({url:String(url),...init});return new Response(r.text,{status:r.status,headers:r.headers});};
        const NativeWorker=window.Worker;const workerBlob=new Blob([WORKER_CODE],{type:'text/javascript'});
        window.Worker=class extends NativeWorker{constructor(){super(URL.createObjectURL(workerBlob));}};
        '''.replace('WORKER_CODE',json.dumps(workers))
        code='\n'.join(flatten(f) for f in ['games/dots-and-boxes/rules.js','games/dots-and-boxes/analysis.js','analytics.js','game.js'])
        page.add_script_tag(content=setup+code)
    else:page.goto(args.url)
    page.wait_for_selector('.edge',timeout=15000)
    assert page.locator('.edge').count()==40
    assert page.locator('#board .dot').count()==25
    page.select_option('#difficulty','easy')
    # First move creates the authoritative match; no fabricated preview events.
    page.locator('.edge.available:not([disabled])').first.click()
    page.wait_for_function("!document.querySelector('#new-game').disabled",timeout=40000)
    assert int(page.locator('#event-count').inner_text())>=5
    # Keyboard navigation uses real native buttons.
    first=page.locator('.edge.available:not([disabled])').first;first.focus();page.keyboard.press('ArrowRight')
    assert page.evaluate("document.activeElement.classList.contains('edge')")
    page.keyboard.press('Enter');page.wait_for_function("!document.querySelector('#new-game').disabled",timeout=40000)
    # Complete one board with the first legal line to exercise chains and extra turns.
    turns=2
    while 'EDGES LEFT' in page.locator('#remaining').inner_text() and not page.locator('#remaining').inner_text().startswith('0 '):
        buttons=page.locator('.edge.available:not([disabled])')
        if not buttons.count():page.wait_for_timeout(100);continue
        buttons.first.click();page.wait_for_function("!document.querySelector('#new-game').disabled",timeout=40000);turns+=1
        if turns>40:raise AssertionError('Game did not terminate')
    assert int(page.locator('#human-score').inner_text())+int(page.locator('#jev-score').inner_text())==16
    page.click('#audit');page.wait_for_function("document.querySelector('#audit-result').textContent.startsWith('Valid:')",timeout=10000)
    page.evaluate("document.querySelector('#toast').hidden=true;document.activeElement.blur();window.scrollTo(0,0)");page.screenshot(path=str(REPORTS/'desktop-preview.png'),full_page=True)
    page.click('[data-tab="candidates"]');assert page.locator('#candidate-rows tr').count()>0
    page.click('[data-tab="timeline"]');assert page.locator('.event').count()>40
    page.locator('.event summary').first.click();assert page.locator('.event[open] pre').is_visible()
    page.click('[data-tab="replay"]');page.locator('#replay-slider').fill('20');page.locator('#replay-slider').dispatch_event('input');assert page.locator('#replay-position').inner_text()=='20 / 40'
    page.click('[data-tab="leaderboard"]');page.wait_for_function("!document.querySelector('#leaderboard-status').textContent.includes('Loading')")
    assert 'No verified' in page.locator('#leaderboard-status').inner_text()
    page.click('[data-scope="channel"]');page.wait_for_function("document.querySelector('#leaderboard-status').textContent.includes('Launch')")
    page.click('[data-tab="overview"]');page.click('#rules-open');assert page.locator('#rules-dialog').is_visible();page.click('[data-close="rules-dialog"]')
    viewports=[]
    for width,height in [(390,844),(320,740)]:
        page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(100)
        overflow=page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
        assert not overflow,f'Horizontal page overflow at {width}px'
        viewports.append({'width':width,'height':height,'overflow':overflow})
        if width==390:page.screenshot(path=str(REPORTS/'mobile-preview.png'),full_page=True)
    assert not errors,errors
    report={'passed':True,'mode':'embedded-source-with-real-HTTP-bridge' if args.embedded else 'normal-navigation','checks':['40 legal initial edges','25 dots','server-created match','mouse moves','keyboard navigation','complete 40-edge game','captures total 16','hash and replay audit','candidate inspector','event inspector','replay scrubber','world leaderboard','channel authorization','rules dialog','390px layout','320px layout','no uncaught page errors'],'pageErrors':errors,'viewports':viewports,'limitations':['Embedded mode does not validate navigation, CSP enforcement, browser cookie attributes, OAuth redirects or download behavior.'] if args.embedded else []}
    (REPORTS/'browser-tests.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2));browser.close()
