'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

// ===== الإعدادات (كلها قابلة للضبط من متغيرات البيئة) =====
const PORT = process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';                       // فعّله إذا كان الخادم خلف وسيط (يقرأ IP من X-Forwarded-For)
const ALLOW_AUTO_CREATE_ROOMS = process.env.ALLOW_AUTO_CREATE_ROOMS !== '0'; // 0 = الغرف تُنشأ من لوحة الإدارة فقط
const NOTIFY_ON_LISTEN = process.env.NOTIFY_ON_LISTEN !== '0';              // إشعار الأعضاء عندما تستمع الإدارة
const MAX_TALK_MS = Number(process.env.MAX_TALK_MS) || 60000;
const MAX_ROOMS = 200;
const MAX_USERS_PER_ROOM = 100;
const MAX_CLIENTS = 1000;
const MAX_FRAME_BYTES = 1275;            // أقصى حجم لحزمة Opus
const MAX_BUFFERED_BYTES = 64 * 1024;    // لا نرسل صوتًا لعميل بطيء متراكم
const HEARTBEAT_MS = 15000;
const ADMIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

const SECRET = process.env.SERVER_SECRET || crypto.randomBytes(32).toString('hex');
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = crypto.randomBytes(12).toString('base64url');
    console.warn('[WARN] ADMIN_PASSWORD غير مضبوط. كلمة مرور مؤقتة لهذه الجلسة: ' + ADMIN_PASSWORD);
}

const digest = (value) => crypto.createHmac('sha256', SECRET).update(String(value)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

const CALLSIGN_RE = /^[A-Z0-9-]{2,16}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{1,16}$/;
const cleanName = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function log(event, data) {
    // stderr بدل stdout: بعض المنصات تعرض stderr فورًا وقد تؤخر stdout
    console.error(JSON.stringify(Object.assign({ t: new Date().toISOString(), event }, data || {})));
}

// ===== HTTP =====
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    next();
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
log('boot', { port: Number(PORT), node: process.version, hasAdminPassword: !!process.env.ADMIN_PASSWORD });

// بصمة الملفات: تكشف فورًا إن كان أي ملف على الاستضافة ناقصًا أو مختلفًا عن المرفوع
function fingerprint(file) {
    try {
        const buf = fs.readFileSync(file);
        return { bytes: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8) };
    } catch (e) {
        return { missing: true };
    }
}
log('files', {
    server: fingerprint(__filename),
    admin_html: fingerprint(path.join(__dirname, 'public', 'admin.html')),
    admin_js: fingerprint(path.join(__dirname, 'public', 'admin.js')),
    admin_css: fingerprint(path.join(__dirname, 'public', 'admin.css'))
});
const wss = new WebSocket.Server({ server, maxPayload: 4096, perMessageDeflate: false });

// ===== الحالة =====
const rooms = new Map();       // roomId -> room
const clients = new Map();     // ws -> client
const bans = new Map();        // مفتاح الحظر -> وقت الانتهاء
const adminFails = new Map();  // ip -> { count, until, last }
const auditLog = [];

// ===== أدوات =====
function getIp(req) {
    if (TRUST_PROXY) {
        const xff = req.headers['x-forwarded-for'];
        if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

function send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendAudio(ws, data) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED_BYTES) {
        ws.send(data, { binary: true });
    }
}

function broadcastRoom(room, obj, exceptWs) {
    const payload = JSON.stringify(obj);
    for (const u of room.users) {
        if (u !== exceptWs && u.readyState === WebSocket.OPEN) u.send(payload);
    }
}

function findById(id) {
    for (const [ws, c] of clients) {
        if (c.id === id) return { ws, c };
    }
    return null;
}

function isBanned(key) {
    const until = bans.get(key);
    return !!until && until > Date.now();
}

function overLimit(client, isBinary) {
    const now = Date.now();
    if (now - client.winStart >= 1000) {
        client.winStart = now;
        client.jsonCount = 0;
        client.binCount = 0;
    }
    return isBinary ? ++client.binCount > 100 : ++client.jsonCount > 30;
}

