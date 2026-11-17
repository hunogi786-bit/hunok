// 무궁화 꽃이 피었습니다 — 카메라가 술래가 되는 몸놀이
// 몸 인식(MediaPipe Pose Landmarker)은 이 폴더 안의 파일로 기기에서만 돌아갑니다.
// 카메라 영상은 화면에 그리기만 하고 저장하거나 전송하지 않습니다.

const $ = s => document.querySelector(s);
const canvas = $('#stage');
const ctx = canvas.getContext('2d');
const video = $('#cam');

const here = p => new URL(p, location.href).href;
const VENDOR = {
  bundle: here('vendor/mediapipe/vision_bundle.mjs'),
  loader: here('vendor/mediapipe/wasm/vision_wasm_internal.js'),
  wasm:   here('vendor/mediapipe/wasm/vision_wasm_internal.wasm'),
  model:  here('vendor/mediapipe/models/pose_landmarker_lite.task'),
};

/* ---------------- 놀이 규칙 숫자 ----------------
   움직임 값: 몸통 길이를 1로 볼 때, 관절들이 1초에 평균 얼마나 움직였는지.
   가만히 서 있으면 약 0.02~0.08, 제자리 달리기·팔 흔들기는 약 0.4 이상. */
const GOAL = 100;            // 도착 거리
const MOVE_DEADZONE = 0.10;  // 이보다 작은 움직임은 앞으로 가지 않음
const MOVE_GAIN = 9;         // 움직임 → 걸음 수 배율
const MOVE_CAP = 0.9;        // 너무 세게 움직여도 이 이상 빨라지지 않음
const LEVELS = {
  //          멈춤 기준      돌아본 뒤 봐주는 시간  이만큼 계속 움직이면 걸림  뒤로 가는 거리
  easy:   { threshold: 0.32, grace: 1.00, sustain: 0.35, back: 12, freeze: [2.0, 3.0] },
  normal: { threshold: 0.21, grace: 0.75, sustain: 0.20, back: 18, freeze: [2.2, 3.4] },
  hawk:   { threshold: 0.13, grace: 0.55, sustain: 0.10, back: 24, freeze: [2.4, 4.0] },
};
const LEVEL_NAME = { easy: '너그러움', normal: '보통', hawk: '매의 눈' };

/* ---------------- 설정 ---------------- */
const settings = { players: '1', level: 'normal', voice: 'on' };
try { Object.assign(settings, JSON.parse(localStorage.getItem('mugunghwa') || '{}')); } catch (e) {}
if (!LEVELS[settings.level]) settings.level = 'normal';
if (!['1', '2'].includes(settings.players)) settings.players = '1';
const save = () => { try { localStorage.setItem('mugunghwa', JSON.stringify(settings)); } catch (e) {} };

function syncMenu() {
  document.querySelectorAll('.chips').forEach(g => g.querySelectorAll('.chip').forEach(c =>
    c.setAttribute('aria-pressed', String(c.dataset.value === settings[g.dataset.group]))));
}
document.querySelectorAll('.chips').forEach(g => g.addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  settings[g.dataset.group] = c.dataset.value; save(); syncMenu();
}));
syncMenu();

/* ---------------- 화면 ---------------- */
let W = 0, H = 0, U = 1;
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  W = innerWidth; H = innerHeight; U = Math.min(W, H);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize); resize();

/* ---------------- 소리 ---------------- */
let ac = null, master = null;
function initAudio() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain(); master.gain.value = 0.55; master.connect(ac.destination);
  } catch (e) { ac = null; }
}
function tone(freq, dur, type = 'sine', vol = 0.3, endFreq = null, delay = 0) {
  if (!ac) return;
  const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
}
const sTick   = n => tone([392, 440, 523, 587, 659][n % 5], 0.12, 'triangle', 0.22);
const sFreeze = () => { tone(196, 0.6, 'sine', 0.35); tone(294, 0.6, 'sine', 0.2, null, 0.02); };
const sCaught = () => { tone(440, 0.5, 'square', 0.12, 110); };
const sBeep   = hi => tone(hi ? 1046 : 660, hi ? 0.35 : 0.15, 'square', 0.1);
const sWin    = () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, 'triangle', 0.25, null, i * 0.13));

let koVoice = null;
function pickVoice() {
  try { koVoice = speechSynthesis.getVoices().find(v => /^ko/i.test(v.lang)) || null; } catch (e) {}
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.addEventListener?.('voiceschanged', pickVoice); }
function say(text, rate = 1, interrupt = true) {
  if (settings.voice !== 'on' || !('speechSynthesis' in window)) return;
  try {
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR'; u.rate = rate; u.pitch = 1.1;
    if (koVoice) u.voice = koVoice;
    speechSynthesis.speak(u);
  } catch (e) {}
}
const hush = () => { try { speechSynthesis.cancel(); } catch (e) {} };

