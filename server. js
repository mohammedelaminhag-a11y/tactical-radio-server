const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const OpusScript = require('opusscript');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ADMIN_PASSWORD = "admin123";
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const clients = new Map();

wss.on('connection', (ws) => {
    clients.set(ws, { id: Math.random().toString(36).substr(2, 9), isAdmin: false, isMuted: false });

    ws.on('message', (message, isBinary) => {
        const client = clients.get(ws);
        if (!client) return;

        if (isBinary) {
            if (client.roomId && !client.isAdmin && !client.isMuted) {
                const room = rooms[client.roomId];
                if (room && room.activeSpeaker === client.id) {
                    broadcastToRoom(client.roomId, message, ws);
                   
                    try {
                        if (!room.adminDecoder) {
                            room.adminDecoder = new OpusScript(16000, 1);
                        }
                        const pcmBuffer = room.adminDecoder.decode(message);
                        sendToAdminsListening(client.roomId, pcmBuffer);
                    } catch (e) {
                        console.error("Admin decode error:", e);
                    }
                }
            }
            return;
        }

        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                const roomId = data.room;
                if (!rooms[roomId]) {
                    rooms[roomId] = { name: `CH-${roomId}`, password: data.password || "", users: new Set(), activeSpeaker: null, adminDecoder: null };
                }
                if (rooms[roomId].password && rooms[roomId].password !== data.password) {
                    ws.send(JSON.stringify({ type: 'error', message: 'كلمة المرور خاطئة' }));
                    return;
                }
                client.callsign = data.callsign;
                client.roomId = roomId;
                rooms[roomId].users.add(ws);
                ws.send(JSON.stringify({ type: 'joined', status: 'success' }));
                updateAdminDashboard();
            }

            if (data.type === 'ptt_start') {
                const room = rooms[client.roomId];
                if (room && !client.isMuted) {
                    if (room.activeSpeaker === null) {
                        room.activeSpeaker = client.id;
                        client.isTalking = true;
                        ws.send(JSON.stringify({ type: 'floor_granted' }));
                        broadcastToRoom(client.roomId, JSON.stringify({ type: 'user_talking', callsign: client.callsign }), ws);
                        updateAdminDashboard();
                    } else {
                        ws.send(JSON.stringify({ type: 'floor_busy' }));
                    }
                }
            }

            if (data.type === 'ptt_stop') {
                const room = rooms[client.roomId];
                if (room && room.activeSpeaker === client.id) {
                    room.activeSpeaker = null;
                    client.isTalking = false;
                    broadcastToRoom(client.roomId, JSON.stringify({ type: 'user_stopped' }), ws);
                    updateAdminDashboard();
                }
            }

            if (data.type === 'admin_join') {
                if (data.password === ADMIN_PASSWORD) {
                    client.isAdmin = true;
                    ws.send(JSON.stringify({ type: 'admin_logged_in' }));
                    updateAdminDashboard();
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'كلمة مرور الإدارة خاطئة' }));
                }
            }

            if (client.isAdmin) {
                if (data.type === 'admin_listen_start') client.adminListenRoom = data.roomId;
                if (data.type === 'admin_listen_stop') client.adminListenRoom = null;
               
                if (data.type === 'kick_user') {
                    const targetWs = Array.from(clients.entries()).find(([ws, c]) => c.callsign === data.callsign)?.[0];
                    if (targetWs) {
                        targetWs.send(JSON.stringify({ type: 'kicked' }));
                        targetWs.close();
                    }
                    updateAdminDashboard();
                }
               
                if (data.type === 'mute_user') {
                    const targetClient = Array.from(clients.values()).find(c => c.callsign === data.callsign);
                    if (targetClient) {
                        targetClient.isMuted = data.mute;
                        updateAdminDashboard();
                    }
                }
               
                if (data.type === 'create_room') {
                    rooms[data.roomId] = { name: data.name, password: data.password || "", users: new Set(), activeSpeaker: null, adminDecoder: null };
                    updateAdminDashboard();
                }
               
                if (data.type === 'delete_room') {
                    if (rooms[data.roomId]) {
                        rooms[data.roomId].users.forEach(u => u.close());
                        delete rooms[data.roomId];
                    }
                    updateAdminDashboard();
                }
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        if (client && client.roomId && rooms[client.roomId]) {
            rooms[client.roomId].users.delete(ws);
            if (rooms[client.roomId].activeSpeaker === client.id) {
                rooms[client.roomId].activeSpeaker = null;
            }
        }
        clients.delete(ws);
        updateAdminDashboard();
    });
});

function broadcastToRoom(roomId, message, excludeWs) {
    if (!rooms[roomId]) return;
    rooms[roomId].users.forEach((userWs) => {
        if (userWs !== excludeWs && userWs.readyState === WebSocket.OPEN) {
            userWs.send(message);
        }
    });
}

function sendToAdminsListening(roomId, message) {
    clients.forEach((c, ws) => {
        if (c.isAdmin && c.adminListenRoom === roomId && ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}

function updateAdminDashboard() {
    const roomsData = {};
    for (const [id, room] of Object.entries(rooms)) {
        roomsData[id] = {
            name: room.name, hasPassword: !!room.password, activeSpeaker: room.activeSpeaker,
            users: Array.from(room.users).map(ws => {
                const c = clients.get(ws);
                return c ? { callsign: c.callsign, isTalking: c.isTalking, isMuted: c.isMuted } : null;
            }).filter(Boolean)
        };
    }
    const payload = JSON.stringify({ type: 'update_rooms', rooms: roomsData });
    clients.forEach((c, ws) => {
        if (c.isAdmin && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });
}

// تعديل مهم جداً: الاستماع على 0.0.0.0 ليعمل على Deplexo
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Tactical Server running on port ${PORT}`);
});
