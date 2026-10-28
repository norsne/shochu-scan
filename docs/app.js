import { Quaternion, Vector3 } from 'three';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { MindARThree } from './vendor/mindar/mindar-image-three.prod.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);

// 網址參數只接受清單裡的值，其他情況用預設值
const stepParam = (name, steps, fallback) =>
  params.has(name) && steps.includes(Number(params.get(name))) ? Number(params.get(name)) : fallback;
// 浮動卡與酒標的間距（酒標寬度 = 1000）；0 = 緊貼酒標，抖動最小
const GAP_STEPS = [0, 40, 80, 150];
const floatGap = stepParam('gap', GAP_STEPS, 0);
// 酒款資訊：預設全螢幕，?sheet=half 是舊的半版（比較用，定案後拿掉）
const sheetHalf = params.get('sheet') === 'half';
// 浮動卡消失超過這麼久才重播彈出動畫，短暫掉追蹤時直接顯示，不會一直彈
const POP_AFTER_MS = 1000;
// 關掉酒款資訊後「結束掃描」等這麼久才出現，避免連點時第二下按到
const BACK_DELAY_MS = 500;
// 浮動卡跟著酒標「畫面內旋轉」（繞鏡頭方向，例如瓶子左右歪）的比例
const ROTATION_STEPS = [0, 0.3, 0.6, 1];
const rotation = stepParam('rot', ROTATION_STEPS, 0.3);
// 浮動卡跟著酒標「畫面外傾斜」（前後左右翻）的比例；0 = 永遠跟螢幕平行、不會變形，0.1 留一點立體感
const TILT_STEPS = [0, 0.1, 0.3];
const tilt = stepParam('tilt', TILT_STEPS, 0.1);
// MindAR 防抖參數 beta：0 = 截止頻率固定在 cf，最穩但動得快時會稍微延遲（MindAR 預設 1000 會抖）
const beta = params.has('beta') ? Number(params.get('beta')) : 0;

const els = {
  ar: $('#ar'),
  start: $('#start'),
  startBtn: $('#start-btn'),
  notice: $('#notice'),
  back: $('#back'),
  hint: $('#hint'),
  loading: $('#loading'),
  loadingText: $('#loading-text'),
  liquid: $('#liquid'),
  liquidTop: $('#liquid-top'),
  sheet: $('#sheet'),
  sheetClose: $('#sheet-close'),
  debug: $('#debug'),
};

let items = [];
let targets = null;
let size = 0;
let targetsSrc = null; // 下載好的辨識檔 blob URL，再次開始掃描不用重下
let mindar = null;
let running = false;
let tracking = null; // 目前追蹤中的酒款 index
let labelAngle = 0; // 酒標相對於正對相機的角度（除錯用）
const floats = [];

const _pos = new Vector3();
const _scale = new Vector3();
const _labelQ = new Quaternion();
const _cardQ = new Quaternion();
const _twistQ = new Quaternion();
const _swingQ = new Quaternion();
const _identity = new Quaternion();

// 減少浮動卡的旋轉：在世界座標裡，正對相機 = 沒有旋轉。
// 把酒標的旋轉拆成「繞 z 軸的畫面內旋轉（twist）」和「其餘的畫面外傾斜（swing）」，
// 各自從「沒有旋轉」只走 rotation／tilt 的比例，組回去後再換算回酒標座標
function dampRotation(group, obj) {
  group.matrix.decompose(_pos, _labelQ, _scale);
  labelAngle = Math.round((2 * Math.acos(Math.min(1, Math.abs(_labelQ.w))) * 180) / Math.PI);

  _twistQ.set(0, 0, _labelQ.z, _labelQ.w);
  if (_twistQ.lengthSq() < 1e-8) _twistQ.identity(); // 剛好翻轉 180° 時沒有 twist
  else _twistQ.normalize();
  _swingQ.copy(_twistQ).invert().premultiply(_labelQ); // labelQ = swing × twist

  _swingQ.slerp(_identity, 1 - tilt);
  _twistQ.slerp(_identity, 1 - rotation);
  _cardQ.copy(_swingQ).multiply(_twistQ);
  obj.quaternion.copy(_labelQ.invert().multiply(_cardQ));
}

