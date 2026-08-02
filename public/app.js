/* ═══════════════════════════════════════════════════════════════════════════
   OnlineAV — Frontend Application
   ═══════════════════════════════════════════════════════════════════════════ */

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Views
const viewHome = $('#view-home');
const viewHost = $('#view-host');
const viewViewer = $('#view-viewer');

// Home elements
const dropzone = $('#dropzone');
const fileInput = $('#file-input');
const uploadProgress = $('#upload-progress');
const progressFill = $('#progress-fill');
const progressText = $('#progress-text');
const btnCreate = $('#btn-create');
const joinCode = $('#join-code');
const joinName = $('#join-name');
const btnJoin = $('#btn-join');
const joinError = $('#join-error');

// Host elements
const hostPlayer = $('#player');
const hostBiliContainer = $('#host-bili-container');
const hostDropzone = $('#host-dropzone');
const hostFileInput = $('#host-file-input');
const hostUploadProgress = $('#host-upload-progress');
const hostProgressFill = $('#host-progress-fill');
const hostProgressText = $('#host-progress-text');
const hostOverlay = $('#host-overlay');
const hostRoomCode = $('#host-room-code');
const hostViewerCount = $('#host-viewer-count');
const hostStatus = $('#host-status');
const btnCopy = $('#btn-copy');
const btnLeaveHost = $('#btn-leave-host');
const btnDeleteRoom = $('#btn-delete-room');

// Viewer elements
const viewerPlayer = $('#viewer-player');
const viewerBiliContainer = $('#viewer-bili-container');
const viewerOverlay = $('#viewer-overlay');
const overlayMessage = $('#overlay-message');
const viewerRoomCode = $('#viewer-room-code');
const viewerViewerCount = $('#viewer-viewer-count');
const viewerStatus = $('#viewer-status');
const btnLeaveViewer = $('#btn-leave-viewer');

// Toast
const toast = $('#toast');

// Bilibili elements
const biliBvid = $('#bili-bvid');
const btnBiliSet = $('#btn-bili-set');
const biliHint = $('#bili-hint');

// ── State ───────────────────────────────────────────────────────────────────
let socket = null;
let currentView = 'home';
let currentRole = null;      // 'host' | 'viewer'
let currentRoom = null;
let uploadedVideo = null;    // { videoId, name, size, filename } or { type:'bilibili', bvid, name }
let syncing = false;         // Guard: suppress native events during remote apply
let hasVideo = false;
let pendingSync = null;      // Pending sync state for buffering viewers
let syncTimer = null;        // For periodic correction ticks
let toastTimer = null;
let hostBiliPlayer = null;   // Host bilibili player controller
let viewerBiliPlayer = null; // Viewer bilibili player controller
let videoType = null;        // 'upload' | 'bilibili'

// ── Bilibili Player ──────────────────────────────────────────────────────────
/**
 * Create a Bilibili iframe player.
 * @param {string} bvid — BV number
 * @param {HTMLElement} container — container element to place iframe into
 * @param {number} [startSec] — initial start time in seconds
 * @returns {{play, pause, seek, setTime, destroy, iframe}}
 */
function createBiliPlayer(bvid, container, startSec) {
  const tParam = startSec ? `&t=${Math.round(startSec)}` : '';
  const iframe = document.createElement('iframe');
  iframe.src = `https://player.bilibili.com/player.html?bvid=${bvid}&page=1&autoplay=0&danmaku=0${tParam}`;
  iframe.setAttribute('allow', 'autoplay; fullscreen');
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('scrolling', 'no');
  iframe.style.cssText = 'width:100%;height:100%;border:none;position:absolute;inset:0;';

  // Clear container and add iframe
  container.innerHTML = '';
  container.appendChild(iframe);

  let lastProgress = startSec || 0;

  // Internal message handler to track progress
  const msgHandler = (e) => {
    if (!e.origin.includes('bilibili')) return;
    let data = e.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { return; }
    }
    if (!data || typeof data !== 'object') return;
    const inner = data.data || data.info || data;
    if (inner && typeof inner.progress === 'number') {
      lastProgress = inner.progress;
    }
  };

  window.addEventListener('message', msgHandler);

  /** Send a command to the iframe via postMessage */
  function sendCommand(data) {
    try {
      iframe.contentWindow.postMessage(
        typeof data === 'string' ? data : JSON.stringify(data),
        'https://player.bilibili.com'
      );
    } catch (_) { /* ignore */ }
  }

  return {
    iframe,
    _lastSeek: startSec || 0,  // Track last seek position for sync

    play() {
      sendCommand({ cmd: 'play' });
    },

    pause() {
      sendCommand({ cmd: 'pause' });
    },

    seek(sec) {
      sendCommand({ cmd: 'seek', data: { time: sec } });
      sendCommand({ cmd: 'seek', param: sec });
      lastProgress = sec;
    },

    /** Reload iframe at specific time (fallback for large seeks) */
    setTime(sec) {
      iframe.src = `https://player.bilibili.com/player.html?bvid=${bvid}&page=1&autoplay=0&danmaku=0&t=${Math.round(sec)}`;
      lastProgress = sec;
    },

    destroy() {
      window.removeEventListener('message', msgHandler);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
  };
}

