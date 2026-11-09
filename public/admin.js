'use strict';

(() => {
    const $ = (id) => document.getElementById(id);

    let ws = null;
    let password = '';          // في الذاكرة فقط، ولا تُحفظ في أي تخزين
    let wantConnection = false;
    let loggedIn = false;
    let reconnectTimer = null;
    let currentRooms = {};
    let listeningRoom = null;

    // ===== بناء عناصر آمن (textContent فقط، لا innerHTML) =====
    function el(tag, props, children) {
        const node = document.createElement(tag);
        const p = props || {};
        for (const key of Object.keys(p)) {
            if (key === 'class') node.className = p[key];
            else if (key === 'text') node.textContent = p[key];
            else if (key.startsWith('on')) node.addEventListener(key.slice(2), p[key]);
            else node.setAttribute(key, p[key]);
        }
        for (const child of children || []) {
            if (child) node.append(child);
        }
        return node;
    }

    function btn(label, cls, onClick) {
        return el('button', { type: 'button', class: cls || '', text: label, onclick: onClick });
    }

    function send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    function setState(text, on) {
        const s = $('connState');
        s.textContent = text;
        s.className = 'pill ' + (on ? 'on' : 'off');
    }

    let toastTimer = null;
    function toast(text) {
        const t = $('toast');
        t.textContent = text;
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
    }

    // ===== الاتصال =====
    function connect() {
        wantConnection = true;
        clearTimeout(reconnectTimer);
        const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        ws = new WebSocket(proto + location.host);
        ws.binaryType = 'arraybuffer';
        setState('CONNECTING', false);

        ws.onopen = () => send({ type: 'admin_join', password });

        ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') {
                let data;
                try { data = JSON.parse(ev.data); } catch (e) { return; }
                onJson(data);
            } else {
                onAudio(ev.data);
            }
        };

        ws.onclose = () => {
            setState('OFFLINE', false);
            stopAudio();
            listeningRoom = null;
            if (wantConnection && loggedIn) {
                reconnectTimer = setTimeout(connect, 2000);
            }
        };
        ws.onerror = () => {};
    }

    function showLogin(message) {
        loggedIn = false;
        wantConnection = false;
        password = '';
        $('dashboard').hidden = true;
        $('loginBox').hidden = false;
        $('errorMsg').textContent = message || '';
    }

    function onJson(data) {
        switch (data.type) {
            case 'admin_logged_in':
                loggedIn = true;
                $('adminPass').value = '';
                $('errorMsg').textContent = '';
                $('loginBox').hidden = true;
                $('dashboard').hidden = false;
                setState('ONLINE', true);
                break;
            case 'error':
                if (!loggedIn) {
                    showLogin(data.message || 'Error');
                    if (ws) ws.close();
                } else {
                    toast(data.message || 'Error');
                }
                break;
            case 'update_rooms':
                currentRooms = data.rooms || {};
                renderRooms();
                if (data.stats) {
                    $('stats').textContent = data.stats.rooms + ' rooms / ' + data.stats.clients + ' clients / up ' + data.stats.uptime + 's';
                }
                break;
            case 'audit_log':
                $('auditList').replaceChildren();
                (data.entries || []).forEach((e) => addAudit(e, false));
                break;
            case 'audit_entry':
                addAudit(data.entry, true);
                break;
            case 'listen_started':
                listeningRoom = data.roomId;
                renderRooms();
                break;
            case 'listen_ended':
                listeningRoom = null;
                stopAudio();
                renderRooms();
                break;
            default:
                break;
        }
    }

    // ===== العرض =====
    function renderRooms() {
        const container = $('roomsContainer');
        container.replaceChildren();
        const ids = Object.keys(currentRooms);
        if (ids.length === 0) {
            container.append(el('div', { class: 'empty', text: 'No channels yet. Create one above.' }));
            return;
        }

        ids.forEach((id) => {
            const room = currentRooms[id];
            const badges = el('div', { class: 'badges' });
            if (room.hasPassword) badges.append(el('span', { class: 'badge', text: 'PASSWORD' }));
            if (room.auto) badges.append(el('span', { class: 'badge', text: 'AUTO' }));
            if (room.listeners > 0) badges.append(el('span', { class: 'badge listen', text: 'LISTENED: ' + room.listeners }));

            const usersBox = el('div');
            if (!room.users || room.users.length === 0) {
                usersBox.append(el('div', { class: 'empty', text: 'Empty' }));
            } else {
                room.users.forEach((u) => {
                    const name = el('span', { class: 'name' + (u.isTalking ? ' talking' : ''), text: u.callsign });
                    if (u.isMuted) name.append(el('span', { class: 'muted-tag', text: 'MUTED' }));
                    const actions = el('div', {}, [
                        btn(u.isMuted ? 'UNMUTE' : 'MUTE', 'warning', () => send({ type: 'mute_user', id: u.id, mute: !u.isMuted })),
                        btn('KICK', 'danger', () => {
                            if (confirm('Kick ' + u.callsign + '?')) send({ type: 'kick_user', id: u.id });
                        }),
                        btn('BAN 10M', 'danger', () => {
                            if (confirm('Kick and ban ' + u.callsign + ' for 10 minutes?')) send({ type: 'kick_user', id: u.id, banMinutes: 10 });
                        })
                    ]);
                    usersBox.append(el('div', { class: 'user' }, [name, actions]));
                });
            }

            const listening = listeningRoom === id;
            const roomActions = el('div', { class: 'room-actions' }, [
                btn(listening ? 'STOP LISTENING' : 'LISTEN LIVE', listening ? 'danger' : 'warning', () => toggleListen(id)),
                btn('RELEASE FLOOR', 'warning', () => send({ type: 'force_release', roomId: id })),
                btn('DELETE', 'danger', () => {
                    if (confirm('Delete channel ' + id + '? All members will be disconnected.')) send({ type: 'delete_room', roomId: id });
                })
            ]);

            container.append(el('div', { class: 'room' }, [
                el('h3', { text: 'ROOM ' + id + ' / ' + room.name }),
                badges,
                usersBox,
                roomActions
            ]));
        });
    }

    function addAudit(entry, prepend) {
        if (!entry) return;
        const time = new Date(entry.t).toLocaleTimeString('en-GB');
        const rest = Object.keys(entry)
            .filter((k) => k !== 't' && k !== 'actor' && k !== 'action')
            .map((k) => k + '=' + entry[k])
            .join(' ');
        const li = el('li', {}, [
            el('span', { class: 'time', text: time }),
            el('span', { text: entry.actor + ' ' + entry.action + (rest ? ' ' + rest : '') })
        ]);
        const list = $('auditList');
        if (prepend) list.prepend(li); else list.append(li);
        while (list.children.length > 200) list.lastChild.remove();
    }

    // ===== الاستماع الحي: فك Opus بـ WebCodecs =====
    let audioCtx = null;
    let decoder = null;
    let nextTime = 0;
    let chunkTs = 0;

    async function ensureAudio() {
        if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 16000 });
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        if (!decoder || decoder.state === 'closed') {
            decoder = new AudioDecoder({
                output: playFrame,
                error: (e) => console.error('AudioDecoder', e)
            });
            decoder.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1 });
        }
    }

    function playFrame(audioData) {
        const n = audioData.numberOfFrames;
        const samples = new Float32Array(n);
        audioData.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
        const rate = audioData.sampleRate;
        audioData.close();

        const buffer = audioCtx.createBuffer(1, n, rate);
        buffer.copyToChannel(samples, 0);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        if (nextTime < now + 0.02 || nextTime > now + 0.5) nextTime = now + 0.08;
        source.start(nextTime);
        nextTime += buffer.duration;
    }

    function onAudio(buffer) {
        if (!decoder || decoder.state !== 'configured' || !listeningRoom) return;
        if (decoder.decodeQueueSize > 10) return;
        try {
            chunkTs += 20000;
            decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: chunkTs, data: buffer }));
        } catch (e) { /* حزمة تالفة */ }
    }

    function stopAudio() {
        nextTime = 0;
        if (decoder && decoder.state !== 'closed') {
            try { decoder.close(); } catch (e) { /* مغلق مسبقًا */ }
        }
        decoder = null;
    }

    async function toggleListen(roomId) {
        if (listeningRoom === roomId) {
            send({ type: 'admin_listen_stop' });
            listeningRoom = null;
            stopAudio();
            renderRooms();
            return;
        }
        if (!('AudioDecoder' in window)) {
            toast('This browser cannot decode Opus audio. Use a recent Chrome or Edge.');
            return;
        }
        try {
            await ensureAudio();
            send({ type: 'admin_listen_start', roomId });
        } catch (e) {
            toast('Could not start audio: ' + e.message);
        }
    }

    // ===== الأحداث =====
    function doLogin() {
        const value = $('adminPass').value;
        if (!value) { $('errorMsg').textContent = 'Enter the password.'; return; }
        password = value;
        $('errorMsg').textContent = '';
        if (ws) { wantConnection = false; ws.close(); }
        connect();
    }

    $('loginBtn').addEventListener('click', doLogin);
    $('adminPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

    $('logoutBtn').addEventListener('click', () => {
        wantConnection = false;
        if (ws) ws.close();
        stopAudio();
        showLogin('');
    });

    $('createBtn').addEventListener('click', () => {
        const roomId = $('newRoomId').value.trim();
        if (!roomId) { toast('Enter a channel ID.'); return; }
        send({
            type: 'create_room',
            roomId,
            name: $('newRoomName').value.trim(),
            password: $('newRoomPass').value
        });
        $('newRoomId').value = '';
        $('newRoomName').value = '';
        $('newRoomPass').value = '';
    });
})();
