'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// ===== الإعدادات (كلها قابلة للضبط من متغيرات البيئة) =====
const PORT = process.env.PORT || 8080;
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