// ── View Router ─────────────────────────────────────────────────────────────
function showView(name) {
  currentView = name;
  viewHome.classList.toggle('active', name === 'home');
  viewHost.classList.toggle('active', name === 'host');
  viewViewer.classList.toggle('active', name === 'viewer');
}

// ── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ── Socket.IO ───────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io({ autoConnect: true, reconnection: true, reconnectionDelay: 1000 });

  socket.on('connect', () => {
    console.log('[socket] connected:', socket.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] disconnected:', reason);
  });

  // ── Host events ──────────────────────────────────────────────────────────
  socket.on('play', (data) => applyRemote('play', data.positionMs / 1000));
  socket.on('pause', (data) => applyRemote('pause', data.positionMs / 1000));
  socket.on('seek', (data) => applyRemote('seek', data.positionMs / 1000));
  socket.on('sync', (data) => applySync(data));

  // ── Video ready (viewer) ─────────────────────────────────────────────────
  socket.on('video:ready', (video) => {
    console.log('[socket] video:ready', video);
    uploadedVideo = video;
    videoType = video.type || 'upload';
    if (currentRole === 'viewer') {
      if (videoType === 'bilibili') {
        loadViewerBili(video);
      } else {
        loadViewerVideo();
      }
    }
  });

  // ── Host left ────────────────────────────────────────────────────────────
  socket.on('host:left', (data) => {
    if (data && data.reason === 'room_deleted') {
      showToast('房间已被主持人删除');
      overlayMessage.textContent = '房间已被删除';
    } else {
      showToast('主持人已离开房间');
      overlayMessage.textContent = '主持人已离开，等待重新连接...';
    }
    viewerOverlay.classList.remove('hidden');
    viewerStatus.classList.remove('synced', 'playing');
    if (viewerBiliPlayer) {
      viewerBiliPlayer.pause();
    } else {
      viewerPlayer.pause();
    }
  });

  // ── Viewer count ─────────────────────────────────────────────────────────
  socket.on('viewer:joined', (data) => updateViewerCount(data.count));
  socket.on('viewer:left', (data) => updateViewerCount(data.count));
}

function updateViewerCount(count) {
  if (currentRole === 'host') {
    hostViewerCount.textContent = `${count} 人在线`;
  } else {
    viewerViewerCount.textContent = `${count} 人在线`;
  }
}

// ── Remote Control ──────────────────────────────────────────────────────────
/** Apply a play/pause/seek command from the host (viewer side) */
function applyRemote(action, positionSec) {
  // Handle bilibili viewer
  if (videoType === 'bilibili' && viewerBiliPlayer) {
    applyRemoteBili(action, positionSec);
    return;
  }

  const player = viewerPlayer;
  if (!hasVideo || !player) return;

  syncing = true;

  const currentTime = player.currentTime;
  const diff = Math.abs(currentTime - positionSec);

  // Seek if drift exceeds threshold
  if (diff > 0.8 && action !== 'seek') {
    player.currentTime = positionSec;
  } else if (action === 'seek') {
    player.currentTime = positionSec;
  }

  // Execute the action
  if (action === 'play') {
    player.play().catch(() => {});
    viewerStatus.textContent = '▶ 播放中';
    viewerStatus.className = 'status-badge playing';
  } else {
    player.pause();
    viewerStatus.textContent = '⏸ 已同步';
    viewerStatus.className = 'status-badge synced';
  }

  // Release guard after a short delay
  setTimeout(() => { syncing = false; }, 100);
}

