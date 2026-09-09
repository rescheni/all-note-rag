#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { URL } from 'node:url';

const CDP = process.env.CDP || 'http://127.0.0.1:9224';
const EMAIL = 'reschen@126.com';
const PASS = 'admin123';
const BASE = 'http://127.0.0.1:3000';
const API = 'http://127.0.0.1:3001';
const QUERY = process.env.ASK_Q || '什么是感情';

function httpJson(urlPath, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const abs = urlPath.startsWith('http');
    const u = new URL(urlPath, abs ? undefined : CDP);
    const data = body ? Buffer.from(body) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
    });
    req.on('upgrade', (_res, socket) => {
      socket.setNoDelay(true);
      const client = {
        socket, buf: Buffer.alloc(0), pending: new Map(), nextId: 1,
        send(method, params = {}) {
          const id = client.nextId++;
          const payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
          socket.write(encodeFrame(payload));
          return new Promise((res2, rej2) => client.pending.set(id, { res: res2, rej: rej2 }));
        },
      };
      socket.on('data', (chunk) => {
        client.buf = Buffer.concat([client.buf, chunk]);
        while (true) {
          const decoded = decodeFrame(client.buf);
          if (!decoded) break;
          client.buf = decoded.rest;
          if (decoded.opcode === 8) { socket.end(); return; }
          if (decoded.opcode !== 1) continue;
          let msg; try { msg = JSON.parse(decoded.payload.toString('utf8')); } catch { continue; }
          if (msg.id && client.pending.has(msg.id)) {
            const { res, rej } = client.pending.get(msg.id);
            client.pending.delete(msg.id);
            if (msg.error) rej(new Error(JSON.stringify(msg.error)));
            else res(msg.result || {});
          }
        }
      });
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

function encodeFrame(payload) {
  const len = payload.length;
  const maskKey = crypto.randomBytes(4);
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f; let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { opcode, payload, rest: buf.subarray(offset + maskLen + len) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(cdp, path) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('wrote', path, fs.statSync(path).size);
}

async function evalJson(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function main() {
  const login = await httpJson(API + '/v1/auth/login', 'POST', JSON.stringify({ email: EMAIL, password: PASS }));
  const token = login.token;
  if (!token) throw new Error('login failed: ' + JSON.stringify(login));

  const tab = await httpJson('/json/new?' + encodeURIComponent('about:blank'), 'PUT');
  if (!tab?.webSocketDebuggerUrl) throw new Error('no tab');
  const cdp = await connectWs(tab.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false,
  });

  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1000);
  await evalJson(cdp, `(() => {
    localStorage.setItem('hub_token', ${JSON.stringify(token)});
    localStorage.setItem('note-hub:ask-sources-open', '1'); // stale open — must be ignored
    return true;
  })()`);

  await cdp.send('Page.navigate', { url: BASE + '/ask' });
  await sleep(2200);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(2500);

  // New chat so we get a fresh ask animation
  await evalJson(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /新对话/.test(b.textContent || ''));
    btn?.click();
    return !!btn;
  })()`);
  await sleep(600);

  const submit = await evalJson(cdp, `(() => {
    const input = document.querySelector('.ask-prompt-shell input, input[name="query"]');
    if (!input) return { ok:false, reason:'no input' };
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, ${JSON.stringify(QUERY)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const form = input.closest('form');
    form?.requestSubmit();
    return { ok:true };
  })()`);
  console.log('submit', submit);

  // Poll for mid-scan: scanning class + exactly 1 card (or few)
  let mid = null;
  for (let i = 0; i < 90; i++) {
    mid = await evalJson(cdp, `(() => {
      const scanning = !!document.querySelector('.ask-cites-scanning');
      const cards = document.querySelectorAll('.ask-cites-scanning .cite-card').length;
      const chips = document.querySelectorAll('.ask-cites-scanning .cite-chip').length;
      const paper = !!document.querySelector('.ask-answer-paper');
      const labels = [...document.querySelectorAll('.ask-section-label')].map(el => el.textContent.trim());
      return { scanning, cards, chips, paper, labels, busy: !!document.querySelector('[aria-busy="true"]') };
    })()`);
    if (mid.scanning && mid.cards >= 1 && mid.cards <= 2 && !mid.paper) {
      console.log('mid-scan hit', mid, 'at', i);
      await shot(cdp, '/workspace/ask-scan-mid.png');
      break;
    }
    if (i === 89) console.log('mid-scan timeout', mid);
    await sleep(250);
  }

  // Wait for after: collapsed sources above answer
  let after = null;
  for (let i = 0; i < 120; i++) {
    after = await evalJson(cdp, `(() => {
      const scanning = !!document.querySelector('.ask-cites-scanning');
      const cites = document.querySelector('.ask-cites');
      const paper = document.querySelector('.ask-answer-paper');
      const toggle = document.querySelector('.ask-cites-toggle');
      const expanded = toggle?.getAttribute('aria-expanded');
      const cards = document.querySelectorAll('.cite-card').length;
      const chips = document.querySelectorAll('.cite-chip').length;
      const marks = document.querySelectorAll('.cite-mark').length;
      const openKey = localStorage.getItem('note-hub:ask-sources-open');
      const labels = [...document.querySelectorAll('.ask-section-label')].map(el => el.textContent.trim());
      const citesBefore = !!(cites && paper && (cites.compareDocumentPosition(paper) & Node.DOCUMENT_POSITION_FOLLOWING));
      const sectionOrder = [...document.querySelectorAll('.ask-section')].map(s => s.className);
      return {
        scanning, expanded, cards, chips, marks, openKey, labels, citesBefore, sectionOrder,
        citesTop: cites && Math.round(cites.getBoundingClientRect().top),
        paperTop: paper && Math.round(paper.getBoundingClientRect().top),
        hasPaper: !!paper,
      };
    })()`);
    if (!after.scanning && after.hasPaper && after.citesBefore) {
      console.log('after settled', after, 'at', i);
      await shot(cdp, '/workspace/ask-after-fold.png');
      break;
    }
    if (i === 119) console.log('after timeout', after);
    await sleep(400);
  }

  // Hover a citation mark
  const hover = await evalJson(cdp, `(() => {
    const mark = document.querySelector('.cite-mark');
    if (!mark) return { ok:false, reason:'no mark' };
    const r = mark.getBoundingClientRect();
    mark.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
    mark.focus?.();
    return { ok:true, n: mark.textContent, x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  console.log('hover', hover);
  if (hover?.ok) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: hover.x, y: hover.y, button: 'none',
    });
    await sleep(400);
  }
  const pop = await evalJson(cdp, `(() => {
    const pop = document.querySelector('.cite-pop');
    const hl = document.querySelector('.cite-pop .cite-hl');
    const chipActive = document.querySelector('.cite-chip-active');
    const quoteStrip = document.querySelector('.cite-chip-quote');
    const z = pop ? getComputedStyle(pop).zIndex : null;
    return {
      pop: !!pop,
      hl: !!hl,
      hlText: hl?.textContent?.slice(0, 80) || null,
      chipActive: !!chipActive,
      quoteStrip: !!quoteStrip,
      z,
      popTitle: pop?.querySelector('.cite-pop-title')?.textContent || null,
    };
  })()`);
  console.log('popover', pop);
  await shot(cdp, '/workspace/ask-cite-popover.png');

  const report = { query: QUERY, mid, after, hover, pop };
  fs.writeFileSync('/workspace/ask-ux-verify.json', JSON.stringify(report, null, 2));
  console.log('REPORT', JSON.stringify(report, null, 2));

  try { await httpJson('/json/close/' + tab.id, 'GET'); } catch {}
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
