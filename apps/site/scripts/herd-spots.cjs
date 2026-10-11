'use strict';
// The site's spot drawings, drawn with the herd films' engine and cast (see
// scripts/draw-herd.mjs). Each function draws into a transparent canvas measured
// in CSS pixels; the cast is authored at film scale and scaled down here.

/** Display size of each drawing, in CSS pixels. */
const SIZES = {
    fence: [1200, 44],
    herd: [280, 84],
    lost: [420, 330],
    question: [300, 300],
    farm: [620, 330],
    delivery: [360, 260],
    pair: [480, 300],
    'step-install': [64, 64],
    'step-app': [64, 64],
    'step-scan': [64, 64],
};

/** A gently rolling ground line with a few tufts, from x0 to x1 at y. */
function ground(c, id, x0, x1, y, amp, v, o = {}) {
    const pts = [];
    for (let x = x0; x <= x1; x += 12) pts.push([x, y - amp * Math.sin(x / 97 + 1.3) - amp * .45 * Math.sin(x / 41)]);
    ink(c, pts, { id, v, width: o.width ?? 2, rough: .8, pressure: [[0, .15], [.06, 1], [.94, 1], [1, .15]] });
    const every = o.tufts ?? 70;
    for (let x = x0 + every * .6, k = 0; x < x1 - 10; x += every, k++) {
        if (hash(k, id.length) < .3) continue;
        const gy = y - amp * Math.sin(x / 97 + 1.3) - amp * .45 * Math.sin(x / 41) + 1, t = 5 + hash(k, 7) * 4;
        ink(c, [[x - 3, gy], [x - 1.5, gy - t * .8]], { id: `${id}t${k}a`, v, width: 1.1, rough: .2, opacity: .75 });
        ink(c, [[x, gy], [x + .5, gy - t]], { id: `${id}t${k}b`, v, width: 1.1, rough: .2, opacity: .75 });
        ink(c, [[x + 3, gy], [x + 4.5, gy - t * .7]], { id: `${id}t${k}c`, v, width: 1.1, rough: .2, opacity: .75 });
    }
}

/** A post-and-rail fence run between x0 and x1, feet on y. */
function fenceRun(c, id, x0, x1, y, gap, height, v) {
    const posts = [];
    for (let x = x0; x <= x1 + 1; x += gap) posts.push(x);
    posts.forEach((x, k) => {
        const lean = (hash(k, 3) - .5) * 3;
        ink(c, [[x, y + 2], [x + lean * .3, y - height * .5], [x + lean, y - height]], { id: `${id}p${k}`, v, width: 2.1, rough: .4 });
    });
    for (const [r, at] of [[0, .78], [1, .4]]) {
        for (let k = 0; k < posts.length - 1; k++) {
            const a = posts[k], b = posts[k + 1], sag = 1.6 + hash(k + r * 9, 5) * 1.4;
            ink(c, [[a - 2, y - height * at], [(a + b) / 2, y - height * at + sag], [b + 2, y - height * at + hash(k, 11) - .5]], { id: `${id}r${r}${k}`, v, width: 1.6, rough: .5 });
        }
    }
}

/** A hand-inked phone, upright, top-left at x, y. */
function phoneOutline(c, id, x, y, w, h, v, o = {}) {
    const r = w * .2, pts = [];
    for (let i = 0; i <= 40; i++) {
        const u = i / 40, side = Math.floor(u * 4), f = u * 4 - side;
        const corners = [[x + r, y], [x + w, y + r], [x + w - r, y + h], [x, y + h - r]];
        const ends = [[x + w - r, y], [x + w, y + h - r], [x + r, y + h], [x, y + r]];
        pts.push([lerp(corners[side % 4][0], ends[side % 4][0], f), lerp(corners[side % 4][1], ends[side % 4][1], f)]);
    }
    if (o.fill) fillPts(c, pts, o.fill, .7);
    ink(c, [...pts, pts[0]], { id, v, width: o.width ?? 2.2, rough: .35, close: true });
    ink(c, [[x + w * .38, y + h * .07], [x + w * .62, y + h * .07]], { id: id + 'spk', v, width: o.width ?? 2, rough: .1 });
}

/** A few QR-like finder squares and modules in a square box. */
function qr(c, x, y, s, v, id, color = INK) {
    const cell = s / 7;
    c.save(); c.fillStyle = color;
    for (const [fx, fy] of [[0, 0], [4, 0], [0, 4]]) {
        inkRect(c, `${id}f${fx}${fy}`, x + fx * cell + cell * .15, y + fy * cell + cell * .15, cell * 2.7, cell * 2.7, v, { width: Math.max(1.2, cell * .45), rough: .2, n: 3, color });
        c.fillRect(x + (fx + 1) * cell, y + (fy + 1) * cell, cell, cell);
    }
    for (let i = 0; i < 9; i++) if (hash(i, 21) > .35) c.fillRect(x + (4 + i % 3) * cell, y + (4 + Math.floor(i / 3)) * cell, cell * .9, cell * .9);
    c.restore();
}

