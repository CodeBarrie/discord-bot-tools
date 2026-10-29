'use strict';
// node --test   (Node 18+, no dependencies)
// Which Discord messages wake the desk, now that another desk's bot can ask it for something (peerDesks).
// Runs the real trigger()/heard() against a throwaway config; nothing touches Discord or ~/.discord-desk.
// Two desks: DeskA (run by Alice) and DeskB (run by Bob). Every id here is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-desk-test-'));
const ALICE = '100000000000000001';
const BOB = '100000000000000002';
const DESK_A = '200000000000000001';
const DESK_B = '200000000000000002';
const STRANGER_BOT = '1111111111111111111';
const CHANNEL = '300000000000000001';
const cfgPath = path.join(tmp, 'desk.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    projectRoots: [tmp], allow: [ALICE, BOB],
    operator: { id: ALICE, name: 'Alice' },
    peerDesks: [{ id: DESK_B, name: 'DeskB', for: 'Bob' }]
}));
process.env.DESK_CONFIG = cfgPath;
process.env.DESK_DIR = path.join(tmp, 'desk');
const desk = require('../desk.js');

// Alice's desk (DeskA), with DeskB as its peer; and Bob's desk (DeskB), with DeskA as its peer.
const aCtx = () => ({ botId: DESK_A, botRoleId: null, allow: new Set([ALICE, BOB]), peers: new Map([[DESK_B, { id: DESK_B, name: 'DeskB', for: 'Bob' }]]) });
const bCtx = () => ({ botId: DESK_B, botRoleId: null, allow: new Set([ALICE, BOB]), peers: new Map([[DESK_A, { id: DESK_A, name: 'DeskA', for: 'Alice' }]]) });
const fresh = () => ({ pending: {} });

let n = 1553900000000000000n;
const NAMES = { [ALICE]: 'alice', [BOB]: 'bob', [DESK_A]: 'DeskA', [DESK_B]: 'DeskB' };
const user = (id, bot) => ({ id, username: NAMES[id] || 'somebot', bot: !!bot });
/** a Discord message; `tags` are the user ids it @mentions (in the text and resolved by Discord) */
function msg(authorId, text, { bot = false, tags = [], replyTo = null, webhook = false, textOnlyTag = null } = {}) {
    const content = [...tags.map(id => `<@${id}>`), textOnlyTag ? `\`<@${textOnlyTag}>\`` : null, text].filter(Boolean).join(' ');
    return {
        id: String(n++), type: replyTo ? 19 : 0, timestamp: new Date().toISOString(), content,
        author: user(authorId, bot), mentions: tags.map(id => user(id, [DESK_A, DESK_B].includes(id))), mention_roles: [],
        ...(webhook ? { webhook_id: authorId } : {}),
        ...(replyTo ? { message_reference: { message_id: replyTo.id }, referenced_message: replyTo } : {})
    };
}
const thread = { id: '1553887300000000000', name: 'logo animation' };

test('a DeskB message that tags DeskA is a request, attributed to Bob from the signature', () => {
    const m = msg(DESK_B, 'please export the overlays with alpha.\n\n— Claude, for Bob', { bot: true, tags: [DESK_A] });
    const h = desk.heard(m, thread, aCtx(), fresh());
    assert.strictEqual(h.act, 'request');
    assert.strictEqual(h.why, 'peer desk tagged');
    assert.deepStrictEqual(h.onBehalfOf, { name: 'Bob', source: 'signed' });
    const s = desk.shape(m, thread.id, h.peer, h.onBehalfOf);
    assert.strictEqual(s.author, 'DeskB (peer desk, for Bob)');
    assert.strictEqual(s.peerDesk, 'DeskB');
});

test('an unsigned peer request falls back to the configured "for"', () => {
    const h = desk.heard(msg(DESK_B, 'can you check the render?', { bot: true, tags: [DESK_A] }), thread, aCtx(), fresh());
    assert.strictEqual(h.act, 'request');
    assert.deepStrictEqual(h.onBehalfOf, { name: 'Bob', source: 'config' });
});

test('a peer message without a tag is not a request', () => {
    assert.strictEqual(desk.heard(msg(DESK_B, 'title test finished.', { bot: true }), thread, aCtx(), fresh()).act, 'ignore');
});

test('a tag the text carries but Discord did not resolve (code block, quote, a desk reply sent with mentions off) does not count', () => {
    const m = msg(DESK_B, 'DeskA is tagged as shown', { bot: true, textOnlyTag: DESK_A });
    assert.strictEqual(desk.heard(m, thread, aCtx(), fresh()).act, 'ignore');
});

