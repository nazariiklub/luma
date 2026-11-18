const $ = selector => document.querySelector(selector);
const query = new URLSearchParams(location.search);
const createRoomCode = () => Math.random().toString(36).slice(2, 8).toLowerCase();
const makeBrowserId = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

let roomId = query.get('room') || createRoomCode();
if (!query.has('room')) history.replaceState(null, '', `/?room=${roomId}`);
let userId = localStorage.getItem('luma-user-id');
if (!userId) { userId = makeBrowserId(); localStorage.setItem('luma-user-id', userId); }
let myName = localStorage.getItem('luma-name') || '';
let myId = userId;
let socket, roomPeers = new Map(), connections = new Map(), remoteStreams = new Map(), roomJoined = false;
let publishStream = null, publishMode = '', micStream = null, micOn = false, soundOn = false;
let publishOwner = '', toastTimer, heartbeatTimer, heartbeatTimeout, qualityTimer, reconnectTimer, reconnectAttempts = 0;
let rejectedFromRoom = false, intentionalLeave = false, rtcConfigurationLoaded = false, rtcConfigLoading = false;
let rtcIceServers = [{ urls:['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

const colors = [
  'linear-gradient(135deg,#7f65b2,#bf8eb5)', 'linear-gradient(135deg,#4a8290,#8dc2ad)',
  'linear-gradient(135deg,#b6746c,#d8b17b)', 'linear-gradient(135deg,#6170a4,#a895d2)'
];

$('#roomCode').textContent = `# LUMA-${roomId.slice(0, 4).toUpperCase()}`;
$('#headerRoom').textContent = 'Очікує на вхід';
$('#topAvatar').textContent = myName ? myName[0].toUpperCase() : '?';
setSoundUi();

function toast(message) {
  $('#toastText').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3000);
}
function signal(data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}
function openInvite() {
  $('#inviteLink').textContent = `${location.origin}/?room=${roomId}`;
  $('#modal').classList.add('open');
}
$('#inviteButton').onclick = openInvite;
$('#inviteNav').onclick = openInvite;
$('#modalClose').onclick = () => $('#modal').classList.remove('open');
$('#modal').onclick = event => { if (event.target === $('#modal')) $('#modal').classList.remove('open'); };
$('#copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText($('#inviteLink').textContent); toast('Посилання скопійовано'); }
  catch { toast('Скопіюй посилання з поля вище'); }
};
$('#helpButton').onclick = () => toast('До 4 людей · анонімний профіль цього браузера');
$('#watchNav').onclick = () => $('#stage').scrollIntoView({ behavior:'smooth', block:'center' });

function setMicUi() {
  $('#micState').textContent = micOn ? 'УВІМКН.' : 'ВИМКН.';
  $('#micState').classList.toggle('on', micOn);
  $('#micButton').classList.toggle('muted', !micOn);
}
function setSoundUi() {
  $('#soundState').textContent = soundOn ? 'УВІМКН.' : 'ВИМКН.';
  $('#soundState').classList.toggle('on', soundOn);
}
function showVideo(stream, { local = false } = {}) {
  const video = $('#mainVideo');
  if (video.srcObject !== stream) video.srcObject = stream;
  video.muted = local || !soundOn;
  $('#stage').classList.toggle('video-active', !!stream);
  if (stream) video.play().catch(() => {});
}
async function loadRtcConfiguration() {
  try {
    const response = await fetch('/api/ice-servers', { cache:'no-store' });
    if (!response.ok) throw new Error(`ICE config returned ${response.status}`);
    const servers = await response.json();
    if (Array.isArray(servers) && servers.some(server => server?.urls)) rtcIceServers = servers;
  } catch (error) {
    console.warn('Не вдалося завантажити ICE налаштування; буде використано STUN', error);
  }
}
function updateStage() {
  const active = !!publishOwner;
  $('#streamBadge').classList.toggle('active', active);
  $('#stageTitle').textContent = active ? 'ЗАРАЗ ДИВИТЕСЬ РАЗОМ' : 'ЗАЛ ОЧІКУВАННЯ';
  $('#stageHint').textContent = active ? 'Трансляція наживо · адаптивна якість' : 'Твоя кімната чекає на прем’єру';
}

function renderPeople() {
  const people = roomJoined ? [{ id:myId, name:myName || 'Ти', me:true }, ...roomPeers.values()] : [];
  $('#viewerCount').textContent = people.length;
  $('#capacityLabel').innerHTML = `${String(people.length).padStart(2, '0')} <i>/</i> 04 МІСЦЯ`;
  $('#startShare').disabled = !roomJoined && !publishStream;
  $('#startCamera').disabled = !roomJoined && !publishStream;
  $('#miniAvatars').innerHTML = people.map((person, index) =>
    `<span class="mini-avatar ${person.me ? 'mini-me' : ''}" style="background:${person.me ? 'linear-gradient(135deg,#8b69c9,#d67fb2)' : colors[(index - 1) % 4]}">${escapeHtml(person.name[0] || 'Г')}</span>`
  ).join('');
  const occupied = people.map((person, index) => {
    const broadcasting = publishOwner === person.id;
    const peerState = person.me ? 'self' : connections.get(person.id)?.connectionState || 'waiting';
    const connectionLabel = peerState === 'connected' ? 'З’єднання готове'
      : peerState === 'failed' ? 'Мережа блокує зв’язок'
      : peerState === 'connecting' || peerState === 'new' ? 'З’єднується…'
      : peerState === 'disconnected' ? 'Зв’язок перервано'
      : 'У кімнаті';
    return `<div class="person-card ${person.me ? 'me' : ''} ${broadcasting ? 'speaking' : ''}">
      <span class="person-avatar" style="background:${person.me ? 'linear-gradient(135deg,#8b69c9,#d67fb2)' : colors[(index - 1) % 4]}">${escapeHtml(person.name[0] || 'Г')}</span>
      <span class="person-info"><span class="person-name">${escapeHtml(person.me ? myName : person.name)}${person.me ? ' (це ти)' : ''}</span>
      <span class="person-role">${broadcasting ? 'Транслює зараз' : person.me ? 'Твій профіль' : connectionLabel}</span></span>
      <span class="person-presence ${broadcasting ? 'broadcasting' : peerState === 'failed' ? 'offline' : 'online'}"></span></div>`;
  }).join('');
  const empty = Array.from({ length:Math.max(0, 4 - people.length) }, () =>
    '<div class="person-card empty"><span class="empty-add">+</span><span class="empty-person">Вільне місце<small>Запроси друга</small></span></div>'
  ).join('');
  $('#peopleGrid').innerHTML = occupied + empty;
}

function startSession(name) {
  myName = name.trim().slice(0, 24);
  if (!myName) return;
  localStorage.setItem('luma-name', myName);
  $('#topAvatar').textContent = myName[0].toUpperCase();
  $('#welcomeModal').classList.remove('visible');
  renderPeople();
  setupSocket();
}
$('#welcomeForm').onsubmit = event => {
  event.preventDefault();
  startSession($('#welcomeName').value);
};
if (myName) setupSocket();
else {
  $('#welcomeModal').classList.add('visible');
  $('#welcomeName').focus();
}

$('#topAvatar').title = 'Змінити ім’я';
$('#topAvatar').style.cursor = 'pointer';
$('#topAvatar').onclick = () => {
  const next = prompt('Твоє ім’я у кімнаті', myName);
  if (!next?.trim()) return;
  myName = next.trim().slice(0, 24);
  localStorage.setItem('luma-name', myName);
  $('#topAvatar').textContent = myName[0].toUpperCase();
  signal({ type:'name', name:myName });
  renderPeople();
};

function setupSocket() {
  if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
  if (!rtcConfigurationLoaded) {
    if (rtcConfigLoading) return;
    rtcConfigLoading = true;
    loadRtcConfiguration().finally(() => {
      rtcConfigurationLoaded = true;
      rtcConfigLoading = false;
      setupSocket();
    });
    $('#headerRoom').textContent = 'Налаштування з’єднання…';
    return;
  }
  intentionalLeave = false;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);
  $('#headerRoom').textContent = 'Підключення…';
  socket.onopen = () => {
    reconnectAttempts = 0;
    signal({ type:'join', room:roomId, userId, name:myName });
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      signal({ type:'ping' });
      clearTimeout(heartbeatTimeout);
      heartbeatTimeout = setTimeout(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.close();
      }, 10000);
    }, 25000);
  };
  socket.onmessage = async event => {
    const message = JSON.parse(event.data);
    if (message.type === 'pong') {
      clearTimeout(heartbeatTimeout);
    } else if (message.type === 'already-here') {
      rejectedFromRoom = true;
      $('#headerRoom').textContent = 'Профіль уже в кімнаті';
      toast('Цей профіль уже відкритий у кімнаті в іншій вкладці');
      socket.close();
    } else if (message.type === 'full') {
      rejectedFromRoom = true;
      $('#headerRoom').textContent = 'Кімната заповнена';
      toast('У цій кімнаті вже 4 учасники');
      socket.close();
    } else if (message.type === 'joined') {
      myId = message.id;
      roomJoined = true;
      $('#headerRoom').textContent = `Кімната LUMA-${roomId.slice(0, 4).toUpperCase()}`;
      roomPeers.clear();
      message.peers.forEach(person => roomPeers.set(person.id, person));
      renderPeople();
      if (publishStream) signal({ type:'sharing', active:true });
    } else if (message.type === 'peer-joined') {
      roomPeers.set(message.id, { id:message.id, name:message.name });
      renderPeople();
      makeConnection(message.id, true);
      refreshSenderBudgets();
    } else if (message.type === 'peer-left') {
      roomPeers.delete(message.id);
      connections.get(message.id)?.close();
      connections.delete(message.id);
      remoteStreams.delete(message.id);
      if (publishOwner === message.id) { publishOwner = ''; showVideo(null); updateStage(); }
      refreshSenderBudgets();
      renderPeople();
    } else if (message.type === 'peer-name') {
      const person = roomPeers.get(message.id);
      if (person) { person.name = message.name; renderPeople(); }
    } else if (message.type === 'sharing') {
      if (message.active) {
        publishOwner = message.id;
        if (message.id !== myId) showVideo(remoteStreams.get(message.id) || null);
      } else if (publishOwner === message.id) {
        publishOwner = '';
        showVideo(null);
      }
      updateStage(); renderPeople();
    } else if (message.type === 'sharing-rejected') {
      toast('Хтось уже транслює. Твою трансляцію зупинено.');
      if (publishOwner === myId) stopPublishing();
    } else if (message.type === 'signal') {
      const pc = connections.get(message.from) || makeConnection(message.from, false);
      await handleSignal(pc, message.from, message.data);
    }
  };
  socket.onerror = () => {
    if (!rejectedFromRoom) {
      $('#headerRoom').textContent = 'Немає зв’язку з кімнатою';
      toast('Не вдалося з’єднатися із сервером кімнати');
    }
  };
  socket.onclose = () => {
    clearInterval(heartbeatTimer);
    clearTimeout(heartbeatTimeout);
    roomJoined = false;
    connections.forEach(pc => pc.close());
    connections.clear();
    remoteStreams.clear();
    if (publishOwner !== myId) {
      publishOwner = '';
      showVideo(null);
      updateStage();
    }
    renderPeople();
    if (!rejectedFromRoom && !intentionalLeave) {
      $('#headerRoom').textContent = 'Зв’язок перервано';
      toast('Зв’язок перервався. Підключаю кімнату знову…');
      clearTimeout(reconnectTimer);
      const delay = Math.min(1000 * (2 ** reconnectAttempts), 15000);
      reconnectAttempts++;
      reconnectTimer = setTimeout(setupSocket, delay);
    }
  };
}