/** Apply remote command to Bilibili iframe viewer */
function applyRemoteBili(action, positionSec) {
  if (!viewerBiliPlayer) return;
  syncing = true;

  if (action === 'seek') {
    // For large seeks, reload iframe; for small, postMessage
    viewerBiliPlayer.setTime(positionSec);
  } else if (action === 'play') {
    viewerBiliPlayer.play();
    viewerStatus.textContent = '▶ 播放中';
    viewerStatus.className = 'status-badge playing';
  } else {
    viewerBiliPlayer.pause();
    viewerStatus.textContent = '⏸ 已同步';
    viewerStatus.className = 'status-badge synced';
  }

  setTimeout(() => { syncing = false; }, 300);
}

/** Apply periodic sync correction from server virtual clock */
function applySync(data) {
  // Handle bilibili viewer
  if (videoType === 'bilibili' && viewerBiliPlayer) {
    applySyncBili(data);
    return;
  }

  const player = viewerPlayer;
  if (!hasVideo || !player || syncing) return;

  const positionSec = data.positionMs / 1000;
  const diff = Math.abs(player.currentTime - positionSec);

  if (diff > 0.8) {
    syncing = true;
    player.currentTime = positionSec;
    if (data.playing && player.paused) {
      player.play().catch(() => {});
      viewerStatus.textContent = '▶ 播放中';
      viewerStatus.className = 'status-badge playing';
    } else if (!data.playing && !player.paused) {
      player.pause();
      viewerStatus.textContent = '⏸ 已同步';
      viewerStatus.className = 'status-badge synced';
    }
    setTimeout(() => { syncing = false; }, 100);
  }
}

/** Apply sync to Bilibili iframe viewer */
function applySyncBili(data) {
  if (!viewerBiliPlayer || syncing) return;
  const positionSec = data.positionMs / 1000;

  // Only correct large drift (>3s) for bilibili to avoid excessive reloads
  if (Math.abs(positionSec - (viewerBiliPlayer._lastSeek || 0)) > 3) {
    syncing = true;
    viewerBiliPlayer.setTime(positionSec);
    viewerBiliPlayer._lastSeek = positionSec;

    if (data.playing) {
      viewerStatus.textContent = '▶ 播放中';
      viewerStatus.className = 'status-badge playing';
    } else {
      viewerStatus.textContent = '⏸ 已同步';
      viewerStatus.className = 'status-badge synced';
    }
    setTimeout(() => { syncing = false; }, 500);
  }
}

// ── Video Upload ────────────────────────────────────────────────────────────
function uploadVideo(file, progressFillEl, progressTextEl, progressEl, onSuccess) {
  progressEl.classList.remove('hidden');
  progressFillEl.style.width = '0%';
  progressTextEl.textContent = '准备上传...';

  const formData = new FormData();
  formData.append('video', file);

  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFillEl.style.width = pct + '%';
      const loadedMB = (e.loaded / 1024 / 1024).toFixed(0);
      const totalMB = (e.total / 1024 / 1024).toFixed(0);
      progressTextEl.textContent = `上传中 ${pct}% (${loadedMB}MB / ${totalMB}MB)`;
    }
  });

  xhr.addEventListener('load', () => {
    if (xhr.status === 200) {
      const video = JSON.parse(xhr.responseText);
      progressTextEl.textContent = '✅ 上传完成';
      onSuccess(video);
    } else {
      progressTextEl.textContent = '❌ 上传失败';
      showToast('上传失败，请重试');
    }
  });

  xhr.addEventListener('error', () => {
    progressTextEl.textContent = '❌ 上传失败（网络错误）';
    showToast('上传失败，请检查网络');
  });

  xhr.open('POST', '/api/upload');
  xhr.send(formData);
}

// ── Dropzone Setup ──────────────────────────────────────────────────────────
function setupDropzone(dropzoneEl, fileInputEl, progressEl, progressFillEl, progressTextEl, onSuccess) {
  // Click to browse
  dropzoneEl.addEventListener('click', () => fileInputEl.click());
  fileInputEl.addEventListener('change', () => {
    if (fileInputEl.files[0]) {
      uploadVideo(fileInputEl.files[0], progressFillEl, progressTextEl, progressEl, onSuccess);
    }
  });

  // Drag and drop
  dropzoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzoneEl.classList.add('dragover');
  });

  dropzoneEl.addEventListener('dragleave', () => {
    dropzoneEl.classList.remove('dragover');
  });

  dropzoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
      uploadVideo(file, progressFillEl, progressTextEl, progressEl, onSuccess);
    } else {
      showToast('请选择视频文件');
    }
  });
}