/* ---------------- 카메라와 몸 인식 ---------------- */
let landmarker = null, camReady = false, lastVideoTime = -1, poses = [];
function setStatus(kind, text) { $('#camDot').className = 'dot ' + kind; $('#camText').textContent = text; }

async function initCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera api');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false,
  });
  video.srcObject = stream;
  await video.play();
  camReady = true;
}
async function initPose() {
  const { PoseLandmarker } = await import(VENDOR.bundle);
  const fileset = { wasmLoaderPath: VENDOR.loader, wasmBinaryPath: VENDOR.wasm };
  const opts = delegate => ({
    baseOptions: { modelAssetPath: VENDOR.model, delegate },
    runningMode: 'VIDEO', numPoses: settings.players === '2' ? 4 : 2,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch (e) { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
  // 2인 모드로 바뀌면 더 많은 사람을 찾도록 설정을 다시 맞춥니다.
  landmarker.__numPoses = opts().numPoses;
}
(async () => {
  setStatus('wait', '카메라를 켜는 중… "허용"을 눌러 주세요');
  try { await initCamera(); }
  catch (e) {
    const why = location.protocol === 'file:' ? ' (파일로 열면 안 돼요. 인터넷 주소로 열어 주세요)' : '';
    setStatus('bad', '카메라를 쓸 수 없어요' + why + '. 키보드 A·L이나 화면 누르기로 해볼 수 있어요.');
    return;
  }
  setStatus('wait', '몸 인식 준비 중… (처음 한 번은 조금 걸려요)');
  try { await initPose(); setStatus('ok', '준비 완료! 카메라 앞에 서서 시작을 누르세요.'); }
  catch (e) { console.error(e); setStatus('bad', '몸 인식을 불러오지 못했어요. 페이지를 새로 고쳐 주세요. (키보드로는 할 수 있어요)'); }
})();

async function ensureNumPoses() {
  const want = settings.players === '2' ? 4 : 2;
  if (landmarker && landmarker.__numPoses !== want) {
    try { await landmarker.setOptions({ numPoses: want }); landmarker.__numPoses = want; } catch (e) {}
  }
}

function videoRect() {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh), dw = vw * s, dh = vh * s;
  return { x: (W - dw) / 2, y: (H - dh) / 2, w: dw, h: dh };
}
function detect(now) {
  if (!landmarker || !camReady || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  try { poses = landmarker.detectForVideo(video, now).landmarks || []; } catch (e) { poses = []; }
}

/* ---------------- 사람별 움직임 ---------------- */
const KEYPTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const WINDOW = 0.25; // 이 시간 동안 움직인 거리로 움직임을 잽니다 (작은 떨림에 덜 민감)

function makePlayer(i) {
  return {
    i, label: i === 0 ? '1P' : '2P', spoken: i === 0 ? '왼쪽 친구' : '오른쪽 친구',
    color: i === 0 ? '#ff7a3d' : '#3b82f6',
    progress: 0, shown: 0, caught: 0, motion: 0, camMotion: 0, visible: false, unseenT: 0,
    hist: [], sm: null, over: 0, caughtThisPhase: false, caughtFx: 0, key: false, touch: false,
  };
}
let players = [makePlayer(0)];

function poseInfo(lm, vw, vh) {
  const P = k => ({ x: lm[k].x * vw, y: lm[k].y * vh, v: lm[k].visibility ?? 1 });
  const ls = P(11), rs = P(12), lh = P(23), rh = P(24);
  const sm = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 }, hm = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const torso = Math.max(Math.hypot(sm.x - hm.x, sm.y - hm.y), Math.hypot(ls.x - rs.x, ls.y - rs.y) * 1.2);
  const cx = 1 - ((lm[11].x + lm[12].x + lm[23].x + lm[24].x) / 4); // 화면은 거울처럼 뒤집혀 있음
  return { torso, cx };
}

function assignPoses() {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const cands = poses.map(lm => ({ lm, ...poseInfo(lm, vw, vh) })).filter(c => c.torso > 8);
  const biggest = list => list.reduce((a, b) => (!a || b.torso > a.torso ? b : a), null);
  if (players.length === 1) return [biggest(cands)];
  return [biggest(cands.filter(c => c.cx < 0.5)), biggest(cands.filter(c => c.cx >= 0.5))];
}

function updateMotion(p, cand, now, dt) {
  if (!cand) {
    p.visible = false; p.unseenT += dt; p.hist = []; p.sm = null;
    p.camMotion += (0 - p.camMotion) * Math.min(1, dt / 0.2);
    return;
  }
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const pts = KEYPTS.map(k => ({ x: cand.lm[k].x * vw, y: cand.lm[k].y * vh, v: cand.lm[k].visibility ?? 1 }));
  // 다른 사람으로 바뀐 것처럼 크게 튀면 기록을 새로 시작
  if (p.sm) {
    const c0 = p.sm[1], c1 = pts[1];
    if (Math.hypot(c1.x - c0.x, c1.y - c0.y) > cand.torso * 1.5) { p.hist = []; p.sm = null; }
  }
  if (p.sm) pts.forEach((q, k) => { q.x = p.sm[k].x + (q.x - p.sm[k].x) * 0.6; q.y = p.sm[k].y + (q.y - p.sm[k].y) * 0.6; });
  p.sm = pts; p.visible = true; p.unseenT = 0;
  p.hist.push({ t: now, pts, torso: cand.torso });
  while (p.hist.length > 2 && p.hist[1].t <= now - WINDOW * 1000) p.hist.shift();
  // 적어도 WINDOW만큼 지난 기록과 비교 (느린 기기에서 프레임 간격이 길어도 동작)
  const old = p.hist[0];
  const span = (now - old.t) / 1000;
  if (p.hist.length < 2 || span < 0.1) return;
  if (span > 1.2) { p.hist = [p.hist[p.hist.length - 1]]; return; }
  let sum = 0, n = 0;
  pts.forEach((q, k) => {
    const o = old.pts[k];
    if (q.v > 0.5 && o.v > 0.5) { sum += Math.hypot(q.x - o.x, q.y - o.y); n++; }
  });
  if (n < 3) return;
  const inst = (sum / n) / cand.torso / span;
  p.camMotion += (inst - p.camMotion) * Math.min(1, Math.max(dt, 0.016) / 0.12);
}

/* 카메라가 없을 때: 키보드 A(1P)·L(2P), 화면 왼쪽·오른쪽 누르고 있기 */
const keyHeld = { a: false, l: false };
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'l') keyHeld[k] = true;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === 'Enter' && (state === 'menu' || state === 'result')) { e.preventDefault(); startGame(); }
  else if (k === 'f') toggleFull();
});
addEventListener('keyup', e => { const k = e.key.toLowerCase(); if (k === 'a' || k === 'l') keyHeld[k] = false; });
const touches = new Map();
canvas.addEventListener('pointerdown', e => { touches.set(e.pointerId, e.clientX); });
const lift = e => touches.delete(e.pointerId);
addEventListener('pointerup', lift); addEventListener('pointercancel', lift);
function manualMotion(p) {
  let held = false;
  if (players.length === 1) held = keyHeld.a || keyHeld.l || touches.size > 0;
  else {
    held = p.i === 0 ? keyHeld.a : keyHeld.l;
    for (const x of touches.values()) if ((x < W / 2) === (p.i === 0)) held = true;
  }
  return held ? 0.6 : 0;
}