function createRemoteStream(peerId) {
  let stream = remoteStreams.get(peerId);
  if (!stream) { stream = new MediaStream(); remoteStreams.set(peerId, stream); }
  return stream;
}
function makeConnection(peerId, initiator) {
  if (connections.has(peerId)) return connections.get(peerId);
  const pc = new RTCPeerConnection({ iceServers:rtcIceServers, iceCandidatePoolSize:4 });
  pc._pendingCandidates = [];
  pc._lumaSenders = {
    video: pc.addTransceiver('video', { direction:'sendrecv' }).sender,
    audio: [
      pc.addTransceiver('audio', { direction:'sendrecv' }).sender,
      pc.addTransceiver('audio', { direction:'sendrecv' }).sender
    ]
  };
  connections.set(peerId, pc);
  pc.onicecandidate = event => { if (event.candidate) signal({ type:'signal', to:peerId, data:{ candidate:event.candidate } }); };
  pc.ontrack = event => {
    const stream = createRemoteStream(peerId);
    if (!stream.getTracks().some(track => track.id === event.track.id)) stream.addTrack(event.track);
    if (event.track.kind === 'video' && publishOwner === peerId) showVideo(stream);
  };
  pc.onconnectionstatechange = () => {
    renderPeople();
    if (pc.connectionState === 'failed') toast('Мережа не пропускає WebRTC. Для цієї мережі може знадобитися TURN.');
  };
  pc._lumaReady = syncLocalTracks(pc).then(async () => {
    if (initiator) await sendOffer(pc, peerId);
  }).catch(error => console.warn('Не вдалося підготувати медіа', error));
  return pc;
}