test('a tag inside a quote or code does not count, even when Discord resolved it', () => {
    const a = aCtx();
    const q = msg(DESK_B, 'x', { bot: true, tags: [DESK_A] });
    const tag = `<@${DESK_A}>`;
    for (const content of [`> ${tag} can you do this?\nquoting Alice above`, `>>> ${tag} all of this is quoted`, 'see `' + tag + '`', '```\n' + tag + ' render\n```']) {
        assert.strictEqual(desk.trigger({ ...q, content }, a), null, content);
    }
    assert.strictEqual(desk.trigger({ ...q, content: `> Alice said render it\n${tag} please do` }, a), 'peer desk tagged');
});

test('a peer Reply to this desk\'s own post is never a request, even with a tag', () => {
    const ours = msg(DESK_A, 'Here are the overlays.', { bot: true });
    const m = msg(DESK_B, 'thanks, and one more: the lower third too', { bot: true, tags: [DESK_A], replyTo: ours });
    assert.strictEqual(desk.trigger(m, aCtx()), null);
    // a Reply without its referenced message (deleted) is refused too
    const orphan = { ...m, id: String(n++), referenced_message: null };
    assert.strictEqual(desk.trigger(orphan, aCtx()), null);
    // a Reply to someone else's message that tags this desk is fine
    const bobs = msg(BOB, 'we need the overlays');
    assert.strictEqual(desk.trigger(msg(DESK_B, 'relaying this', { bot: true, tags: [DESK_A], replyTo: bobs }), aCtx()), 'peer desk tagged');
});

test('the desk never triggers on its own messages', () => {
    const ctx = aCtx();
    ctx.peers.set(DESK_A, { id: DESK_A, name: 'DeskA' });     // even if misconfigured as its own peer
    assert.strictEqual(desk.trigger(msg(DESK_A, 'hello me', { bot: true, tags: [DESK_A] }), ctx), null);
    const ours = msg(DESK_A, 'earlier post', { bot: true });
    assert.strictEqual(desk.trigger(msg(DESK_A, 'reply to myself', { bot: true, replyTo: ours }), ctx), null);
});

test('an unlisted bot or a webhook does not trigger, tag or not', () => {
    assert.strictEqual(desk.heard(msg(STRANGER_BOT, 'do a thing', { bot: true, tags: [DESK_A] }), thread, aCtx(), fresh()).act, 'ignore');
    // a webhook can post under any name, but not as a listed bot user: webhook messages are refused outright
    assert.strictEqual(desk.trigger(msg(DESK_B, 'do a thing', { bot: true, tags: [DESK_A], webhook: true }), aCtx()), null);
    // a peer desk tagging a different bot is not for us
    assert.strictEqual(desk.trigger(msg(DESK_B, 'for someone else', { bot: true, tags: [STRANGER_BOT] }), aCtx()), null);
});

test('a peer acknowledgement gets the reaction, not a request, and does not use up the hop', () => {
    const state = fresh();
    assert.strictEqual(desk.heard(msg(DESK_B, 'thanks!', { bot: true, tags: [DESK_A] }), thread, aCtx(), state).act, 'ack');
    assert.strictEqual(desk.heard(msg(DESK_B, 'now render the intro', { bot: true, tags: [DESK_A] }), thread, aCtx(), state).act, 'request');
});

test('two desks tagging each other stop after one round each, and a person restarts it', () => {
    const a = aCtx(), b = bCtx();
    const aState = fresh(), bState = fresh();
    // Bob asks DeskB in the thread; both desks see it (DeskA is not tagged, so it only resets its hop count)
    const ask = msg(BOB, 'ask DeskA for the overlays', { tags: [DESK_B] });
    assert.strictEqual(desk.heard(ask, thread, b, bState).act, 'request');
    assert.strictEqual(desk.heard(ask, thread, a, aState).act, 'ignore');

    // DeskB's worker tags DeskA: DeskA takes it (its one hop in this thread)
    const hop1 = msg(DESK_B, 'please export the overlays\n— Claude, for Bob', { bot: true, tags: [DESK_A] });
    assert.strictEqual(desk.heard(hop1, thread, a, aState).act, 'request');
    assert.strictEqual(desk.heard(hop1, thread, b, bState).act, 'ignore');       // DeskB's own post

    // DeskA's worker answers and tags DeskB back: DeskB takes it (its one hop)
    const hop2 = msg(DESK_A, 'done, exported. can you post them to Drive?', { bot: true, tags: [DESK_B] });
    aState.pending = {}; bState.pending = {};                                        // bursts settled into jobs
    assert.strictEqual(desk.heard(hop2, thread, b, bState).act, 'request');

    // DeskB's worker tags DeskA again: refused, and so is every further round, both ways
    const hop3 = msg(DESK_B, 'posted. anything else?', { bot: true, tags: [DESK_A] });
    bState.pending = {};
    const r3 = desk.heard(hop3, thread, a, aState);
    assert.strictEqual(r3.act, 'refused');
    assert.match(r3.reason, /hop limit/);
    for (let i = 0; i < 5; i++) {
        assert.strictEqual(desk.heard(msg(DESK_A, `round ${i}`, { bot: true, tags: [DESK_B] }), thread, b, bState).act, 'refused');
        assert.strictEqual(desk.heard(msg(DESK_B, `round ${i}`, { bot: true, tags: [DESK_A] }), thread, a, aState).act, 'refused');
    }

    // a person posting in the thread (even untagged) lets a peer ask once more
    desk.heard(msg(ALICE, 'looks good'), thread, a, aState);
    assert.strictEqual(desk.heard(msg(DESK_B, 'one more: the lower third', { bot: true, tags: [DESK_A] }), thread, a, aState).act, 'request');

    // an unlisted person posting does not reset it
    aState.pending = {};
    desk.heard(msg('999999999999999999', 'hi'), thread, a, aState);
    assert.strictEqual(desk.heard(msg(DESK_B, 'render the outro too', { bot: true, tags: [DESK_A] }), thread, a, aState).act, 'refused');
});