/* ---------------- 놀이 진행 ---------------- */
let state = 'menu';         // menu | countdown | chant | freeze | paused | result
let pausedFrom = null;
let phaseT = 0, chantD = 3, freezeD = 3, round = 0, playT = 0, cdT = 0;
let chantPlan = [], syllables = [], winner = null, flashT = 0;
let wakeLock = null;
const rand = (a, b) => a + Math.random() * (b - a);
const L = () => LEVELS[settings.level];
const SYL = ['무', '궁', '화', ' ', '꽃', '이', ' ', '피', '었', '습', '니', '다'];
const SYL_AT = [0, .12, .24, null, .36, .47, null, .58, .68, .78, .88, .96];

function planChant() {
  const r = Math.random();
  chantD = r < 0.25 ? rand(1.8, 2.6) : r < 0.75 ? rand(3.0, 4.5) : rand(5.0, 6.5);
  const rate = Math.max(0.75, Math.min(1.7, 2.2 - chantD * 0.25));
  chantPlan = chantD < 2.7
    ? [{ at: 0, text: '무궁화 꽃이 피었습니다', rate: 1.7, done: false }]
    : [{ at: 0, text: '무궁화', rate, done: false }, { at: 0.36 * chantD, text: '꽃이', rate, done: false },
       { at: 0.58 * chantD, text: '피었습니다', rate, done: false }];
  syllables = SYL.map((s, k) => ({ s, at: SYL_AT[k] === null ? null : SYL_AT[k] * chantD, shown: false }));
}

function startChant() {
  state = 'chant'; phaseT = 0; round++;
  players.forEach(p => { p.caughtThisPhase = false; p.over = 0; });
  planChant();
}
function startFreeze() {
  state = 'freeze'; phaseT = 0;
  freezeD = rand(...L().freeze);
  players.forEach(p => { p.caughtThisPhase = false; p.over = 0; });
  sFreeze(); say('얼음!', 1.15);
}

