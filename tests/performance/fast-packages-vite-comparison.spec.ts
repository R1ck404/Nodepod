import {expect,test} from '@playwright/test';
import {cp,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const baseline=process.env.NODEPOD_FAST_BASELINE;
test.skip(!baseline,'Set NODEPOD_FAST_BASELINE to a built previous Nodepod checkout to run this benchmark.');

test('compare previous Nodepod and all-seven update on the same Vite React app',async({browser},testInfo)=>{
  test.setTimeout(15*60*1000);
  const samples:unknown[]=[];
  await mkdir('perf-bench/fast-packages',{recursive:true});
  await cp(resolve(baseline!,'dist'),resolve('perf-bench/fast-baseline/dist'),{recursive:true});
  // Warm both package/CDN paths first, then alternate measured pair order.
  for(let round=-1;round<3;round++)for(const label of round%2===0?['baseline','candidate']:['candidate','baseline']){
    const context=await browser.newContext({serviceWorkers:'allow'});
    const page=await context.newPage();
    try{
      const dist=label==='baseline'?'/perf-bench/fast-baseline/dist':'/dist';
      const url=new URL('/tests/performance/fast-packages-vite.html',testInfo.project.use.baseURL);
      url.searchParams.set('dist',dist);
      await page.goto(url.href);
      await expect(page.locator('#status')).toHaveText(/^(DONE|FAIL)/,{timeout:180000});
      const result=await page.evaluate(()=>(window as any).__bench);
      expect(result?.ok,result?.error).toBe(true);
      expect(result.components).toBe(100);
      expect(result.buildFiles).toContain('index.html');
      const native=await page.evaluate(()=>Object.getOwnPropertyDescriptor(Document.prototype,'visibilityState')!.get!.call(document));
      expect(native).toBe('visible');
      samples.push({round,label,...result});
      console.log('VITE COMPARISON',JSON.stringify(samples.at(-1)));
      await writeFile('perf-bench/fast-packages/vite-results.json',JSON.stringify(samples,null,2));
    }finally{await context.close()}
  }
  await testInfo.attach('fast-packages-vite-results.json',{body:JSON.stringify(samples,null,2),contentType:'application/json'});
});