function record(actor, action, details) {
    const entry = Object.assign({ t: Date.now(), actor: actor ? actor.id.slice(0, 8) : 'system', action }, details || {});
    auditLog.push(entry);
    if (auditLog.length > 500) auditLog.shift();
    log('audit', entry);
    for (const [ws, c] of clients) {
        if (c.isAdmin) send(ws, { type: 'audit_entry', entry });
    }
}

// ===== الغرف =====
function createRoom(id, name, password, auto) {
    const room = {
        id,
        name: cleanName(name, 32) || ('CH-' + id),
        passDigest: password ? digest(id + ':' + password) : null,
        auto: !!auto,
        users: new Set(),
        listeners: new Set(),
        muted: new Set(),
        speakerId: null,
        speakerWs: null,
        talkTimer: null
    };
    rooms.set(id, room);
    return room;
}

function roomPasswordOk(room, password) {
    if (!room.passDigest) return true;
    return crypto.timingSafeEqual(room.passDigest, digest(room.id + ':' + password));
}

function destroyRoom(room) {
    clearTimeout(room.talkTimer);
    for (const u of Array.from(room.users)) {
        const c = clients.get(u);
        if (c) { c.roomId = null; c.isTalking = false; }
        send(u, { type: 'room_deleted' });
        u.close(4004, 'room_deleted');
    }
    room.users.clear();
    for (const l of room.listeners) {
        const c = clients.get(l);
        if (c) c.adminListenRoom = null;
        send(l, { type: 'listen_ended', roomId: room.id });
    }
    room.listeners.clear();
    rooms.delete(room.id);
}

function broadcastRoster(room) {
    const roster = [];
    for (const u of room.users) {
        const c = clients.get(u);
        if (c) roster.push({ id: c.id, callsign: c.callsign, talking: c.isTalking, muted: c.isMuted });
    }
    // user_list للتوافق مع التطبيق الحالي، و roster للتطبيق الجديد
    const legacy = JSON.stringify({ type: 'user_list', users: roster.map((r) => r.callsign) });
    const full = JSON.stringify({ type: 'roster', users: roster });
    for (const u of room.users) {
        if (u.readyState === WebSocket.OPEN) { u.send(legacy); u.send(full); }
    }
}

function leaveRoom(ws, client) {
    const room = rooms.get(client.roomId);
    if (!room) { client.roomId = null; return; }
    if (room.speakerId === client.id) releaseFloor(room, 'left');
    client.roomId = null;
    client.isTalking = false;
    room.users.delete(ws);
    broadcastRoster(room);
    if (room.auto && room.users.size === 0) destroyRoom(room);
    scheduleDashboard();
}

// ===== التحكم بدور الكلام =====
function grantFloor(room, ws, client) {
    room.speakerId = client.id;
    room.speakerWs = ws;
    client.isTalking = true;
    room.talkTimer = setTimeout(() => releaseFloor(room, 'timeout'), MAX_TALK_MS);
}

function releaseFloor(room, reason) {
    if (!room.speakerId) return;
    clearTimeout(room.talkTimer);
    room.talkTimer = null;
    const sws = room.speakerWs;
    const c = sws ? clients.get(sws) : null;
    room.speakerId = null;
    room.speakerWs = null;
    if (c) c.isTalking = false;
    if (sws) send(sws, { type: 'floor_released', reason });
    broadcastRoom(room, { type: 'user_stopped' }, sws);
    scheduleDashboard();
}

// ===== معالجات الرسائل =====
function joinError(ws, code, message) {
    send(ws, { type: 'error', code, message });
    ws.close(4001, code);
}

