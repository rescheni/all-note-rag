#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { URL } from "node:url";

const CDP = process.env.CDP || "http://127.0.0.1:9224";
const EMAIL = "reschen@126.com";
const PASS = "admin123";
const BASE = "http://127.0.0.1:3000";
const API = "http://127.0.0.1:3001";
const QUERY = process.env.ASK_Q || "什么是感情";

function httpJson(urlPath, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const abs = urlPath.startsWith("http");
    const u = new URL(urlPath, abs ? undefined : CDP);
    const data = body ? Buffer.from(body) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key },
    });
    req.on("upgrade", (_res, socket) => {
      socket.setNoDelay(true);
      const client = {
        socket, buf: Buffer.alloc(0), pending: new Map(), nextId: 1,
        send(method, params = {}) {
          const id = client.nextId++;
          const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
          socket.write(encodeFrame(payload));
          return new Promise((res2, rej2) => client.pending.set(id, { res: res2, rej: rej2 }));
        },
      };
      socket.on("data", (chunk) => {
        client.buf = Buffer.concat([client.buf, chunk]);
        while (true) {
          const decoded = decodeFrame(client.buf);
          if (!decoded) break;
          client.buf = decoded.rest;
          if (decoded.opcode === 8) { socket.end(); return; }
          if (decoded.opcode !== 1) continue;
          let msg; try { msg = JSON.parse(decoded.payload.toString("utf8")); } catch { continue; }
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
    req.on("error", reject);
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
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(path, Buffer.from(data, "base64"));
  console.log("wrote", path, fs.statSync(path).size);
}

async function evalJson(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function main() {
  const login = await httpJson(API + "/v1/auth/login", "POST", JSON.stringify({ email: EMAIL, password: PASS }));
  const token = login.token;
  if (!token) throw new Error("login failed: " + JSON.stringify(login));

  const tab = await httpJson("/json/new?" + encodeURIComponent("about:blank"), "PUT");
  if (!tab?.webSocketDebuggerUrl) throw new Error("no tab");
  const cdp = await connectWs(tab.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false,
  });

  await cdp.send("Page.navigate", { url: BASE + "/" });
  await sleep(1000);
  await evalJson(cdp, `(() => {
    localStorage.setItem("hub_token", ${JSON.stringify(token)});
    localStorage.setItem("note-hub:ask-sources-open", "0");
    return true;
  })()`);

  await cdp.send("Page.navigate", { url: BASE + "/ask" });
  await sleep(2200);
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(2800);

  await evalJson(cdp, `(() => {
    const btn = [...document.querySelectorAll("button")].find(b => /新对话/.test(b.textContent || ""));
    btn?.click();
    return !!btn;
  })()`);
  await sleep(500);

  const submit = await evalJson(cdp, `(() => {
    const input = document.querySelector('.ask-prompt-shell input, input[name="query"]');
    if (!input) return { ok:false, reason:"no input" };
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(input, ${JSON.stringify(QUERY)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form")?.requestSubmit();
    return { ok:true };
  })()`);
  console.log("submit", submit);

  let busyShot = null;
  for (let i = 0; i < 50; i++) {
    busyShot = await evalJson(cdp, `(() => {
      const pipe = document.querySelector(".ask-pipeline");
      const steps = [...document.querySelectorAll(".ask-pipeline-step")].map(el => ({
        state: el.dataset.state,
        label: el.querySelector(".ask-pipeline-label")?.textContent,
      }));
      const bare = /正在从笔记里检索/.test(document.body.innerText || "");
      return { hasPipeline: !!pipe, steps, bare, busyAttr: !!document.querySelector('.ask-pipeline[aria-busy="true"]') };
    })()`);
    if (busyShot.hasPipeline) {
      console.log("busy pipeline", JSON.stringify(busyShot));
      await shot(cdp, "/workspace/ask-busy-pipeline.png");
      break;
    }
    await sleep(200);
  }
  if (!busyShot?.hasPipeline) console.log("busy pipeline miss", busyShot);

  let mid = null;
  for (let i = 0; i < 110; i++) {
    mid = await evalJson(cdp, `(() => {
      const scanning = !!document.querySelector(".ask-cites-scanning");
      const cards = document.querySelectorAll(".ask-cites-scanning .cite-card").length;
      const chips = document.querySelectorAll(".ask-cites-scanning .cite-chip").length;
      const paper = !!document.querySelector(".ask-answer-paper");
      return { scanning, cards, chips, paper };
    })()`);
    if (mid.scanning && mid.cards >= 1 && !mid.paper) {
      console.log("mid-scan", mid, "at", i);
      await shot(cdp, "/workspace/ask-scan-mid.png");
      break;
    }
    if (i === 109) console.log("mid-scan timeout", mid);
    await sleep(250);
  }

  let after = null;
  for (let i = 0; i < 150; i++) {
    after = await evalJson(cdp, `(() => {
      const scanning = !!document.querySelector(".ask-cites-scanning");
      const paper = document.querySelector(".ask-answer-paper");
      const cites = document.querySelector(".ask-cites");
      const toggle = document.querySelector(".ask-cites-toggle");
      const expanded = toggle?.getAttribute("aria-expanded");
      const quoteStrip = !!document.querySelector(".cite-chip-quote");
      const weak = document.querySelector(".ask-weak-pill")?.textContent || null;
      const marks = document.querySelectorAll(".cite-mark").length;
      const paperTop = paper && Math.round(paper.getBoundingClientRect().top);
      const citesBefore = !!(cites && paper && (cites.compareDocumentPosition(paper) & Node.DOCUMENT_POSITION_FOLLOWING));
      return { scanning, expanded, quoteStrip, weak, marks, paperTop, citesBefore, hasPaper: !!paper };
    })()`);
    if (!after.scanning && after.hasPaper && after.citesBefore) {
      console.log("after", after, "at", i);
      await shot(cdp, "/workspace/ask-after-fold.png");
      break;
    }
    if (i === 149) console.log("after timeout", after);
    await sleep(350);
  }

  const markPos = await evalJson(cdp, `(() => {
    const mark = document.querySelector(".cite-mark");
    if (!mark) return null;
    const r = mark.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, n: mark.textContent };
  })()`);
  console.log("mark", markPos);

  const tops = [];
  let flicker = { ok: false };
  if (markPos) {
    for (let i = 0; i < 12; i++) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: markPos.x, y: markPos.y, button: "none",
      });
      await evalJson(cdp, `(() => {
        const mark = document.querySelector(".cite-mark");
        if (!mark) return false;
        mark.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        return true;
      })()`);
      await sleep(180);
      const sample = await evalJson(cdp, `(() => {
        const paper = document.querySelector(".ask-answer-paper");
        const mark = document.querySelector(".cite-mark");
        const pop = document.querySelector(".cite-pop");
        const strip = document.querySelector(".cite-chip-quote");
        const expanded = document.querySelector(".ask-cites-toggle")?.getAttribute("aria-expanded");
        const chipActive = !!document.querySelector(".cite-chip-active");
        return {
          paperTop: paper && Math.round(paper.getBoundingClientRect().top),
          markTop: mark && Math.round(mark.getBoundingClientRect().top),
          pop: !!pop,
          strip: !!strip,
          expanded,
          chipActive,
          z: pop ? getComputedStyle(pop).zIndex : null,
        };
      })()`);
      tops.push(sample);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: markPos.x + 40, y: markPos.y + 30, button: "none",
      });
      await sleep(80);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: markPos.x, y: markPos.y, button: "none",
      });
    }
    await shot(cdp, "/workspace/ask-cite-hover-stable.png");
    const paperTops = tops.map(t => t.paperTop).filter(v => typeof v === "number");
    const markTops = tops.map(t => t.markTop).filter(v => typeof v === "number");
    const paperDelta = paperTops.length ? Math.max(...paperTops) - Math.min(...paperTops) : null;
    const markDelta = markTops.length ? Math.max(...markTops) - Math.min(...markTops) : null;
    const anyStrip = tops.some(t => t.strip);
    const anyExpand = tops.some(t => t.expanded === "true");
    const anyPop = tops.some(t => t.pop);
    flicker = {
      ok: paperDelta != null && paperDelta <= 2 && markDelta != null && markDelta <= 2 && !anyStrip && !anyExpand,
      paperDelta, markDelta, anyStrip, anyExpand, anyPop,
      samples: tops.slice(0, 4),
    };
    console.log("flicker", flicker);
  }

  const report = { query: QUERY, busyShot, mid, after, markPos, flicker };
  fs.writeFileSync("/workspace/ask-flicker-verify.json", JSON.stringify(report, null, 2));
  console.log("REPORT", JSON.stringify(report, null, 2));

  try { await httpJson("/json/close/" + tab.id, "GET"); } catch {}
  process.exit(flicker.ok ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
