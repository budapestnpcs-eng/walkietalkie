'use strict';
const $ = id => document.getElementById(id);
const ui = {
  loading: $('loadingView'), login: $('loginView'), room: $('roomView'), form: $('loginForm'),
  password: $('password'), loginError: $('loginError'), loginButton: $('loginButton'),
  connect: $('connectBtn'), disconnect: $('disconnectBtn'), logout: $('logoutBtn'),
  talk: $('talkButton'), talkState: $('talkState'), talkHelp: $('talkHelp'),
  status: $('statusText'), detail: $('statusDetail'), badge: $('usersBadge'),
  notice: $('notice'), remoteAudio: $('remoteAudio'), enableAudio: $('enableAudioBtn')
};
let ws = null, pc = null, localStream = null, localId = null;
let peerCount = 0, currentFloorOwner = null, wantsToTalk = false;
let iceServers = [], pendingCandidates = [], intentionalDisconnect = false;
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
  ui.talk.disabled = !ready || !!otherSpeaking;
  ui.talk.classList.toggle('talking', ready && currentFloorOwner === localId);
  if (!ready) { ui.talkState.textContent = 'CSATLAKOZÁS SZÜKSÉGES'; ui.talkHelp.textContent = 'Aktiváld a mikrofont a folytatáshoz.'; }
  else if (currentFloorOwner === localId) { ui.talkState.textContent = 'ADÁS FOLYAMATBAN'; ui.talkHelp.textContent = 'Engedd fel a gombot, ha végeztél.'; }
  else if (otherSpeaking) { ui.talkState.textContent = 'A MÁSIK FÉL BESZÉL'; ui.talkHelp.textContent = 'Hallgatás – a csatorna jelenleg foglalt.'; }
  else { ui.talkState.textContent = 'TARTSD NYOMVA A BESZÉDHEZ'; ui.talkHelp.textContent = 'Telefonon érintsd meg, számítógépen nyomd meg.'; }
  ui.badge.textContent = `${peerCount} / 2`;
}
function stopSending() { if (localStream) for (const track of localStream.getAudioTracks()) track.enabled = false; }
function startTalk() {
  if (!isConnected() || ui.talk.disabled || wantsToTalk) return;
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
  stopTalk();
  if (ws) { const old = ws; ws = null; old.onclose = null; old.close(); }
  closePc();
  if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
  localId = null; peerCount = 0; currentFloorOwner = null;
  ui.enableAudio.classList.add('hidden');
  updateUI();
}
async function makePeerConnection() {
  closePc();
  pc = new RTCPeerConnection({ iceServers });
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
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
      setStatus('Várakozás a másik félre', 'A másik résztvevő kilépett');
      message('A másik fél kilépett. A kapcsolat automatikusan felépül, amikor visszatér.');
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
        if (wantsToTalk) { for (const track of localStream.getAudioTracks()) track.enabled = true; }
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
    if (roomInfo.count >= roomInfo.capacity) throw new Error('A szoba valóban tele van (2 / 2). Ha te vagy bent egy másik lapon, ott bontsd a kapcsolatot.');
    const configResp = await fetch('/api/config');
    if (!configResp.ok) throw new Error('Lejárt a bejelentkezés. Lépj be újra.');
    iceServers = (await configResp.json()).iceServers;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    stopSending();
    intentionalDisconnect = false;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/signal`);
    ws = socket;
    socket.onopen = () => { setStatus('Csatlakozva', 'Hangcsatorna elérhető'); updateUI(); };
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
        message(detail);
      }
    };
    socket.onerror = () => { setStatus('Kapcsolódási hiba', 'Nem sikerült elérni a szervert'); };
    message('Várakozás a másik félre…');
  } catch (err) {
    console.error(err); cleanup(); setStatus('Nem sikerült csatlakozni', 'Ellenőrizd a mikrofon engedélyét'); message(err.message || 'Váratlan hiba');
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
ui.connect.addEventListener('click', connect);
ui.disconnect.addEventListener('click', () => { intentionalDisconnect = true; cleanup(); setStatus('Kapcsolat bontva', 'Bármikor újra csatlakozhatsz'); });
ui.logout.addEventListener('click', async () => {
  intentionalDisconnect = true; cleanup();
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  show('login');
});
ui.talk.addEventListener('pointerdown', e => { e.preventDefault(); ui.talk.setPointerCapture(e.pointerId); startTalk(); });
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) ui.talk.addEventListener(event, stopTalk);
ui.talk.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target === document.body && !e.repeat && !e.altKey && !e.ctrlKey) { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space' && wantsToTalk) { e.preventDefault(); stopTalk(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTalk(); });
window.addEventListener('blur', stopTalk);
ui.enableAudio.addEventListener('click', async () => {
  try { await ui.remoteAudio.play(); ui.enableAudio.classList.add('hidden'); }
  catch { message('A böngésző blokkolta a hangot. Ellenőrizd az eszköz médiabeállításait.'); }
});
fetch('/api/me').then(r => r.json()).then(data => {
  show(data.authenticated ? 'room' : 'login');
  if (data.authenticated) { setStatus('Még nem csatlakoztál', 'Aktiváld a mikrofont'); updateUI(); }
}).catch(() => { show('login'); ui.loginError.textContent = 'A szerver nem érhető el.'; });