// ── Create Room Flow (Home) ─────────────────────────────────────────────────
function onUploadSuccessHome(video) {
  uploadedVideo = video;
  videoType = 'upload';
  btnCreate.disabled = false;
  btnCreate.textContent = '✨ 创建房间';
  // Clear bilibili selection
  biliHint.textContent = '';
  biliBvid.value = '';
  dropzone.classList.remove('hidden');
}

setupDropzone(dropzone, fileInput, uploadProgress, progressFill, progressText, onUploadSuccessHome);

// ── Bilibili BV Input ────────────────────────────────────────────────────────
btnBiliSet.addEventListener('click', () => {
  const bvid = biliBvid.value.trim();
  if (!bvid) {
    showToast('请输入BV号');
    return;
  }
  if (!/^BV[a-zA-Z0-9]+$/i.test(bvid)) {
    showToast('BV号格式不正确，应以 BV 开头');
    return;
  }
  // Only uppercase the "BV" prefix, preserve original case for the rest
  const normalizedBvid = 'BV' + bvid.slice(2);
  uploadedVideo = {
    type: 'bilibili',
    bvid: normalizedBvid,
    name: 'B站视频: ' + normalizedBvid
  };
  videoType = 'bilibili';
  biliHint.textContent = '✅ 已设置: ' + normalizedBvid;
  biliHint.style.color = 'var(--success)';
  btnCreate.disabled = false;
  btnCreate.textContent = '✨ 创建房间';
  // Clear upload state
  uploadProgress.classList.add('hidden');
  dropzone.classList.add('hidden');
});

biliBvid.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnBiliSet.click();
});

btnCreate.addEventListener('click', () => {
  if (!uploadedVideo) {
    showToast('请先上传视频');
    return;
  }
  createRoom();
});

async function createRoom() {
  try {
    const resp = await fetch('/api/rooms', { method: 'POST' });
    const { code } = await resp.json();

    // Connect socket and join as host
    if (!socket) connectSocket();

    currentRoom = code;
    currentRole = 'host';
    hostRoomCode.textContent = code;

    // Determine video type if not explicitly set
    if (!videoType && uploadedVideo) {
      videoType = uploadedVideo.type || 'upload';
    }

    socket.emit('room:join', { code, role: 'host' }, (ack) => {
      if (!ack.ok) {
        showToast('创建房间失败: ' + ack.error);
        return;
      }
      // Set video
      socket.emit('video:set', uploadedVideo);
      // Switch to host view
      enterHostView();
      // Load the video into host player
      if (videoType === 'bilibili') {
        loadHostBili(uploadedVideo);
      } else {
        loadHostVideo(uploadedVideo);
      }
    });
  } catch (err) {
    showToast('创建房间失败: ' + err.message);
  }
}

// ── Join Room Flow (Home) ───────────────────────────────────────────────────
btnJoin.addEventListener('click', joinRoom);
joinCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

function joinRoom() {
  const code = joinCode.value.trim().toUpperCase();
  if (!code || code.length !== ROOM_CODE_LENGTH) {
    joinError.textContent = '请输入6位房间码';
    joinError.classList.remove('hidden');
    return;
  }

  const name = joinName.value.trim() || undefined;

  if (!socket) connectSocket();

  currentRoom = code;
  currentRole = 'viewer';

  socket.emit('room:join', { code, role: 'viewer', name }, (ack) => {
    if (!ack.ok) {
      joinError.textContent = ack.error;
      joinError.classList.remove('hidden');
      currentRoom = null;
      currentRole = null;
      return;
    }

    joinError.classList.add('hidden');

    // Store pending sync (might arrive before video is loaded)
    pendingSync = {
      playing: ack.state.playing,
      positionMs: ack.state.positionMs
    };

    if (ack.video) {
      uploadedVideo = ack.video;
      videoType = ack.video.type || 'upload';
    }

    viewerRoomCode.textContent = code;
    updateViewerCount(ack.viewerCount);

    enterViewerView();

    if (ack.video) {
      if (videoType === 'bilibili') {
        loadViewerBili(ack.video);
      } else {
        loadViewerVideo();
      }
    }
  });
}

// ── Host View ───────────────────────────────────────────────────────────────
let hostDropzoneSetup = false;