function localTracks() {
  const video = publishStream?.getVideoTracks()[0] || null;
  const programAudio = publishStream?.getAudioTracks()[0] || null;
  const microphone = micStream?.getAudioTracks()[0] || null;
  return { video, audio:[programAudio, microphone] };
}
async function syncLocalTracks(pc) {
  const tracks = localTracks();
  const videoSender = pc._lumaSenders.video;
  if (videoSender.track !== tracks.video) await videoSender.replaceTrack(tracks.video);
  for (let index = 0; index < 2; index++) {
    const sender = pc._lumaSenders.audio[index];
    const track = tracks.audio[index];
    if (sender.track !== track) await sender.replaceTrack(track);
  }
  const senders = [videoSender, ...pc._lumaSenders.audio];
  for (const sender of senders) {
    if (sender.track?.kind === 'video') await configureVideoSender(sender);
  }
}
async function configureVideoSender(sender) {
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    const state = qualityState.get(sender) || { level:0, bad:0, good:0 };
    qualityState.set(sender, state);
    const perViewerBudget = Math.min(7_500_000, 15_000_000 / Math.max(1, connections.size));
    parameters.encodings[0].maxBitrate = Math.max(700_000, perViewerBudget * qualityLevels[state.level].rate);
    parameters.encodings[0].maxFramerate = 30;
    parameters.encodings[0].scaleResolutionDownBy = qualityLevels[state.level].scale;
    await sender.setParameters(parameters);
  } catch (error) { console.debug('Браузер сам керує параметрами відео', error); }
}
function refreshSenderBudgets() {
  for (const pc of connections.values()) {
    const sender = pc._lumaSenders?.video;
    if (sender?.track) configureVideoSender(sender);
  }
}
async function sendOffer(pc, peerId) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal({ type:'signal', to:peerId, data:{ description:pc.localDescription } });
}
async function handleSignal(pc, peerId, data) {
  try {
    await pc._lumaReady;
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      for (const candidate of pc._pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
      if (data.description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal({ type:'signal', to:peerId, data:{ description:pc.localDescription } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else pc._pendingCandidates.push(data.candidate);
    }
  } catch (error) { console.warn('Помилка узгодження WebRTC', error); }
}

const qualityLevels = [
  { scale:1, rate:1 }, { scale:1.25, rate:0.76 }, { scale:1.5, rate:0.57 },
  { scale:1.75, rate:0.4 }, { scale:2, rate:0.28 }
];
const qualityState = new WeakMap();
async function adaptConnection(pc) {
  const sender = pc._lumaSenders?.video;
  if (!sender?.track || pc.connectionState !== 'connected') return;
  try {
    const stats = await pc.getStats();
    let available = 0, loss = 0, reason = '';
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) available = report.availableOutgoingBitrate || available;
      if (report.type === 'outbound-rtp' && report.kind === 'video') reason = report.qualityLimitationReason || reason;
      if (report.type === 'remote-inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) loss = Math.max(loss, report.fractionLost || 0);
    }
    const state = qualityState.get(sender) || { level:0, bad:0, good:0 };
    const perViewerBudget = Math.min(7_500_000, 15_000_000 / Math.max(1, connections.size));
    const targetBitrate = perViewerBudget * qualityLevels[state.level].rate;
    const constrained = reason === 'bandwidth' || reason === 'cpu' || loss > 0.06 || (available > 0 && available < targetBitrate * 1.15);
    if (constrained) { state.bad++; state.good=0; }
    else { state.good++; state.bad=0; }
    if (state.bad >= 2 && state.level < qualityLevels.length - 1) { state.level++; state.bad=0; }
    else if (state.good >= 5 && available > targetBitrate * 1.7 && state.level > 0) { state.level--; state.good=0; }
    const next = qualityLevels[state.level];
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = Math.max(700_000, perViewerBudget * next.rate);
    parameters.encodings[0].maxFramerate = 30;
    parameters.encodings[0].scaleResolutionDownBy = next.scale;
    await sender.setParameters(parameters);
    qualityState.set(sender, state);
  } catch (error) { console.debug('Адаптація якості недоступна в цьому браузері', error); }
}
function startQualityMonitor() {
  clearInterval(qualityTimer);
  qualityTimer = setInterval(() => connections.forEach(pc => adaptConnection(pc)), 2500);
}

async function publish(stream, mode) {
  publishStream = stream;
  publishMode = mode;
  publishOwner = myId;
  for (const track of stream.getVideoTracks()) track.contentHint = mode === 'camera' ? 'motion' : 'detail';
  if (mode === 'camera') {
    const audio = stream.getAudioTracks()[0];
    if (audio) { audio.enabled = micOn; }
  }
  showVideo(stream, { local:true });
  updateStage(); renderPeople(); startQualityMonitor();
  signal({ type:'sharing', active:true });
  $('#startShare').querySelector('strong').textContent = 'Зупинити трансляцію';
  $('#cameraActionText').textContent = 'Зупинити трансляцію';
  $('#resolutionLabel').innerHTML = '2K <i></i> 30 FPS · АДАПТИВНО';
  for (const pc of connections.values()) {
    try { await syncLocalTracks(pc); }
    catch (error) { console.warn('Не вдалося надіслати трансляцію учаснику', error); }
  }
  for (const track of stream.getTracks()) track.addEventListener('ended', stopPublishing, { once:true });
  toast(mode === 'camera' ? 'Трансляція камери почалася' : 'Трансляція екрана почалася');
}
async function captureScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Цей браузер не вміє ділитися екраном. На телефоні натисни «Транслювати камеру».');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video:{ width:{ ideal:2560 }, height:{ ideal:1440 }, frameRate:{ ideal:30, max:30 } },
      audio:true
    });
    await publish(stream, 'screen');
  } catch (error) {
    if (error.name !== 'NotAllowedError') toast('Не вдалося почати трансляцію екрана в цьому браузері');
  }
}
async function captureCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('Цей браузер не підтримує трансляцію камери'); return; }
  try {
    const constraints = {
      video:{ facingMode:{ ideal:'environment' }, width:{ ideal:2560 }, height:{ ideal:1440 }, frameRate:{ ideal:30, max:30 } },
      audio:true
    };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch { stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', frameRate:{ ideal:30, max:30 } }, audio:true }); }
    await publish(stream, 'camera');
  } catch (error) {
    if (error.name === 'NotAllowedError') toast('Дозволь доступ до камери й мікрофона в браузері');
    else toast('Не вдалося відкрити камеру. Перевір дозвіл і спробуй знову.');
  }
}
async function stopPublishing() {
  if (!publishStream) return;
  const previous = publishStream;
  const wasCamera = publishMode === 'camera';
  publishStream = null; publishMode = '';
  signal({ type:'sharing', active:false });
  for (const pc of connections.values()) {
    try { await syncLocalTracks(pc); } catch {}
  }
  previous.getTracks().forEach(track => track.stop());
  if (wasCamera) {
    micOn = false;
    micStream?.getAudioTracks().forEach(track => { track.enabled = false; });
    setMicUi();
  }
  publishOwner = '';
  clearInterval(qualityTimer);
  showVideo(null); updateStage(); renderPeople();
  $('#startShare').querySelector('strong').textContent = 'Почати трансляцію';
  $('#cameraActionText').textContent = 'Транслювати камеру телефона';
  $('#resolutionLabel').innerHTML = '2K <i></i> 30 FPS · АДАПТИВНО';
}
$('#startShare').onclick = () => publishStream ? stopPublishing() : captureScreen();
$('#startCamera').onclick = () => publishStream ? stopPublishing() : captureCamera();

