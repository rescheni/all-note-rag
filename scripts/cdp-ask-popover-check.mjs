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
function httpJson(urlPath, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const abs = urlPath.startsWith("http");
    const u = new URL(urlPath, abs ? undefined : CDP);
    const data = body ? Buffer.from(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } },
      (res) => { const chunks=[]; res.on("data", c=>chunks.push(c)); res.on("end", ()=>{ const t=Buffer.concat(chunks).toString("utf8"); try{resolve(JSON.parse(t))}catch{resolve(t)} }); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl); const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key } });
    req.on("upgrade", (_res, socket) => {
      socket.setNoDelay(true);
      const client = { socket, buf: Buffer.alloc(0), pending: new Map(), nextId: 1,
        send(method, params = {}) { const id = client.nextId++; const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf8"); socket.write(encodeFrame(payload)); return new Promise((res2, rej2) => client.pending.set(id, { res: res2, rej: rej2 })); } };
      socket.on("data", (chunk) => { client.buf = Buffer.concat([client.buf, chunk]); while (true) { const decoded = decodeFrame(client.buf); if (!decoded) break; client.buf = decoded.rest; if (decoded.opcode === 8) { socket.end(); return; } if (decoded.opcode !== 1) continue; let msg; try { msg = JSON.parse(decoded.payload.toString("utf8")); } catch { continue; } if (msg.id && client.pending.has(msg.id)) { const { res, rej } = client.pending.get(msg.id); client.pending.delete(msg.id); if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result || {}); } } });
      resolve(client);
    });
    req.on("error", reject); req.end();
  });
}
function encodeFrame(payload) { const len = payload.length; const maskKey = crypto.randomBytes(4); let header; if (len < 126) { header = Buffer.alloc(2); header[0]=0x81; header[1]=0x80|len; } else if (len < 65536) { header = Buffer.alloc(4); header[0]=0x81; header[1]=0x80|126; header.writeUInt16BE(len,2); } else { header = Buffer.alloc(10); header[0]=0x81; header[1]=0x80|127; header.writeUInt32BE(0,2); header.writeUInt32BE(len,6); } const masked = Buffer.alloc(len); for (let i=0;i<len;i++) masked[i]=payload[i]^maskKey[i%4]; return Buffer.concat([header, maskKey, masked]); }
function decodeFrame(buf) { if (buf.length < 2) return null; const opcode = buf[0]&0x0f; const masked=(buf[1]&0x80)!==0; let len=buf[1]&0x7f; let offset=2; if (len===126){ if(buf.length<4)return null; len=buf.readUInt16BE(2); offset=4;} else if(len===127){ if(buf.length<10)return null; len=Number(buf.readBigUInt64BE(2)); offset=10;} const maskLen=masked?4:0; if(buf.length<offset+maskLen+len)return null; let payload=buf.subarray(offset+maskLen, offset+maskLen+len); if(masked){ const mask=buf.subarray(offset,offset+4); const out=Buffer.alloc(len); for(let i=0;i<len;i++) out[i]=payload[i]^mask[i%4]; payload=out;} return {opcode,payload,rest:buf.subarray(offset+maskLen+len)}; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(cdp, path) { const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }); fs.writeFileSync(path, Buffer.from(data, "base64")); console.log("wrote", path); }
async function evalJson(cdp, expression) { const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function main() {
  const login = await httpJson(API + "/v1/auth/login", "POST", JSON.stringify({ email: EMAIL, password: PASS }));
  const token = login.token;
  const tab = await httpJson("/json/new?" + encodeURIComponent("about:blank"), "PUT");
  const cdp = await connectWs(tab.webSocketDebuggerUrl);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: BASE + "/" }); await sleep(800);
  await evalJson(cdp, `(() => { localStorage.setItem("hub_token", ${JSON.stringify(token)}); return true; })()`);
  await cdp.send("Page.navigate", { url: BASE + "/ask" }); await sleep(2000);
  await evalJson(cdp, `(() => {
    return Promise.resolve().then(async () => {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
      }
      if (window.caches) {
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
      }
      return true;
    });
  })()`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(3500);
  // pick latest thread with marks
  const scrolled = await evalJson(cdp, `(() => {
    const mark = document.querySelector(".cite-mark");
    if (!mark) return { ok:false };
    mark.scrollIntoView({ block: "center", inline: "center" });
    const feed = document.querySelector(".ask-feed");
    return { ok:true, feedTop: feed?.scrollTop, markText: mark.textContent };
  })()`);
  console.log("scrolled", scrolled);
  await sleep(400);
  const pos = await evalJson(cdp, `(() => {
    const mark = document.querySelector(".cite-mark");
    if (!mark) return null;
    const r = mark.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  console.log("pos", pos);

  // Stable open via React mouseenter (no click toggle race)
  await evalJson(cdp, `(() => {
    const mark = document.querySelector(".cite-mark");
    if (!mark) return false;
    mark.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
    mark.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    mark.focus();
    return true;
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y, button: "none" });
  await sleep(400);

  let state = await evalJson(cdp, `(() => {
    const pop = document.querySelector(".cite-pop");
    const strip = document.querySelector(".cite-chip-quote");
    const expanded = document.querySelector(".ask-cites-toggle")?.getAttribute("aria-expanded");
    const paper = document.querySelector(".ask-answer-paper");
    const mark = document.querySelector(".cite-mark");
    return {
      pop: !!pop, strip: !!strip, expanded,
      hl: pop?.querySelector(".cite-hl")?.textContent?.slice(0,80) || null,
      title: pop?.querySelector(".cite-pop-title")?.textContent || null,
      z: pop ? getComputedStyle(pop).zIndex : null,
      paperTop: paper && Math.round(paper.getBoundingClientRect().top),
      markTop: mark && Math.round(mark.getBoundingClientRect().top),
      chipActive: !!document.querySelector(".cite-chip-active"),
      openClass: !!document.querySelector(".cite-mark-open"),
    };
  })()`);
  console.log("after hover", state);
  await shot(cdp, "/workspace/ask-cite-popover.png");

  const basePaper = state.paperTop;
  const tops=[];
  for (let i=0;i<10;i++){
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x + (i%2?5:-5), y: pos.y + (i%2?3:-3), button: "none" });
    await evalJson(cdp, `(() => {
      const mark = document.querySelector(".cite-mark");
      mark?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, view: window }));
      return true;
    })()`);
    await sleep(150);
    tops.push(await evalJson(cdp, `(() => {
      const paper = document.querySelector(".ask-answer-paper");
      const mark = document.querySelector(".cite-mark");
      return {
        paperTop: paper && Math.round(paper.getBoundingClientRect().top),
        markTop: mark && Math.round(mark.getBoundingClientRect().top),
        strip: !!document.querySelector(".cite-chip-quote"),
        expanded: document.querySelector(".ask-cites-toggle")?.getAttribute("aria-expanded"),
        pop: !!document.querySelector(".cite-pop"),
        chipActive: !!document.querySelector(".cite-chip-active"),
      };
    })()`));
  }
  await shot(cdp, "/workspace/ask-cite-hover-stable.png");
  const paperTops = tops.map(t=>t.paperTop).filter(v=>typeof v==="number");
  const markTops = tops.map(t=>t.markTop).filter(v=>typeof v==="number");
  const report = {
    state,
    deltaPaper: paperTops.length? Math.max(...paperTops)-Math.min(...paperTops): null,
    deltaMark: markTops.length? Math.max(...markTops)-Math.min(...markTops): null,
    anyStrip: tops.some(t=>t.strip),
    anyExpand: tops.some(t=>t.expanded==="true"),
    anyPop: tops.some(t=>t.pop),
    chipActiveAny: tops.some(t=>t.chipActive),
    tops: tops.slice(0,4),
  };
  console.log("REPORT", JSON.stringify(report,null,2));
  fs.writeFileSync("/workspace/ask-popover-check.json", JSON.stringify(report,null,2));
  try { await httpJson("/json/close/"+tab.id, "GET"); } catch {}
  const ok = report.deltaPaper!=null && report.deltaPaper<=2 && !report.anyStrip && !report.anyExpand && (state.pop || report.anyPop);
  process.exit(ok ? 0 : 2);
}
main().catch(e=>{ console.error(e); process.exit(1); });