async function startGame() {
  initAudio();
  await ensureNumPoses();
  players = settings.players === '2' ? [makePlayer(0), makePlayer(1)] : [makePlayer(0)];
  round = 0; playT = 0; winner = null; flashT = 0;
  $('#menu').hidden = true; $('#result').hidden = true; $('#tools').hidden = false;
  $('#btnPause').textContent = '일시정지';
  state = 'countdown'; cdT = 0; lastCd = -1;
  say('술래가 돌아보면 얼음! 준비!', 1.05);
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { wakeLock = null; }
}
function finish(p) {
  state = 'result'; winner = p; hush(); sWin();
  $('#tools').hidden = true;
  const solo = players.length === 1;
  const mm = Math.floor(playT / 60), ss = Math.floor(playT % 60);
  const time = mm ? `${mm}분 ${ss}초` : `${ss}초`;
  $('#resKicker').textContent = solo ? '도착!' : p ? `${p.label} 도착!` : '둘 다 도착!';
  $('#resTitle').textContent = solo ? '술래를 잡았어요!' : p ? `${p.label} 승리!` : '무승부!';
  const stars = solo ? (p.caught <= 1 ? 3 : p.caught <= 3 ? 2 : 1) : 0;
  $('#resStars').innerHTML = solo ? [0, 1, 2].map(i => `<span class="${i < stars ? 'on' : 'off'}">★</span>`).join('') : '';
  $('#resStars').hidden = !solo;
  const rows = solo
    ? [['걸린 횟수', `${p.caught}번`], ['걸린 시간', time], ['술래 눈치', LEVEL_NAME[settings.level]]]
        .map(([a, b]) => `<div class="resRow"><span>${a}</span><span>${b}</span></div>`)
    : players.map(q => `<div class="resRow"><span class="who"><i style="background:${q.color}"></i>${q.label}${q === p ? ' 🏁' : ''}</span>
        <span>${Math.min(100, Math.round(q.progress))}% · 걸린 횟수 ${q.caught}번</span></div>`);
  $('#resRows').innerHTML = rows.join('');
  $('#result').hidden = false;
  say(solo ? '도착! 술래를 잡았어요!' : p ? `${p.spoken} 승리!` : '둘 다 도착! 무승부!', 1.05);
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
}
function goMenu() {
  state = 'menu'; hush();
  $('#tools').hidden = true; $('#result').hidden = true; $('#menu').hidden = false;
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
}
function togglePause() {
  if (state === 'chant' || state === 'freeze' || state === 'countdown') {
    pausedFrom = state; state = 'paused'; hush(); $('#btnPause').textContent = '계속하기';
  } else if (state === 'paused') {
    state = pausedFrom; $('#btnPause').textContent = '일시정지';
    if (state === 'chant') { startChant(); round--; }  // 노래는 처음부터 다시
  }
}
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$('#btnStart').addEventListener('click', startGame);
$('#btnAgain').addEventListener('click', startGame);
$('#btnMenu').addEventListener('click', goMenu);
$('#btnHome').addEventListener('click', goMenu);
$('#btnPause').addEventListener('click', togglePause);
$('#btnFull').addEventListener('click', toggleFull);
document.addEventListener('visibilitychange', () => { if (document.hidden && state !== 'paused') togglePause(); });

let lastCd = -1;
function update(now, dt) {
  // 사람 찾기와 움직임 계산은 놀이 중에만
  if (state === 'countdown' || state === 'chant' || state === 'freeze' || state === 'paused') {
    const cands = camReady && landmarker ? assignPoses() : [];
    players.forEach((p, k) => {
      updateMotion(p, cands[k] || null, now, dt);
      const m = manualMotion(p);
      p.motion = Math.max(p.camMotion, m);
      if (m) { p.visible = true; p.unseenT = 0; }
    });
  }
  players.forEach(p => {
    p.shown += (p.progress - p.shown) * Math.min(1, dt * 6);
    if (p.caughtFx > 0) p.caughtFx -= dt;
  });
  if (flashT > 0) flashT -= dt;

  if (state === 'countdown') {
    cdT += dt;
    const n = Math.floor(cdT / 0.9);
    if (n !== lastCd) { lastCd = n; if (n <= 3) sBeep(n === 3); }
    if (cdT >= 3.6) startChant();
    return;
  }
  if (state === 'chant') {
    phaseT += dt; playT += dt;
    for (const s of chantPlan) if (!s.done && phaseT >= s.at) { s.done = true; say(s.text, s.rate); }
    syllables.forEach((s, k) => { if (s.at !== null && !s.shown && phaseT >= s.at) { s.shown = true; if (settings.voice !== 'on') sTick(k); } });
    for (const p of players) {
      const step = Math.max(0, Math.min(MOVE_CAP, p.motion) - MOVE_DEADZONE) * MOVE_GAIN * dt;
      p.progress = Math.min(GOAL, p.progress + step);
    }
    const done = players.filter(p => p.progress >= GOAL);
    if (done.length) { finish(done.length > 1 ? null : done[0]); return; }   // 같은 순간에 둘 다 도착하면 무승부
    if (phaseT >= chantD) startFreeze();
    return;
  }
  if (state === 'freeze') {
    phaseT += dt; playT += dt;
    const lv = L();
    if (phaseT > lv.grace) {
      for (const p of players) {
        if (!p.visible || p.caughtThisPhase) continue;
        if (p.motion > lv.threshold) p.over += dt; else p.over = Math.max(0, p.over - dt * 0.5);
        if (p.over >= lv.sustain) {
          p.caughtThisPhase = true; p.caught++; p.caughtFx = 1.4; flashT = 0.5;
          p.progress = Math.max(0, p.progress - lv.back);
          sCaught();
          say(players.length === 1 ? '움직였다! 뒤로!' : `${p.spoken} 걸렸다!`, 1.15, false);
        }
      }
    }
    if (phaseT >= freezeD) startChant();
  }
}

