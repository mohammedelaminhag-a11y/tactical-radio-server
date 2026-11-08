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
