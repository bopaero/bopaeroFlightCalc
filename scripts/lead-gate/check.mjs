/* End-to-end check of TripCalc's launch lead gate in real headless Chrome.
     bash scripts/lead-gate/check.sh
   Asserts: the gate covers the app at launch; required fields enforced; a failed
   send keeps it shut; a good send lifts it and sets the shared cookie; a reload
   (and a visitor who already has the cookie from bopaero.com) skips it; the
   restore-trip prompt waits for the gate. Screenshots land in $OUT - LOOK at them. */
import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const OUT = process.env.OUT || '/tmp';
let pass = 0, fail = 0;
const is = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : `\n         got ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
};
const MOCK = `window.__bopLeadEndpoint = '/mock/lead';`;

for (const view of [{ name: 'desktop', width: 1280, height: 860 }, { name: 'phone', width: 390, height: 844, mobile: true }]) {
  console.log(`\n${view.name}`);
  const b = await launch(view);
  await b.onNewDocument(MOCK);
  await b.goto(BASE + '/index.html', 3500);
  is('gate shown at launch', await b.eval(`!document.getElementById('leadGate').hidden`), true);
  is('gate covers the app', await b.eval(`(()=>{const e=document.elementFromPoint(innerWidth/2,10);return !!e.closest('#leadGate')})()`), true);
  is('no restore prompt behind the gate', await b.eval(`[...document.querySelectorAll('.confirm-overlay')].some(o=>getComputedStyle(o).display!=='none')`), false);
  await b.screenshot(`${OUT}/tripcalc-${view.name}-1-gate.png`);

  await b.click('#leadSubmit'); await b.sleep(200);
  is('name required', await b.eval(`document.getElementById('leadError').textContent`), 'Please enter your name.');
  await b.type('#leadName', 'fail');
  await b.type('#leadEmail', 'pilot@example.com');
  await b.click('#leadSubmit'); await b.sleep(800);
  is('failure: gate stays', await b.eval(`!document.getElementById('leadGate').hidden`), true);
  is('failure: message', await b.eval(`/couldn.t send/.test(document.getElementById('leadError').textContent)`), true);
  await b.screenshot(`${OUT}/tripcalc-${view.name}-2-error.png`);

  await b.type('#leadName', 'Pat Pilot');
  await b.eval(`document.getElementById('leadProgram').value='sr22t'`);
  await b.click('#leadSubmit'); await b.sleep(1200);
  is('gate lifted', await b.eval(`document.getElementById('leadGate').hidden`), true);
  const sent = await (await fetch(BASE + '/mock/leads')).json();
  const last = sent[sent.length - 1];
  is('payload', [last.name, last.email, last.program, last.tool, last.website], ['Pat Pilot', 'pilot@example.com', 'sr22t', 'tripcalc', '']);
  const ck = (await b.cookies()).find((c) => c.name === 'bopaero_lead');
  is('cookie set (value 1, Lax, ~1 year)', ck && [ck.value, ck.sameSite, Math.round((ck.expires * 1000 - Date.now()) / 864e5)], ['1', 'Lax', 365]);
  await b.screenshot(`${OUT}/tripcalc-${view.name}-3-app.png`);

  await b.reload(3500);
  is('reload: no gate', await b.eval(`document.getElementById('leadGate').hidden`), true);
  is('version bumped', await b.eval(`APP_VERSION`), 'v2026-10-16.1');
  is('no console errors', b.consoleErrors.filter((e) => !/ERR_|Failed to load resource|net::/.test(e)), []);
  await b.close();
}

// A visitor who already sent the form on bopaero.com arrives with the cookie.
console.log('\nreturning visitor');
{
  const b = await launch({ width: 1280, height: 860 });
  await b.onNewDocument(MOCK + `document.cookie='bopaero_lead=1; Path=/';`);
  await b.goto(BASE + '/index.html', 3500);
  is('cookie present: gate never shown', await b.eval(`document.getElementById('leadGate').hidden`), true);
  await b.close();
}
console.log(`\n${pass} passed, ${fail} failed   screenshots: ${OUT}/tripcalc-*.png`);
process.exit(fail ? 1 : 0);