test('hops are counted per thread; a second message in the same pending burst joins it', () => {
    const a = aCtx(), state = fresh();
    const other = { id: '1553000000000000001', name: 'another thread' };
    // heard() then enqueue() is what the tick does with each message
    const first = msg(DESK_B, 'first', { bot: true, tags: [DESK_A] });
    const h1 = desk.heard(first, thread, a, state);
    assert.strictEqual(h1.act, 'request');
    desk.enqueue(state, first, thread, h1, CHANNEL);                             // still inside QUIET_MS
    assert.strictEqual(state.pending[thread.id].peerAdmitted, true);
    const second = msg(DESK_B, 'and also this', { bot: true, tags: [DESK_A] });
    const h2 = desk.heard(second, thread, a, state);
    assert.strictEqual(h2.act, 'request');
    desk.enqueue(state, second, thread, h2, CHANNEL);
    assert.strictEqual(state.pending[thread.id].messages.length, 2);
    assert.strictEqual(state.pending[thread.id].messages[1].author, 'DeskB (peer desk, for Bob)');
    assert.strictEqual(desk.heard(msg(DESK_B, 'different thread', { bot: true, tags: [DESK_A] }), other, a, state).act, 'request');
});

test('riding along with a pending human request still uses the hop', () => {
    const a = aCtx(), state = fresh();
    // Alice's request is pending (no peer admitted into it yet); DeskB's tag joins it and takes the thread's hop
    const alices = msg(ALICE, 'render the intro', { tags: [DESK_A] });
    desk.enqueue(state, alices, thread, desk.heard(alices, thread, a, state), CHANNEL);
    assert.ok(!state.pending[thread.id].peerAdmitted);
    assert.strictEqual(desk.heard(msg(DESK_B, 'riding along', { bot: true, tags: [DESK_A] }), thread, a, state).act, 'request');
    state.pending = {};                                                                       // that burst ran
    assert.strictEqual(desk.heard(msg(DESK_B, 'and again', { bot: true, tags: [DESK_A] }), thread, a, state).act, 'refused');
});

test('a person posting mid-burst gives the peer one fresh hop, not an open door', () => {
    const a = aCtx(), state = fresh();
    const first = msg(DESK_B, 'first', { bot: true, tags: [DESK_A] });
    desk.enqueue(state, first, thread, desk.heard(first, thread, a, state), CHANNEL);
    const bob = msg(BOB, 'yes please');                                                   // untagged: not a request to DeskA
    assert.strictEqual(desk.heard(bob, thread, a, state).act, 'ignore');
    assert.strictEqual(state.pending[thread.id].peerAdmitted, false);
    const second = msg(DESK_B, 'second, after Bob', { bot: true, tags: [DESK_A] });
    const hb = desk.heard(second, thread, a, state);
    assert.strictEqual(hb.act, 'request');                                                    // spends the fresh hop
    desk.enqueue(state, second, thread, hb, CHANNEL);
    state.pending = {};                                                                       // burst ran
    assert.strictEqual(desk.heard(msg(DESK_B, 'third', { bot: true, tags: [DESK_A] }), thread, a, state).act, 'refused');
});

test('a system message by a person (a pin) does not reset the thread', () => {
    const a = aCtx(), state = fresh();
    assert.strictEqual(desk.heard(msg(DESK_B, 'first', { bot: true, tags: [DESK_A] }), thread, a, state).act, 'request');
    desk.heard({ ...msg(ALICE, ''), type: 6 }, thread, a, state);
    assert.strictEqual(desk.heard(msg(DESK_B, 'again after a pin', { bot: true, tags: [DESK_A] }), thread, a, state).act, 'refused');
});

