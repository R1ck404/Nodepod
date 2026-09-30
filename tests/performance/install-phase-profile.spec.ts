import {test,expect} from '@playwright/test';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {instrumentInstall} from './instrument-install.mjs';
const baseline=process.env.NODEPOD_FAST_BASELINE;
test.skip(!baseline,'Set NODEPOD_FAST_BASELINE to a built baseline checkout.');
for(const mode of ['live','replay'])test('profile fresh install phases: '+mode,async({browser},testInfo)=>{
 test.setTimeout(240000);const prefix='perf-bench/install-profile-'+Date.now();await mkdir('perf-bench/fast-packages',{recursive:true});
 await instrumentInstall(resolve(baseline!,'dist'),resolve(prefix+'/baseline/dist'));
 await instrumentInstall(resolve('dist'),resolve(prefix+'/candidate/dist'));const samples=[];const payloads=new Map();
 for(let round=-1;round<4;round++) for(const label of round%2===0?['baseline','candidate']:['candidate','baseline']) {
  const context=await browser.newContext();const bodyTasks=[];if(mode==='replay'&&payloads.size){await context.route('https://registry.npmjs.org/**',async route=>{const saved=payloads.get(route.request().url());if(!saved)throw new Error('Missing recorded URL '+route.request().url());await route.fulfill(saved)});}else if(mode==='replay'){context.on('response',response=>{if(response.url().startsWith('https://registry.npmjs.org/'))bodyTasks.push((async()=>{const body=await response.body();payloads.set(response.url(),{status:response.status(),headers:response.headers(),body})})());});}const requests=[];context.on('requestfinished',request=>{requests.push({url:request.url(),timing:request.timing(),type:request.resourceType()})});const page=await context.newPage();const phases=[];page.on('console',msg=>{if(msg.text().startsWith('INSTALL_PHASES '))phases.push(...JSON.parse(msg.text().slice(15)))});
  try {
   await page.goto(new URL('/tests/performance/install-phase-profile.html?dist='+ '/'+prefix+'/'+label+'/dist',testInfo.project.use.baseURL).href);
   await expect(page.locator('#status')).toHaveText(/DONE|FAIL/,{timeout:60000});
   await Promise.all(bodyTasks);const result=await page.evaluate(()=>(window as any).__bench);expect(result.ok,result.error).toBe(true);
   expect(await page.evaluate(()=>Object.getOwnPropertyDescriptor(Document.prototype,'visibilityState')!.get!.call(document))).toBe('visible');
   expect(phases.some(s=>s.name==='packages.materialize')).toBe(true);
   samples.push({round,label,...result,phases,requests});
   console.log(label,round,JSON.stringify({total:result.report.durationMs,phases:phases.filter(s=>['packages.install','packages.resolve','packages.materialize'].includes(s.name)),spawn:result.report.summary.operations}));
   await writeFile('perf-bench/fast-packages/install-phases-'+mode+'.json',JSON.stringify(samples));
  }finally{await context.close()}
 }
});