function enterHostView() {
  showView('host');
  hostOverlay.classList.remove('hidden');

  // Show dropzone for uploading in host view too (only for upload type)
  if (videoType !== 'bilibili') {
    hostDropzone.classList.remove('hidden');
    hostBiliContainer.classList.add('hidden');
    hostPlayer.classList.remove('hidden');
  } else {
    hostDropzone.classList.add('hidden');
    hostBiliContainer.classList.remove('hidden');
    hostPlayer.classList.add('hidden');
  }

  if (!hostDropzoneSetup) {
    hostDropzoneSetup = true;
    setupDropzone(hostDropzone, hostFileInput, hostUploadProgress, hostProgressFill, hostProgressText, (video) => {
      uploadedVideo = video;
      videoType = 'upload';
      hostDropzone.classList.add('hidden');
      hostUploadProgress.classList.add('hidden');
      socket.emit('video:set', video);
      loadHostVideo(video);
    });
  }
}

let hostListenersReady = false;

function setupHostListeners() {
  if (hostListenersReady) return;
  hostListenersReady = true;

  hostPlayer.addEventListener('loadedmetadata', onHostMetaLoaded);
  hostPlayer.addEventListener('play', onHostPlay);
  hostPlayer.addEventListener('pause', onHostPause);
  hostPlayer.addEventListener('seeked', onHostSeeked);
  hostPlayer.addEventListener('ended', onHostEnded);
  hostPlayer.addEventListener('error', onHostError);
  hostPlayer.addEventListener('waiting', () => {
    hostStatus.innerHTML = '<span class="status-dot"></span> 🔄 缓冲中';
  });
  hostPlayer.addEventListener('canplay', () => {
    // Video is playable
    if (hostOverlay.classList.contains('hidden')) return;
    onHostMetaLoaded();
  });

  // Fallback: click overlay to dismiss if stuck
  hostOverlay.addEventListener('click', () => {
    if (hostPlayer.readyState >= 1 && hostPlayer.error === null) {
      onHostMetaLoaded();
    }
  });
}

function onHostMetaLoaded() {
  hostOverlay.classList.add('hidden');
  hasVideo = true;
  hostStatus.innerHTML = '<span class="status-dot"></span> 就绪';
  hostStatus.className = 'status-badge synced';
}

function onHostPlay() {
  if (syncing) return;
  hostStatus.innerHTML = '<span class="status-dot"></span> ▶ 播放中';
  hostStatus.className = 'status-badge playing';
  socket.emit('play', { positionMs: Math.round(hostPlayer.currentTime * 1000) });
}

function onHostPause() {
  if (syncing) return;
  // Don't report pause if video ended (handled by ended event)
  if (hostPlayer.ended) return;
  hostStatus.innerHTML = '<span class="status-dot"></span> ⏸ 已暂停';
  hostStatus.className = 'status-badge synced';
  socket.emit('pause', { positionMs: Math.round(hostPlayer.currentTime * 1000) });
}

function onHostSeeked() {
  if (syncing) return;
  socket.emit('seek', { positionMs: Math.round(hostPlayer.currentTime * 1000) });
}

function onHostEnded() {
  if (syncing) return;
  hostStatus.innerHTML = '<span class="status-dot"></span> ⏸ 播放结束';
  hostStatus.className = 'status-badge synced';
  const dur = hostPlayer.duration;
  if (isFinite(dur) && dur > 0) {
    socket.emit('pause', { positionMs: Math.round(dur * 1000) });
  }
}

function onHostError() {
  const err = hostPlayer.error;
  const msg = err
    ? `视频加载失败: ${getVideoErrorMessage(err)}`
    : '视频加载失败';
  hostOverlay.querySelector('p').textContent = msg;
  hostOverlay.style.pointerEvents = 'auto';
  hostOverlay.style.cursor = 'pointer';
  hostStatus.innerHTML = '<span class="status-dot"></span> ❌ 加载失败';
  hostStatus.className = 'status-badge';
  console.error('[host] video error:', err);
}

function getVideoErrorMessage(err) {
  switch (err.code) {
    case 1: return '视频格式不支持，请转换为 H.264 MP4 格式';
    case 2: return '视频加载被中断';
    case 3: return '视频解码失败，请转换为 H.264 MP4 格式';
    case 4: return '视频文件不完整或损坏';
    default: return `未知错误 (code: ${err.code})`;
  }
}