const DRAW = {
    fence(c, w, h) {
        ground(c, 'fg', 4, w - 4, h - 8, 2.2, 0, { tufts: 90 });
        fenceRun(c, 'ff', 60, w - 60, h - 9, 118, 28, 0);
    },

    herd(c, w, h) {
        // no ground of its own: the herd trots on the fence line it is laid over
        const s = .3;
        sheep(c, 'ewe', 'trot1', 58, h - 9, s, { v: 0, tag: BLUE });
        sheep(c, 'ram', 'trot3', 142, h - 9, s, { v: 1, tag: RED });
        sheep(c, 'lamb', 'trot2', 218, h - 9, s * .95, { v: 2, tag: GREEN, scarf: true });
    },

    lost(c, w, h) {
        const gy = h - 26;
        ground(c, 'lg', 14, w - 14, gy, 2.5, 0, { tufts: 55 });
        // a signpost that points everywhere but here
        const px = 104;
        ink(c, [[px, gy + 2], [px + 1, gy - 110], [px, gy - 200]], { id: 'lp', v: 0, width: 3, rough: .4 });
        const board = (id, y, dir, len) => {
            const x0 = px + (dir > 0 ? -8 : 8), tip = x0 + dir * len, pts = [[x0, y - 13], [tip - dir * 16, y - 14], [tip, y], [tip - dir * 16, y + 13], [x0, y + 12], [x0, y - 13]];
            fillPts(c, pts, WOOL, .6); ink(c, dens(pts, 5), { id, v: 0, width: 2.2, rough: .4 });
            ink(c, [[x0 + dir * 14, y - 2], [x0 + dir * (len * .62), y - 3]], { id: id + 's', v: 0, width: 1.4, rough: .6, opacity: .45 });
            ink(c, [[x0 + dir * 14, y + 4], [x0 + dir * (len * .4), y + 4]], { id: id + 't', v: 0, width: 1.4, rough: .6, opacity: .45 });
        };
        board('lb1', gy - 172, 1, 92);
        board('lb2', gy - 128, -1, 78);
        groundShadow(c, 286, gy, 62, .55);
        sheep(c, 'lamb', 'sad', 280, gy + 1, .72, { v: 0, tag: RED, scarf: true, flip: true });
        bubble(c, 330, gy - 208, 1, { scale: .78 });
    },

    question(c, w, h) {
        const ox = 92, oy = h - 56, s = .58;
        c.save(); c.translate(ox, oy); c.scale(s, s);
        // bench and table, the same carriage furniture he sits at in the films
        inkRect(c, 'qb', -90, 0, 190, 16, 0, { fill: WOOD, width: 2.6 });
        ink(c, [[-70, 16], [-72, 96]], { id: 'qbl1', v: 0, width: 3 });
        ink(c, [[80, 16], [82, 96]], { id: 'qbl2', v: 0, width: 3 });
        inkRect(c, 'qt', 100, -130, 240, 14, 0, { fill: WOOD, width: 2.6 });
        ink(c, [[300, -116], [302, 96]], { id: 'qtl', v: 0, width: 3 });
        c.fillStyle = INK; c.beginPath(); c.roundRect(226, -140, 70, 10, 4); c.fill();
        human(c, 'perk', 0, 0, 1, { v: 0 });
        ink(c, [[-140, 98], [420, 96]], { id: 'qg', v: 0, width: 2.4, rough: .8 });
        c.restore();
        bubble(c, ox + 118, oy - 196, 1, { scale: .6, color: INK });
    },

    farm(c, w, h) {
        const gy = h - 24;
        ground(c, 'fmg', 8, w - 8, gy, 2, 0, { tufts: 64 });
        c.save(); c.translate(26, gy); c.scale(.4, .4);
        const fh = farmhouse(c, 0, 0, 0, { lit: 1 });
        c.restore();
        // puff of chimney smoke
        const cx = 26 + fh.chimney[0] * .4, cy = gy + fh.chimney[1] * .4;
        for (const [k, dx, dy, r] of [[0, 4, -14, 9], [1, 16, -32, 12], [2, 34, -52, 15]]) {
            const b = blob(cx + dx, cy + dy, r, r * .8, 40 + k, { amp: .12 });
            ink(c, [...b, b[0]], { id: 'smk' + k, v: 0, width: 1.5, rough: .4, close: true, opacity: .7 });
        }
        fenceRun(c, 'fmf', 322, w - 20, gy - 2, 72, 40, 0);
        sheep(c, 'ewe', 'stand', 400, gy + 10, .42, { v: 0, tag: BLUE });
        sheep(c, 'ram', 'sad', 492, gy + 14, .44, { v: 1, tag: GREEN, flip: true });
        sheep(c, 'lamb', 'up', 560, gy + 14, .4, { v: 2, tag: BLUE, scarf: true });
    },

    delivery(c, w, h) {
        const gy = h - 30;
        ground(c, 'dg', 10, w - 10, gy, 2, 0, { tufts: 58 });
        motionLines(c, 92, gy - 96, 46, 3, .55, 0, 5);
        groundShadow(c, 206, gy, 70, .5);
        sheep(c, 'ram', 'trot2', 200, gy + 1, .78, { v: 0, tag: BLUE });
        crateOn(c, 194, gy - 20, .6, 0, 'muxr');
        dust(c, 118, gy, .35, -1, 4);
    },

    pair(c, w, h) {
        const ox = 110, oy = h - 44, s = .56;
        c.save(); c.translate(ox, oy); c.scale(s, s);
        inkRect(c, 'pb', -90, 0, 190, 16, 0, { fill: WOOD, width: 2.6 });
        ink(c, [[-70, 16], [-72, 70]], { id: 'pbl1', v: 0, width: 3 });
        ink(c, [[80, 16], [82, 70]], { id: 'pbl2', v: 0, width: 3 });
        inkRect(c, 'pt', 100, -130, 470, 14, 0, { fill: WOOD, width: 2.6 });
        ink(c, [[530, -116], [532, 70]], { id: 'ptl', v: 0, width: 3 });
        // the laptop on the table, its pairing code on screen
        const lx = 340, ly = -130;
        c.fillStyle = INK; c.beginPath(); c.moveTo(lx - 10, ly); c.lineTo(lx + 190, ly); c.lineTo(lx + 176, ly - 10); c.lineTo(lx + 4, ly - 10); c.fill();
        c.save(); c.translate(lx + 176, ly - 10); c.rotate(-.12);
        inkRect(c, 'plid', -150, -134, 150, 134, 0, { fill: '#fffaf0', width: 2.8 });
        qr(c, -122, -110, 92, 0, 'pqr');
        c.restore();
        human(c, 'lift', 0, 0, 1, { v: 0 });
        // the phone in his hand, turned toward the code
        c.save(); c.translate(196, -196); c.rotate(.18);
        phoneOutline(c, 'pph', -18, -66, 40, 76, 0, { fill: INK, width: 2.6 });
        c.restore();
        ink(c, [[-140, 72], [620, 70]], { id: 'pg', v: 0, width: 2.4, rough: .8 });
        c.restore();
        // the link between them, in the lifecycle green
        const a = [ox + 214 * s, oy - 250 * s], b = [ox + 360 * s, oy - 230 * s];
        c.save(); c.setLineDash([3, 5]); c.strokeStyle = GREEN; c.lineWidth = 2; c.lineCap = 'round';
        c.beginPath(); c.moveTo(...a); c.quadraticCurveTo((a[0] + b[0]) / 2, a[1] - 34, ...b); c.stroke(); c.restore();
    },

    'step-install'(c) {
        inkRect(c, 'si', 10, 14, 44, 30, 0, { width: 2.2, n: 5 });
        ink(c, [[3, 50], [61, 50]], { id: 'sib', v: 0, width: 2.4, rough: .3 });
        ink(c, [[6, 50], [10, 44]], { id: 'sil', v: 0, width: 1.8, rough: .2 });
        ink(c, [[58, 50], [54, 44]], { id: 'sir', v: 0, width: 1.8, rough: .2 });
        ink(c, [[18, 23], [24, 28], [18, 33]], { id: 'sip', v: 0, width: 2, rough: .2 });
        ink(c, [[28, 34], [38, 34]], { id: 'siu', v: 0, width: 2, rough: .2, color: GREEN });
    },
    'step-app'(c) {
        phoneOutline(c, 'sa', 18, 6, 28, 52, 0);
        ink(c, [[32, 20], [32, 40]], { id: 'saa', v: 0, width: 2.2, rough: .2, color: GREEN });
        ink(c, [[25, 33], [32, 41], [39, 33]], { id: 'sah', v: 0, width: 2.2, rough: .2, color: GREEN });
    },
    'step-scan'(c) {
        phoneOutline(c, 'ss', 18, 6, 28, 52, 0);
        qr(c, 22.5, 18, 19, 0, 'ssq');
        ink(c, [[8, 12], [8, 6], [14, 6]], { id: 'sc1', v: 0, width: 1.8, rough: .2, color: GREEN });
        ink(c, [[50, 6], [56, 6], [56, 12]], { id: 'sc2', v: 0, width: 1.8, rough: .2, color: GREEN });
        ink(c, [[8, 52], [8, 58], [14, 58]], { id: 'sc3', v: 0, width: 1.8, rough: .2, color: GREEN });
        ink(c, [[50, 58], [56, 58], [56, 52]], { id: 'sc4', v: 0, width: 1.8, rough: .2, color: GREEN });
    },
};

module.exports = { SIZES, DRAW };