/* ---------------- 그리기 ---------------- */
function rr(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function text(str, x, y, size, color, align = 'center', weight = 900, stroke = null) {
  ctx.font = `${weight} ${size}px "Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  if (stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.18; ctx.strokeStyle = stroke; ctx.strokeText(str, x, y); }
  ctx.fillStyle = color; ctx.fillText(str, x, y);
}

function flower(x, y, r, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  for (let i = 0; i < 5; i++) {
    ctx.save(); ctx.rotate(i * Math.PI * 2 / 5);
    ctx.fillStyle = '#f07aa8'; ctx.beginPath(); ctx.ellipse(0, -r * 0.55, r * 0.42, r * 0.55, 0, 0, 7); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = '#a3123f'; ctx.beginPath(); ctx.arc(0, 0, r * 0.32, 0, 7); ctx.fill();
  ctx.fillStyle = '#ffe28a'; ctx.beginPath(); ctx.arc(0, 0, r * 0.1, 0, 7); ctx.fill();
  ctx.restore();
}

// 술래: front=true면 우리를 보고 있음
function drawTagger(cx, cy, s, turn, t) {
  // turn: 0 = 뒤돌아 있음, 1 = 앞을 봄
  const front = turn > 0.5;
  const squash = Math.abs(Math.cos(turn * Math.PI)); // 도는 동안 좁아짐
  ctx.save(); ctx.translate(cx, cy); ctx.scale(Math.max(0.08, squash), 1);
  // 몸 (저고리)
  ctx.fillStyle = '#2e7a57';
  ctx.beginPath(); ctx.moveTo(-s * 0.42, s * 0.95); ctx.quadraticCurveTo(-s * 0.4, s * 0.38, 0, s * 0.36);
  ctx.quadraticCurveTo(s * 0.4, s * 0.38, s * 0.42, s * 0.95); ctx.closePath(); ctx.fill();
  if (front) {
    ctx.fillStyle = '#fbf6ea'; ctx.beginPath(); ctx.moveTo(-s * 0.1, s * 0.38); ctx.lineTo(0, s * 0.62); ctx.lineTo(s * 0.1, s * 0.38); ctx.fill();
    ctx.fillStyle = '#e5508a'; ctx.beginPath(); ctx.ellipse(s * 0.05, s * 0.62, s * 0.06, s * 0.03, 0.4, 0, 7); ctx.fill();
  }
  // 머리
  ctx.fillStyle = '#ffd9b8'; ctx.beginPath(); ctx.arc(0, 0, s * 0.36, 0, 7); ctx.fill();
  ctx.fillStyle = '#2a1d16';
  if (!front) {
    ctx.beginPath(); ctx.arc(0, -s * 0.02, s * 0.37, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -s * 0.4, s * 0.13, 0, 7); ctx.fill();          // 쪽머리
    ctx.fillStyle = '#e5508a'; ctx.fillRect(-s * 0.16, -s * 0.33, s * 0.32, s * 0.05);
  } else {
    ctx.beginPath(); ctx.arc(0, -s * 0.05, s * 0.37, Math.PI * 1.02, Math.PI * 1.98); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -s * 0.4, s * 0.13, 0, 7); ctx.fill();
    const hawk = settings.level === 'hawk', look = Math.sin(t * 2.6) * s * 0.05;
    for (const sx of [-1, 1]) {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(sx * s * 0.13, s * 0.02, s * 0.085, hawk ? s * 0.06 : s * 0.09, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#1b1b1b'; ctx.beginPath(); ctx.arc(sx * s * 0.13 + look, s * 0.03, s * 0.045, 0, 7); ctx.fill();
      ctx.strokeStyle = '#2a1d16'; ctx.lineWidth = s * 0.03; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(sx * s * 0.2, hawk ? -s * 0.11 : -s * 0.1); ctx.lineTo(sx * s * 0.06, hawk ? -s * 0.06 : -s * 0.11); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(229,80,138,.35)';
    ctx.beginPath(); ctx.arc(-s * 0.22, s * 0.14, s * 0.05, 0, 7); ctx.arc(s * 0.22, s * 0.14, s * 0.05, 0, 7); ctx.fill();
    ctx.strokeStyle = '#a3123f'; ctx.lineWidth = s * 0.025;
    ctx.beginPath(); ctx.arc(0, s * 0.17, s * 0.06, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }
  ctx.restore();
}

// 달리는 아이 캐릭터
function drawRunner(x, base, s, color, mode, t) {
  const swing = mode === 'run' ? Math.sin(t * 16) * 0.75 : 0;
  ctx.save(); ctx.translate(x, base);
  if (mode === 'caught') ctx.rotate(Math.sin(t * 30) * 0.15);
  const icy = mode === 'freeze';
  ctx.lineCap = 'round'; ctx.lineWidth = s * 0.1; ctx.strokeStyle = icy ? '#7cc8ef' : '#3a2a20';
  const leg = (a) => { ctx.beginPath(); ctx.moveTo(0, -s * 0.38); ctx.lineTo(Math.sin(a) * s * 0.28, -s * 0.38 + Math.cos(a) * s * 0.36); ctx.stroke(); };
  leg(swing); leg(-swing);
  const arm = (a) => { ctx.beginPath(); ctx.moveTo(0, -s * 0.66); ctx.lineTo(Math.sin(a) * s * 0.3, -s * 0.66 + Math.cos(a) * s * 0.28); ctx.stroke(); };
  arm(-swing * 1.2 + (icy ? 2.6 : 0)); arm(swing * 1.2 - (icy ? 2.6 : 0));
  ctx.fillStyle = color; rr(-s * 0.17, -s * 0.78, s * 0.34, s * 0.44, s * 0.12); ctx.fill();
  ctx.fillStyle = '#ffd9b8'; ctx.beginPath(); ctx.arc(0, -s * 0.92, s * 0.18, 0, 7); ctx.fill();
  ctx.fillStyle = '#2a1d16'; ctx.beginPath(); ctx.arc(0, -s * 0.96, s * 0.185, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
  ctx.fillStyle = '#1b1b1b'; ctx.beginPath(); ctx.arc(s * 0.07, -s * 0.92, s * 0.025, 0, 7); ctx.fill();
  if (icy) { ctx.strokeStyle = 'rgba(160,220,255,.9)'; ctx.lineWidth = 3; rr(-s * 0.36, -s * 1.16, s * 0.72, s * 1.18, s * 0.2); ctx.stroke(); }
  ctx.restore();
  if (mode === 'caught') for (let k = 0; k < 3; k++) {
    const a = t * 6 + k * 2.1; text('★', x + Math.cos(a) * s * 0.3, base - s * 1.2 + Math.sin(a) * s * 0.08, s * 0.2, '#ffd23f');
  }
}

function drawTrack(t) {
  const duo = players.length === 2;
  const laneH = duo ? Math.min(H * 0.12, 110) : Math.min(H * 0.17, 150);
  const gap = 10, bottom = H - 14;
  const laneL = Math.max(20, W * 0.03), laneR = W - Math.max(20, W * 0.03);
  const labelW = Math.max(54, laneH * 0.62);
  const x0 = laneL + labelW + laneH * 0.25, endX = laneR - laneH * 0.42, x1 = endX - laneH * 0.55;
  players.forEach((p, k) => {
    const y = bottom - (players.length - k) * laneH - (players.length - 1 - k) * gap;
    ctx.fillStyle = 'rgba(251,246,234,.9)'; rr(laneL, y, laneR - laneL, laneH, 18); ctx.fill();
    ctx.fillStyle = duo ? p.color : '#2e7a57'; rr(laneL + 6, y + 6, labelW, laneH - 12, 13); ctx.fill();
    text(duo ? p.label : '출발', laneL + 6 + labelW / 2, y + laneH / 2, Math.max(14, Math.min(laneH * 0.3, labelW * 0.36)), '#fff');
    ctx.strokeStyle = 'rgba(36,33,28,.15)'; ctx.setLineDash([6, 10]); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, y + laneH * 0.82); ctx.lineTo(x1, y + laneH * 0.82); ctx.stroke(); ctx.setLineDash([]);
    for (let s = 1; s < 10; s++) { const xx = x0 + (x1 - x0) * s / 10; ctx.fillStyle = 'rgba(36,33,28,.18)'; ctx.fillRect(xx - 1, y + laneH * 0.74, 2, laneH * 0.16); }
    const fill = (x1 - x0) * p.shown / GOAL;
    ctx.fillStyle = p.color + '33'; rr(x0, y + laneH * 0.78, Math.max(0, fill), laneH * 0.08, 4); ctx.fill();
    flower(endX, y + laneH * 0.48, laneH * 0.32, t * 0.3);
    const mode = p.caughtFx > 0 ? 'caught' : state === 'freeze' ? 'freeze' : (state === 'chant' && p.motion > MOVE_DEADZONE ? 'run' : 'idle');
    drawRunner(x0 + fill, y + laneH * 0.8, laneH * 0.62, p.color, mode, t + k);
  });
  return bottom - players.length * laneH - (players.length - 1) * gap;
}

function drawPlayerPanel(p, x, y, align, t) {
  const w = Math.min(260, W * 0.3);
  const left = align === 'left' ? x : x - w;
  ctx.fillStyle = 'rgba(251,246,234,.92)'; rr(left, y, w, 78, 16); ctx.fill();
  ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(left + 26, y + 26, 11, 0, 7); ctx.fill();
  text(players.length === 1 ? '나' : p.label, left + 46, y + 26, 22, '#24211c', 'left');
  const status = !camReady && !p.visible ? (players.length === 1 ? 'A키 누르기' : p.i === 0 ? 'A키 누르기' : 'L키 누르기') : !p.visible ? '안 보여요' : state === 'freeze' ? (p.caughtThisPhase ? '걸렸다!' : '꼼짝 마!') : '달려요!';
  text(status, left + w - 14, y + 26, 17, !p.visible && camReady ? '#e23b3b' : '#6b6457', 'right', 800);
  // 움직임 막대
  const bx = left + 14, by = y + 50, bw = w - 28, bh = 14, max = 0.8;
  ctx.fillStyle = '#efe6d2'; rr(bx, by, bw, bh, 7); ctx.fill();
  const v = Math.min(1, p.motion / max);
  const over = state === 'freeze' && p.motion > L().threshold;
  ctx.fillStyle = over ? '#e23b3b' : state === 'freeze' ? '#7cc8ef' : '#24a35a';
  rr(bx, by, Math.max(bh, bw * v), bh, 7); ctx.fill();
  if (state === 'freeze') {
    const tx = bx + bw * Math.min(1, L().threshold / max);
    ctx.fillStyle = '#24211c'; ctx.fillRect(tx - 1.5, by - 4, 3, bh + 8);
  }
}

function drawScene(t) {
  ctx.fillStyle = '#1f4d3a'; ctx.fillRect(0, 0, W, H);
  if (camReady && video.readyState >= 2) {
    const r = videoRect();
    ctx.save(); ctx.translate(r.x + r.w, r.y); ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, r.w, r.h); ctx.restore();
    ctx.fillStyle = 'rgba(20,46,35,.25)'; ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#2e7a57'); g.addColorStop(1, '#1f4d3a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (let k = 0; k < 7; k++) flower(W * (0.1 + k * 0.14), H * (0.25 + 0.4 * ((k * 37) % 10) / 10), U * 0.04, t * 0.2 + k);
  }
  if (state === 'menu' || state === 'result') return;

  const duo = players.length === 2;
  // 화면 테두리: 초록 = 움직여요, 빨강 = 멈춰요
  if (state === 'chant' || state === 'freeze') {
    ctx.strokeStyle = state === 'chant' ? '#24a35a' : '#e23b3b'; ctx.lineWidth = 16; ctx.strokeRect(8, 8, W - 16, H - 16);
  }
  // 2인 가운데 선
  if (duo) {
    ctx.strokeStyle = 'rgba(251,246,234,.75)'; ctx.lineWidth = 4; ctx.setLineDash([14, 12]);
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
  }
  // 걸린 사람 쪽 빨간 번쩍임
  players.forEach(p => {
    if (p.caughtFx <= 0) return;
    const a = Math.min(1, p.caughtFx) * 0.35;
    ctx.fillStyle = `rgba(226,59,59,${a})`;
    if (!duo) ctx.fillRect(0, 0, W, H); else ctx.fillRect(p.i === 0 ? 0 : W / 2, 0, W / 2, H);
    const cx = !duo ? W / 2 : (p.i === 0 ? W * 0.25 : W * 0.75);
    text('걸렸다!', cx, H * 0.42, U * 0.1, '#fff', 'center', 900, 'rgba(120,10,20,.6)');
    text(`뒤로 ${L().back}걸음`, cx, H * 0.42 + U * 0.085, U * 0.045, '#fff', 'center', 800, 'rgba(120,10,20,.6)');
  });

  // 술래
  const s = Math.min(H * 0.13, W * 0.09);
  const tagY = 14 + s * 0.55;
  const turn = state === 'freeze' ? Math.min(1, phaseT / 0.3) : (state === 'chant' ? Math.max(0, 1 - phaseT / 0.3) : 0);
  drawTagger(W / 2, tagY, s, turn, t);

  // 말풍선 (술래 몸 아래)
  const fs = Math.min(U * 0.075, W * 0.055);
  const by = tagY + s * 0.95 + fs * 0.85 + 8;
  if (state === 'chant') {
    ctx.font = `900 ${fs}px "Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif`;
    const full = SYL.join(''), tw = ctx.measureText(full).width;
    ctx.fillStyle = 'rgba(251,246,234,.95)'; rr(W / 2 - tw / 2 - 24, by - fs * 0.85, tw + 48, fs * 1.7, 20); ctx.fill();
    let x = W / 2 - tw / 2;
    syllables.forEach(sy => {
      const w = ctx.measureText(sy.s).width;
      if (sy.s !== ' ') text(sy.s, x + w / 2, by, fs, sy.shown ? '#1f4d3a' : 'rgba(31,77,58,.22)');
      x += w;
    });
  } else if (state === 'freeze') {
    const big = Math.min(U * 0.13, W * 0.1);
    text('얼음!', W / 2, by + big * 0.25, big, '#fff', 'center', 900, 'rgba(160,20,30,.75)');
  } else if (state === 'countdown') {
    const n = Math.floor(cdT / 0.9);
    const label = n < 3 ? String(3 - n) : '시작!';
    text(label, W / 2, H * 0.45, U * 0.22, '#fff', 'center', 900, 'rgba(20,46,35,.6)');
    text('술래가 돌아보면 얼음!', W / 2, H * 0.45 + U * 0.17, U * 0.05, '#fff', 'center', 800, 'rgba(20,46,35,.6)');
  } else if (state === 'paused') {
    text('잠깐 멈춤', W / 2, H * 0.45, U * 0.12, '#fff', 'center', 900, 'rgba(20,46,35,.6)');
  }

  // 왼쪽 위: 움직여요/멈춰요 표시와 판 수
  if (state === 'chant' || state === 'freeze') {
    const go = state === 'chant';
    ctx.fillStyle = go ? '#24a35a' : '#e23b3b'; rr(24, 24, 170, 54, 27); ctx.fill();
    text(go ? '움직여요!' : '멈춰요!', 109, 51, 24, '#fff');
    text(`${round}번째 판 · ${LEVEL_NAME[settings.level]}`, 28, 96, 15, '#fff', 'left', 800, 'rgba(0,0,0,.35)');
  }

  const trackTop = drawTrack(t);
  // 사람별 상태판
  const py = trackTop - 92;
  drawPlayerPanel(players[0], 24, py, 'left', t);
  if (duo) drawPlayerPanel(players[1], W - 24, py, 'right', t);

  // 안 보일 때 안내
  const lost = players.filter(p => p.unseenT > 1.5 && !manualMotion(p));
  if (lost.length && camReady && landmarker && state !== 'paused') {
    const msg = duo ? `${lost.map(p => p.label).join('·')} 친구가 안 보여요. 자기 쪽에 서 주세요` : '카메라에 몸이 다 보이게 뒤로 서 주세요';
    ctx.font = `800 ${Math.max(16, U * 0.035)}px system-ui,sans-serif`;
    const tw = ctx.measureText(msg).width;
    ctx.fillStyle = 'rgba(251,246,234,.95)'; rr(W / 2 - tw / 2 - 18, py - 64, tw + 36, 46, 14); ctx.fill();
    text(msg, W / 2, py - 41, Math.max(16, U * 0.035), '#24211c', 'center', 800);
  }
}

/* ---------------- 반복 ---------------- */
let last = performance.now();
function frame(now) {
  // 느린 기기에서도 노래·얼음 시간은 실제 시간대로 흐르게 함 (탭을 오래 비우면 0.5초까지만)
  const dt = Math.min(0.5, (now - last) / 1000); last = now;
  if (state !== 'menu' && state !== 'result') detect(now);
  update(now, dt);
  drawScene(now / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* 시험용: 놀이 상태를 읽기만 하는 창 (화면이나 영상 정보는 없음) */
Object.defineProperty(window, '__mugunghwa', { value: Object.freeze({
  snapshot: () => ({ state, round, phaseT, poses: poses.length,
    players: players.map(p => ({ label: p.label, progress: +p.progress.toFixed(1), motion: +p.motion.toFixed(3), cam: +p.camMotion.toFixed(3), visible: p.visible, caught: p.caught })) }),
}) });

/* ---------------- 홈 화면 설치 ---------------- */
let installEvt = null;
const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (!standalone) $('#btnInstall').hidden = false; });
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch (e) {}
  installEvt = null; $('#btnInstall').hidden = true;
});
addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !standalone) $('#iosHint').hidden = false;

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