function loadHostVideo(video) {
  if (!video || !video.videoId) {
    console.error('[host] loadHostVideo called with invalid video:', video);
    return;
  }

  const url = `/videos/${video.videoId}`;
  console.log('[host] loading video:', url);

  // Clean up bilibili player if exists
  if (hostBiliPlayer) {
    hostBiliPlayer.destroy();
    hostBiliPlayer = null;
  }

  // Reset state for new video
  hasVideo = false;
  syncing = false;
  videoType = 'upload';
  hostPlayer.src = url;
  hostPlayer.classList.remove('hidden');
  hostBiliContainer.classList.add('hidden');
  hostDropzone.classList.add('hidden');
  hostUploadProgress.classList.add('hidden');
  hostOverlay.classList.remove('hidden');
  hostOverlay.querySelector('p').textContent = '加载视频中...';
  hostStatus.innerHTML = '<span class="status-dot"></span> 🔄 加载中';

  // Ensure listeners are attached (only once)
  setupHostListeners();

  // Handle case where metadata already loaded before listener attached
  if (hostPlayer.readyState >= 1) {
    onHostMetaLoaded();
  }
}

/** Load Bilibili video in host view */
function loadHostBili(video) {
  if (!video || !video.bvid) {
    console.error('[host] loadHostBili called with invalid video:', video);
    return;
  }

  console.log('[host] loading bilibili:', video.bvid);
  hasVideo = false;
  syncing = false;
  videoType = 'bilibili';

  // Clean up native player
  hostPlayer.pause();
  hostPlayer.src = '';
  hostPlayer.classList.add('hidden');
  hostDropzone.classList.add('hidden');
  hostUploadProgress.classList.add('hidden');
  hostOverlay.classList.remove('hidden');
  hostOverlay.querySelector('p').textContent = '加载B站视频中...';
  hostStatus.innerHTML = '<span class="status-dot"></span> 🔄 加载中';

  hostBiliContainer.classList.remove('hidden');

  // Destroy previous bili player
  if (hostBiliPlayer) {
    hostBiliPlayer.destroy();
  }

  // Create bilibili player
  hostBiliPlayer = createBiliPlayer(video.bvid, hostBiliContainer, 0);

  // Set up bilibili event → socket relay
  let lastSentProgress = 0;
  let lastSentPlaying = false;

  const biliEventHandler = (evt) => {
    if (!hasVideo) return;
    const cmd = evt.cmd;

    // Detect play/pause/seek from iframe messages
    if (cmd.includes('play') && evt.progress >= 0) {
      if (!lastSentPlaying || Math.abs(evt.progress - lastSentProgress) > 2) {
        socket.emit('play', { positionMs: Math.round(evt.progress * 1000) });
        lastSentPlaying = true;
        lastSentProgress = evt.progress;
      }
      hostStatus.innerHTML = '<span class="status-dot"></span> ▶ 播放中';
      hostStatus.className = 'status-badge playing';
    } else if (cmd.includes('pause') && evt.progress >= 0) {
      socket.emit('pause', { positionMs: Math.round(evt.progress * 1000) });
      lastSentPlaying = false;
      lastSentProgress = evt.progress;
      hostStatus.innerHTML = '<span class="status-dot"></span> ⏸ 已暂停';
      hostStatus.className = 'status-badge synced';
    } else if (cmd.includes('seek') || cmd.includes('progress')) {
      if (evt.progress >= 0 && Math.abs(evt.progress - lastSentProgress) > 1.5) {
        socket.emit('seek', { positionMs: Math.round(evt.progress * 1000) });
        lastSentProgress = evt.progress;
      }
    } else if (cmd.includes('end')) {
      hostStatus.innerHTML = '<span class="status-dot"></span> ⏸ 播放结束';
      hostStatus.className = 'status-badge synced';
      if (lastSentProgress > 0) {
        socket.emit('pause', { positionMs: Math.round(lastSentProgress * 1000) });
      }
    }
  };

  // Listen for messages from Bilibili iframe and forward to event handler
  const biliMsgHandler = (e) => {
    if (!e.origin.includes('bilibili')) return;
    let data = e.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { return; }
    }
    if (!data || typeof data !== 'object') return;

    const cmd = String(data.cmd || data.action || data.type || '').toLowerCase();
    const inner = data.data || data.info || data;
    const progress = inner && typeof inner.progress === 'number' ? inner.progress :
                     typeof data.progress === 'number' ? data.progress : -1;

    biliEventHandler({ cmd, progress });
  };

  window.addEventListener('message', biliMsgHandler);

  // Store cleanup
  const origDestroy = hostBiliPlayer.destroy.bind(hostBiliPlayer);
  hostBiliPlayer.destroy = () => {
    window.removeEventListener('message', biliMsgHandler);
    origDestroy();
  };

  // Handle iframe load
  hostBiliPlayer.iframe.addEventListener('load', () => {
    hasVideo = true;
    hostOverlay.classList.add('hidden');
    hostStatus.innerHTML = '<span class="status-dot"></span> ▶ 播放中';
    hostStatus.className = 'status-badge playing';
  });
}