function handleJoin(ws, client, msg) {
    const roomId = String(msg.room == null ? '' : msg.room);
    const callsign = String(msg.callsign == null ? '' : msg.callsign).trim().toUpperCase();
    const password = String(msg.password == null ? '' : msg.password).slice(0, 64);

    if (!ROOM_RE.test(roomId)) return joinError(ws, 'bad_room', 'رقم القناة غير صالح');
    if (!CALLSIGN_RE.test(callsign)) return joinError(ws, 'bad_callsign', 'رمز النداء غير صالح (2-16: A-Z و 0-9 و -)');
    if (isBanned('cs:' + roomId + ':' + callsign) || (TRUST_PROXY && isBanned('ip:' + client.ip))) {
        return joinError(ws, 'banned', 'تم حظرك مؤقتًا من هذه القناة');
    }

    let room = rooms.get(roomId);
    if (!room) {
        if (!ALLOW_AUTO_CREATE_ROOMS) return joinError(ws, 'no_room', 'القناة غير موجودة');
        if (rooms.size >= MAX_ROOMS) return joinError(ws, 'limit', 'تم بلوغ الحد الأقصى للقنوات');
        room = createRoom(roomId, 'CH-' + roomId, password, true);
    } else if (!roomPasswordOk(room, password)) {
        return joinError(ws, 'bad_password', 'كلمة المرور خاطئة');
    }
    if (!room.users.has(ws) && room.users.size >= MAX_USERS_PER_ROOM) {
        return joinError(ws, 'room_full', 'القناة ممتلئة');
    }

    // رمز النداء فريد داخل القناة. نفس الـ IP يعني إعادة اتصال، فنطرد الجلسة العالقة
    for (const u of Array.from(room.users)) {
        const other = clients.get(u);
        if (u !== ws && other && other.callsign === callsign) {
            if (other.ip === client.ip) {
                leaveRoom(u, other);
                u.terminate();
            } else {
                return joinError(ws, 'callsign_taken', 'رمز النداء مستخدم في هذه القناة');
            }
        }
    }

    if (client.roomId && client.roomId !== roomId) leaveRoom(ws, client);
    client.callsign = callsign;
    client.roomId = roomId;
    client.isMuted = room.muted.has(callsign);
    room.users.add(ws);

    send(ws, { type: 'joined', status: 'success', id: client.id, room: roomId, callsign, muted: client.isMuted });
    if (NOTIFY_ON_LISTEN && room.listeners.size > 0) {
        send(ws, { type: 'command_listening', active: true, count: room.listeners.size });
    }
    broadcastRoster(room);
    scheduleDashboard();
    log('join', { room: roomId, callsign, id: client.id });
}

function handlePttStart(ws, client) {
    const room = rooms.get(client.roomId);
    if (!room) return send(ws, { type: 'error', code: 'not_joined', message: 'لم تنضم إلى قناة بعد' });
    if (client.isMuted) return send(ws, { type: 'floor_busy', reason: 'muted' });
    if (room.speakerId === client.id) return send(ws, { type: 'floor_granted', maxMs: MAX_TALK_MS });
    if (room.speakerId) return send(ws, { type: 'floor_busy', reason: 'busy' });

    grantFloor(room, ws, client);
    send(ws, { type: 'floor_granted', maxMs: MAX_TALK_MS });
    broadcastRoom(room, { type: 'user_talking', callsign: client.callsign, id: client.id }, ws);
    scheduleDashboard();
}

function handlePttStop(client) {
    const room = rooms.get(client.roomId);
    if (room && room.speakerId === client.id) releaseFloor(room, 'stopped');
}

function handleAudio(ws, client, data) {
    if (!client.roomId || client.isAdmin || client.isMuted) return;
    if (data.length === 0 || data.length > MAX_FRAME_BYTES) return;
    const room = rooms.get(client.roomId);
    if (!room || room.speakerId !== client.id) return;
    for (const u of room.users) {
        if (u !== ws) sendAudio(u, data);
    }
    for (const l of room.listeners) sendAudio(l, data);
}

function handleAdminJoin(ws, client, msg) {
    const now = Date.now();
    const rec = adminFails.get(client.ip) || { count: 0, until: 0, last: now };
    if (rec.until > now) {
        return send(ws, { type: 'error', code: 'locked', message: 'محاولات كثيرة. حاول بعد قليل' });
    }
    if (safeEqual(String(msg.password == null ? '' : msg.password), ADMIN_PASSWORD)) {
        adminFails.delete(client.ip);
        client.isAdmin = true;
        send(ws, { type: 'admin_logged_in', id: client.id, config: { maxTalkMs: MAX_TALK_MS } });
        send(ws, { type: 'audit_log', entries: auditLog.slice(-100) });
        record(client, 'admin_login', { ip: client.ip });
        scheduleDashboard();
    } else {
        rec.count += 1;
        rec.last = now;
        if (rec.count >= 5) { rec.until = now + ADMIN_FAIL_WINDOW_MS; rec.count = 0; }
        adminFails.set(client.ip, rec);
        log('admin_login_failed', { ip: client.ip });
        send(ws, { type: 'error', code: 'bad_admin_password', message: 'كلمة مرور الإدارة خاطئة' });
    }
}

