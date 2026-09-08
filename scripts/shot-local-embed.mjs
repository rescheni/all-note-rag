#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { URL } from 'node:url';

const CDP = process.env.CDP || 'http://127.0.0.1:9224';
const EMAIL = 'reschen@126.com';
const PASS = 'admin123';
const BASE = 'http://127.0.0.1:3000';

function httpJson(urlPath, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, urlPath.startsWith('http') ? undefined : CDP);
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
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('wrote', path, fs.statSync(path).size);
}


async function main() {
  const login = await httpJson('http://127.0.0.1:3001/v1/auth/login', 'POST', JSON.stringify({ email: EMAIL, password: PASS }));
  const token = login.token;
  if (!token) throw new Error('login failed: ' + JSON.stringify(login));

  const tab = await httpJson('/json/new?' + encodeURIComponent('about:blank'), 'PUT');
  if (!tab?.webSocketDebuggerUrl) throw new Error('no tab');
  const cdp = await connectWs(tab.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false,
  });

  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1000);
  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.setItem('hub_token', ${JSON.stringify(token)}); true`,
  });

  await cdp.send('Page.navigate', { url: BASE + '/settings' });
  await sleep(2200);

  // Switch to 本地模型 tab
  const switched = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('.embed-provider-tabs button, .segmented button')];
      const local = btns.find((b) => /本地/.test(b.textContent || ''));
      if (!local) return { ok:false, texts: btns.map(b=>b.textContent) };
      local.click();
      return { ok:true, cards: document.querySelectorAll('.local-embed-card').length };
    })()`,
    returnByValue: true,
  });
  console.log('switch', switched.result?.value);
  await sleep(1200);

  // Scroll local panel into view
  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.embed-local-panel, .local-embed-list')?.scrollIntoView({block:'center'}); true`,
  });
  await sleep(400);

  await shot(cdp, '/workspace/note-hub/docs/settings-local-embed.png');

  // Also a cropped-feel full page of settings
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(300);
  await shot(cdp, '/workspace/note-hub/docs/settings-local-embed-tall.png');

  try { await httpJson('/json/close/' + tab.id, 'GET'); } catch {}
  console.log('done');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
