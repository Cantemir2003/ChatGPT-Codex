import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';

// Build first: this exercises the actual production bundle and backend routes.
const temp = await mkdtemp(join(tmpdir(), 'lecture-ui-'));
const screenshots = resolve('work/screenshots');
await mkdir(screenshots, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'tests/ui-server.ts'], {
  cwd: process.cwd(), env: { ...process.env, LECTURE_UI_TEST_DIR: temp }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.on('data', data => { stderr += data.toString(); });
let browser;
const problems = [];
try {
  const info = await new Promise((resolveInfo, reject) => {
    const lines = createInterface({ input: server.stdout });
    const timer = setTimeout(() => reject(new Error(`UI test server did not start. ${stderr}`)), 20_000);
    lines.once('line', line => { clearTimeout(timer); try { resolveInfo(JSON.parse(line)); } catch (error) { reject(error); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`UI test server exited (${code}): ${stderr}`)); });
  });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: process.env.CI ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  async function capture(name) {
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
    await page.waitForTimeout(250); // Allow theme transitions and scroll position to settle.
    await page.screenshot({ path: join(screenshots, name), fullPage: true, animations: 'disabled' });
  }
  async function assertReadableContrast() {
    const results = await page.evaluate(() => {
      const components = color => color.match(/[\d.]+/g).map(Number);
      const luminance = color => components(color).slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      return ['.brand', '.setup-heading strong', '.upload-content p', '.new-lecture', '.key-status', '.upload-footer'].map(selector => {
        const element = document.querySelector(selector);
        let ancestor = element, background = 'rgb(255, 255, 255)';
        while (ancestor) {
          const candidate = getComputedStyle(ancestor).backgroundColor;
          if (components(candidate).length < 4 || components(candidate)[3] > 0) { background = candidate; break; }
          ancestor = ancestor.parentElement;
        }
        const foreground = getComputedStyle(element).color;
        const a = luminance(foreground), b = luminance(background);
        return { selector, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), foreground, background };
      });
    });
    for (const result of results) assert(result.contrast >= 4.5, `${result.selector} must meet AA contrast: ${JSON.stringify(result)}`);
  }
  await page.goto(info.url);
  await page.getByRole('dialog', { name: 'Welcome to Lecture Transcriber' }).waitFor();
  await capture('first-run-light.png');
  await page.getByRole('button', { name: 'Explore the workspace first' }).click();
  await page.getByRole('heading', { name: 'Focus on the lecture. We’ll keep the words.' }).waitFor();
  assert.equal(await page.locator('html').evaluate(node => node.scrollWidth <= window.innerWidth), true, 'The 1280px layout must not scroll horizontally.');
  await capture('empty-light.png');
  await assertReadableContrast();

  // System color scheme and explicit override both work without localStorage.
  await page.emulateMedia({ colorScheme: 'dark' });
  await capture('empty-dark.png');
  await assertReadableContrast();
  const darkBackground = await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('button', { name: 'Settings saved', exact: true }).waitFor();
  assert.notEqual(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), darkBackground);
  await page.getByLabel('Section length (minutes)', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'App settings' }).getByRole('alert').waitFor();
  assert.match(await page.getByRole('dialog', { name: 'App settings' }).getByRole('alert').innerText(), /1 to 10 minutes/);
  await page.getByLabel('Section length (minutes)', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('button', { name: 'Settings saved', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog' }).click();

  // A fabricated test credential is sent only to the mocked keychain route.
  const fakeKey = 'sk-test_abcdefghijklmnopqrstuvwxyz0123456789';
  await page.getByRole('button', { name: 'Connect API key' }).click();
  await page.getByLabel('OpenAI API key', { exact: true }).fill(fakeKey);
  await page.getByRole('button', { name: 'Save key securely' }).click();
  await page.getByRole('button', { name: 'API key connected' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert.equal((await page.content()).includes(fakeKey), false);

  // Saved preset preserves diacritics and permits an empty vocabulary list.
  await page.getByRole('button', { name: /Transcription settings/ }).click();
  await page.getByLabel('Recording context', { exact: true }).fill('Curs despre sănătatea orală.');
  await page.getByLabel('Vocabulary', { exact: false }).fill('țesut dentar\nîngrijire\n');
  await page.getByLabel('Preset name').fill('Dentistry test');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await page.getByRole('button', { name: 'Settings saved', exact: true }).waitFor();
  await page.getByRole('button', { name: /Transcription settings/ }).click();

  await page.getByLabel('Choose lecture recordings').setInputFiles(info.recording);
  await page.getByText('Ready to transcribe', { exact: true }).last().waitFor();
  let bootstrap = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  assert.equal(bootstrap.jobs.length, 1);
  assert.equal(bootstrap.jobs[0].status, 'ready', 'Import must never automatically transcribe.');
  assert(bootstrap.jobs[0].audio.duration >= 2.9 && bootstrap.jobs[0].audio.duration <= 3.2, 'Duration must come from FFprobe.');
  assert(bootstrap.jobs[0].audio.size > 0);
  assert.equal(bootstrap.jobs[0].estimatedUsd, bootstrap.jobs[0].audio.duration / 60 * bootstrap.pricing.usdPerMinute);
  assert.equal(bootstrap.jobs[0].sourceFile, '');
  await capture('recording-ready-light.png');
  const id = bootstrap.jobs[0].id;
  const preview = await context.request.get(`${info.url}/api/jobs/${id}/audio`, { headers: { range: 'bytes=0-31' } });
  assert.equal(preview.status(), 206);
  assert.equal((await preview.body()).length, 32);

  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await page.getByLabel('Complete transcript', { exact: true }).waitFor({ timeout: 25_000 });
  assert.equal(await page.getByLabel('Complete transcript', { exact: true }).innerText(), info.expectedText);
  assert.equal(await page.locator('.transcript-badge').innerText(), 'Complete');
  await page.getByLabel('Search transcript').fill('îngrijire');
  assert.equal(await page.locator('.transcript-text mark').count(), 3);
  await page.getByRole('button', { name: 'Next search match' }).click();
  assert.equal(await page.locator('.search-count').innerText(), '2 of 3');
  await page.getByLabel('Search transcript').fill('');
  await capture('mocked-transcript-light.png');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export TXT', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'mock-romanian-lecture.txt');
  assert.equal(await readFile(await download.path(), 'utf8'), info.expectedText);
  const original = await readFile(info.recording);
  assert(original.length > 0, 'The original recording must survive audio cleanup.');

  await page.reload();
  await page.getByLabel('Complete transcript', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Complete transcript', { exact: true }).innerText(), info.expectedText);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByRole('button', { name: /Transcription settings/ }).click();
  await page.getByLabel('Saved presets', { exact: true }).selectOption('Dentistry test');
  assert.equal(await page.getByLabel('Recording context', { exact: true }).inputValue(), 'Curs despre sănătatea orală.');
  assert.equal(await page.getByLabel('Vocabulary', { exact: false }).inputValue(), 'țesut dentar\nîngrijire');
  await page.getByRole('button', { name: /Transcription settings/ }).click();

  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByText('No API key connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  bootstrap = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  assert.equal(bootstrap.keyConfigured, false);
  assert.equal(bootstrap.jobs[0].status, 'complete');
  assert.equal(bootstrap.jobs[0].audioAvailable, false);
  assert.equal(bootstrap.usage.requests, 1);
  assert.equal(JSON.stringify(bootstrap).includes(fakeKey), false);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.deepEqual(problems, [], 'No browser runtime or console errors expected.');

  // Review workflow: three real audio sections, deliberately mocked sparse/empty responses.
  // This must preserve all ranges, including the five-second tail, without extra API calls.
  await page.evaluate(async fakeKey=>{
    const boot=await(await fetch('/api/bootstrap')).json();
    const headers={'content-type':'application/json','x-csrf-token':boot.csrfToken};
    const saved=await fetch('/api/key',{method:'POST',headers,body:JSON.stringify({key:fakeKey})});
    if(!saved.ok)throw new Error('Could not restore fixture key');
    boot.preferences.app.chunkMinutes=1;
    const settings=await fetch('/api/preferences',{method:'PUT',headers,body:JSON.stringify(boot.preferences)});
    if(!settings.ok)throw new Error('Could not set fixture chunk duration');
  },fakeKey);
  await page.reload();
  await page.getByLabel('Choose lecture recordings').setInputFiles(info.reviewRecording);
  await page.getByText('Ready to transcribe',{exact:true}).last().waitFor();
  await page.getByRole('button',{name:'Transcribe',exact:true}).click();
  await page.waitForFunction(async()=>{
    const jobs=await(await fetch('/api/jobs')).json();
    return jobs.some(job=>job.filename==='review-fixture.wav'&&job.status==='complete');
  },undefined,{timeout:30000});
  await page.getByLabel('Transcript requiring review',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.review-marker').length===3);
  assert.equal(await page.locator('.transcript-badge').innerText(),'Review needed');
  assert.match(await page.locator('.lecture-needs-review .lecture-meta').innerText(),/review needed/);
  bootstrap=await page.evaluate(async()=>(await fetch('/api/bootstrap')).json());
  const reviewed=bootstrap.jobs.find(job=>job.filename==='review-fixture.wav');
  assert.deepEqual(reviewed.chunks.map(chunk=>chunk.status),['complete','no_text','no_text']);
  assert.deepEqual(reviewed.chunks.map(chunk=>[chunk.start,chunk.end]),[[0,60],[60,120],[120,125]]);
  assert.equal(reviewed.review.missingTextCount,2);assert.equal(reviewed.review.shortTextCount,1);
  assert.equal(reviewed.audioAvailable,true,'Flagged audio must survive keepAudio=false cleanup.');
  assert.equal(bootstrap.usage.requests,4,'One original request plus three reviewed sections; no quality retries.');
  const reviewText=await page.getByLabel('Transcript requiring review',{exact:true}).innerText();
  assert.match(reviewText,/Transcriere posibil incompletă/);assert.equal((reviewText.match(/FĂRĂ TRANSCRIERE/g)||[]).length,2);
  assert(reviewText.includes('00:02:00–00:02:05'));assert(reviewText.includes('review-fixture.wav'));
  await capture('review-light.png');

  // Keyboard activation seeks the source recording and pauses at the selected interval's end.
  const middle=page.getByRole('button',{name:'Play review interval 00:01:00–00:02:00 for review-fixture.wav',exact:true});
  await middle.focus();await page.keyboard.press('Enter');
  await page.getByLabel('Selected review interval').waitFor();
  await page.waitForFunction(()=>{const audio=document.querySelector('audio');return audio&&audio.currentTime>=60&&audio.currentTime<64;});
  assert.equal(await page.locator('audio').evaluate(audio=>audio.paused),false);
  await page.locator('audio').evaluate(audio=>{audio.currentTime=120.1;audio.dispatchEvent(new Event('timeupdate'));});
  await page.waitForFunction(()=>document.querySelector('audio')?.paused===true);
  assert.equal(await page.locator('audio').evaluate(audio=>audio.currentTime),120);
  const exported=await context.request.get(`${info.url}/api/jobs/${reviewed.id}/export`);
  assert.equal(await exported.text(),reviewed.text);
  await page.getByRole('button',{name:'Copy all',exact:true}).click();
  await page.getByRole('button',{name:'Copied',exact:true}).waitFor();
  await page.reload();
  await page.getByLabel('Transcript requiring review',{exact:true}).waitFor();
  assert.equal(await page.locator('.review-marker').count(),3);
  assert.match(await page.locator('.lecture-needs-review .lecture-meta').innerText(),/review needed/);
  const afterReview=await page.evaluate(async id=>{
    const boot=await(await fetch('/api/bootstrap')).json();
    const job=boot.jobs.find(item=>item.id===id);
    const response=await fetch(`/api/jobs/${id}/start`,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':boot.csrfToken},body:JSON.stringify({settings:job.settings,appSettings:job.appSettings})});
    if(!response.ok)throw new Error('Restart guard failed');
    return (await fetch('/api/bootstrap')).json();
  },reviewed.id);
  assert.equal(afterReview.usage.requests,4,'Opening review markers/reloading/starting a finished review must not retranscribe.');
  await page.getByRole('button',{name:'App settings',exact:true}).click();
  await page.getByRole('button',{name:'Dark',exact:true}).click();
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.getByRole('button',{name:'Settings saved',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close dialog'}).click();
  await capture('review-dark.png');
  assert.deepEqual(problems,[],'Review workflow must not produce browser runtime/console errors.');

  // A narrow-screen sanity check supplements the requested MacBook viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('html').evaluate(node => node.scrollWidth <= window.innerWidth), true);
  await capture('mocked-transcript-mobile.png');
  console.log('UI checks passed: actual import/inspection, explicit start, mocked transcription, UTF-8 export, refresh, search, presets, theme, key save/removal, cleanup, empty/sparse/final-tail review markers, retained audio, keyboard interval playback/end stop, no added requests, and responsive layout.');
  console.log('Screenshots saved in work/screenshots. Transcription screenshots use synthetic audio and explicitly mocked API output.');
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(temp, { recursive: true, force: true });
}