// ---------- 環境檢查 ----------

// LINE 內建瀏覽器可以用參數直接跳到外部瀏覽器
if (/\bLine\//i.test(ua) && !params.has('openExternalBrowser')) {
  params.set('openExternalBrowser', '1');
  location.replace(`${location.pathname}?${params}`);
}

function environmentNotice() {
  if (/\bLine\/|FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|Threads/i.test(ua)) {
    return {
      html: `<p>你現在是在 App 裡開啟網頁，相機可能無法使用。</p>
        <p>請點右上角選單，選「用瀏覽器開啟」，或複製網址貼到 ${isIOS ? 'Safari' : 'Chrome'}。</p>
        <button type="button" data-action="copy">複製網址</button>`,
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { html: '<p>這個瀏覽器不支援相機功能，請改用 Safari 或 Chrome 開啟。</p>', block: true };
  }
  if (!isIOS && !isAndroid && !/Mobile/.test(ua)) {
    return { html: '<p>這個活動是設計給手機用的，請用手機掃描展場的 QR 碼。</p>' };
  }
  return null;
}

function showNotice(html) {
  els.notice.innerHTML = html;
  els.notice.classList.remove('hidden');
}

els.notice.addEventListener('click', async (e) => {
  if (e.target.dataset.action !== 'copy') return;
  const url = location.href.replace(/[?&]openExternalBrowser=1/, '');
  try {
    await navigator.clipboard.writeText(url);
    e.target.textContent = '已複製';
  } catch {
    prompt('請手動複製網址', url);
  }
});

function cameraErrorNotice(err) {
  const name = err?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    const ios = `<p>iPhone（Safari）：</p><ol>
        <li>點網址列左邊的頁面選單圖示（aA）</li>
        <li>選「網站設定」</li>
        <li>把「相機」改成「允許」，再重新整理頁面</li></ol>`;
    const android = `<p>Android（Chrome）：</p><ol>
        <li>點網址列左邊的設定圖示</li>
        <li>選「權限」→「相機」</li>
        <li>改成「允許」，再重新整理頁面</li></ol>`;
    return `<p><b>相機權限被拒絕了</b>，需要開啟權限才能掃描：</p>
      ${isIOS ? ios : isAndroid ? android : ios + android}`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '<p>找不到可以使用的相機。</p>';
  }
  if (name === 'NotReadableError') {
    return '<p>相機正在被其他 App 使用，請關掉其他用到相機的 App 後再試一次。</p>';
  }
  return '<p>相機啟動失敗，請重新整理頁面後再試一次。</p>';
}

// ---------- 卡片內容 ----------

const metaText = (it) => [it.category, it.abv != null ? `${it.abv} 度` : null].filter(Boolean).join('・');

function fillTags(container, tags, tag) {
  container.replaceChildren(...tags.map((t) => {
    const el = document.createElement(tag);
    el.textContent = t;
    return el;
  }));
}

function createFloat(index) {
  const it = items[index];
  const el = $('#float-tpl').content.firstElementChild.cloneNode(true);
  el.querySelector('[data-field="name"]').textContent = it.name;
  el.querySelector('[data-field="brewery"]').textContent = it.brewery;
  el.querySelector('[data-field="meta"]').textContent = metaText(it);
  fillTags(el.querySelector('[data-field="tags"]'), it.tags, 'span');
  el.querySelector('.float-card').addEventListener('click', () => openSheet(index));
  return el;
}

// 重播彈出動畫：先拿掉 class、強制重新排版，再加回去
function popFloat(index) {
  const card = floats[index].querySelector('.float-card');
  card.classList.remove('pop');
  void card.offsetWidth;
  card.classList.add('pop');
}