// ── Viewer View ─────────────────────────────────────────────────────────────
let viewerListenersReady = false;

function setupViewerListeners() {
  if (viewerListenersReady) return;
  viewerListenersReady = true;

  // Only setup native player listeners for upload type
  viewerPlayer.addEventListener('loadedmetadata', onViewerMetaLoaded);
  viewerPlayer.addEventListener('error', onViewerError);
  viewerPlayer.addEventListener('waiting', () => {
    viewerStatus.innerHTML = '<span class="status-dot"></span> 🔄 缓冲中';
  });

  // Prevent viewer from controlling playback
  viewerPlayer.addEventListener('play', (e) => {
    if (!syncing) {
      viewerPlayer.pause();
      showToast('只有主持人可以控制播放');
    }
  });

  viewerPlayer.addEventListener('pause', (e) => {
    if (!syncing) {
      viewerPlayer.play().catch(() => {});
    }
  });

  // Block viewer from seeking
  viewerPlayer.addEventListener('seeking', () => {
    if (!syncing && pendingSync) {
      viewerPlayer.currentTime = pendingSync.positionMs / 1000;
    }
  });

  // Click overlay to start (for autoplay policy)
  viewerOverlay.addEventListener('click', () => {
    if (hasVideo) {
      viewerOverlay.classList.add('hidden');
      if (videoType === 'bilibili' && viewerBiliPlayer) {
        viewerBiliPlayer.play();
      } else {
        viewerPlayer.play().catch(() => {});
      }
    }
  });
}

function onViewerMetaLoaded() {
  hasVideo = true;
  viewerStatus.textContent = '⏸ 已同步';
  viewerStatus.className = 'status-badge synced';

  // Apply pending sync
  if (pendingSync) {
    const isPlaying = pendingSync.playing;
    applyRemote(
      isPlaying ? 'play' : 'pause',
      pendingSync.positionMs / 1000
    );
    pendingSync = null;

    // If autoplay was blocked, show click-to-start overlay
    if (isPlaying && viewerPlayer.paused) {
      overlayMessage.textContent = '点击任意位置开始观看';
      viewerOverlay.classList.remove('hidden');
    } else {
      viewerOverlay.classList.add('hidden');
    }
  } else {
    viewerOverlay.classList.add('hidden');
  }
}

function onViewerError() {
  const err = viewerPlayer.error;
  overlayMessage.textContent =
    err ? `视频加载失败: ${err.message || '未知错误'}` : '视频加载失败';
  viewerOverlay.classList.remove('hidden');
  viewerStatus.innerHTML = '<span class="status-dot"></span> ❌ 加载失败';
  viewerStatus.className = 'status-badge';
  console.error('[viewer] video error:', err);
}

function enterViewerView() {
  showView('viewer');
  viewerOverlay.classList.remove('hidden');
  overlayMessage.textContent = '等待视频...';
  viewerPlayer.controls = false;
}

function loadViewerVideo() {
  if (!uploadedVideo) return;

  const url = `/videos/${uploadedVideo.videoId}`;
  console.log('[viewer] loading video:', url);

  // Clean up bilibili player
  if (viewerBiliPlayer) {
    viewerBiliPlayer.destroy();
    viewerBiliPlayer = null;
  }
  videoType = 'upload';

  hasVideo = false;
  viewerPlayer.classList.remove('hidden');
  viewerBiliContainer.classList.add('hidden');
  viewerPlayer.src = url;
  overlayMessage.textContent = '加载视频中...';
  viewerOverlay.classList.remove('hidden');

  // Ensure listeners (only once)
  setupViewerListeners();

  // Handle case where metadata already loaded
  if (viewerPlayer.readyState >= 1) {
    onViewerMetaLoaded();
  }
}

