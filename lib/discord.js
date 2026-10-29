'use strict';
/**
 * discord.js — the small slice of Discord's REST API the desk uses.
 *
 * REST only, no gateway connection, so it can share a token with a bot that already runs somewhere else without
 * touching that bot's session. Credentials come from the caller, the environment or a private file, and are never
 * logged:
 *
 *   DISCORD_BOT_TOKEN    bot token
 *   DISCORD_CHANNEL_ID   the channel to listen and post in
 *   DISCORD_BOT_CONFIG   path of the private file (default ~/.discord-bot.json: {"token": "…", "channelId": "…"})
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/CodeBarrie/discord-bot-tools, 1.0)';
const PRIVATE_FILE = process.env.DISCORD_BOT_CONFIG || path.join(os.homedir(), '.discord-bot.json');

/** Credentials: the caller's overrides, then env, then the private file. Never logged. */
function config(overrides) {
    const o = overrides || {};
    let file = {};
    try { if (fs.existsSync(PRIVATE_FILE)) file = JSON.parse(fs.readFileSync(PRIVATE_FILE, 'utf-8')) || {}; } catch (e) { file = {}; }
    return {
        token: o.token || process.env.DISCORD_BOT_TOKEN || file.token || null,
        channelId: o.channelId || process.env.DISCORD_CHANNEL_ID || file.channelId || null,
        mention: o.mention ? String(o.mention) : null
    };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** REST call with bot auth, JSON or multipart body, 429 handling. Errors carry .status and .body. */
async function api(cfg, method, route, body, files) {
    if (!cfg.token) throw new Error('no bot token (set DISCORD_BOT_TOKEN, ~/.discord-bot.json or discord.tokenFrom)');
    for (let attempt = 0; attempt < 5; attempt++) {
        const headers = { Authorization: 'Bot ' + cfg.token, 'User-Agent': USER_AGENT };
        let payload;
        if (files && files.length) {
            payload = new FormData();
            payload.append('payload_json', JSON.stringify(body || {}));
            files.forEach((f, i) => payload.append(`files[${i}]`, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name));
        } else if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const res = await fetch(API + route, { method, headers, body: payload });
        if (res.status === 429) {
            let wait = 1000;
            try { const j = await res.json(); wait = Math.ceil((j.retry_after || 1) * 1000); } catch (e) { /* ignore */ }
            await sleep(wait + 100);
            continue;
        }
        if (res.status === 204) return null;
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        if (!res.ok) {
            const msg = json && json.message ? json.message : text.slice(0, 200);
            const err = new Error(`Discord ${method} ${route.split('?')[0]} -> ${res.status} ${msg}`);
            err.status = res.status; err.body = json;
            throw err;
        }
        return json;
    }
    throw new Error('Discord rate limit did not clear');
}

async function me(cfg) { return api(cfg, 'GET', '/users/@me'); }

/**
 * Post a message in a channel or thread. Pings are off unless `mentionUsers` names someone: those users are tagged
 * at the front (unless the text already tags them) and only they are notified. Attachments Discord refuses as too
 * large are dropped and the text goes out on its own; the returned message's attachments say which happened.
 * @param {{files?: Array<{name: string, data: Buffer, type?: string}>, mentionUsers?: string[]}} [opts]
 */
async function send(cfg, channelId, text, opts) {
    const o = opts || {};
    const mention = (o.mentionUsers || []).filter(Boolean).map(String);
    const tagged = mention.length && new RegExp(mention.map(id => '<@!?' + id + '>').join('|')).test(text);
    const body = { content: (mention.length && !tagged ? mention.map(id => `<@${id}>`).join(' ') + ' ' : '') + text, allowed_mentions: { parse: [], users: mention } };
    const files = o.files || [];
    if (!files.length) return api(cfg, 'POST', `/channels/${channelId}/messages`, body);
    try { return await api(cfg, 'POST', `/channels/${channelId}/messages`, { ...body, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }, files); }
    catch (e) {
        if (e.status === 413 || /too large|40005/i.test(e.message)) return api(cfg, 'POST', `/channels/${channelId}/messages`, body);
        throw e;
    }
}

module.exports = { config, api, me, send };