function openSheet(index) {
  const it = items[index];
  const s = els.sheet;
  $('#sheet-name').textContent = it.name;
  s.querySelector('[data-field="brewery"]').textContent = it.brewery;
  s.querySelector('[data-field="reading"]').textContent = it.reading;
  s.querySelector('[data-field="meta"]').textContent = metaText(it);
  fillTags(s.querySelector('[data-field="tags"]'), it.tags, 'li');
  s.querySelector('[data-field="flavor"]').textContent = it.flavor;
  s.querySelector('[data-field="serving"]').textContent = it.serving;
  s.querySelector('.sheet-body').scrollTop = 0;
  if (!s.classList.contains('hidden')) return;
  pushLayer();
  clearTimeout(backTimer);
  els.back.classList.add('hidden');
  s.classList.remove('hidden');
  document.body.classList.add('sheet-open');
}

let backTimer = 0;

function closeSheet() {
  if (els.sheet.classList.contains('hidden')) return;
  els.sheet.classList.add('hidden');
  document.body.classList.remove('sheet-open');
  clearTimeout(backTimer);
  backTimer = setTimeout(() => { if (running) els.back.classList.remove('hidden'); }, BACK_DELAY_MS);
}

if (sheetHalf) els.sheet.classList.add('half');
els.sheetClose.addEventListener('click', () => history.back());

// ---------- 瀏覽紀錄 ----------

// 掃描畫面和酒款資訊各記一筆瀏覽紀錄，按手機的返回只會退一層，不會離開網站。
// 畫面上的按鈕也走 history.back()，實際的關閉都在 popstate 裡做，紀錄才不會亂掉
let depth = 0; // 0 = 首頁、1 = 掃描畫面、2 = 酒款資訊

function pushLayer() {
  depth++;
  history.pushState({ depth }, '');
}

function popAllLayers() {
  if (depth > 0) history.go(-depth);
}

window.addEventListener('popstate', (e) => {
  const target = e.state?.depth ?? 0;
  // 按「下一頁」回到已經關掉的畫面時，直接退回去
  if (target > depth) {
    history.go(depth - target);
    return;
  }
  depth = target;
  if (depth < 2) closeSheet();
  if (depth < 1) stopAR();
});

// ---------- 載入畫面（小酒杯斟酒） ----------

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const POUR_EMPTY = 0.04; // 空杯也留一點底
let pourLevel = POUR_EMPTY; // 畫面上的水位（0~1，1 = 液面在 y=24）
let pourTarget = POUR_EMPTY;
let slosh = 1; // 晃動幅度，水位變化越快晃越大
let pourLast = 0;
let pourRaf = 0;
let pourDone = null; // 斟滿時呼叫

function drawCup(t) {
  const dt = pourLast ? Math.min((t - pourLast) / 1000, 0.1) : 0;
  pourLast = t;
  const prev = pourLevel;
  pourLevel = reduceMotion ? pourTarget : pourLevel + (pourTarget - pourLevel) * Math.min(1, dt * 4);
  const speed = dt ? Math.abs(pourLevel - prev) / dt : 0;
  slosh += ((reduceMotion ? 0 : 1 + Math.min(speed * 8, 1.5)) - slosh) * Math.min(1, dt * 3);

  const s = t / 1000;
  const y0 = 68 - pourLevel * 44;
  const tilt = Math.sin(s * 1.6) * 0.03 * slosh;
  let surface = '';
  for (let x = 10; x <= 90; x += 4) {
    const wave = Math.sin(x * 0.12 + s * 3.2) * 0.6 + Math.sin(x * 0.07 - s * 2.1) * 0.4;
    const y = y0 + tilt * (x - 50) + wave * slosh;
    surface += `${x === 10 ? 'M' : 'L'}${x} ${y.toFixed(2)}`;
  }
  els.liquid.setAttribute('d', `${surface}L90 100L10 100Z`);
  els.liquidTop.setAttribute('d', surface);

  if (pourDone && pourLevel > 0.98) {
    pourDone();
    pourDone = null;
  }
  pourRaf = requestAnimationFrame(drawCup);
}