/** Load Bilibili video in viewer view */
function loadViewerBili(video) {
  if (!video || !video.bvid) return;

  console.log('[viewer] loading bilibili:', video.bvid);
  hasVideo = false;
  videoType = 'bilibili';

  // Clean up native player
  viewerPlayer.pause();
  viewerPlayer.src = '';
  viewerPlayer.classList.add('hidden');
  viewerBiliContainer.classList.remove('hidden');
  overlayMessage.textContent = '加载B站视频中...';
  viewerOverlay.classList.remove('hidden');

  // Destroy previous
  if (viewerBiliPlayer) {
    viewerBiliPlayer.destroy();
  }

  // Calculate initial start time from pending sync
  const startSec = pendingSync ? (pendingSync.positionMs / 1000) : 0;

  viewerBiliPlayer = createBiliPlayer(video.bvid, viewerBiliContainer, startSec);

  viewerBiliPlayer.iframe.addEventListener('load', () => {
    hasVideo = true;
    viewerStatus.textContent = '⏸ 已同步';
    viewerStatus.className = 'status-badge synced';

    // Set up viewer controls blocking: prevent bilibili iframe interaction
    viewerBiliContainer.style.pointerEvents = 'none';

    // Apply pending sync
    if (pendingSync) {
      const isPlaying = pendingSync.playing;
      viewerOverlay.classList.add('hidden');

      if (isPlaying) {
        viewerBiliPlayer.play();
        viewerStatus.textContent = '▶ 播放中';
        viewerStatus.className = 'status-badge playing';
      }
      pendingSync = null;
    } else {
      viewerOverlay.classList.add('hidden');
    }
  });

  setupViewerListeners();
}

// ── Copy Link ───────────────────────────────────────────────────────────────
btnCopy.addEventListener('click', () => {
  const shareUrl = `${window.location.origin}/w/${currentRoom}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('✅ 链接已复制！发给朋友即可加入');
  }).catch(() => {
    // Fallback for older browsers
    const input = document.createElement('input');
    input.value = shareUrl;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('✅ 链接已复制！');
  });
});

// ── Delete Room ─────────────────────────────────────────────────────────────
btnDeleteRoom.addEventListener('click', () => {
  if (!currentRoom || currentRole !== 'host') return;

  const confirmed = confirm('确定要删除房间吗？上传的视频文件也会被删除，此操作不可撤销。');
  if (!confirmed) return;

  if (socket) {
    socket.emit('room:delete');
  }
  showToast('房间已删除');

  leaveRoom();
});

// ── Leave Room ──────────────────────────────────────────────────────────────
btnLeaveHost.addEventListener('click', leaveRoom);
btnLeaveViewer.addEventListener('click', leaveRoom);

function leaveRoom() {
  if (socket && currentRoom) {
    socket.emit('leave-room');
  }

  // Reset state
  hasVideo = false;
  pendingSync = null;
  syncing = false;
  currentRole = null;
  currentRoom = null;
  uploadedVideo = null;
  videoType = null;
  hostDropzoneSetup = false;
  hostListenersReady = false;
  viewerListenersReady = false;

  // Clean up bilibili players
  if (hostBiliPlayer) { hostBiliPlayer.destroy(); hostBiliPlayer = null; }
  if (viewerBiliPlayer) { viewerBiliPlayer.destroy(); viewerBiliPlayer = null; }

  // Reset players
  hostPlayer.pause();
  hostPlayer.src = '';
  hostPlayer.classList.add('hidden');
  hostBiliContainer.classList.add('hidden');
  hostOverlay.classList.remove('hidden');
  hostDropzone.classList.add('hidden');
  hostUploadProgress.classList.add('hidden');

  viewerPlayer.pause();
  viewerPlayer.src = '';
  viewerPlayer.classList.add('hidden');
  viewerBiliContainer.classList.add('hidden');
  viewerOverlay.classList.remove('hidden');

  // Reset home page elements
  biliBvid.value = '';
  biliHint.textContent = '';
  dropzone.classList.remove('hidden');
  uploadProgress.classList.add('hidden');
  btnCreate.disabled = true;
  btnCreate.textContent = '创建房间';

  showView('home');
}

// ── Auto-join from /w/:code URL ─────────────────────────────────────────────
function checkAutoJoin() {
  const match = window.location.pathname.match(/^\/w\/([A-Za-z0-9]+)$/);
  if (match) {
    const code = match[1].toUpperCase();
    joinCode.value = code;
    // Switch to clean URL
    window.history.replaceState({}, '', '/');
    // Auto-join after a short delay (wait for socket)
    setTimeout(() => joinRoom(), 300);
    return true;
  }
  return false;
}

// ── Init ────────────────────────────────────────────────────────────────────
const ROOM_CODE_LENGTH = 6;

function init() {
  connectSocket();

  // Check for auto-join URL
  if (!checkAutoJoin()) {
    showView('home');
  }
}

// ── Keyboard shortcut: leave room ───────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentView !== 'home') {
    leaveRoom();
  }
});

init();
