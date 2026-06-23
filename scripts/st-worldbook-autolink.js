#!/usr/bin/env node
/**
 * ST World Book Auto-Linker
 * 监控ST聊天目录，新建聊天时自动挂载对应角色的世界书
 *
 * 用法: node scripts/st-worldbook-autolink.js
 * systemd: hermes-st-worldbook.service
 */

const fs = require('fs');
const path = require('path');

const CHATS_DIR = process.env.ST_CHATS_DIR || '/home/node/app/data/default-user/chats';
const WORLDS_DIR = process.env.ST_WORLDS_DIR || '/home/node/app/data/default-user/worlds';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000', 10);

const seenFiles = new Set();

function getWorldBooks() {
    try {
        return fs.readdirSync(WORLDS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    } catch { return []; }
}

function patchChatFile(filepath, worldName) {
    try {
        const content = fs.readFileSync(filepath, 'utf-8');
        const lines = content.split('\n');
        if (lines.length < 2) return false;

        const meta = JSON.parse(lines[0]);

        // Already has world book
        if (meta.chat_metadata?.world_info) return false;

        // Attach world book
        meta.chat_metadata = meta.chat_metadata || {};
        meta.chat_metadata.world_info = worldName;
        lines[0] = JSON.stringify(meta);

        fs.writeFileSync(filepath, lines.join('\n'), 'utf-8');
        return true;
    } catch { return false; }
}

function scan() {
    const worldBooks = getWorldBooks();
    if (worldBooks.length === 0) return;

    try {
        const charDirs = fs.readdirSync(CHATS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const charName of charDirs) {
            // Check if this character has a world book
            if (!worldBooks.includes(charName)) continue;

            const charChatDir = path.join(CHATS_DIR, charName);
            const files = fs.readdirSync(charChatDir).filter(f => f.endsWith('.jsonl'));

            for (const f of files) {
                const fullPath = path.join(charChatDir, f);
                if (seenFiles.has(fullPath)) continue;

                seenFiles.add(fullPath);
                const patched = patchChatFile(fullPath, charName);
                if (patched) {
                    console.log(`[WorldBook] ✅ Auto-linked "${charName}" → ${f}`);
                }
            }
        }
    } catch (err) {
        // Directory might not exist yet
    }
}

// Initial scan
scan();
console.log(`[WorldBook] Watching ${CHATS_DIR} (${getWorldBooks().length} world books available)`);

// Poll for new files
setInterval(scan, POLL_INTERVAL);