test('only a person resets a thread, not time', () => {
    const a = aCtx(), state = fresh();
    const t0 = Date.now();
    assert.strictEqual(desk.heard(msg(DESK_B, 'first', { bot: true, tags: [DESK_A] }), thread, a, state, t0).act, 'request');
    const later = t0 + 30 * 24 * 3600 * 1000;
    assert.strictEqual(desk.heard(msg(DESK_B, 'a month on', { bot: true, tags: [DESK_A] }), thread, a, state, later).act, 'refused');
});

test('peer messages are capped per hour across threads', () => {
    const a = aCtx(), state = fresh();
    const t0 = Date.now();
    let accepted = 0;
    for (let i = 0; i < desk.PEER_WAKES_PER_HOUR + 3; i++) {
        const r = desk.heard(msg(DESK_B, `job ${i}`, { bot: true, tags: [DESK_A] }), { id: String(1554000000000000000n + BigInt(i)), name: `t${i}` }, a, state, t0 + i);
        if (r.act === 'request') accepted++; else assert.match(r.reason, /hourly cap/);
    }
    assert.strictEqual(accepted, desk.PEER_WAKES_PER_HOUR);
    // an hour later the cap has cleared
    assert.strictEqual(desk.heard(msg(DESK_B, 'later', { bot: true, tags: [DESK_A] }), { id: '1555000000000000000', name: 'later' }, a, state, t0 + 3600001).act, 'request');
});

test('people: unchanged behaviour', () => {
    const a = aCtx();
    const ours = msg(DESK_A, 'a desk post', { bot: true });
    assert.strictEqual(desk.trigger(msg(BOB, 'render it', { tags: [DESK_A] }), a), 'tagged');
    assert.strictEqual(desk.trigger(msg(ALICE, 'and this', { replyTo: ours }), a), 'reply to bot');
    assert.strictEqual(desk.trigger(msg(BOB, 'just chatting with Alice'), a), null);
    assert.strictEqual(desk.trigger(msg('999999999999999999', 'hey', { tags: [DESK_A] }), a), null);   // not on the allow list
    // a person's reply to a peer's post is not a request to this desk
    const peers = msg(DESK_B, 'DeskB post', { bot: true });
    assert.strictEqual(desk.trigger(msg(BOB, 'nice', { replyTo: peers }), a), null);
    // people are never hop-limited, however many peer rounds happened
    const state = fresh();
    state.peerHops = { [thread.id]: { n: 99, at: Date.now() } };
    state.peerWakes = Array(50).fill(Date.now());
    assert.strictEqual(desk.heard(msg(BOB, 'render it', { tags: [DESK_A] }), thread, a, state).act, 'request');
    // and a desk with no peerDesks configured ignores every bot, as before
    const plain = { ...a, peers: new Map() };
    assert.strictEqual(desk.trigger(msg(DESK_B, 'do it', { bot: true, tags: [DESK_A] }), plain), null);
    assert.strictEqual(desk.trigger(msg(DESK_B, 'do it', { bot: true, tags: [DESK_A] }), { ...a, peers: undefined }), null);
});

test('peerOnBehalfOf reads only a signature line', () => {
    assert.deepStrictEqual(desk.peerOnBehalfOf('text\n— Claude, for Bob', null), { name: 'Bob', source: 'signed' });
    assert.deepStrictEqual(desk.peerOnBehalfOf('text\n-- Codex, for Alice.', null), { name: 'Alice', source: 'signed' });
    assert.deepStrictEqual(desk.peerOnBehalfOf('this is for Bob, not you', { for: 'Alice' }), { name: 'Alice', source: 'config' });
    assert.deepStrictEqual(desk.peerOnBehalfOf('no signature', null), { name: null, source: 'unknown' });
});

test('config: peerDesks must hold bot ids, and a person cannot be listed as one', () => {
    const { spawnSync } = require('child_process');
    const run = cfg => {
        const p = path.join(tmp, `bad-${n++}.json`);
        fs.writeFileSync(p, JSON.stringify({ projectRoots: [tmp], allow: [ALICE, BOB], ...cfg }));
        return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'desk.js'))})`], { env: { ...process.env, DESK_CONFIG: p }, encoding: 'utf-8' });
    };
    assert.match(run({ peerDesks: { id: DESK_B } }).stderr, /peerDesks must be a list/);
    assert.match(run({ peerDesks: [{ name: 'DeskB' }] }).stderr, /needs an "id"/);
    assert.match(run({ peerDesks: [{ id: ALICE }] }).stderr, /also in "allow"/);
    assert.strictEqual(run({ peerDesks: [{ id: DESK_B, name: 'DeskB' }] }).status, 0);
});