// ===== أوامر الإدارة =====
function startListening(ws, client, roomId) {
    stopListening(ws, client);
    const room = rooms.get(roomId);
    if (!room) return send(ws, { type: 'error', code: 'no_room', message: 'القناة غير موجودة' });
    room.listeners.add(ws);
    client.adminListenRoom = roomId;
    send(ws, { type: 'listen_started', roomId });
    if (NOTIFY_ON_LISTEN) broadcastRoom(room, { type: 'command_listening', active: true, count: room.listeners.size });
    record(client, 'listen_start', { room: roomId });
    scheduleDashboard();
}

function stopListening(ws, client) {
    const roomId = client.adminListenRoom;
    if (!roomId) return;
    client.adminListenRoom = null;
    const room = rooms.get(roomId);
    if (room) {
        room.listeners.delete(ws);
        if (NOTIFY_ON_LISTEN) {
            broadcastRoom(room, { type: 'command_listening', active: room.listeners.size > 0, count: room.listeners.size });
        }
    }
    record(client, 'listen_stop', { room: roomId });
    scheduleDashboard();
}

function handleAdmin(ws, client, msg) {
    switch (msg.type) {
        case 'admin_listen_start':
            return startListening(ws, client, String(msg.roomId));
        case 'admin_listen_stop':
            return stopListening(ws, client);

        case 'kick_user': {
            const t = findById(String(msg.id));
            if (!t || t.c.isAdmin) return;
            const banMin = Math.min(Math.max(Number(msg.banMinutes) || 0, 0), 1440);
            if (banMin > 0) {
                const until = Date.now() + banMin * 60000;
                if (t.c.roomId && t.c.callsign) bans.set('cs:' + t.c.roomId + ':' + t.c.callsign, until);
                if (TRUST_PROXY) bans.set('ip:' + t.c.ip, until);
            }
            record(client, 'kick', { target: t.c.callsign, room: t.c.roomId, banMin });
            send(t.ws, { type: 'kicked' });
            t.ws.close(4003, 'kicked');
            setTimeout(() => t.ws.terminate(), 1000);
            return;
        }

        case 'mute_user': {
            const t = findById(String(msg.id));
            if (!t || !t.c.roomId) return;
            const room = rooms.get(t.c.roomId);
            if (!room) return;
            const mute = !!msg.mute;
            t.c.isMuted = mute;
            if (mute) room.muted.add(t.c.callsign); else room.muted.delete(t.c.callsign);
            if (mute && room.speakerId === t.c.id) releaseFloor(room, 'muted');
            send(t.ws, { type: 'muted', value: mute });
            broadcastRoster(room);
            record(client, mute ? 'mute' : 'unmute', { target: t.c.callsign, room: room.id });
            scheduleDashboard();
            return;
        }

        case 'force_release': {
            const room = rooms.get(String(msg.roomId));
            if (!room) return;
            releaseFloor(room, 'admin');
            record(client, 'force_release', { room: room.id });
            return;
        }

        case 'create_room': {
            const id = String(msg.roomId == null ? '' : msg.roomId);
            if (!ROOM_RE.test(id)) return send(ws, { type: 'error', code: 'bad_room', message: 'معرّف القناة غير صالح (1-16: حروف وأرقام و - و _)' });
            if (rooms.has(id)) return send(ws, { type: 'error', code: 'exists', message: 'القناة موجودة مسبقًا' });
            if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', code: 'limit', message: 'تم بلوغ الحد الأقصى للقنوات' });
            createRoom(id, msg.name, String(msg.password == null ? '' : msg.password).slice(0, 64), false);
            record(client, 'create_room', { room: id });
            scheduleDashboard();
            return;
        }

        case 'delete_room': {
            const room = rooms.get(String(msg.roomId));
            if (!room) return;
            record(client, 'delete_room', { room: room.id });
            destroyRoom(room);
            scheduleDashboard();
            return;
        }

        default:
            return;
    }
}

