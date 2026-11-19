'use strict';
const $ = id => document.getElementById(id);
const ui = {
  loading: $('loadingView'), login: $('loginView'), room: $('roomView'), form: $('loginForm'),
  password: $('password'), loginError: $('loginError'), loginButton: $('loginButton'),
  connect: $('connectBtn'), disconnect: $('disconnectBtn'), logout: $('logoutBtn'),
  talk: $('talkButton'), talkState: $('talkState'), talkHelp: $('talkHelp'),
  status: $('statusText'), detail: $('statusDetail'), badge: $('usersBadge'),
  notice: $('notice'), remoteAudio: $('remoteAudio'), enableAudio: $('enableAudioBtn'),
  manualMode: $('manualMode'), voiceMode: $('voiceMode'), voxSettings: $('voxSettings'),
  voxSensitivity: $('voxSensitivity'), voxLevel: $('voxLevel')
};
let ws = null, pc = null, localStream = null, localId = null;
let peerCount = 0, currentFloorOwner = null, wantsToTalk = false;
let iceServers = [], pendingCandidates = [], intentionalDisconnect = false;
let outputStream = null, audioContext = null, analyser = null, analyserSamples = null;
let voiceMode = false, voxFrame = null, voxLastSound = 0, voxLastRequest = 0, reconnectTimer = null, reconnectAttempts = 0;
const VOX_HOLD_MS = 750;
function show(which) { for (const key of ['loading','login','room']) ui[key].classList.toggle('hidden', key !== which); }
function setStatus(status, detail) { ui.status.textContent = status; ui.detail.textContent = detail; }
function message(msg) { ui.notice.textContent = msg; }
function isConnected() { return ws?.readyState === WebSocket.OPEN && !!localStream; }
function send(type, extra = {}) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...extra })); }
function updateUI() {
  const ready = isConnected();
  ui.connect.classList.toggle('hidden', ready);
  ui.disconnect.classList.toggle('hidden', !ready);
  const otherSpeaking = currentFloorOwner && currentFloorOwner !== localId;
  ui.talk.disabled = !ready || !!otherSpeaking || voiceMode;
  ui.talk.classList.toggle('talking', ready && currentFloorOwner === localId);
  if (!ready) { ui.talkState.textContent = 'CSATLAKOZÁS SZÜKSÉGES'; ui.talkHelp.textContent = 'Aktiváld a mikrofont a folytatáshoz.'; }
  else if (currentFloorOwner === localId) { ui.talkState.textContent = 'ADÁS FOLYAMATBAN'; ui.talkHelp.textContent = 'Engedd fel a gombot, ha végeztél.'; }
  else if (otherSpeaking) { ui.talkState.textContent = 'A MÁSIK FÉL BESZÉL'; ui.talkHelp.textContent = 'Hallgatás – a csatorna jelenleg foglalt.'; }
  else if (voiceMode) { ui.talkState.textContent = 'AUTOMATIKUS HANGÉRZÉKELÉS'; ui.talkHelp.textContent = 'Beszélj: a mikrofon automatikusan adásba kapcsol.'; }
  else { ui.talkState.textContent = 'TARTSD NYOMVA A BESZÉDHEZ'; ui.talkHelp.textContent = 'Telefonon érintsd meg, számítógépen nyomd meg.'; }
  ui.badge.textContent = `${peerCount} / 2`;
}
function stopSending() { if (outputStream) for (const track of outputStream.getAudioTracks()) track.enabled = false; }
function startVoxMonitor() {
  if (!localStream || audioContext) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { message('Ez a böngésző nem támogatja a hangérzékelést. Használd a kézi módot.'); return; }
  audioContext = new Ctx();
  const source = audioContext.createMediaStreamSource(localStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyserSamples = new Float32Array(analyser.fftSize);
  source.connect(analyser);
  const tick = () => {
    voxFrame = requestAnimationFrame(tick);
    if (!analyser) return;
    analyser.getFloatTimeDomainData(analyserSamples);
    let sum = 0;
    for (const v of analyserSamples) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / analyserSamples.length) + 1e-8);
    ui.voxLevel.textContent = db > -75 ? Math.round(db) + ' dB' : 'Csend';
    if (!voiceMode || !isConnected() || document.hidden) return;
    const now = performance.now();
    const threshold = Number(ui.voxSensitivity.value);
    if (db > threshold) {
      voxLastSound = now;
      if (!wantsToTalk && currentFloorOwner !== localId && now - voxLastRequest > 1000) {
        voxLastRequest = now;
        startTalk(true);
      }
    } else if (wantsToTalk && now - voxLastSound > VOX_HOLD_MS) stopTalk();
  };
  tick();
}
function stopVoxMonitor() {
  if (voxFrame !== null) cancelAnimationFrame(voxFrame);
  voxFrame = null; analyser = null; analyserSamples = null;
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  ui.voxLevel.textContent = 'Mikrofon kikapcsolva';
}
function setMode(vox) {
  stopTalk();
  voiceMode = vox;
  voxLastSound = performance.now();
  ui.manualMode.classList.toggle('selected', !vox);
  ui.voiceMode.classList.toggle('selected', vox);
  ui.manualMode.setAttribute('aria-pressed', String(!vox));
  ui.voiceMode.setAttribute('aria-pressed', String(vox));
  ui.voxSettings.classList.toggle('hidden', !vox);
  updateUI();
}
function startTalk(automatic = false) {
  if (!isConnected() || (ui.talk.disabled && !automatic) || wantsToTalk || (currentFloorOwner && currentFloorOwner !== localId)) return;
  wantsToTalk = true;
  send('floor-request');
}
function stopTalk() {
  wantsToTalk = false;
  stopSending();
  if (currentFloorOwner === localId) {
    currentFloorOwner = null;
    send('floor-release');
  }
  updateUI();
}
function closePc() {
  if (pc) { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); pc = null; }
  ui.remoteAudio.srcObject = null;
  pendingCandidates = [];
}
function cleanup() {
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopTalk();
  stopVoxMonitor();
  if (ws) { const old = ws; ws = null; old.onclose = null; old.close(); }
  closePc();
  if (outputStream) { outputStream.getTracks().forEach(track => track.stop()); outputStream = null; }
  if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
  localId = null; peerCount = 0; currentFloorOwner = null;
  ui.enableAudio.classList.add('hidden');
  updateUI();
}
async function makePeerConnection() {
  closePc();
  pc = new RTCPeerConnection({ iceServers });
  for (const track of outputStream.getTracks()) pc.addTrack(track, outputStream);
  pc.onicecandidate = e => { if (e.candidate) send('ice', { candidate: e.candidate.toJSON() }); };
  pc.ontrack = e => {
    ui.remoteAudio.srcObject = e.streams[0] || new MediaStream([e.track]);
    ui.remoteAudio.play().then(() => ui.enableAudio.classList.add('hidden')).catch(() => ui.enableAudio.classList.remove('hidden'));
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') { setStatus('Hangkapcsolat aktív', 'A másik résztvevő csatlakozott'); message('A hang titkosított WebRTC-kapcsolaton továbbítódik.'); }
    else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') { setStatus('Hangkapcsolat megszakadt', 'Ellenőrizd a hálózatot és próbálj újracsatlakozni'); message('Korlátozó hálózat esetén TURN-szerver szükséges lehet.'); }
  };
}
async function flushIce() {
  if (!pc?.remoteDescription) return;
  for (const ice of pendingCandidates.splice(0)) {
    try { await pc.addIceCandidate(ice); } catch (err) { console.warn('ICE candidate rejected', err); }
  }
}
async function onSignal(data) {
  switch (data.type) {
    case 'welcome':
      localId = data.id; peerCount = data.count; currentFloorOwner = data.floorOwner;
      setStatus(peerCount === 2 ? 'Kapcsolódás a másik félhez…' : 'Várakozás a másik félre', peerCount === 2 ? 'Biztonságos hangcsatorna létrehozása' : 'A másik fél még nincs a szobában');
      updateUI();
      if (data.shouldOffer) {
        await makePeerConnection();
        await pc.setLocalDescription(await pc.createOffer());
        send('offer', { sdp: pc.localDescription });
      }
      break;
    case 'presence':
      peerCount = data.count; updateUI(); break;
    case 'peer-joined':
      peerCount = 2; setStatus('Kapcsolódás…', 'Hangkapcsolat felépítése'); updateUI(); break;
    case 'peer-left':
      stopTalk(); currentFloorOwner = null; peerCount = 1; closePc();
      setStatus('Várakozás a másik félre', 'A másik fél kapcsolata megszakadt vagy újracsatlakozik');
      message('A másik fél pillanatnyilag nem elérhető. Amint visszakapcsolódik, a hangkapcsolat felépül.');
      updateUI(); break;
    case 'offer': {
      const earlyCandidates = pendingCandidates.splice(0);
      await makePeerConnection();
      pendingCandidates.push(...earlyCandidates);
      await pc.setRemoteDescription(data.sdp);
      await flushIce();
      await pc.setLocalDescription(await pc.createAnswer());
      send('answer', { sdp: pc.localDescription }); break; }
    case 'answer':
      if (pc) { await pc.setRemoteDescription(data.sdp); await flushIce(); }
      break;
    case 'ice':
      if (pc?.remoteDescription) await pc.addIceCandidate(data.candidate);
      else pendingCandidates.push(data.candidate);
      break;
    case 'floor':
      currentFloorOwner = data.owner;
      if (currentFloorOwner === localId) {
        if (wantsToTalk && outputStream) { for (const track of outputStream.getAudioTracks()) track.enabled = true; }
        else { stopSending(); send('floor-release'); currentFloorOwner = null; }
      } else stopSending();
      updateUI(); break;
    case 'floor-denied':
      wantsToTalk = false; stopSending(); updateUI(); break;
  }
}
async function connect() {
  ui.connect.disabled = true;
  setStatus('Mikrofon engedélyezése…', 'Engedélyezd a mikrofon használatát');
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('A mikrofonhoz HTTPS vagy localhost szükséges.');
    const roomResp = await fetch('/api/room', { cache: 'no-store' });
    if (!roomResp.ok) throw new Error('Nem sikerült ellenőrizni a szoba állapotát. Jelentkezz be újra.');
    const roomInfo = await roomResp.json();
    // Don't refuse here: a stale socket from this session may be occupying a slot.
    // The server replaces it after successful authenticated WebSocket upgrade.
    const configResp = await fetch('/api/config');
    if (!configResp.ok) throw new Error('Lejárt a bejelentkezés. Lépj be újra.');
    iceServers = (await configResp.json()).iceServers;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    outputStream = new MediaStream(localStream.getAudioTracks().map(track => track.clone()));
    stopSending();
    startVoxMonitor();
    intentionalDisconnect = false;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/signal`);
    ws = socket;
    socket.onopen = () => { reconnectAttempts = 0; setStatus('Csatlakozva', 'Hangcsatorna elérhető'); updateUI(); };
    socket.onmessage = event => {
      try { onSignal(JSON.parse(event.data)).catch(err => { console.error(err); message('Hiba a hangkapcsolat felépítése közben. Csatlakozz újra.'); }); }
      catch (err) { console.error(err); }
    };
    socket.onclose = async event => {
      if (ws !== socket) return;
      cleanup();
      if (!intentionalDisconnect) {
        let detail = 'A WebSocket-kapcsolat megszakadt.';
        try {
          const response = await fetch('/api/room', { cache: 'no-store' });
          if (response.status === 401) detail = 'Lejárt a bejelentkezés. Jelentkezz be újra.';
          else if (response.ok) {
            const room = await response.json();
            detail = room.count >= 2
              ? 'A szoba tényleg tele van (2 / 2).'
              : 'A szoba nem tele (' + room.count + ' / 2). A WebSocket-kapcsolat hibásodott meg. Ellenőrizd a Render Logs naplót.';
          }
        } catch { detail = 'A szerver nem érhető el. Ellenőrizd a Render állapotát.'; }
        setStatus('Nincs kapcsolat', 'WebSocket hiba (kód: ' + event.code + ')');
        const delay = Math.min(15000, 1500 * Math.pow(1.5, Math.min(reconnectAttempts++, 6)));
        message(detail + ' Automatikus újracsatlakozás következik.');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!intentionalDisconnect) connect();
        }, delay);
      }
    };
    socket.onerror = () => { setStatus('Kapcsolódási hiba', 'Nem sikerült elérni a szervert'); };
    message('Várakozás a másik félre…');
  } catch (err) {
    console.error(err); cleanup(); setStatus('Nem sikerült csatlakozni', 'Ellenőrizd a mikrofon engedélyét'); message(err.message || 'Váratlan hiba');
    if (!intentionalDisconnect && String(err.message).includes('Lejárt') === false && String(err.message).includes('engedély') === false) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!intentionalDisconnect) connect(); }, 5000);
    }
  } finally { ui.connect.disabled = false; updateUI(); }
}
ui.form.addEventListener('submit', async e => {
  e.preventDefault(); ui.loginError.textContent = ''; ui.loginButton.disabled = true;
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ui.password.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sikertelen belépés');
    ui.password.value = ''; show('room');
    setStatus('Még nem csatlakoztál', 'Aktiváld a mikrofont'); updateUI();
  } catch (err) { ui.loginError.textContent = err.message; }
  finally { ui.loginButton.disabled = false; }
});
ui.connect.addEventListener('click', () => { reconnectAttempts = 0; connect(); });
ui.manualMode.addEventListener('click', () => setMode(false));
ui.voiceMode.addEventListener('click', () => setMode(true));
ui.disconnect.addEventListener('click', () => { intentionalDisconnect = true; cleanup(); setStatus('Kapcsolat bontva', 'Bármikor újra csatlakozhatsz'); });
ui.logout.addEventListener('click', async () => {
  intentionalDisconnect = true; cleanup();
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  show('login');
});
ui.talk.addEventListener('pointerdown', e => { e.preventDefault(); if (!voiceMode) { ui.talk.setPointerCapture(e.pointerId); startTalk(); } });
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) ui.talk.addEventListener(event, stopTalk);
ui.talk.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (!voiceMode && e.code === 'Space' && e.target === document.body && !e.repeat && !e.altKey && !e.ctrlKey) { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space' && wantsToTalk) { e.preventDefault(); stopTalk(); } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTalk();
  else if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
});
window.addEventListener('blur', stopTalk);
ui.enableAudio.addEventListener('click', async () => {
  try { await ui.remoteAudio.play(); ui.enableAudio.classList.add('hidden'); }
  catch { message('A böngésző blokkolta a hangot. Ellenőrizd az eszköz médiabeállításait.'); }
});
fetch('/api/me').then(r => r.json()).then(data => {
  show(data.authenticated ? 'room' : 'login');
  if (data.authenticated) { setStatus('Még nem csatlakoztál', 'Aktiváld a mikrofont'); updateUI(); }
}).catch(() => { show('login'); ui.loginError.textContent = 'A szerver nem érhető el.'; });