function showLoading(text) {
  pourLevel = pourTarget = POUR_EMPTY;
  pourLast = 0;
  pourDone = null;
  els.loadingText.textContent = text;
  els.loading.classList.remove('hidden', 'fade');
  cancelAnimationFrame(pourRaf);
  pourRaf = requestAnimationFrame(drawCup);
}

function setPour(level, text) {
  pourTarget = Math.max(pourTarget, level);
  if (text) els.loadingText.textContent = text;
}

// rAF 只在載入畫面顯示時跑
function hideLoading() {
  cancelAnimationFrame(pourRaf);
  pourDone = null;
  els.loading.classList.add('hidden');
  els.loading.classList.remove('fade');
}

// 斟滿再淡出；不等它跑完，掃描已經在後面開始了
function finishLoading() {
  setPour(1, '準備完成');
  pourDone = () => {
    els.loading.classList.add('fade');
    setTimeout(hideLoading, 300);
  };
}

// 自己下載辨識檔才算得出進度（MindAR 內部只是 fetch(imageTargetSrc)），轉成 blob URL 交給它
async function downloadTargets(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  const total = Number(res.headers.get('Content-Length'));
  // 沒有檔案大小就算不出進度，酒杯只晃動不加水
  if (!total || !res.body) return URL.createObjectURL(await res.blob());
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const p = Math.min(received / total, 1);
    setPour(0.15 + p * 0.65, `載入酒標資料 ${Math.round(p * 100)}%`);
  }
  return URL.createObjectURL(new Blob(chunks));
}

// ---------- AR ----------

function setupMindAR() {
  mindar = new MindARThree({
    container: els.ar,
    imageTargetSrc: targetsSrc,
    maxTrack: 1,
    uiLoading: 'no', // 載入畫面自己控制，MindAR 會太早關掉，來不及演斟滿
    uiScanning: '#hint',
    uiError: 'no',
    filterMinCF: params.has('cf') ? Number(params.get('cf')) : null,
    filterBeta: beta,
  });

  targets.targets.forEach(({ aspect }, index) => {
    const anchor = mindar.addCSSAnchor(index);
    const obj = new CSS3DObject(createFloat(index));
    // 卡片底邊貼在酒標上緣再往上 floatGap；細長的酒標把卡片放大一點，免得字太小
    obj.position.y = (1000 * aspect) / 2 + floatGap;
    obj.scale.setScalar(Math.min(Math.max(aspect * 0.55, 1), 1.4));
    anchor.group.add(obj);
    floats.push(obj.element);
    let lostAt = -Infinity;
    anchor.onTargetFound = () => {
      tracking = index;
      if (performance.now() - lostAt > POP_AFTER_MS) popFloat(index);
      renderDebug();
    };
    anchor.onTargetLost = () => {
      lostAt = performance.now();
      if (tracking === index) tracking = null;
      renderDebug();
    };
    anchor.onTargetUpdate = () => { if (anchor.visible) dampRotation(anchor.group, obj); };
  });
}