$('#micButton').onclick = async () => {
  if (publishMode === 'camera' && publishStream?.getAudioTracks().length) {
    micOn = !micOn;
    publishStream.getAudioTracks().forEach(track => { track.enabled = micOn; });
    setMicUi();
    return;
  }
  if (!micStream) {
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio:true }); }
    catch { toast('Дозволь доступ до мікрофона в браузері'); return; }
  }
  micOn = !micOn;
  micStream.getAudioTracks().forEach(track => { track.enabled = micOn; });
  if (micOn) for (const pc of connections.values()) await syncLocalTracks(pc).catch(() => {});
  setMicUi();
};
$('#soundButton').onclick = () => {
  soundOn = !soundOn;
  setSoundUi();
  const video = $('#mainVideo');
  video.muted = publishOwner === myId || !soundOn;
  if (soundOn && video.srcObject) video.play().catch(() => toast('Торкнися відео, щоб увімкнути звук'));
};
$('#mainVideo').onloadedmetadata = () => {
  if ($('#stage').classList.contains('video-active')) $('#mainVideo').play().catch(() => {});
};
$('#expandButton').onclick = () => {
  if (!document.fullscreenElement) $('#stage').requestFullscreen?.();
  else document.exitFullscreen?.();
};
$('#leaveButton').onclick = () => {
  rejectedFromRoom = true;
  intentionalLeave = true;
  clearTimeout(reconnectTimer);
  socket?.close();
  roomJoined = false;
  $('#headerRoom').textContent = 'Ти вийшов із кімнати';
  publishStream?.getTracks().forEach(track => track.stop());
  micStream?.getTracks().forEach(track => track.stop());
  connections.forEach(pc => pc.close());
  connections.clear(); roomPeers.clear();
  toast('Ти вийшов із кімнати'); renderPeople();
};

document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#modal').classList.remove('open'); });
renderPeople();
