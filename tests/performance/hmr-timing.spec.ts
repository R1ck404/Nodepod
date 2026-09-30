import { expect, test } from '@playwright/test';

test('native visible preview delivers HMR without timer or package patches', async ({ page }, testInfo) => {
  await page.goto('/tests/performance/hmr-timing.html');
  await expect(page.locator('#status')).toHaveText(/^(READY|FAIL)/,{timeout:120_000});
  await expect(page.locator('#status')).toHaveText('READY');
  try {
    const counter=page.frameLocator('#preview').locator('#counter');
    await counter.click();await counter.click();await counter.click();
    await expect(counter).toHaveText('3');
    const result=await page.evaluate(()=>(window as any).runHmrTiming());
    await testInfo.attach('hmr-native-timing.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
    expect(result.nativeHostVisibility).toBe('visible');
    expect(result.nativePreviewVisibility).toBe('visible');
    expect(result.timerMs).toBeLessThan(250);
    expect(result.updates).toHaveLength(5);
    expect(Math.max(...result.updates.map((update:any)=>update.ms))).toBeLessThan(750);
    expect(result.updates.every((update:any)=>update.count===3)).toBe(true);
    await expect(counter).toHaveText('3');
    console.log('Native HMR timing:',JSON.stringify(result));
  }finally{await page.evaluate(()=>(window as any).stopHmrTiming())}
});