async function startAR() {
  els.startBtn.disabled = true;
  els.notice.classList.add('hidden');

  // 先自己要一次相機權限，才拿得到錯誤原因（MindAR 失敗時不會告訴我們原因）
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    showNotice(cameraErrorNotice(err));
    els.startBtn.disabled = false;
    return;
  }

  els.start.classList.add('hidden');
  // 階段：載入酒標資料 N%（第一次才有）→ 相機啟動與準備辨識（MindAR 內部，拆不開）→ 斟滿淡出
  const url = `targets/targets-${size}.mind`;
  if (!targetsSrc) {
    showLoading('載入酒標資料…');
    setPour(0.15);
    try {
      targetsSrc = await downloadTargets(url);
    } catch (err) {
      console.error(err); // 下載失敗就退回原網址，讓 MindAR 自己抓
    }
  } else {
    showLoading('相機啟動中…');
  }
  setPour(0.9, '相機啟動中…');
  if (!mindar) setupMindAR();
  mindar.imageTargetSrc = targetsSrc ?? url;
  try {
    await mindar.start();
  } catch (err) {
    console.error(err);
    hideLoading();
    els.start.classList.remove('hidden');
    showNotice(cameraErrorNotice(err));
    els.startBtn.disabled = false;
    return;
  }
  running = true;
  finishLoading();
  pushLayer();
  els.back.classList.remove('hidden');
  els.startBtn.disabled = false;
  startFrameLoop();
  renderDebug();
}

function stopAR() {
  if (!running) return;
  running = false;
  mindar.stop();
  mindar.renderer.setAnimationLoop(null);
  tracking = null;
  floats.forEach((el) => { el.style.visibility = 'hidden'; });
  closeSheet();
  clearTimeout(backTimer);
  els.hint.classList.add('hidden');
  els.back.classList.add('hidden');
  els.start.classList.remove('hidden');
  renderDebug();
}

els.startBtn.addEventListener('click', startAR);
els.back.addEventListener('click', popAllLayers);

// 切到別的 App 時相機會被系統停掉，回來後畫面會卡住，所以直接回初始頁
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  stopAR();
  popAllLayers();
});

// ---------- 畫面更新與除錯 ----------

let frames = 0;
let fps = 0;
let lastFpsAt = performance.now();

function startFrameLoop() {
  mindar.renderer.setAnimationLoop(() => {
    mindar.cssRenderer.render(mindar.cssScene, mindar.camera);
    if (!debug) return;
    frames++;
    const now = performance.now();
    if (now - lastFpsAt >= 1000) {
      fps = Math.round((frames * 1000) / (now - lastFpsAt));
      frames = 0;
      lastFpsAt = now;
      renderDebug();
    }
  });
}

function renderDebug() {
  if (!debug) return;
  els.debug.classList.remove('hidden');
  const state = !running ? '待機' : tracking == null ? '掃描中' : `追蹤 ${items[tracking].id}`;
  els.debug.innerHTML = `
    <div>狀態：${state}</div>
    <div>FPS：${running ? fps : '-'}</div>
    <div>酒標角度：${tracking == null ? '-' : `${labelAngle}°`}</div>`;
}

// ---------- 初始化 ----------

async function init() {
  const env = environmentNotice();
  if (env) showNotice(env.html);

  try {
    const [shochu, meta] = await Promise.all(
      ['data/shochu.json', 'data/targets.json'].map((u) => fetch(u).then((r) => {
        if (!r.ok) throw new Error(`${u} ${r.status}`);
        return r.json();
      })),
    );
    items = shochu.items;
    targets = meta;
  } catch (err) {
    console.error(err);
    showNotice('<p>資料載入失敗，請檢查網路後重新整理頁面。</p>');
    els.startBtn.textContent = '無法開始';
    return;
  }

  // 比對檔裡的順序必須跟酒款資料一致
  const mismatch = targets.targets.some((t, i) => t.id !== items[i]?.id) || targets.targets.length !== items.length;
  if (mismatch) {
    console.error('targets.json 與 shochu.json 的酒款順序不一致，請重新執行 npm run build');
    showNotice('<p>資料版本不一致，請稍後再試。</p>');
    els.startBtn.textContent = '無法開始';
    return;
  }

  const requested = Number(params.get('size'));
  size = targets.sizes.includes(requested) ? requested : targets.defaultSize;

  els.startBtn.textContent = '開始掃描';
  els.startBtn.disabled = Boolean(env?.block);
  renderDebug();
}

init();
