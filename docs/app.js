import { Quaternion, Vector3 } from 'three';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { MindARThree } from './vendor/mindar/mindar-image-three.prod.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);

// 浮動卡與酒標的間距（酒標寬度 = 1000）
const FLOAT_GAP = 40;
// 網址參數只接受清單裡的值，其他情況用預設值
const stepParam = (name, steps, fallback) =>
  params.has(name) && steps.includes(Number(params.get(name))) ? Number(params.get(name)) : fallback;
// 浮動卡跟著酒標「畫面內旋轉」（繞鏡頭方向，例如瓶子左右歪）的比例
const ROTATION_STEPS = [0, 0.3, 0.6, 1];
const rotation = stepParam('rot', ROTATION_STEPS, 0.3);
// 浮動卡跟著酒標「畫面外傾斜」（前後左右翻）的比例；0 = 永遠跟螢幕平行、不會變形，0.1 留一點立體感
const TILT_STEPS = [0, 0.1, 0.3];
const tilt = stepParam('tilt', TILT_STEPS, 0.1);
// MindAR 防抖參數 beta，按鈕只是方便切換，網址可以填任意值
const BETA_STEPS = [1000, 500, 100, 10];
const beta = params.has('beta') ? Number(params.get('beta')) : null; // null = MindAR 預設 1000

const els = {
  ar: $('#ar'),
  start: $('#start'),
  startBtn: $('#start-btn'),
  notice: $('#notice'),
  back: $('#back'),
  hint: $('#hint'),
  loading: $('#loading'),
  sheet: $('#sheet'),
  sheetClose: $('#sheet-close'),
  debug: $('#debug'),
};

let items = [];
let targets = null;
let size = 0;
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
  s.scrollTop = 0;
  s.classList.remove('hidden');
  document.body.classList.add('sheet-open');
}

function closeSheet() {
  els.sheet.classList.add('hidden');
  document.body.classList.remove('sheet-open');
}

els.sheetClose.addEventListener('click', closeSheet);

// ---------- AR ----------

function setupMindAR() {
  mindar = new MindARThree({
    container: els.ar,
    imageTargetSrc: `targets/targets-${size}.mind`,
    maxTrack: 1,
    uiLoading: '#loading',
    uiScanning: '#hint',
    uiError: 'no',
    filterMinCF: params.has('cf') ? Number(params.get('cf')) : null,
    filterBeta: beta,
  });

  targets.targets.forEach(({ aspect }, index) => {
    const anchor = mindar.addCSSAnchor(index);
    const obj = new CSS3DObject(createFloat(index));
    // 卡片底邊貼在酒標上緣再往上 FLOAT_GAP；細長的酒標把卡片放大一點，免得字太小
    obj.position.y = (1000 * aspect) / 2 + FLOAT_GAP;
    obj.scale.setScalar(Math.min(Math.max(aspect * 0.55, 1), 1.4));
    anchor.group.add(obj);
    floats.push(obj.element);
    anchor.onTargetFound = () => { tracking = index; renderDebug(); };
    anchor.onTargetLost = () => { if (tracking === index) tracking = null; renderDebug(); };
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
  if (!mindar) setupMindAR();
  try {
    await mindar.start();
  } catch (err) {
    console.error(err);
    els.loading.classList.add('hidden');
    els.start.classList.remove('hidden');
    showNotice(cameraErrorNotice(err));
    els.startBtn.disabled = false;
    return;
  }
  running = true;
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
  els.hint.classList.add('hidden');
  els.back.classList.add('hidden');
  els.start.classList.remove('hidden');
  renderDebug();
}

els.startBtn.addEventListener('click', startAR);
els.back.addEventListener('click', stopAR);

// 切到別的 App 時相機會被系統停掉，回來後畫面會卡住，所以直接回初始頁
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAR();
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
    <div>酒標角度：${tracking == null ? '-' : `${labelAngle}°`}</div>
    <div>傾斜 ${TILT_STEPS.map((t) =>
      `<button type="button" data-tilt="${t}" aria-pressed="${t === tilt}">${t}</button>`).join('')}</div>
    <div>beta ${BETA_STEPS.map((b) =>
      `<button type="button" data-beta="${b}" aria-pressed="${b === (beta ?? 1000)}">${b}</button>`).join('')}</div>`;
}

els.debug.addEventListener('click', (e) => {
  const key = ['tilt', 'beta'].find((k) => k in e.target.dataset);
  if (!key) return;
  params.set(key, e.target.dataset[key]);
  location.search = params.toString();
});

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