function handleMessage(ws, client, data, isBinary) {
    if (overLimit(client, isBinary)) return;
    if (isBinary) return handleAudio(ws, client, data);

    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    try {
        switch (msg.type) {
            case 'join': return handleJoin(ws, client, msg);
            case 'leave': return leaveRoom(ws, client);
            case 'ptt_start': return handlePttStart(ws, client);
            case 'ptt_stop': return handlePttStop(client);
            case 'ping': return send(ws, { type: 'pong', t: typeof msg.t === 'number' ? msg.t : 0 });
            case 'admin_join': return handleAdminJoin(ws, client, msg);
            default:
                if (client.isAdmin) return handleAdmin(ws, client, msg);
        }
    } catch (e) {
        log('handler_error', { type: msg.type, message: e.message });
    }
}

function handleClose(ws, client) {
    leaveRoom(ws, client);
    stopListening(ws, client);
    clients.delete(ws);
    scheduleDashboard();
}

// ===== لوحة الإدارة =====
let dashTimer = null;
function scheduleDashboard() {
    if (dashTimer) return;
    dashTimer = setTimeout(() => { dashTimer = null; pushDashboard(); }, 100);
}

function pushDashboard() {
    const admins = [];
    for (const [ws, c] of clients) if (c.isAdmin && ws.readyState === WebSocket.OPEN) admins.push(ws);
    if (admins.length === 0) return;

    const snapshot = {};
    for (const [id, room] of rooms) {
        const users = [];
        for (const u of room.users) {
            const c = clients.get(u);
            if (c) users.push({ id: c.id, callsign: c.callsign, isTalking: c.isTalking, isMuted: c.isMuted });
        }
        snapshot[id] = {
            name: room.name,
            hasPassword: !!room.passDigest,
            auto: room.auto,
            activeSpeaker: room.speakerId,
            listeners: room.listeners.size,
            users
        };
    }
    const payload = JSON.stringify({
        type: 'update_rooms',
        rooms: snapshot,
        stats: { clients: clients.size, rooms: rooms.size, uptime: Math.floor(process.uptime()) }
    });
    for (const ws of admins) ws.send(payload);
}

// ===== الاتصالات =====
wss.on('connection', (ws, req) => {
    const ip = getIp(req);
    if (TRUST_PROXY && isBanned('ip:' + ip)) return ws.close(1008, 'banned');
    if (clients.size >= MAX_CLIENTS) return ws.close(1013, 'server_full');

    const client = {
        id: crypto.randomUUID(),
        ip,
        isAdmin: false,
        isMuted: false,
        isTalking: false,
        callsign: null,
        roomId: null,
        adminListenRoom: null,
        winStart: Date.now(),
        jsonCount: 0,
        binCount: 0
    };
    clients.set(ws, client);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => handleMessage(ws, client, data, isBinary));
    ws.on('close', () => handleClose(ws, client));
    ws.on('error', (e) => log('ws_error', { id: client.id, message: e.message }));
});

// نبض الاتصال: نقطع الاتصالات الميتة ليتحرر دور الكلام تلقائيًا
setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
    }
    const now = Date.now();
    for (const [k, until] of bans) if (until <= now) bans.delete(k);
    for (const [k, rec] of adminFails) if (now - rec.last > ADMIN_FAIL_WINDOW_MS) adminFails.delete(k);
}, HEARTBEAT_MS).unref();

server.on('error', (e) => {
    log('server_error', { message: e.message, code: e.code });
    process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => log('listening', { port: Number(PORT) }));

function shutdown() {
    log('shutdown');
    for (const ws of wss.clients) {
        send(ws, { type: 'server_shutdown' });
        ws.close(1001, 'server_shutdown');
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => { log('signal', { signal: 'SIGTERM' }); shutdown(); });
process.on('SIGINT', () => { log('signal', { signal: 'SIGINT' }); shutdown(); });
process.on('exit', (code) => log('exit', { code }));
process.on('unhandledRejection', (e) => log('unhandled_rejection', { message: String(e) }));

// END OF server.js
