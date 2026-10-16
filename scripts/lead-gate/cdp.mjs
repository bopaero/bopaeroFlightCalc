/* Copied from bopaero-embeds/tools/testbed/cdp.mjs (+ onNewDocument).
   Minimal headless-Chrome driver over the DevTools protocol - no npm install.
   Node 22+ (global WebSocket). Used by the lead-gate checks; one profile per run,
   so cookies persist across reloads inside a run and never leak between runs. */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1280, height = 900, mobile = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'bop-cdp-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch (e) {}
    await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) listeners.forEach((l) => l(m));
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id; pending.set(n, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const consoleErrors = [];
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });

  const api = {
    consoleErrors,
    async goto(url, settle = 2500) {
      const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
      await send('Page.navigate', { url }); await loaded; await sleep(settle);
    },
    async reload(settle = 2500) {
      const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
      await send('Page.reload', { ignoreCache: true }); await loaded; await sleep(settle);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    /* Real typing, so input events fire as they would for a person. */
    async type(selector, text) {
      await api.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.value='';})()`);
      await send('Input.insertText', { text });
      await api.eval(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input',{bubbles:true}))`);
    },
    async click(selector) {
      // Blur first: after a captureBeyondViewport shot, Chrome re-clamps the scroll
      // position on the next focus change - which would move the target between
      // mousedown and mouseup. Blurring up front settles that before measuring.
      await api.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      await sleep(150);
      await api.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
      await sleep(250);   // let any scroll settle before measuring
      const box = await api.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    },
    async screenshot(file, selector) {
      let clip;
      if (selector) {
        const r = await api.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'start'});const r=e.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};})()`);
        await sleep(300);
        clip = { ...r, scale: 1 };
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      writeFileSync(file, Buffer.from(data, 'base64'));
      // captureBeyondViewport resizes the page for the shot; put the emulated
      // viewport back or the next click misses its target.
      if (clip) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await sleep(200); }
    },
    /* Script run before any page script on every navigation (e.g. a test endpoint). */
    async onNewDocument(source) { await send('Page.addScriptToEvaluateOnNewDocument', { source }); },
    async cookies() { return (await send('Network.getAllCookies')).cookies; },
    sleep,
    async close() { try { ws.close(); } catch (e) {} proc.kill(); await sleep(300); rmSync(profile, { recursive: true, force: true }); },
  };
  return api;
}
