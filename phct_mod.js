window.PHCT_VERSION = 4;
// PHCT mod (phone): settings + game speed. Loaded from main.js before the game code; everything that touches game modules
// waits for EVENT_GAME_INITED, and works on the code of whichever hot update the phone has (no change to project.jsc).
(function () {
    if (window.PHCT) return;
    var KEY = "phct_mod_cfg", DEF = { ka: 4, kn: 2, kb: true, noPop: true, noLock: true, noTouchFx: false, block: false, autoDebate: false, autoErrand: false, alerts: true, x: 0, y: 0 };
    var cfg = {};
    try { cfg = JSON.parse(cc.sys.localStorage.getItem(KEY) || "{}") || {}; } catch (e) { }
    for (var k in DEF) if (cfg[k] === undefined) cfg[k] = DEF[k];
    var BLOCK = ["NoticePopup", "NewBannerPopup", "HaremAnnunciatePopup", "RankWrshpPopup"];
    window.PHCT = {
        cfg: cfg,
        save: function () { try { cc.sys.localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { } }
    };
    // The last script errors of the game go to files/phct/err.log: after a crash the menu can show where it stopped.
    var oldErr = window.__errorHandler;
    window.__errorHandler = function (file, line, msg, stack) {
        try {
            var F = jsb.fileUtils, D = F.getWritablePath() + "phct/", P2 = D + "err.log", o = F.isFileExist(P2) ? F.getStringFromFile(P2) : "";
            F.createDirectory(D);
            F.writeStringToFile((o + new Date().toLocaleString() + " " + msg + " @" + file + ":" + line + "\n" + String(stack || "").slice(0, 400) + "\n").slice(-6000), P2);
        } catch (e) { }
        if (oldErr) return oldErr.apply(this, arguments);
    };
    // Only the dt of these three is scaled; the global Scheduler keeps real time, so network timeouts and heartbeats are not touched.
    function hook(proto, factor) {
        if (!proto || typeof proto.update !== "function" || proto.__phct) return;
        var orig = proto.update;
        proto.update = function (dt) { return orig.call(this, dt * factor()); };
        proto.__phct = true;
    }
    hook(cc.ActionManager && cc.ActionManager.prototype, function () { return cfg.ka; });
    hook(cc.AnimationManager && cc.AnimationManager.prototype, function () { return cfg.kn; });
    hook(cc.Button && cc.Button.prototype, function () { return cfg.kb ? 20 : 1; });

    function gameHooks() {
        var R = window.__require;
        function tryHook(name, fn) { try { fn(); } catch (e) { console.log("PHCT hook " + name + ": " + e); } }
        tryHook("popup", function () {   // the 0.2 s pop-in, with the buttons locked meanwhile
            var p = R("Popup").default.prototype, o = p.onLoad;
            p.onLoad = function () {
                o.apply(this, arguments);
                if (cfg.noPop && this.popping) { this.node.stopAllActions(); this.node.setScale(1, 1); this.interactable = true; }
            };
        });
        tryHook("click lock", function () {   // ButtonAudio locks a button for 0.3 s after each press
            var p = cc.Button.prototype, o = p.setDelay;
            if (o) p.setDelay = function () { if (!cfg.noLock) return o.apply(this, arguments); };
        });
        tryHook("touch effect", function () {
            var p = R("UIManager").default.prototype, o = p.touchBeginHandler;
            p.touchBeginHandler = function () { if (!cfg.noTouchFx) return o.apply(this, arguments); };
        });
        tryHook("block popups", function () {   // popups the game opens by itself
            function blocked(t) {
                if (!cfg.block) return false;
                for (var i = 0; i < BLOCK.length; i++) {
                    if (t === BLOCK[i]) return true;
                    try { if (typeof t === "function" && t === getRC(BLOCK[i])) return true; } catch (e) { }
                }
                return false;
            }
            [R("ControllerBase").default.prototype, R("TopController").default.prototype].forEach(function (p) {
                var o = p.createPopup;
                p.createPopup = function (t) {
                    if (blocked(t)) return;
                    var r = o.apply(this, arguments);
                    if (t === "ConfidantShowPopup" && arguments[2] === true && window.PHCT.tasks) {   // yes to "Săn Sóc Nhanh tất cả": the game only does this one
                        var id = arguments[1], T = window.PHCT.tasks;
                        T.run("Săn Sóc tất cả", function () { return T.sanSocAll(id); });
                    }
                    return r;
                };
            });
        });
        tryHook("server refusal", function () {
            // A refusal whose msg is a number crashes the game's reader (msg.indexOf), the request queue then stays stuck forever;
            // the token it carries must also be kept, or the next request loses the session.
            var p = R("NetManager").default.prototype, o = p.processResponse;
            p.processResponse = function (t, e, n, r) {
                try {
                    if (e != 200 && e != 520 && n) {
                        var j = JSON.parse(n);
                        if (j && j.token !== undefined) this.setToken(j.token);
                        if (j && j.msg !== undefined && typeof j.msg !== "string") { j.msg = String(j.msg); n = JSON.stringify(j); }
                    }
                } catch (x) { }
                return o.call(this, t, e, n, r);
            };
        });
    }
    if (window.__require) gameHooks();
    else cc.game.once(cc.game.EVENT_GAME_INITED, gameHooks);
})();

// AGENT: lets the local Manager inspect the current screen and press buttons.
// It only performs what a finger tap does (fires the Button's click event); it does not touch the
// network layer of the game. Talks to the Manager over plain HTTP on the emulator host loopback.
(function () {
    if (typeof jsb === "undefined") return;
    var BASE = "http://10.0.2.2:@@PORT@@";
    var cfgPath = jsb.fileUtils.getWritablePath() + "agent_id.txt";   // "<slot>|<token>", written by the Manager
    function L(m) { try { console.log("AGENT " + m); } catch (e) { } }

    function readCfg() {
        try {
            if (!jsb.fileUtils.isFileExist(cfgPath)) return null;
            var s = jsb.fileUtils.getStringFromFile(cfgPath).trim().split("|");
            return s.length >= 2 ? { id: s[0], token: s[1] } : null;
        } catch (e) { return null; }
    }

    function http(method, path, body, cb) {
        var done = false;
        function fin(v) { if (!done) { done = true; cb(v); } }
        try {
            var x = new XMLHttpRequest();
            x.open(method, BASE + path, true);
            x.timeout = 8000;
            x.onreadystatechange = function () { if (x.readyState === 4) fin(x.status === 200 ? x.responseText : null); };
            x.onerror = function () { fin(null); };
            x.ontimeout = function () { fin(null); };
            x.send(body || null);
            // this runtime does not honour x.timeout: give up by hand, a hung request must not stall the agent for minutes
            var h0 = Date.now();
            setTimeout(function () { if (!done) { try { x.abort(); } catch (e) { } try { window.__fastui_log && window.__fastui_log("agent", "http-hang " + method + " " + path.split("?")[0] + " " + (Date.now() - h0) + "ms"); } catch (e2) { } fin(null); } }, 6000);
        } catch (e) { fin(null); }
    }

    // ---- screen inspection -------------------------------------------------------------------
    function pathOf(n) {
        var a = [];
        for (var p = n; p && p.parent; p = p.parent) a.push(p.name);   // skip the Scene itself
        return a.reverse().join("/");
    }
    function visible(n) {
        for (var p = n; p && p.parent; p = p.parent) { if (!p.active || p.opacity === 0) return false; }   // not the Scene itself
        try {
            var r = n.getBoundingBoxToWorld(), v = cc.view.getVisibleSize();
            if (r.xMax < 0 || r.yMax < 0 || r.xMin > v.width || r.yMin > v.height) return false;
        } catch (e) { }
        return true;
    }
    function textOf(n) {
        var q = [n], i = 0;
        while (i < q.length && i < 60) {
            var c = q[i++], l = c.getComponent(cc.Label) || c.getComponent(cc.RichText);
            if (l && l.string && String(l.string).trim()) return String(l.string).replace(/<[^>]+>/g, "").trim();
            for (var k = 0; k < c.children.length; k++) q.push(c.children[k]);
        }
        return "";
    }
    function collect() {
        var scene = cc.director.getScene(), out = { scene: scene ? scene.name : null, buttons: [], labels: [] };
        out.size = [cc.view.getVisibleSize().width, cc.view.getVisibleSize().height];
        var t0 = Date.now(), visited = 0;
        (function walk(n) {
            if (!n.active) return;
            // some screens (character art with skeleton animations) hold thousands of nodes: never spend more than ~1.5 s
            if (++visited > 8000 || (visited % 64 === 0 && Date.now() - t0 > 1500)) { out.truncated = true; return; }
            try { if (window.dragonBones && n.getComponent(dragonBones.ArmatureDisplay)) return; } catch (e) { }
            try { if (window.sp && n.getComponent(sp.Skeleton)) return; } catch (e) { }
            var b = n.getComponent(cc.Button);
            if (b && b.interactable && out.buttons.length < 400 && visible(n)) {
                var c = n.convertToWorldSpaceAR(cc.v2(0, 0));
                out.buttons.push({ p: pathOf(n), t: textOf(n), x: Math.round(c.x), y: Math.round(c.y) });
            }
            var l = n.getComponent(cc.Label);
            if (l && l.string && out.labels.length < 400 && visible(n)) out.labels.push({ p: pathOf(n), t: String(l.string).trim() });
            for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
        })({ active: true, getComponent: function () { return null; }, children: scene ? scene.children : [] });   // the Scene node itself can report active=false
        return out;
    }
    function findButtons(a) {
        var all = collect().buttons, want = a.text != null ? String(a.text).trim() : null, res = [];
        for (var i = 0; i < all.length; i++) {
            var b = all[i];
            if (a.path != null && b.p !== a.path) continue;
            if (want != null && (a.contains ? b.t.indexOf(want) < 0 : b.t !== want)) continue;
            res.push(b);
        }
        return res;
    }
    function clickNode(path) {   // same path as a real tap: Button.clickEvents + the node's 'click' event
        var n = cc.find(path, cc.director.getScene());
        var b = n && n.getComponent(cc.Button);
        if (!b || !b.interactable) return false;
        cc.Component.EventHandler.emitEvents(b.clickEvents, new cc.Event.EventCustom("click", true));
        n.emit("click", b);
        return true;
    }

    // ---- observation: log every real button press (path + label) ----------------------------
    // Called from inside the game's own cc.Button._onTouchEnded (patched in project.js), because the game
    // re-defines that method at startup and would overwrite any hook installed from outside.
    window.__fastui_click = function (btn) {
        try { window.__fastui_log("click", pathOf(btn.node) + " | " + textOf(btn.node)); } catch (e) { }
    };

    // ---- observation 3: which game function a pressed button runs --------------------------------
    // Button 'click' listeners (code-registered) and clickEvents (editor-assigned) are described by owner class + the
    // first characters of the function, which can be searched in the game's project.js.
    function describeFn(fn, target) {
        var owner = "";
        try { owner = target ? (target.name || (target.constructor && target.constructor.name) || "") : ""; } catch (e) { }
        var src = "";
        try { src = String(fn).replace(/\s+/g, " ").slice(0, 160); } catch (e) { }
        return (owner ? owner + " :: " : "") + src;
    }
    function listenersOf(node, type) {
        var out = [], inv = node._bubblingListeners, tab = inv && inv._callbackTable && inv._callbackTable[type];
        var arr = tab && (tab.callbacks || tab);
        if (arr && arr.length) {
            // 2.1.x stores [cb, target, cb, target...]; older code stores [{callback, target}]
            if (typeof arr[0] === "function") { for (var i = 0; i < arr.length; i += 2) out.push([arr[i], arr[i + 1]]); }
            else arr.forEach(function (c) { if (c && c.callback) out.push([c.callback, c.target]); });
        }
        return out;
    }
    try {
        var NP = cc.Node.prototype, origEmit = NP.emit, origOn = NP.on;
        // Remember every 'click' handler at the moment it is registered: the game's real handler is registered
        // by its controller (the sound-effect wrapper is only one of several listeners on the same node).
        if (origOn && !NP.__onlog) {
            NP.on = function (type, cb, target) {
                try {
                    if (type === "click" && typeof cb === "function") {
                        (this.__clickHandlers || (this.__clickHandlers = [])).push(describeFn(cb, target));
                    }
                } catch (e) { }
                return origOn.apply(this, arguments);
            };
            NP.__onlog = true;
        }
        if (origEmit && !NP.__emitlog) {
            NP.emit = function (type) {
                try {
                    if (type === "click" && window.__fastui_log) {
                        var hs = (this.__clickHandlers || []).filter(function (h) { return h.indexOf("playEffect") < 0; });
                        if (!hs.length) hs = listenersOf(this, "click").map(function (p) { return describeFn(p[0], p[1]); });
                        var b = this.getComponent(cc.Button);
                        (b && b.clickEvents || []).forEach(function (ev) {
                            hs.push("[editor] " + (ev.target && ev.target.name) + "/" + (ev.component || "") + "." + ev.handler);
                        });
                        window.__fastui_log("handler", pathOf(this) + " => " + (hs.length ? hs.join("  ;;  ") : "(no listener found)"));
                    }
                } catch (e) { }
                return origEmit.apply(this, arguments);
            };
            NP.__emitlog = true;
        }
    } catch (e) { }

    // ---- observation 2: every touch on the screen + the button under the finger -----------------
    // Independent of the Button hook above: listens to raw touches, then finds the top-most visible button there.
    function buttonAt(pt) {
        var hit = null;
        (function walk(n) {
            if (!n.active) return;
            var b = n.getComponent(cc.Button);
            if (b && b.interactable) {
                try { if (n.getBoundingBoxToWorld().contains(pt) && visible(n)) hit = n; } catch (e) { }
            }
            for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
        })(cc.director.getScene());
        return hit;   // later in the tree = drawn on top
    }
    try {
        cc.eventManager.addListener(cc.EventListener.create({
            event: cc.EventListener.TOUCH_ONE_BY_ONE,
            swallowTouches: false,
            onTouchBegan: function (touch) {
                try {
                    var p = touch.getLocation(), n = buttonAt(p);
                    window.__fastui_log && window.__fastui_log("tap", "(" + Math.round(p.x) + "," + Math.round(p.y) + ") -> " +
                        (n ? pathOf(n) + " | " + textOf(n) : "(no button)"));
                } catch (e) { }
                return false;   // observe only, never take the touch
            }
        }), 1);
    } catch (e) { }

    // ---- server list (account screen) --------------------------------------------------------
    function R(name) { return window.__require(name); }
    function acctCtrl() {   // the controller of the account/server screen holds serverList + serverIdTable
        var c = R("ControllerManager").default.getInstance().getTopController();
        if (!c || !c.serverList || !c.serverIdTable) throw new Error("not on the account/server screen");
        return c;
    }
    function allServers(c) {
        var out = [], t = c.serverIdTable;
        for (var k in t) { var s = t[k]; out.push({ id: s.id !== undefined ? s.id : k, name: s.name, sts: s.sts, access: s.access, merge_to: s.merge_to }); }
        return out;
    }

    // ---- "Bái Kiến" (worship the top player of each ranking for gold) -------------------------
    // Same request the Bái Kiến button sends (ProfileModel.reqRankListWorship); no screen needed.
    var RANK_NAMES = { power: "Thế Lực", trunk: "Cốt truyện", follow: "Đồng Hành", favor: "Thiện Cảm",
                       costume: "Phục Sức", child: "Nghĩa Tử", pet: "Pet" };
    function worshipInfo() {
        // every ranking tab of the Bái Kiến screen, asked one by one like its button does (isTodayCanWorshipRankByTypeIdx):
        // getTodayCanWorshipTypeIdxList only lists tabs the server already sent a date for, so a new account showed only "power"
        var pm = R("ProfileModel"), m = pm.default.getInstance(), types = pm.PRankListType, can = [];
        for (var i = 0; i < types.length; i++) if (RANK_NAMES[types[i]] && m.isTodayCanWorshipRankByTypeIdx(i)) can.push(i);
        return { m: m, types: types, can: can };
    }
    function worshipAll() {
        return new Promise(function (resolve) {
            var w = worshipInfo(), todo = w.can.slice(), done = [];
            (function next() {
                if (!todo.length) return resolve({ done: done, remaining: worshipInfo().can.map(function (i) { return w.types[i]; }) });
                var idx = todo.shift(), type = w.types[idx];
                w.m.reqRankListWorship(idx, function (ok, msg) {
                    var reward = null;
                    try { reward = JSON.parse(JSON.stringify(R("RewardModel").default.getInstance().getLastReward())); } catch (e) { }
                    done.push({ idx: idx, type: type, name: RANK_NAMES[type] || type, ok: !!ok,
                                msg: ok ? "" : String(msg || "").slice(0, 80), reward: ok ? reward : null });
                    setTimeout(next, 300);
                });
            })();
        });
    }

    // ---- "Thỉnh An" (daily greeting to the empress, gold reward) ------------------------------
    // Same request as the Thỉnh An button in the greeting popup (GreetingModel.greet -> greeting/do).
    // id = position of the character; 1 is the empress in the middle.
    function greetOnce(pos) {
        return new Promise(function (resolve) {
            var g = R("GreetingModel").default.getInstance();
            if (g.ifGreet()) return resolve({ already: true, greeted: true });
            g.greet(pos || 1, function () {
                setTimeout(function () {   // the server pushes the new greeting data right after the reply
                    var rw = null;
                    try { rw = JSON.parse(JSON.stringify(R("RewardModel").default.getInstance().getLastReward())); } catch (e) { }
                    resolve({ already: false, greeted: !!g.ifGreet(), reward: rw });
                }, 800);
            });
        });
    }

    function safe(o, max) {   // JSON-safe copy with a size cap
        try { var s = JSON.stringify(o); return s.length > (max || 3000) ? s.slice(0, max || 3000) + "..." : JSON.parse(s); }
        catch (e) { return String(o); }
    }

    function clickNodeObj(n) {   // same as clickNode, but for a node we already hold (paths are ambiguous between same-named siblings)
        var b = n && n.getComponent(cc.Button);
        if (!b || !b.interactable) return false;
        cc.Component.EventHandler.emitEvents(b.clickEvents, new cc.Event.EventCustom("click", true));
        n.emit("click", b);
        return true;
    }
    function storyOptions() {
        var po = null, out = [];
        (function walk(n) {
            if (po || !n.active) return;
            if (n.name === "PnOption") { po = n; return; }
            for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
        })({ active: true, name: "", children: cc.director.getScene().children });
        if (po) po.children.forEach(function (c) {
            var d = c.active && c.userData && c.userData["default"];
            if (d && d.index != null) out.push({ index: d.index, text: String(d.text || "").slice(0, 60), p: pathOf(c), node: c });
        });
        return out;
    }

    function handle(c) {
        var a = c.args || {};
        switch (c.cmd) {
            case "affairs_status": {   // Cung vu (AffairsPanel): current event + turns left
                var am0 = R("AffairsModel").default.getInstance(), d0 = am0.getAffairsData();
                return { count: d0.count, hasEvent: !!d0.current, options: d0.current ? d0.current.options.length : 0 };
            }
            case "affairs": {   // answer the Cung vu events with option `choice` (default 2) until no turns are left
                var choice = String(a.choice || 2), am = R("AffairsModel").default.getInstance();
                return new Promise(function (resolve) {
                    var done = 0, fin = false, log = [];
                    function end(note) {
                        if (fin) return; fin = true;
                        var d = am.getAffairsData();
                        resolve({ done: done, left: d.count, hasEvent: !!d.current, note: note || "ok" });
                    }
                    (function step() {
                        var d = am.getAffairsData();
                        if (!(d.current && d.count > 0) || done >= 60) return end();
                        am.affairsClick(choice, function () { done++; setTimeout(step, 450); });
                    })();
                    setTimeout(function () { end("timeout 90s"); }, 90000);
                });
            }
            case "follower_up": {   // press "Tang cap" (x10) on follower `id` until it cannot go up any more
                var fid = a.id || 1, fm = R("FollowerModel").default.getInstance(), rm2 = R("ResModel").default.getInstance();
                return new Promise(function (resolve) {
                    var fin = false, times = 0, start = (fm.getFolloSvrDataById(fid) || {}).level;
                    function end(why) {
                        if (fin) return; fin = true;
                        resolve({ id: fid, from: start, level: (fm.getFolloSvrDataById(fid) || {}).level, times: times, why: why });
                    }
                    (function step() {
                        var d = fm.getFolloSvrDataById(fid);
                        if (!d) return end("no such follower");
                        var g = fm.getFolloGrdLocalConfDataByGrd(d.grade);
                        if (g && d.level >= g.lvMax) return end("max level for the grade");
                        if (a.to && d.level >= a.to) return end("reached level " + a.to);
                        if (rm2.getResById(RES_MONEY1) === 0) return end("out of silver");
                        if (times >= 200) return end("200 presses");
                        var before = d.level;
                        fm.upgradeLevel(fid, true, function (ok) {
                            times++;
                            if (!ok) return end("server refused");
                            setTimeout(function () {
                                var d2 = fm.getFolloSvrDataById(fid);
                                if (d2 && d2.level === before) return end("level did not change");
                                step();
                            }, 400);
                        });
                    })();
                    setTimeout(function () { end("timeout 120s"); }, 120000);
                });
            }
            case "follower_study": {   // raise an aptitude book (tu chat) the way the study popup does: with the item, else with the exp
                var fms = R("FollowerModel").default.getInstance(), pms = R("PropModel").default.getInstance(), need = [], chosen = null;
                var ids = a.id ? [a.id] : (fms.getAvailFolloIdListData() || []);
                ids.forEach(function (fid) {
                    if (chosen) return;
                    var sv = fms.getFolloSvrDataById(fid), gr = fms.getFolloGrdLocalConfDataByGrd(sv.grade), exp = sv.aptitudeExp || 0;
                    (fms.getFollowerBooksById(fid) || []).forEach(function (b) {
                        if (chosen || b.lv >= gr.aptMax) return;
                        var pi = pms.getPropInfoById(b.lvCostItem[0]), have = pi ? pi.count : 0;
                        if (have >= b.lvCostItem[1]) chosen = { b: b, type: 1 };
                        else if (exp >= b.lvCostExp) chosen = { b: b, type: 2 };
                        else if (need.length < 4) need.push({ fid: fid, item: b.lvCostItem[0], need: b.lvCostItem[1], have: have, exp: exp, expNeed: b.lvCostExp });
                    });
                });
                if (!chosen) return { done: false, need: need };
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    var req = { id: chosen.b.fid, index: chosen.b.index, skinid: chosen.b.skinid, type: chosen.type };
                    fms.bookStudy(req, function (ok, msg) { end({ done: !!ok, req: req, msg: String(msg || "").slice(0, 120) }); });
                    setTimeout(function () { end({ done: false, req: req, msg: "no answer in 10s (refused?)" }); }, 10000);
                });
            }
            case "errand_status": {   // Noi chinh stock: count now, max, recover info (erd1 Ham Mo, erd2 Bach Ngan, erd3 Danh Vong)
                var ed = R("ErrandModel").default.getInstance().getErrandData(), eo = {};
                for (var ek in ed) eo[ek] = { count: ed[ek].count, max: ed[ek].max, recover: safe(ed[ek].recover, 200) };
                return eo;
            }
            case "errand_take": {     // collect once, only when there is stock (the game refuses otherwise)
                var em = R("ErrandModel").default.getInstance(), en = a.n, ed2 = em.getErrandData()["erd" + en];
                if (!ed2 || !(ed2.count > 0)) return { ok: false, note: "no stock", count: ed2 ? ed2.count : null };
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    var sent = em.getRes(en, function () { setTimeout(function () { end({ ok: true, count: (em.getErrandData()["erd" + en] || {}).count }); }, 400); });
                    if (!sent) end({ ok: false, note: "game refused (not enough charm vs silver?)" });
                    setTimeout(function () { end({ ok: false, note: "no answer in 10s" }); }, 10000);
                });
            }
            case "guide_skip_all": {   // mark every tutorial step done (what the player does one by one), so no finger/mask gets in the way
                var gmm = R("GuideModel").default.getInstance(), doneNow = gmm.getGuideData().guideList || [];
                var allIds = Object.keys(gmm.guideListSetting).map(Number).filter(function (id) { return doneNow.indexOf(id) < 0; });
                var chunks = [];
                for (var ci = 0; ci < allIds.length; ci += 60) chunks.push(allIds.slice(ci, ci + 60));
                return new Promise(function (resolve) {
                    var fin = false, sent = 0;
                    function end(note) { if (!fin) { fin = true; resolve({ sent: sent, total: allIds.length, note: note }); } }
                    (function next() {
                        if (!chunks.length) return end("ok");
                        var part = chunks.shift(), answered = false;
                        gmm.guideDone(part, function () { answered = true; sent += part.length; setTimeout(next, 150); });
                        setTimeout(function () { if (!answered) { chunks.length = 0; end("no answer for a chunk"); } }, 8000);
                    })();
                    setTimeout(function () { end("timeout"); }, 50000);
                });
            }
            case "rank_tasks_take": {   // "Con Duong Cung Dinh": claim every rank task that is ready, then the rank reward itself
                var tkm = R("TaskModel").default.getInstance(), pfm = R("ProfileModel").default.getInstance();
                return new Promise(function (resolve) {
                    var fin = false, took = [], rk = pfm.getProfileRankData().rank;
                    function end(note) { if (!fin) { fin = true; resolve({ took: took, rank: rk, note: note || "ok" }); } }
                    var ready = (tkm.getNewRankTaskList() || []).filter(function (t) { return t.weight === 0; }).map(function (t) { return t.id; });
                    (function next() {
                        if (!ready.length) {
                            if (tkm.newTaskRankSetting[rk] && Object.keys(tkm.newTaskRankSetting[rk]).length && tkm.ifNewRankDo(rk) && tkm.getNewRankData().rankTake.indexOf(rk) < 0)
                                return tkm.takeNewRankReward(rk, function () { took.push("rank" + rk); setTimeout(end, 400); });
                            return end();
                        }
                        var id = ready.shift();
                        tkm.takeNewRankTaskReward(id, function () { took.push(id); setTimeout(next, 300); });
                    })();
                    setTimeout(function () { end("timeout"); }, 20000);
                });
            }
            case "pray": {   // Ho Cam Ly: LotteryModel.reqDrawLottery checks the cost itself (free draw once a day, then Money9)
                var lmo = R("LotteryModel").default.getInstance();
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    var code = lmo.reqDrawLottery(a.type || 1, !!a.ten, !!a.useitem, function (ok, msg, res) { end({ sent: true, ok: !!ok, res: safe(res, 400) }); });
                    if (code !== undefined && code !== null) return end({ sent: false, code: String(code) });
                    setTimeout(function () { end({ sent: true, ok: false, note: "no answer in 12s" }); }, 12000);
                });
            }
            case "net_state": {   // the game's request queue: one request at a time, a stuck one blocks the rest
                var nm = R("NetManager").default.getInstance();
                return { sending: !!nm.sending, queued: (nm.delayRequests || []).length, blocking: !!nm.blocking, req: nm.reqNo, resp: nm.respNo };
            }
            case "net_reset": {   // free the queue after a request that never got an answer
                var nm2 = R("NetManager").default.getInstance(), before = { sending: !!nm2.sending, queued: (nm2.delayRequests || []).length };
                nm2.sending = false; nm2.delayRequests = [];
                return { before: before };
            }
            case "confidant_date": {   // Tri Ky Tuong Ngo: clear the next stage with the current outfit, else sweep one that is cleared
                var cmd = R("ConfidantModel").default.getInstance(), sdt = cmd.getStageData(), sets = cmd.getStageIdSetting();
                var pmo = R("ProfileModel").default.getInstance(), pdat = pmo.getProfiledData(), worn = null;
                var list = Object.keys(sets).map(function (k) { return sets[k]; }).filter(function (r) { return r.type === 1; })
                    .sort(function (x, y) { return x.id - y.id; });
                var clr = sdt.clear || {}, energy = sdt.energy ? sdt.energy.count : 0;
                var todo = list.filter(function (r) { return !clr[r.id] && cmd.isUnLockStage(r); })[0];
                if (a.prefer === "sweep" && energy > 0 && list.filter(function (r) { var c = clr[r.id]; return c && (!c.star || c.star >= 2) && !(c.day && c.day.count >= 3); })[0]) todo = null;   // sweep what is cleared first
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    if (todo) {
                        // the outfit the character wears now: the public profile (the same list the game sends)
                        pmo.getRolePublicInfo(pdat.account, function (pub) {
                            worn = pub && pub.wearing;
                            if (!worn || !worn.length) return end({ done: false, note: "no wearing list" });
                            cmd.stageClear(todo.id, { wearing: worn, bg: 1 }, function (res) { end({ done: true, did: "clear", stage: todo.id, star: res && res.star, wearing: worn.length }); });
                        });
                    } else {
                        var sw = list.filter(function (r) { var c = clr[r.id]; return c && (!c.star || c.star >= 2) && !(c.day && c.day.count >= 3); })[0];
                        if (!sw) return end({ done: false, note: "nothing to clear or sweep (energy " + energy + ")" });
                        if (!(energy > 0)) return end({ done: false, note: "no energy" });
                        var code = cmd.stageSweep(sw.id, function () { end({ done: true, did: "sweep", stage: sw.id }); });
                        if (code !== 5) {   // ConfidantModel.OK_SERVER = 5: the request was sent; any other code is a refusal made by the model
                            return end({ done: false, note: "sweep refused: " + String(code) });
                        }
                    }
                    setTimeout(function () { end({ done: false, note: "no answer in 15s" }); }, 15000);
                });
            }
            case "hint_box": {   // the game's error box (CommonHintPopup, lives on the Top layer, not in the controller's popup stack)
                var hn = cc.find("Canvas/Top/Popup/CommonHintPopup", cc.director.getScene());
                if (!hn || !hn.activeInHierarchy) return { open: false };
                var txt = [];
                (function walk(n) { var l = n.getComponent(cc.Label) || n.getComponent(cc.RichText); if (l && l.string && txt.length < 4) txt.push(String(l.string).replace(/<[^>]+>/g, "").trim().slice(0, 80)); n.children.forEach(walk); })(hn);
                return { open: true, text: txt };
            }
            case "boss_check": {   // how strong is the boss and how strong are we (no attack): enemy HP vs the sum of follower attributes
                var bfc = R("FollowerModel").default.getInstance(), tcc = R("ControllerManager").default.getInstance().getTopController();
                var sumAtt = 0, able = 0;
                (bfc.getAvailFolloIdListData() || []).forEach(function (id) {
                    if (!bfc.getFullFolloDataById(id).isDefeat) { sumAtt += bfc.getFightAttributeById(id); able++; }
                });
                var pmc = R("PropModel").default.getInstance(), rinfo = pmc.getPropInfoById("40006"), revive = rinfo ? rinfo.count : 0;
                var powers = (bfc.getAvailFolloIdListData() || []).map(function (id) { return bfc.getFightAttributeById(id); }).sort(function (x, y) { return y - x; });
                var reviveBonus = 0;
                for (var rv = 0; rv < Math.min(revive, powers.length); rv++) reviveBonus += powers[rv];   // a revived follower hits again with its own power
                return { enemyHp: tcc && tcc.enemyData ? tcc.enemyData.curHp : null, selfAtt: sumAtt, able: able, revive: revive, reviveBonus: reviveBonus };
            }
            case "follower_grade_up": {   // raise a follower's grade (phẩm) when its level is at the cap and the items are there (same checks as the button)
                var fmg = R("FollowerModel").default.getInstance(), pmg = R("PropModel").default.getInstance(), nmg = R("NetManager").default.getInstance();
                var cand = null, why = [];
                (fmg.getAvailFolloIdListData() || []).forEach(function (id) {
                    if (cand) return;
                    var sv = fmg.getFolloSvrDataById(id), cur = fmg.getFolloGrdLocalConfDataByGrd(sv.grade), nxt = fmg.getFolloGrdLocalConfDataByGrd(sv.grade + 1);
                    if (!nxt) return;
                    if (sv.level < cur.lvMax) { why.push(id + ": level " + sv.level + "/" + cur.lvMax); return; }
                    var enough = (cur.aptUpPropCosts || []).every(function (c) { var pi = pmg.getPropInfoById(c.id); return pi && pi.count >= c.num; });
                    if (!enough) { why.push(id + ": items"); return; }
                    cand = id;
                });
                if (cand === null) return { done: false, why: why };
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    nmg.post("follower/rank/upgrade", { id: cand }, function (ok) { end({ done: !!ok, id: cand }); });
                    setTimeout(function () { end({ done: false, id: cand, why: ["no answer in 10s"] }); }, 10000);
                });
            }
            case "pray_money": {   // the Pray screen: turn prayers into a resource (res 1 Ham Mo, 2 Bach Ngan, 3 HP); free ones first, KNB only when a.paid
                var pym = R("PrayModel").default.getInstance(), pdd = pym.getPrayData();
                if (pdd.limit) return { done: false, note: "daily limit", count: pdd.count };
                if (pdd.cost > 0 && !a.paid) return { done: false, note: "next one costs " + pdd.cost + " KNB", count: pdd.count, cost: pdd.cost };
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    var sent = pym.pray(a.res || 1, function (res) { end({ done: true, count: pdd.count + 1, cost: pdd.cost, res: safe(res, 200) }); });
                    if (!sent) end({ done: false, note: "refused (limit or KNB)" });
                    setTimeout(function () { end({ done: false, note: "no answer in 10s" }); }, 10000);
                });
            }
            case "dispatch_start": {   // Cong Vu Vien: NewDispatchModel.startNewDispatch (checks the slot, the event and 3 followers like the screen)
                var ndm = R("NewDispatchModel").default.getInstance(), fmd = R("FollowerModel").default.getInstance();
                var avail = (fmd.getAvailFolloIdListData() || []).slice(), n0 = ndm.executeCount;
                var pick3 = (a.ids && a.ids.length === 3) ? a.ids : avail.slice(a.skip || 0, (a.skip || 0) + 3);
                var idx = a.index || 1;
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    function go() {
                        if (!ndm.eventDatas) return end({ done: false, note: "dispatch events not loaded", ids: pick3 });
                        var r = ndm.startNewDispatch(idx, pick3, function (ok, msg) {
                            setTimeout(function () { end({ done: ndm.executeCount > n0, ok: !!ok, ids: pick3, exec: ndm.executeCount }); }, 800);
                        });
                        if (r !== undefined && r !== null) end({ done: false, code: String(r), ids: pick3 });
                    }
                    // the screen first asks the server for the events when it opens (mission/unlock); do the same when they are not there yet
                    if (!ndm.eventDatas) ndm.unlockNewDispatchSystem(function () { setTimeout(go, 600); }); else go();
                    setTimeout(function () { end({ done: ndm.executeCount > n0, ids: pick3, note: "no answer in 12s", exec: ndm.executeCount }); }, 12000);
                });
            }
            case "daily_claim": {   // daily tasks that are done, then the daily activity chests that are reachable (same calls as the Nhiem vu ngay screen)
                var tmd = R("TaskModel").default.getInstance();
                return new Promise(function (resolve) {
                    var fin = false, got = { tasks: [], chests: [] };
                    function end(note) { if (!fin) { fin = true; got.note = note || "ok"; got.active = (tmd.getDailyTaskData() || {}).active; resolve(got); } }
                    var ids = Object.keys(tmd.dailyTaskSetting || {}).map(Number), chestKeys = Object.keys(tmd.dailyRewardSetting || {}).map(Number);
                    (function nextTask() {
                        if (!ids.length) return nextChest();
                        var id = ids.shift(), sts = tmd.takeDailyTaskReward(id, function () { got.tasks.push(id); setTimeout(nextTask, 350); });
                        if (sts !== 4) nextTask();   // 4 = OK (request sent); NOT_DO / HAVE_GET: nothing sent
                    })();
                    function nextChest() {
                        if (!chestKeys.length) return end();
                        var k = chestKeys.shift(), sts = tmd.takeDailyActiveReward(k, function () { got.chests.push(k); setTimeout(nextChest, 350); });
                        if (sts !== 4) nextChest();
                    }
                    setTimeout(function () { end("timeout 30s"); }, 30000);
                });
            }
            case "sevendays_claim": {   // Le Hoi 7 Ngay: every task of the days that are open and done (rank tasks hold the Thanh Chi), then the point rewards
                var svm = R("SevenDaysModel").default.getInstance(), info = svm.getSevenDaysInfo() || {}, today = svm.today();
                var todo = [], tkey, ti;
                for (tkey in svm.typeSettings) {
                    var lst = svm.typeSettings[tkey];
                    for (ti = 0; ti < lst.length; ti++) {
                        var row = lst[ti];
                        try {
                            if (row.day <= today && svm.isTaskFinish(Number(tkey), ti) && !svm.isTaskRewardTaken(Number(tkey), ti, row.day)) todo.push([Number(tkey), ti]);
                        } catch (e) { }
                    }
                }
                var pts = svm.getPointRewardSetting().filter(function (r) { return !(info.reward && info.reward.indexOf(r.id) >= 0) && info.score >= r.cost; }).map(function (r) { return r.id; });
                return new Promise(function (resolve) {
                    var fin = false, got = { tasks: [], points: [], today: today, score: info.score };
                    function end(note) { if (!fin) { fin = true; got.note = note || "ok"; resolve(got); } }
                    (function nextTask() {
                        if (!todo.length) return nextPoint();
                        var t = todo.shift();
                        svm.takeTaskReward(t[0], t[1], function () { got.tasks.push(t[0] + ":" + t[1]); setTimeout(nextTask, 400); });
                    })();
                    function nextPoint() {
                        if (!pts.length) return end();
                        var id = pts.shift();
                        if (!svm.takePointReward(id, function () { got.points.push(id); setTimeout(nextPoint, 400); })) nextPoint();
                    }
                    setTimeout(function () { end("timeout 30s"); }, 30000);
                });
            }
            case "guide_skip_manor": {   // the Dinh Vien / Tam Cung (Homeland, Manor, Pet) tutorial: finish it on the server so the client never opens those screens (it crashes there)
                var gmm2 = R("GuideModel").default.getInstance(), done2 = gmm2.getGuideData().guideList || [];
                var re = /Manor|Homeland|Pet|Fish|Cook|Guest|Banquet/i, ids2 = [];
                for (var gk in gmm2.guideListSetting) {
                    var g = gmm2.guideListSetting[gk], tg = g.target || [], ctrl = String(tg[0] || ""), path = String(tg[2] === undefined ? "" : tg[2]);
                    var tip = String(g.tipText || "");
                    if (done2.indexOf(Number(gk)) >= 0) continue;
                    if (re.test(ctrl) || /BtnHome/.test(path) || /Đình Viện|Tẩm Cung|Cẩm Tẩm/.test(tip)) ids2.push(Number(gk));
                }
                var chunks2 = [];
                for (var ci2 = 0; ci2 < ids2.length; ci2 += 50) chunks2.push(ids2.slice(ci2, ci2 + 50));
                return new Promise(function (resolve) {
                    var fin = false, sent = 0;
                    function end(note) { if (!fin) { fin = true; resolve({ sent: sent, total: ids2.length, note: note }); } }
                    (function next() {
                        if (!chunks2.length) return end("ok");
                        var part = chunks2.shift(), answered = false;
                        gmm2.guideDone(part, function () { answered = true; sent += part.length; setTimeout(next, 200); });
                        setTimeout(function () { if (!answered) { chunks2.length = 0; end("no answer for a chunk"); } }, 8000);
                    })();
                    setTimeout(function () { end("timeout"); }, 40000);
                });
            }
            case "bag_use_auto": {   // use every item in the bag that simply turns into resources / boxes / EXP packs (not the ones kept for later)
                var pmu = R("PropModel").default.getInstance(), keepIds = { 40006: 1 };   // only the revive order stays in the bag (Noi Tieng items are used at once)
                (a.keep || []).forEach(function (k) { keepIds[k] = 1; });   // plus what the caller wants to hold back
                var okVal = { 1: 1, 4: 1, 10: 1, 13: 1, 15: 1 };   // type 7 items: resource 1 / 4, random range, boxes, EXP packs
                var list2 = [];
                for (var pid in pmu.propInfoSetting) {
                    var pi2 = pmu.propInfoSetting[pid];
                    if (pi2 && pi2.count > 0 && Number(pi2.usable) === 1 && Number(pi2.type) === 7 && okVal[Number(pi2.typevalue)] && !keepIds[pid]) list2.push([pid, pi2.count, pi2.name]);
                }
                return new Promise(function (resolve) {
                    var fin = false, used = [];
                    function end(note) { if (!fin) { fin = true; resolve({ used: used, note: note || "ok" }); } }
                    (function next() {
                        if (!list2.length) return end();
                        var it = list2.shift();
                        var sent = pmu.useProp(String(it[0]), it[1], null, function () { used.push(it[2] + " x" + it[1]); setTimeout(next, 450); });
                        if (!sent) next();
                    })();
                    setTimeout(function () { end("timeout 40s"); }, 40000);
                });
            }
            case "online_claim": {   // online-time gifts (Sign page 2): every one whose time has come and is not taken yet
                var sgm = R("SignModel").default.getInstance();
                var SR = R("SignModel").SIGN_SEVEN_REWARD, onl = new (R("SignModel").Online)();
                var oset = onl.getOnlineSetting(), sd = sgm.getSignData(), TU = R("System").default;
                var due = [], waiting = [];
                Object.keys(oset).forEach(function (k) {
                    var o = oset[k];
                    if (sd.online && (sd.online.reward & SR[o.id - 1])) return;
                    var left = sgm.getNextRwdTime(o.time) - TU.time();
                    (left <= 0 ? due : waiting).push({ id: o.id, left: left });
                });
                return new Promise(function (resolve) {
                    var got = [], fin = false;
                    function end() { if (!fin) { fin = true; resolve({ got: got, waiting: waiting }); } }
                    (function next() {
                        if (!due.length) return end();
                        var d = due.shift();
                        if (!onl.getOnlineRwd(d.id, function () { got.push(d.id); setTimeout(next, 400); })) next();
                    })();
                    setTimeout(end, 15000);
                });
            }
            case "limit_claim": {   // Gio Vang (limit-time reward activity): every level whose task value is reached and not taken yet
                var ltm = R("LimitTimeModel").default.getInstance(), lpub = ltm.getPublicData() || {}, ldat = ltm.getLimitTimeData() || {}, lset = ltm.getLimitTimeSetting();
                var lnow = R("System").default.time(), ltodo = [];
                Object.keys(lpub).forEach(function (code) {
                    var pe = lpub[code], rows = pe && lset[pe.reward_id] && lset[pe.reward_id][pe.id];
                    if (!rows || lnow < pe.awardStart || lnow > pe.end) return;
                    Object.keys(rows).forEach(function (lv) {
                        var row = rows[lv], dd = ldat[row.id], val = dd ? dd.value : 0;
                        if (val >= row.taskValue && !(dd && dd.reward && dd.reward.indexOf(row.lv) >= 0)) ltodo.push(row);
                    });
                });
                return new Promise(function (resolve) {
                    var got = [], fin = false;
                    function end() { if (!fin) { fin = true; resolve({ got: got, open: Object.keys(lpub).length }); } }
                    (function next() {
                        if (!ltodo.length) return end();
                        var row = ltodo.shift();
                        ltm.getReward(row, function () { got.push(row.id + ":" + row.lv); setTimeout(next, 400); });
                        setTimeout(function () { if (!fin && ltodo.length === 0 && got.length === 0) end(); }, 500);
                    })();
                    setTimeout(end, 20000);
                });
            }
            case "relogin": {   // what the error box Confirm does (GameManager.restart): back to the login screen, error flag cleared
                var gmr = R("GameManager").default.getInstance();
                gmr.errorFlag = false;
                var hb = cc.find("Canvas/Top/Popup/CommonHintPopup", cc.director.getScene());
                if (hb && hb.parent) { try { hb.removeFromParent(true); } catch (e) { } }
                gmr.restart();
                return { restarted: true };
            }
            case "batch": {   // several commands in ONE round trip: a.cmds = [{cmd, args}, ...] run one after the other
                var bl = (a.cmds || []).slice(), bres = [];
                return new Promise(function (resolve) {
                    (function nextB() {
                        if (!bl.length) return resolve(bres);
                        var bc = bl.shift(), bo;
                        try { bo = handle({ cmd: bc.cmd, args: bc.args || {} }); }
                        catch (e) { bres.push({ ok: false, error: String(e) }); return nextB(); }
                        Promise.resolve(bo).then(function (d) { bres.push({ ok: true, data: d }); nextB(); },
                                                 function (e) { bres.push({ ok: false, error: String(e) }); nextB(); });
                    })();
                });
            }
            case "confidant_skill_up": {   // Tri Ky skill: raise the first skill the "tam y" points can pay (ConfidantModel.upgradeSkill, like the Upgrade button)
                var csm = R("ConfidantModel").default.getInstance(), clist = (csm.confidantData && csm.confidantData.list) || {}, cnote = "no confidant";
                var cpick = null;
                Object.keys(clist).forEach(function (cid) {
                    if (cpick) return;
                    var dd = csm.getDetail(+cid), sks = csm.getSkillSetting(+cid) || {};
                    Object.keys(sks).forEach(function (k) {
                        if (cpick) return;
                        var row = sks[k], lv = (dd.skill && dd.skill[row.id]) || 1, cost = csm.getSkillUpgradeCost(row.expId, lv);
                        cnote = "points " + dd.point + " cost " + cost;
                        if (cost != null && dd.point >= cost) cpick = { cid: +cid, sid: row.id, lv: lv };
                    });
                });
                if (!cpick) return { done: false, note: cnote };
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    var rr = csm.upgradeSkill(cpick.cid, cpick.sid, cpick.lv + 1, function () { setTimeout(function () { end({ done: true, pick: cpick }); }, 400); });
                    if (rr === false) {   // the model refuses when its skill table has no entry yet: send the same request the model would
                        R("NetManager").default.getInstance().post("newconfidant/skill/upgrade", { cid: cpick.cid, sid: cpick.sid, level: cpick.lv + 1 },
                            function (ok) { setTimeout(function () { end({ done: !!ok, pick: cpick, note: "direct request" }); }, 400); });
                    }
                    setTimeout(function () { end({ done: false, note: "no answer in 10s", pick: cpick }); }, 10000);
                });
            }
            case "touch_path": {   // a node that listens to TOUCH_END instead of 'click' (the 'xuat cung' toggle BtnOut): same as lifting a finger on it
                var tn = cc.find(a.path, cc.director.getScene());
                if (!tn || !tn.activeInHierarchy) return { touched: false };
                tn.emit(cc.Node.EventType.TOUCH_END, new cc.Event.EventTouch([], true));
                return { touched: true };
            }
            case "main_scene": {   // which view the main screen shows: in (palace room) / out (palace map, 'xuat cung') / indoor
                var po = cc.find("Canvas/Stack/MainPanel/MainPanel/PnOutdoor", cc.director.getScene());
                function act(nm) { var n = po && cc.find(nm, po); return !!(n && n.activeInHierarchy); }
                return { found: !!po, inside: act("in"), outside: act("out"), top: (R("ControllerManager").default.getInstance().getTopController() || {}).name || null };
            }
            case "manor_guides_left": {   // how many Dinh Vien / Tam Cung (Homeland, Manor, Pet...) tutorial steps are still not done on the server
                var gmL = R("GuideModel").default.getInstance(), doneL = gmL.getGuideData().guideList || [];
                var reL = /Manor|Homeland|Pet|Fish|Cook|Guest|Banquet/i, left = [];
                for (var gkL in gmL.guideListSetting) {
                    var gL = gmL.guideListSetting[gkL], tgL = gL.target || [], ctrlL = String(tgL[0] || ""), pathL = String(tgL[2] === undefined ? "" : tgL[2]);
                    if (doneL.indexOf(Number(gkL)) >= 0) continue;
                    if (reL.test(ctrlL) || /BtnHome/.test(pathL) || /Đình Viện|Tẩm Cung|Cẩm Tẩm/.test(String(gL.tipText || ""))) left.push(Number(gkL));
                }
                return { left: left.length, ids: left.slice(0, 12), done: doneL.length };
            }
            case "guide_copy": {   // the tutorial's finger target as the game made it: a copy of the target node (a Button is added when it has none) directly under Canvas/Top.
                                   // The normal screen scan skips animated (DragonBones) nodes, and the dog of the Dinh Vien tutorial is one of them.
                var top = cc.find("Canvas/Top", cc.director.getScene()), found = [];
                if (top) top.children.forEach(function (c) {
                    if (!c.activeInHierarchy || c.name === "Popup" || c.name === "BtnShadow") return;
                    var bt = c.getComponent(cc.Button);
                    if (bt && bt.interactable) found.push({ p: "Canvas/Top/" + c.name, name: c.name, text: textOf(c) });
                });
                return { copies: found.slice(0, 6) };
            }
            case "manor_plant": {   // Dinh Vien garden: plant up to a.n seeds (the bag holds seeds from stage 4-3 on) on the free plots, like the plant button does
                var mm = R("ManorModel").default.getInstance(), mdat = mm.getManorData() || {}, lands = mdat.lands || [];
                var pm = R("PropModel").default.getInstance(), want = a.n || 3, planted = [], notes = [];
                var seedIds = (a.seed ? [Number(a.seed)] : Object.keys(mm.seedItemSetting || {}).map(Number))   // a.seed: only this seed (e.g. 90012 Nam Thuoc Tinh)
                    .filter(function (id) { var pi = pm.getPropInfoById(id); return pi && pi.count > 0; });
                var free = [];
                for (var li = 0; li < lands.length; li++) if (lands[li] && lands[li].seedType === 0) free.push(li);
                if (!lands.length) return { planted: [], note: "no manor data (the garden is not unlocked yet)" };
                if (!seedIds.length) return { planted: [], note: "no seeds in the bag", free: free.length };
                var todo = free.slice(0, want);
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(note) { if (!fin) { fin = true; resolve({ planted: planted, note: note || "ok", free: free.length, seeds: seedIds.slice(0, 4) }); } }
                    (function next() {
                        if (!todo.length) return end();
                        var idx = todo.shift(), sid = seedIds.find(function (id) { var pi = pm.getPropInfoById(id); return pi && pi.count > 0; });
                        if (sid === undefined) return end("out of seeds");
                        var rr = mm.plantSeed(idx, sid, function () { planted.push(idx + ":" + sid); setTimeout(next, 500); });
                        if (rr !== undefined && rr !== null) { notes.push(String(rr)); next(); }
                    })();
                    setTimeout(function () { end("timeout " + notes.join(",")); }, 20000);
                });
            }
            case "debate_status": {   // Khau Chien: unlocked?, free rounds used today (4 free), 30-min cooldown, followers able to fight (lv>=60, not home, unused today)
                var dsm = R("SysOpenModel"), dso = dsm.default.getInstance(), dmd = R("DebateModel"), dsd = dmd.default.getInstance().getSelfData() || {};
                var dfm = R("FollowerModel").default.getInstance(), dnow = R("System").default.time();
                var dready = dfm.getFilterSortFolloIdArray(function (f) { return !(f.level < 60 || f.retHomeState) && !(dsd.normalused || {})[f.id]; });
                var dtop = dfm.getFilterSortFolloIdArray(function () { return true; }).map(function (f) { return f.level; }).sort(function (x, y) { return y - x; });
                var dtoday = !!dsd.ts && IsSameDay(dsd.ts, dnow);
                return { unlocked: dso.isSystemUnlocked(dsm.SysLockCode.SYS_DISPUTE_SYS), onekey: dso.isSystemUnlocked(dsm.SysLockCode.SYS_ONE_KEY_DEBATE),
                         count: dtoday ? (dsd.count || 0) : 0, free: dmd.DEBATE_FREE_TIME, cooldownLeft: Math.max(0, Math.round((dsd.cooldown || 0) - dnow)),
                         fighter: dsd.id || null, start: !!dsd.start, ready: dready.length, topLevels: dtop.slice(0, 3) };
            }
            case "debate_run": {   // one Khau Chien round, the same calls as the screen: create/normal -> start/normal -> one-key (or each duel) until no rival is left
                var drm = R("DebateModel").default.getInstance(), dro = R("SysOpenModel"), dok = dro.default.getInstance().isSystemUnlocked(dro.SysLockCode.SYS_ONE_KEY_DEBATE);
                return new Promise(function (resolve) {
                    var fin = false, duels = 0, wins = 0, log = [];
                    function end(note) {
                        if (fin) return;
                        fin = true;
                        var sd = drm.getSelfData() || {};
                        resolve({ note: note || "ok", duels: duels, wins: wins, steps: log, count: sd.count || 0, point: sd.point,
                                  cooldownLeft: Math.max(0, Math.round((sd.cooldown || 0) - R("System").default.time())) });
                    }
                    function fight() {
                        var en = drm.getEnemyData();
                        if (!en || !en.current || !en.current.length) return end();
                        if (duels >= 80) return end("too many duels");
                        if (dok) {
                            log.push("onekey");
                            return drm.doOneKeyFight(function (res) { duels++; if (res && res.win) wins++; setTimeout(function () { end(); }, 600); });
                        }
                        drm.doDebateFight(en.current[0], null, function (ok, msg, res) {
                            duels++;
                            if (res && res.win) wins++;
                            if (!ok) return end("duel refused: " + String(msg || "").slice(0, 60));
                            setTimeout(fight, 450);
                        });
                    }
                    function start() {
                        log.push("start");
                        drm.beginStartDebate(function () { setTimeout(fight, 600); });
                    }
                    var sd0 = drm.getSelfData() || {};
                    if (sd0.start) { log.push("resume"); fight(); }
                    else if (sd0.id) start();
                    else {
                        log.push("create");
                        drm.beginNormalDebate(false, function (ok, msg) {
                            if (!ok) return end("create refused: " + String(msg || "").slice(0, 60));
                            setTimeout(function () { (drm.getSelfData() || {}).id ? start() : end("no fighter picked"); }, 600);
                        });
                    }
                    setTimeout(function () { end("timeout 90s"); }, 90000);
                });
            }
            case "manor_status": {   // Dinh Vien: plots (seed, ready time), waters/steals used today
                var msm = R("ManorModel"), mso = msm.default.getInstance(), msd = mso.getManorData() || {}, mnow = R("System").default.time();
                var mpm = R("PropModel").default.getInstance(), mseeds = {};
                Object.keys(mso.seedItemSetting || {}).forEach(function (id) { var pi = mpm.getPropInfoById(Number(id)); if (pi && pi.count > 0) mseeds[id] = pi.count; });
                return { account: String(R("ProfileModel").default.getInstance().getProfiledData().account),   // the in-game ID others water
                         lands: (msd.lands || []).map(function (l) { return l ? { seed: l.seedType, left: l.seedType ? Math.max(0, Math.round(l.plantEndTime - mnow)) : null } : null; }),
                         seeds: mseeds, water: msd.waterCnt || 0, waterMax: msm.MAX_WATER_COUNT, steal: msd.selfStealCnt || 0, stealMax: msm.MAX_STEAL_COUNT };
            }
            case "manor_gather": {   // harvest every ripe plot in one go (the garden's one-key harvest button)
                var mgo = R("ManorModel").default.getInstance(), gnow = R("System").default.time();
                var ripe = ((mgo.getManorData() || {}).lands || []).filter(function (l) { return l && l.seedType && l.plantEndTime <= gnow; }).length;
                return new Promise(function (resolve) {
                    var r0 = mgo.batchHarvestCrops(function (ok, msg) {
                        var items = [];   // what the harvest paid, by item name (the same reward list the game's popup shows)
                        try {
                            (R("RewardModel").default.getInstance().getLastReward(true) || []).forEach(function (rw) {   // true: same items summed
                                if (rw) items.push({ id: rw.id, name: rw.name || String(rw.id), count: rw.count });
                            });
                        } catch (e) { }
                        resolve({ sent: true, ok: !!ok, msg: String(msg || "").slice(0, 80), plots: ok ? ripe : 0, items: ok ? items : [] });
                    });
                    if (r0 !== undefined && r0 !== null) resolve({ sent: false, why: r0, plots: 0, items: [] });   // NO_SEED / TIME_ERROR: nothing ripe
                    setTimeout(function () { resolve({ sent: true, ok: false, msg: "no answer in 15s" }); }, 15000);
                });
            }
            case "manor_water": {   // water another player's garden by in-game ID (Settings screen "ID" = account) like the visit screen's one-key water
                // the visit screen offers watering only on growing plots this account has not watered yet and that have < waterCount (setting) waters
                var mwo = R("ManorModel").default.getInstance(), mwm = R("ManorModel"), acc = String(a.account || "");
                var me = String(R("ProfileModel").default.getInstance().getProfiledData().account);
                if (!acc) return { ok: false, why: "no account" };
                function look(data) {   // the target's plots: time left of the slowest growing plot, waters on it, can this account water any?
                    var now = R("System").default.time(), out = { planted: 0, left: 0, waters: 0, canWater: 0, mine: 0, ripe: 0 };
                    (data && data.lands || []).forEach(function (l) {
                        if (!l || !l.seedType) return;
                        out.planted++;
                        var st = mwo.getSeedItemSetting(l.seedType) || {}, w = 0, mine = false;
                        (l.record || []).forEach(function (r) { if (r.type === 0) { w++; if (String(r.account) === me) mine = true; } });
                        var left = Math.round(l.plantEndTime - now);
                        if (left <= 0) { out.ripe++; return; }
                        out.left = Math.max(out.left, left);
                        out.waters = Math.max(out.waters, w);
                        if (mine) out.mine++;
                        if (!mine) out.canWater++;   // the setting's waterCount (5) may differ from the server: the Manager checks the time really drops
                        out.cap = st.waterCount;
                    });
                    return out;
                }
                return new Promise(function (resolve) {
                    var fin = false, before = (mwo.getManorData() || {}).waterCnt || 0;
                    function end(o) { if (!fin) { fin = true; o.water = (mwo.getManorData() || {}).waterCnt || 0; o.waterBefore = before; o.waterMax = mwm.MAX_WATER_COUNT; resolve(o); } }
                    // visit (farm/land/friend/<id>, the "visit garden" button): works for any player ID; the revenge search only for players who stole from you
                    mwo.visitPlayer(acc, function (data) {
                        if (!data) return end({ ok: false, why: "không mở được vườn của ID này (sai ID hoặc chưa có Đình Viện)" });
                        var pre = look(data);
                        if (!pre.planted) return end({ ok: false, skip: true, why: "vườn chưa trồng cây", after: pre });
                        if (!pre.canWater) return end({ ok: false, skip: true, after: pre,
                            why: pre.left <= 0 ? "cây đã chín" : (pre.mine ? "acc này đã tưới đợt này rồi" : "cây đã đủ lượt tưới") });
                        var sent = mwo.batchWater(acc, function (ok2, msg2) {
                            mwo.visitPlayer(acc, function (data2) {   // look again: how much time is left now
                                end({ ok: !!ok2, msg: String(msg2 || "").slice(0, 80), before: pre, after: data2 ? look(data2) : null });
                            });
                        });
                        if (!sent) end({ ok: false, exhausted: true, why: "hết lượt tưới hôm nay", after: pre });
                    });
                    setTimeout(function () { end({ ok: false, why: "no answer in 25s" }); }, 25000);
                });
            }
            case "fashion_status": {   // Le Hoa Thuong (CostumeWeekModel): stage, joined?, votes left, box points, the pair on stage (ID game + score)
                var fwm = R("CostumeWeekModel"), fwo = fwm.default.getInstance(), fd = fwo.getFashionData() || {}, tr = fd.trial || {}, jd = tr.judge || {};
                var fso = R("SysOpenModel");
                return { unlocked: fso.default.getInstance().isSystemUnlocked(fso.SysLockCode.SYS_FASHION_SHOW), period: fd.period || 0,
                         status: fd.status, trialTime: !!fwo.isTrialTime(), finalTime: !!fwo.isFinalTime(), joined: !!tr.join,
                         myScore: (tr.ladder || {}).myScore || 0, votes: jd.count || 0, point: jd.point || 0, recover: jd.recover || 0,
                         pairs: Object.keys(jd.pairs || {}).map(function (k) { return { account: String(k), score: (jd.pairs[k] || {}).score || 0 }; }),
                         final: (function () {   // Sunday final: ONE player on stage, judged Sang Tao (1) / Hoan My (2) / pass (0)
                             var fj = (fd.final || {}).judge || {}, m = fj.member || null;
                             return { votes: fj.count || 0, point: fj.point || 0, hasJudge: !!(fd.final || {}).judge, bought: fj.buycount || 0,
                                      member: m ? { account: String(m.account), perfect: m.perfectScore || 0, creative: m.creativeScore || 0 } : null };
                         })() };
            }
            case "fashion_final_judge": {   // ask for the player to judge (the final judge screen does this when it opens without one)
                var ffo = R("CostumeWeekModel").default.getInstance();
                return new Promise(function (resolve) {
                    ffo.judgeFinal(function () { setTimeout(function () { resolve({ ok: true }); }, 500); });
                    setTimeout(function () { resolve({ ok: false, why: "server không trả lời / từ chối" }); }, 10000);
                });
            }
            case "fashion_final_vote": {   // a.choose: 1 = Sang Tao, 2 = Hoan My, 0 = pass (the three buttons of the final judge screen)
                var fvo2 = R("CostumeWeekModel").default.getInstance();
                return new Promise(function (resolve) {
                    var sent2 = fvo2.finalComment(String(a.account || ""), Number(a.choose || 0), function () { setTimeout(function () { resolve({ ok: true }); }, 600); });
                    if (!sent2) resolve({ ok: false, why: "hết lượt vote chung kết" });
                    setTimeout(function () { resolve({ ok: false, why: "server không trả lời / từ chối" }); }, 10000);
                });
            }
            case "fashion_final_buy": {   // the final screen's refresh button: buy 5 votes for 5 + 5 x (buys today) KNB; refused above 10 votes
                var fbo2 = R("CostumeWeekModel").default.getInstance(), fj2 = ((fbo2.getFashionData() || {}).final || {}).judge || {};
                var price = 5 + 5 * (fj2.buycount || 0), knb3 = R("ResModel").default.getInstance().getResById(window.RES_MONEY4);
                if ((fj2.count || 0) > 10) return { ok: false, why: "còn hơn 10 lượt, game không cho mua" };
                return new Promise(function (resolve) {
                    var sent4 = fbo2.buyFinalCount(function () {
                        setTimeout(function () {
                            var j3 = ((fbo2.getFashionData() || {}).final || {}).judge || {};
                            resolve({ ok: true, price: price, votes: j3.count || 0, bought: j3.buycount || 0,
                                      knb: R("ResModel").default.getInstance().getResById(window.RES_MONEY4) });
                        }, 600);
                    });
                    if (!sent4) resolve({ ok: false, why: "không đủ KNB (cần " + price + ", có " + knb3 + ")" });
                    setTimeout(function () { resolve({ ok: false, why: "server không trả lời / từ chối" }); }, 10000);
                });
            }
            case "fashion_final_box": {   // open the final vote box (15 points each)
                var ffb = R("CostumeWeekModel").default.getInstance();
                return new Promise(function (resolve) {
                    var got2 = [], n2 = 0;
                    (function next() {
                        if (n2 >= 10) return resolve({ opened: n2, items: got2 });
                        var sent3 = ffb.finalBoxReward(function () {
                            n2++;
                            try { (R("RewardModel").default.getInstance().getLastReward(true) || []).forEach(function (rw) { if (rw) got2.push({ name: rw.name, count: rw.count }); }); } catch (e) { }
                            setTimeout(next, 500);
                        });
                        if (!sent3) resolve({ opened: n2, items: got2 });
                    })();
                    setTimeout(function () { resolve({ opened: n2, items: got2, why: "timeout" }); }, 30000);
                });
            }
            case "fashion_join": {   // join the preliminary with the outfit the character wears now (what the join button sends after the outfit screen)
                var fjo = R("CostumeWeekModel").default.getInstance();
                if (!fjo.isTrialTime()) return { ok: false, why: "chưa tới / đã hết vòng loại" };
                if ((fjo.getFashionData().trial || {}).join) return { ok: true, already: true };
                var wear = R("AvatarModel").default.getInstance().getCoordination().getWearingList();
                return new Promise(function (resolve) {
                    fjo.joinTrail(wear, function () { setTimeout(function () { resolve({ ok: !!(fjo.getFashionData().trial || {}).join, wearing: wear.length }); }, 600); });
                    setTimeout(function () { resolve({ ok: false, why: "no answer in 15s" }); }, 15000);
                });
            }
            case "fashion_judge": {   // ask for a pair to vote on (the judge screen does this when it opens without one)
                var fgo = R("CostumeWeekModel").default.getInstance();
                return new Promise(function (resolve) {
                    fgo.judgeTrail(function () { setTimeout(function () { resolve({ ok: true }); }, 500); });
                    setTimeout(function () { resolve({ ok: false, why: "no answer in 15s" }); }, 15000);
                });
            }
            case "fashion_vote": {   // like (vote) a.account of the pair on stage: same call as the left/right like buttons
                var fvo = R("CostumeWeekModel").default.getInstance(), acc2 = String(a.account || "");
                return new Promise(function (resolve) {
                    var sent = fvo.trailComment(acc2, function () { setTimeout(function () { resolve({ ok: true }); }, 600); });
                    if (!sent) resolve({ ok: false, why: "hết lượt vote" });
                    setTimeout(function () { resolve({ ok: false, why: "no answer in 15s" }); }, 15000);
                });
            }
            case "fashion_box": {   // open the vote box (every 10 points) while there are points for it
                var fbo = R("CostumeWeekModel").default.getInstance();
                return new Promise(function (resolve) {
                    var got = [], n = 0;
                    (function next() {
                        if (n >= 10) return resolve({ opened: n, items: got });
                        var sent = fbo.trialBoxReward(function () {
                            n++;
                            try { (R("RewardModel").default.getInstance().getLastReward(true) || []).forEach(function (rw) { if (rw) got.push({ name: rw.name, count: rw.count }); }); } catch (e) { }
                            setTimeout(next, 500);
                        });
                        if (!sent) resolve({ opened: n, items: got });
                    })();
                    setTimeout(function () { resolve({ opened: -1, items: got, why: "timeout" }); }, 30000);
                });
            }
            case "player_names": {   // names of in-game IDs (profile/public, cached by the game for 30 min)
                var pmo = R("ProfileModel").default.getInstance(), ids = [].concat(a.accounts || []), names = {};
                return new Promise(function (resolve) {
                    var left = ids.length;
                    if (!left) return resolve({ names: names });
                    ids.forEach(function (id) {
                        pmo.getRolePublicInfo(String(id), function (pub) { names[id] = pub && pub.name || null; if (--left === 0) resolve({ names: names }); });
                    });
                    setTimeout(function () { resolve({ names: names }); }, 10000);
                });
            }
            case "guild_status": {   // Bang Hoi (GuildModel): my guild, today's building (donate), my in-game ID, KNB
                var gmo = R("GuildModel").default.getInstance(), gd = gmo.getGuildData(), dd = gmo.getDonateData() || {};
                var me3 = String(R("ProfileModel").default.getInstance().getProfiledData().account);
                var gso = R("SysOpenModel"), prof = R("ProfileModel").default.getInstance().getProfiledData();
                return { account: me3, knb: R("ResModel").default.getInstance().getResById(window.RES_MONEY4), donated: dd.id || 0,
                         unlocked: gso.default.getInstance().isSystemUnlocked(gso.SysLockCode.SYS_GUILD_SYS), rank: prof.rank && prof.rank.rank,
                         guild: gd ? { id: String(gd.id || gd.guildId || gd.gid || ""), name: gd.name, number: gd.number, max: gd.max_number, leader: String(gd.leader),
                                       grank: gd.member && gd.member[me3] ? gd.member[me3].grank : null } : null };
            }
            case "guild_join": {   // apply to guild a.gid (the guild's number); with auto-accept on the account is a member right away
                var gjo = R("GuildModel").default.getInstance(), gid = String(a.gid || "");
                if (gjo.getGuildData()) return { ok: String(gjo.getGuildData().id).toUpperCase().replace(/^G/, "") === gid.toUpperCase().replace(/^G/, ""),
                                                 already: true, id: String(gjo.getGuildData().id), name: gjo.getGuildData().name };
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; var g = gjo.getGuildData(); o.joined = !!g; if (g) { o.id = String(g.id || o.applied || ""); o.name = g.name; } resolve(o); } }
                    function apply(id, how) {   // a refusal (403: account not allowed) never calls back: the timer below ends it
                        gjo.applyJoinGuild(id, function (ok, msg) { setTimeout(function () { end({ ok: !!ok && !!gjo.getGuildData(), msg: String(msg || "").slice(0, 80), how: how, applied: id }); }, 800); });
                        setTimeout(function () { end({ ok: false, msg: "server không trả lời / từ chối đơn", how: how, applied: id }); }, 8000);
                    }
                    // the number may be shown as "G352777": compare without the leading G, search with both spellings
                    function norm(x) { return String(x || "").trim().toUpperCase().replace(/^G/, ""); }
                    var want3 = norm(gid), tried = [];
                    function search(key, then) {
                        tried.push(key);
                        if (!gjo.searchGuild(key, function (res) {
                            var list = []; for (var k in res || {}) list.push(res[k]);
                            then(list);
                        })) then([]);
                    }
                    function pick(list) {
                        var hit = list.filter(function (g) { return norm(g.id) === want3; })[0];
                        if (hit) { apply(String(hit.id), "tìm '" + tried.join("', '") + "': " + hit.name + " " + hit.number + "/" + hit.max_number); return true; }
                        if (list.length === 1) { apply(String(list[0].id), "tìm '" + tried.join("', '") + "' (1 kết quả, id " + list[0].id + "): " + list[0].name); return true; }
                        return false;
                    }
                    search(gid, function (l1) {
                        if (pick(l1)) return;
                        if (want3 === String(gid).trim()) return apply(gid, "thẳng theo số (tìm thấy " + l1.length + " bang)");
                        search(want3, function (l2) {
                            if (!pick(l2)) apply(want3, "thẳng theo số " + want3 + " (tìm thấy " + l1.length + "/" + l2.length + " bang)");
                        });
                    });
                    setTimeout(function () { end({ ok: false, msg: "no answer in 20s" }); }, 20000);
                });
            }
            case "guild_donate": {   // today's building: a.id 3 = Mo Rong Phong (200 KNB -> +200 guild exp, +2000 contribution)
                var gdo = R("GuildModel").default.getInstance(), did = a.id || 3, knb0 = R("ResModel").default.getInstance().getResById(window.RES_MONEY4);
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; o.knbBefore = knb0; o.knb = R("ResModel").default.getInstance().getResById(window.RES_MONEY4); resolve(o); } }
                    var code = gdo.donate(did, function (ok, msg) { setTimeout(function () { end({ ok: !!ok, msg: String(msg || "").slice(0, 80) }); }, 600); });
                    if (code !== 0) {   // refused before sending (GuildDonateReturn: 3 = already built today, no KNB, no item)
                        var GR = R("GuildModel").GuildDonateReturn || {};
                        end({ ok: false, refused: true, msg: GR[code] || String(code) });
                    }
                    setTimeout(function () { end({ ok: false, msg: "no answer in 15s" }); }, 15000);
                });
            }
            case "guild_quit": {   // leave the guild (the game then blocks joining another one for 24 h)
                var gqo = R("GuildModel").default.getInstance();
                if (!gqo.getGuildData()) return { ok: true, already: true };
                return new Promise(function (resolve) {
                    var r0 = gqo.quitGuild(function (ok, msg) { resolve({ ok: !!ok, msg: String(msg || "").slice(0, 80) }); });
                    if (r0 !== undefined) resolve({ ok: false, msg: "refused " + r0 + " (bang chủ không tự rời được)" });
                    setTimeout(function () { resolve({ ok: false, msg: "no answer in 15s" }); }, 15000);
                });
            }
            case "guild_fire": {   // leader / deputy: kick each of a.accounts that is a member (no 24 h wait for them)
                var gfo = R("GuildModel").default.getInstance(), gfd = gfo.getGuildData(), want = [].concat(a.accounts || []).map(String);
                if (!gfd) return { ok: false, msg: "acc này không ở trong bang" };
                var members = Object.keys(gfd.member || {}), todo2 = want.filter(function (x) { return members.indexOf(x) >= 0; }), out2 = [];
                return new Promise(function (resolve) {
                    (function next() {
                        if (!todo2.length) return resolve({ ok: true, fired: out2, notMember: want.filter(function (x) { return members.indexOf(x) < 0; }) });
                        var acc3 = todo2.shift();
                        var r1 = gfo.fireMember(acc3, function (ok, msg) { out2.push({ account: acc3, ok: !!ok, msg: String(msg || "").slice(0, 60) }); setTimeout(next, 400); });
                        if (r1 !== undefined) { out2.push({ account: acc3, ok: false, msg: "không có quyền trục xuất (" + r1 + ")" }); next(); }
                    })();
                    setTimeout(function () { resolve({ ok: false, fired: out2, msg: "timeout" }); }, 60000);
                });
            }
            case "mail_claim": {   // the mailbox's 'take all' button (MailModel.getAllAttach -> mail/read of every unread mail)
                var mlo = R("MailModel").default.getInstance(), md2 = mlo.getMailData() || {};
                var unread = Object.keys(md2).filter(function (k) { return md2[k] && !md2[k].r; });
                var withGift = unread.filter(function (k) { var m = md2[k].mail || {}; return m.attach && m.attach.length; });
                if (!unread.length) return { ok: true, mails: 0, gifts: 0, items: [] };
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; o.mails = unread.length; o.gifts = withGift.length; resolve(o); } }
                    var sent5 = mlo.getAllAttach(function () {
                        setTimeout(function () {
                            var items = [];
                            try { (R("RewardModel").default.getInstance().getLastReward(true) || []).forEach(function (rw) { if (rw) items.push({ name: rw.name, count: rw.count }); }); } catch (e) { }
                            var left = Object.keys(mlo.getMailData() || {}).filter(function (k) { var x = mlo.getMailData()[k]; return x && !x.r; }).length;
                            end({ ok: true, items: items, left: left });
                        }, 800);
                    });
                    if (!sent5) end({ ok: true, items: [], note: "không có thư chưa nhận" });
                    setTimeout(function () { end({ ok: false, why: "server không trả lời" }); }, 15000);
                });
            }
            case "popups": {   // popups open on the current controller, straight from the game's own popup stack
                var pc = R("ControllerManager").default.getInstance().getTopController();
                return { ctrl: pc ? (pc.name || null) : null, popups: pc && pc.popups ? pc.popups.map(function (p) { return p.name; }) : [] };
            }
            case "popup_close": {   // close the top popup the way the game does (PopupBase.close)
                var pc2 = R("ControllerManager").default.getInstance().getTopController(), tp = pc2 && pc2.getTopPopup && pc2.getTopPopup();
                if (!tp) return { closed: false };
                var nm = tp.name;
                tp.close();
                return { closed: true, name: nm };
            }
            case "story_options": {   // story choices on screen, straight from the game's own option data (userData of each option)
                return { options: storyOptions().map(function (o) { return { index: o.index, text: o.text, p: o.p }; }) };
            }
            case "story_choose": {    // press the story option whose game index is a.index (falls back to the last one)
                var oo = storyOptions();
                if (!oo.length) return { chose: false };
                var want = oo.filter(function (o) { return o.index === a.index; })[0] || oo[oo.length - 1];
                return { chose: clickNodeObj(want.node), index: want.index, text: want.text, of: oo.length };   // the node itself: the options all share one name
            }
            case "main_state": {    // the current main task: id, finished?, progress and what it asks (setting row)
                var tmm = R("TaskModel").default.getInstance(), md = tmm.getMainTaskData(), cu = md && md.current;
                if (!cu) return { none: true, finished: md ? (md.finish || []).length : 0 };
                var inf = tmm.getMainTaskInfo() || {};
                return { id: cu.id, finish: !!cu.finish, count: cu.count, cur: safe(cu, 400),
                         type: inf.taskTarget, param: inf.parameter, name: inf.taskName, desc: inf.taskTargetDesc };
            }
            case "main_take": {     // claim the finished main task (what the "Nhan" button sends)
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(ok) { if (!fin) { fin = true; resolve({ ok: ok }); } }
                    var sent = R("TaskModel").default.getInstance().takeMainTaskReward(function () { setTimeout(function () { end(true); }, 500); });
                    if (!sent) end(false);
                    setTimeout(function () { end(false); }, 8000);
                });
            }
            case "followers_info": {
                var fmi = R("FollowerModel").default.getInstance();
                return { list: (fmi.getAvailFolloIdListData() || []).map(function (id) {
                    var d = fmi.getFolloSvrDataById(id) || {}, g = fmi.getFolloGrdLocalConfDataByGrd(d.grade) || {};
                    return { id: id, level: d.level, lvMax: g.lvMax, power: fmi.getFightAttributeById(id) };
                }) };
            }
            case "item_use_all": {  // use every piece of an item the bag holds (PropModel.useProp -> item/use)
                var prm = R("PropModel").default.getInstance(), pid = String(a.id), info = prm.getPropInfoById(pid);
                var have = info ? info.count : 0;
                if (!have) return { id: pid, used: 0, note: "none in bag" };
                if (a.count) have = Math.min(have, a.count);
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(note) { if (!fin) { fin = true; resolve({ id: pid, used: note === "ok" ? have : 0, note: note }); } }
                    if (!prm.useProp(pid, have, a.param || null, function (ok) { setTimeout(function () { end(ok === false ? "refused" : "ok"); }, 600); })) end("game refused");
                    setTimeout(function () { end("no answer in 10s"); }, 10000);
                });
            }
            case "rank_up": {   // the decree icon on the main screen: ProfileModel.improve -> profile/rank/upgrade
                var pm2 = R("ProfileModel").default.getInstance();
                function rankState() {
                    var d = pm2.getProfiledData(), cur = pm2.getRankSetting(d.rank.rank);
                    return { rank: d.rank.rank, exp: d.rank.exp, need: cur ? cur.consume : null,
                             can: !!(cur && d.rank.exp >= cur.consume && pm2.getRankSetting(d.rank.rank + 1)) };
                }
                var s0 = rankState();
                if (a.check || !s0.can) return { before: s0, upgraded: false };
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(note) { if (!fin) { fin = true; resolve({ before: s0, after: rankState(), upgraded: note === "ok", note: note }); } }
                    pm2.improve(function () { setTimeout(function () { end("ok"); }, 800); });
                    setTimeout(function () { end("no answer in 10s"); }, 10000);
                });
            }
            case "sign_status": {   // monthly sign-in (Phuc loi): next day, how many are missed, KNB the makeups cost
                var sg0 = R("SignModel").default.getInstance().getSignData().signMonth, today0 = R("System").default.getDate().getDate();
                var cs0 = R("ConstantModel").default.getInstance().getConstantById(210).para1, cost0 = 0;
                for (var q = 0; q < Math.max(0, today0 - sg0.day - (sg0.freeTime > 0 ? 0 : 1)); q++) cost0 += cs0[(sg0.isRepaired || 0) + q] || 0;
                return { signed: sg0.day, today: today0, free: sg0.freeTime, repaired: sg0.isRepaired, makeupCost: cost0,
                         knb: R("ResModel").default.getInstance().getResById(window.RES_MONEY4) };
            }
            case "sign_month": {    // sign today and make up every missed day (isRepair:1, costs KNB), like the Phuc loi screen
                var sgm = R("SignModel").default.getInstance(), rsm = R("ResModel").default.getInstance(), cons = R("ConstantModel").default.getInstance();
                return new Promise(function (resolve) {
                    var fin = false, done = 0, made = 0, spent0 = rsm.getResById(window.RES_MONEY4);
                    function end(why) {
                        if (fin) return; fin = true;
                        var s = sgm.getSignData().signMonth;
                        resolve({ done: done, makeups: made, signed: s.day, today: R("System").default.getDate().getDate(),
                                  spent: spent0 - rsm.getResById(window.RES_MONEY4), why: why });
                    }
                    (function step() {
                        var s = sgm.getSignData().signMonth, today = R("System").default.getDate().getDate();
                        if (s.day + 1 > today) return end("signed up to today");
                        if (done >= 40) return end("40 requests");
                        var repair = s.freeTime > 0 ? 1 : 0;
                        if (repair) {
                            var cost = cons.getConstantById(210).para1[s.isRepaired];
                            if (cost > rsm.getResById(window.RES_MONEY4)) return end("not enough KNB for makeup (need " + cost + ")");
                        }
                        var before = s.day, answered = false;
                        setTimeout(function () { if (!answered) end("no answer in 25s"); }, 25000);
                        sgm.getMonthlySignReward(repair, function () {
                            answered = true;
                            done++; if (repair) made++;
                            setTimeout(function () {
                                if (sgm.getSignData().signMonth.day === before) return end("server did not advance");
                                step();
                            }, 500);
                        });
                    })();
                    setTimeout(function () { end("timeout 90s"); }, 90000);
                });
            }
            case "achievements": {  // claim every achievement tier that is ready (AchieveModel.takeAchieve per category)
                var ach = R("AchieveModel").default.getInstance();
                return new Promise(function (resolve) {
                    var fin = false, types = Object.keys(ach.getAchieveData().list), claimed = {}, total = 0;
                    function end(why) { if (!fin) { fin = true; resolve({ total: total, claimed: claimed, why: why }); } }
                    (function nextType() {
                        if (!types.length) return end("ok");
                        var t = types.shift(), guard = 0;
                        (function again() {
                            var before = (ach.getAchieveData().list[t] || {}).took;
                            if (guard++ >= 40 || !ach.takeAchieve(Number(t), function () {
                                claimed[t] = (claimed[t] || 0) + 1; total++;
                                setTimeout(function () {
                                    var now = (ach.getAchieveData().list[t] || {}).took;
                                    if (now === before) return nextType();   // server did not advance: stop this category
                                    again();
                                }, 350);
                            })) nextType();
                        })();
                    })();
                    setTimeout(function () { end("timeout 90s"); }, 90000);
                });
            }
            case "stage_info": {    // story progress: the stage the player is on and whether chapter/stage `a` is cleared
                var st = R("StageModel").default.getInstance(), cur = st.curStageId, ci = st.getStageInfoById(cur) || {};
                var tid = null, k2;
                for (k2 in st.stageSetting) {
                    var si = st.stageSetting[k2];
                    if (si.chapter === a.chapter && si.stage === a.stage) { tid = Number(k2); break; }
                }
                var cleared = tid != null && !!st.isStageCleared(tid);
                return { cur: cur, chapter: ci.chapter, stage: ci.stage, target: tid, cleared: cleared };
            }
            case "boss_fight": {    // boss stage: every follower attacks once (strongest first) until the boss is dead
                var bf = R("FollowerModel").default.getInstance(), sm = R("ScenarioModel").default.getInstance();
                return new Promise(function (resolve) {
                    var fin = false, tried = [], log = [], results = [];
                    var tcb = R("ControllerManager").default.getInstance().getTopController(), enemyHp = tcb && tcb.enemyData ? tcb.enemyData.curHp : null, selfAtt = 0;
                    (bf.getAvailFolloIdListData() || []).forEach(function (id) { selfAtt += bf.getFightAttributeById(id); });
                    function end(win, why) {
                        if (fin) return; fin = true;
                        resolve({ win: !!win, tried: tried, why: why, enemyHp: enemyHp, selfAtt: selfAtt, results: results });
                    }
                    function onResult(res) {
                        results.push(safe(res, 120));
                        if (res && res.win) {
                            // hand the answer to the boss screen so it plays the win popup and moves on, like the real button
                            try {
                                var tc3 = R("ControllerManager").default.getInstance().getTopController();
                                if (tc3 && tc3.playFight && tc3.enemyData) {
                                    tc3.lastRankExp = Math.floor(R("ProfileModel").default.getInstance().getProfiledData().rank.exp);
                                    tc3.result = res;
                                    tc3.playFight();
                                }
                            } catch (e) { }
                            return true;
                        }
                        return false;
                    }
                    // one attack with every follower that is still able to fight (the damage adds up; one by one each of them is too weak)
                    var allIds = (bf.getAvailFolloIdListData() || []).filter(function (id) { return !bf.getFullFolloDataById(id).isDefeat; });
                    // Lenh Khoi Phuc (item 40006) revives one defeated follower for one more attack: after the all-in attack the boss keeps what is
                    // left of its HP, so revive the strongest fallen follower and hit again, while there are items
                    var pmb = R("PropModel").default.getInstance(), revives = 0;
                    function reviveRound() {
                        var info = pmb.getPropInfoById("40006");
                        if (!info || !info.count || revives >= 12) return end(false, "lost; no more revive items (used " + revives + ")");
                        var fallen = (bf.getAvailFolloIdListData() || []).filter(function (id) { return bf.getFullFolloDataById(id).isDefeat; })
                            .sort(function (x, y) { return bf.getFightAttributeById(y) - bf.getFightAttributeById(x); });
                        if (!fallen.length) return end(false, "lost; nobody to revive");
                        var fid = fallen[0];
                        revives++;
                        var sent = pmb.useProp("40006", 1, [fid, 1], function () {
                            setTimeout(function () {
                                tried.push(fid);
                                sm.doScenario(1, [fid], function (res) {
                                    var w = onResult(res);
                                    if (w) return end(true, "boss defeated after " + revives + " revive(s)");
                                    reviveRound();
                                });
                            }, 900);
                        });
                        if (!sent) end(false, "could not use the revive item");
                    }
                    if (allIds.length && !a.single) {
                        tried = allIds.slice();
                        return sm.doScenario(1, allIds, function (res) {
                            var w = onResult(res);
                            if (w) return end(true, "boss defeated (all at once)");
                            if (a.noRevive) return end(false, "lost with all followers at once");
                            reviveRound();
                        });
                    }
                    (function step() {
                        var ids = (bf.getAvailFolloIdListData() || []).filter(function (id) {
                            return tried.indexOf(id) < 0 && !bf.getFullFolloDataById(id).isDefeat;
                        });
                        if (!ids.length) return end(false, "all followers have attacked");
                        ids.sort(function (x, y) { return bf.getFightAttributeById(y) - bf.getFightAttributeById(x); });
                        var id = ids[0];
                        tried.push(id);
                        sm.doScenario(1, [id], function (res) {
                            results.push(safe(res, 120));
                            if (res && res.win) {
                                // hand the answer to the boss screen so it plays the win popup and moves on, like the real button
                                try {
                                    var tc2 = R("ControllerManager").default.getInstance().getTopController();
                                    if (tc2 && tc2.playFight && tc2.enemyData) {
                                        tc2.lastRankExp = Math.floor(R("ProfileModel").default.getInstance().getProfiledData().rank.exp);
                                        tc2.result = res;
                                        tc2.playFight();
                                    }
                                } catch (e) { }
                                return end(true, "boss defeated");
                            }
                            setTimeout(step, 600);
                        });
                    })();
                    setTimeout(function () { end(false, "timeout 60s"); }, 60000);
                });
            }
            case "guide_state": {   // tutorial steps the server already counts as done
                var gm0 = R("GuideModel").default.getInstance();
                return { done: (gm0.getGuideData().guideList || []).slice() };
            }
            case "guide_done": {    // exactly what the game calls when the player finishes a tutorial step
                var ids = [].concat(a.ids || []);
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(note) { if (!fin) { fin = true; resolve({ ids: ids, note: note }); } }
                    R("GuideModel").default.getInstance().guideDone(ids, function () { end("ok"); });
                    setTimeout(function () { end("no answer in 5s"); }, 5000);
                });
            }
            case "main_task": {     // progress of the main (story) task chain
                var tm = R("TaskModel").default.getInstance();
                return { data: safe(tm.getMainTaskData(), 2500), finished: !!tm.isMainTaskFinished() };
            }
            case "net_post": {      // send one request through the game's own NetManager (same as any button does)
                return new Promise(function (resolve) {
                    var fin = false;
                    function end(o) { if (!fin) { fin = true; resolve(o); } }
                    R("NetManager").default.getInstance().post(a.uri, a.data === undefined ? null : a.data,
                        function (ok, msg, res) { end({ ok: !!ok, msg: String(msg || "").slice(0, 200), result: safe(res, 2500) }); });
                    setTimeout(function () { end({ ok: false, msg: "no answer in 15s" }); }, 15000);
                });
            }
            case "top_controller": {
                var cmgr = R("ControllerManager").default.getInstance();   // undefined while the game is still booting
                if (!cmgr) return { name: null };
                var tc = cmgr.getTopController();
                return { name: tc ? (tc.name || (tc.constructor && tc.constructor.name) || null) : null };
            }
            case "logout":   // same as the account screen's switch-account button (FunTap SDK logout)
                R("Channel").getChannel().loginOut();
                return { ok: true };
            case "money": {   // resources the player holds; knb = RES_MONEY4 (the gold the daily tasks pay)
                var rm = R("ResModel").default.getInstance(), all = {};
                [1, 2, 3, 4, 6].forEach(function (i) { all[i] = rm.getResById(i); });
                return { knb: rm.getResById(window.RES_MONEY4), all: all };
            }
            case "greet_status": return { greeted: !!R("GreetingModel").default.getInstance().ifGreet() };
            case "greet": return greetOnce(a.pos);
            case "worship_status": {
                var ws = worshipInfo();
                return { can: ws.can.map(function (i) { return { idx: i, type: ws.types[i], name: RANK_NAMES[ws.types[i]] || ws.types[i] }; }) };
            }
            case "worship": return worshipAll();
            case "servers": {
                var ac = acctCtrl(), sl = ac.serverList;
                return { zone: ac.zone, suggest: sl.suggest || null, role: (sl.role || []).map(function (r) { return r.zone; }),
                         bigZones: ac.bigZoneList, servers: allServers(ac) };
            }
            case "pick_server": {   // same effect as choosing it in the server popup
                var ac2 = acctCtrl(), tbl = ac2.serverIdTable, found = null, key = null, k;
                if (a.id != null && tbl[a.id]) { found = tbl[a.id]; key = a.id; }
                else if (a.number != null) {
                    var re = new RegExp("^\\s*S?0*" + Number(a.number) + "\\b", "i");
                    for (k in tbl) if (re.test(String(tbl[k].name || ""))) { found = tbl[k]; key = k; break; }
                }
                if (!found) return { ok: false, reason: "server not found" };
                ac2.zone = found.id !== undefined ? found.id : key;
                ac2.helper(R("AccountHelper").default).setZoneIcon(ac2.btnZone, found);
                return { ok: true, picked: { id: ac2.zone, name: found.name, sts: found.sts } };
            }
            case "ping": return { pong: true, scene: cc.director.getScene() && cc.director.getScene().name };
            case "state": return collect();
            case "click_path": return { clicked: clickNode(a.path) };   // cheap: no scan of the whole screen
            case "click":
                var f = findButtons(a), nth = a.nth || 0;
                if (!f.length) return { clicked: false, reason: "no such button" };
                if (nth >= f.length) return { clicked: false, reason: "only " + f.length + " match(es)" };
                return { clicked: clickNode(f[nth].p), button: f[nth], matches: f.length };
            case "eval":   // development helper (token-protected, loopback only)
                var r = eval(a.code);
                if (r && typeof r.then === "function") return r.then(function (v) { try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (e) { return String(v); } });
                try { return JSON.parse(JSON.stringify(r === undefined ? null : r)); } catch (e) { return String(r); }
            default: throw new Error("unknown command " + c.cmd);
        }
    }

    // ---- log forwarding: lines handed to window.__agent_log are POSTed to the Manager ---------
    var logq = [], flushing = false;
    
    function flushLogs() {
        if (flushing || !logq.length) return;
        var c = readCfg();
        if (!c) return;
        flushing = true;
        var batch = logq.splice(0, logq.length);
        setTimeout(function () { flushing = false; }, 15000);
        http("POST", "/log?id=" + encodeURIComponent(c.id) + "&token=" + encodeURIComponent(c.token),
            JSON.stringify(batch), function (ok) { if (ok === null) logq = batch.concat(logq); flushing = false; });
    }
    

    // ---- poll loop ---------------------------------------------------------------------------
    var cfg = null, busy = false, busySince = 0, lostAt = 0, cur = null, seen = {};
    (function () {   // a 401 multiLogin (the client lost its session token): remember when, so commands waiting for an answer can give up
        var old = window.__fastui_log;
        window.__fastui_log = function (kind, name) {
            if (kind === "neterr" && /multiLogin|^200 \[\]/.test(String(name))) lostAt = Date.now();   // 401, or an empty 200 answer (the rotated token never arrived)
            return old && old.apply(this, arguments);
        };
        setInterval(function () {
            if (cur && !cur.sent && lostAt > cur.t0 && Date.now() - lostAt > 4000) cur.fail("session lost (401 multiLogin)");
        }, 500);
    })();
    function loop() {
        // an XHR that never calls back (no timeout in this runtime) must not freeze the agent: take a new poll after 25 s
        if (busy && Date.now() - busySince < 25000) return;
        busySince = Date.now();
        if (!cfg) { cfg = readCfg(); if (!cfg) return; L("online as " + cfg.id); }
        busy = true;
        var q = "?id=" + encodeURIComponent(cfg.id) + "&token=" + encodeURIComponent(cfg.token);
        http("GET", "/poll" + q, null, function (txt) {
            var c = null;
            try { c = txt ? JSON.parse(txt) : null; } catch (e) { }
            if (!c || !c.cmd) { busy = false; setTimeout(loop, txt === null ? 300 : 0); return; }
            var known = seen[c.rid];
            if (known) {   // a repeat of a command we already have: answer again if finished, else it is still running
                if (known.res) { busy = true; http("POST", "/result" + q, JSON.stringify(known.res), function () { busy = false; setTimeout(loop, 0); }); }
                else busy = false;
                return;
            }
            seen[c.rid] = { res: null };
            var seenKeys = Object.keys(seen);
            if (seenKeys.length > 60) delete seen[seenKeys[0]];
            var t0 = Date.now();
            var me = cur = { t0: t0, sent: false };
            me.fail = function (why) { send({ rid: c.rid, ok: false, error: why }); };
            function send(res) {
                if (me.sent) return;
                me.sent = true;
                if (seen[c.rid]) seen[c.rid].res = res;
                try { window.__fastui_log && window.__fastui_log("agent", c.cmd + " " + (res.ok ? "ok" : "ERR " + res.error) + " " + (Date.now() - t0) + "ms"); } catch (e) { }
                var tries = 0, payload = JSON.stringify(res);
                (function post() {   // the answer must reach the Manager: try again when the request hung
                    http("POST", "/result" + q, payload, function (ok) {
                        if (ok === null && ++tries < 3) return post();
                        busy = false;
                        setTimeout(loop, 0);   // ask for the next command at once
                    });
                })();
            }
            var out;
            try { out = handle(c); } catch (e) { send({ rid: c.rid, ok: false, error: String(e) }); return; }
            if (out && typeof out.then === "function")   // async command (e.g. a server request)
                out.then(function (d) { send({ rid: c.rid, ok: true, data: d }); },
                         function (e) { send({ rid: c.rid, ok: false, error: String(e) }); });
            else send({ rid: c.rid, ok: true, data: out });
        });
    }
    window.__mod_handle = function (c) { return handle(c); };
    L("loaded");
})();

(function () {
var R = function (n) { return window.__require(n); };
// Nhiệm vụ hàng ngày: pieces that have no agent command, sent with the 'eval' command (tasks.nhiem_vu_ngay adds a call
// at the end, e.g. "DT.symptic(30)"), so no rebuild/deploy of the game is needed. Each returns {done, note, ...}.
// Found 2026-11-01 on acc 0: the daily task types and the call that counts for each (TaskModel.taskData.daily.list[type].count).
var DT = (function () {
    function model(n) { return R(n).default.getInstance(); }
    function req(f, ms) {   // f(done): sends a request; resolves with done(x) or "no answer" after ms
        return new Promise(function (res) {
            var fin = false;
            function d(x) { if (!fin) { fin = true; res(x === undefined ? "ok" : x); } }
            try { var r = f(d); if (r === false) d("refused"); } catch (e) { d("ERR " + e); }
            setTimeout(function () { d("no answer"); }, ms || 8000);
        });
    }
    function count(type) { var e = model("TaskModel").getDailyTaskData().list[type]; return e ? e.count : 0; }
    function loop(max, step) {   // step() -> promise of true (go on) / false (stop); at most `max` steps
        var n = 0;
        function next() { return n >= max ? Promise.resolve(n) : step().then(function (go) { if (!go) return n; n++; return next(); }); }
        return next();
    }
    return {
        // every daily task: [id, name, type, count, target, took, active]; plus the activity and its chests
        status: function () {
            var tm = model("TaskModel"), d = tm.getDailyTaskData(), set = tm.dailyTaskSetting, out = [];
            Object.keys(set).forEach(function (k) {
                var s = set[k], e = d.list[s.type];
                out.push([s.id, s.name, s.type, e ? e.count : 0, s.target, !!(e && e.took), s.active]);
            });
            return { active: d.active, chests: d.activeReward, tasks: out };
        },
        // Thận Hình Ty (Dạy Dỗ Kẻ Thù, type 6): punish the current prisoner, 10 energy each (300 a day)
        symptic: function (target) {
            var sm = model("SympticModel");
            return loop(40, function () {
                if (count(6) >= target || !sm.getCurrentSymptic()) return Promise.resolve(false);
                return req(function (d) { sm.punishSymptic(false, function () { d(); }); }).then(function (r) {
                    return r === "ok" ? new Promise(function (ok) { setTimeout(function () { ok(true); }, 300); }) : false;
                });
            }).then(function (n) { return { done: n, count: count(6), energy: sm.getCurrentEnergy() }; });
        },
        // Cầu Phúc (type 31): PrayModel.pray while it is free (the rank gives some free prayers a day)
        pray_free: function (target) {
            var pm = model("PrayModel");
            return loop(10, function () {
                var p = pm.getPrayData();
                if (count(31) >= target || p.limit || p.cost > 0) return Promise.resolve(false);
                return req(function (d) { return pm.pray(1, function () { d(); }); }).then(function (r) { return r === "ok"; });
            }).then(function (n) { var p = pm.getPrayData(); return { done: n, count: count(31), next_cost: p.cost }; });
        },
        // Cầu Nguyện = Hồ Cẩm Lý (type 21): the free draw only (same free check as LotteryModel.reqDrawLottery)
        lottery_free: function () {
            var lm = model("LotteryModel"), set = lm.lotterySettings[1], last = lm.lastFreeTimes[1];
            var now = R("System").default.time();
            if (count(21) >= 1) return { done: 0, note: "đã làm" };
            if (last !== undefined && !(last + set.times_free < now)) return { done: 0, note: "chưa tới lượt miễn phí" };
            return req(function (d) { lm.reqDrawLottery(1, false, false, function (ok, msg) { d(ok ? "ok" : "lỗi " + msg); }); }).then(function (r) {
                return { done: r === "ok" ? 1 : 0, note: r, count: count(21) };
            });
        },
        // Kỳ Ngộ = Xuất Cung (TripModel.visit, type 36): spends the energy (5 max, refills with time); no money for luck
        trip: function (target) {
            var tp = model("TripModel");
            return loop(12, function () {
                var v = tp.getVisitData();
                if (count(36) >= target || !v.energy || v.lucky < 2) return Promise.resolve(false);
                return req(function (d) { var r = tp.visit(Math.min(80, v.lucky), false, false, function () { d(); }); if (r !== 3 && r !== 0 && r !== undefined) d("code " + r); }).then(function (r) {
                    return r === "ok" ? new Promise(function (ok) { setTimeout(function () { ok(true); }, 400); }) : false;
                });
            }).then(function (n) { var v = tp.getVisitData(); return { done: n, count: count(36), energy: v.energy, lucky: v.lucky }; });
        },
        // Đình Viện: buy cheap seeds (garden shop, Bạch Ngân) until the bag holds `want` seeds
        buy_seeds: function (want) {   // garden shop rows: {id: seed item id, costMoney2 (Bạch Ngân) | costMoney4 (KNB), isLock}
            var mm = model("ManorModel"), pm = model("PropModel"), seeds = 0;
            var shop = mm.getGardenShopInfo().filter(function (s) { return !s.isLock; });
            shop.forEach(function (s) { var p = pm.getPropInfoById(s.id); seeds += p ? p.count : 0; });
            var need = Math.max(0, want - seeds);
            if (!need) return { done: 0, have: seeds };
            var pick = shop.filter(function (s) { return s.costMoney2 && !s.costMoney4; })
                .sort(function (a, b) { return a.costMoney2 - b.costMoney2; })[0];
            if (!pick) return { done: 0, have: seeds, note: "shop không có hạt giá Bạch Ngân" };
            if (model("ResModel").getResById(window.RES_MONEY2) < pick.costMoney2 * need) return { done: 0, have: seeds, note: "không đủ Bạch Ngân" };
            return req(function (d) { return mm.buyProp(pick.id, need, function () { setTimeout(d, 800); }); }).then(function (r) {   // the answer carries no data
                var p = pm.getPropInfoById(pick.id), now = p ? p.count : 0;
                return { done: now, seed: pick.id, note: r, have: seeds };
            });
        },
        // seed Nấm Thuộc Tính 90012 (garden shop, Bạch Ngân). A purchase the server refuses ends the session: buy only what the silver pays
        buy_mushroom: function (n) {
            var mm = model("ManorModel"), pm = model("PropModel");
            function have() { var p = pm.getPropInfoById(90012); return p ? p.count : 0; }
            var row = mm.getGardenShopInfo().filter(function (s) { return s.id === 90012 && !s.isLock; })[0], h0 = have();
            if (!row || !row.costMoney2) return { bought: 0, note: "shop không bán hạt nấm" };
            n = Math.min(n, Math.floor(model("ResModel").getResById(window.RES_MONEY2) / row.costMoney2));
            if (n < 1) return { bought: 0, note: "không đủ Bạch Ngân" };
            return req(function (d) { return mm.buyProp(90012, n, function () { setTimeout(d, 800); }); }).then(function (r) {
                return { bought: have() - h0, note: r + ", " + row.costMoney2 + " Bạch Ngân/hạt" };
            });
        },
        // outfit screen of a story stage: wear what scores best for it, by the score of each owned piece (value x stage weight x
        // class weight). The stage only uses this list; the outfit saved on the character does not change.
        // (AvatarModel.getBestClothList does the same choice but is dead code in this build: it crashes)
        best_cloth: function () {
            var c = R("ControllerManager").default.getInstance().getTopController(), am = model("AvatarModel");
            if (!c || !c.avatarStage || !c.avatarDisplay) return { done: false, note: "không ở màn thay đồ" };
            var st = c.avatarStage, renew = am.getRenewData() || {}, best = {};
            function score(id) {
                var o = am.getCostumeSetting(id), t = 0, k = st.label && o.label.indexOf(st.label) < 0 ? 0.1 : 1, ch = am.getClassSetting(o.classId).channce;
                (o.styleValue || []).forEach(function (v) {
                    (st.requireStyle || []).forEach(function (w) {
                        if (v && v[0] === w[0]) t += Math.floor((v[1] + (renew[o.set] ? am.getRenewAddByCount(v[1]) : 0)) * w[1] * ch * k);
                    });
                });
                return t;
            }
            function sc(k) { return best[k] ? best[k].score : 0; }
            Object.keys(am.costumeOwnStatus).forEach(function (k) {
                var id = +k, o = am.getCostumeSetting(id);
                if (!o || !am.costumeOwnStatus[k]) return;
                var s = score(id);
                if (!best[o.classId] || s > best[o.classId].score) best[o.classId] = { id: id, score: s };
            });
            var list = [], total = 0;
            function wear(k) { if (best[k]) { list.push(best[k].id); total += best[k].score; } }
            if (sc(1) > sc(2) + sc(3) || !best[2] || !best[3]) wear(1); else { wear(2); wear(3); }
            if (sc(14) > sc(114) + sc(214) + sc(314) + sc(414) + sc(514) || !best[114]) wear(14); else [114, 214, 314, 414, 514].forEach(wear);
            var fx = [17, 18, 19].filter(function (k) { return best[k]; }).sort(function (x, y) { return sc(y) - sc(x); })[0];
            if (fx) wear(fx);
            Object.keys(best).map(Number).forEach(function (k) {   // the other pieces; shoes and hair are always needed
                if ([1, 2, 3, 14, 114, 214, 314, 414, 514, 17, 18, 19].indexOf(k) < 0 && (best[k].score > 0 || k === 6 || k === 15)) wear(k);
            });
            var now = 0;
            c.avatarDisplay.getCoordination().getWearingList().forEach(function (x) { if (am.getCostumeSetting(x)) now += score(x); });
            c.avatarDisplay.updateAll(list);
            return { done: true, note: list.length + " món, ước " + now + " -> " + total + " điểm, ải cần " + st.firstScore };
        },
        // Pet: Nhận bình dự trữ (type 81: receivePetCoin), chăm pet (type 82 x10: playPet with the 4 toys, 6 a day each),
        // cho ăn (type 59 x3: ONE food at a time from the bag; feeding 2 at once got 'Xác thực dữ liệu thất bại' = session lost)
        pet: function () {
            var m = model("PetModel"), pm = model("PropModel"), o = { coin: 0, play: 0, feed: 0 };
            var pid = Object.keys(m.getData().pets || {})[0];
            if (!pid) return { note: "chưa có pet" };
            pid = Number(pid);
            var kind = 1, tries = 0;
            return (count(81) < 1 ? req(function (d) { m.receivePetCoin(false, function (ok) { d(ok ? "ok" : "lỗi"); }); }) : Promise.resolve("đã nhận")).then(function (r) {
                o.coin = r;
                return loop(30, function () {
                    if (count(82) >= 10 || tries >= 8) return Promise.resolve(false);
                    var k = kind; kind = kind % 4 + 1;
                    return req(function (d) { m.playPet(pid, k, false, function (ok) { d(ok ? "ok" : "lỗi"); }); }, 6000).then(function (r) {
                        if (r === "ok") o.play++; else tries++;
                        return true;
                    });
                });
            }).then(function () {
                return loop(3, function () {
                    if (count(59) >= 3) return Promise.resolve(false);
                    var pet = m.getPetById(pid), set = m.getFoodSetting(), food = null;
                    for (var k in set) {
                        var f = set[k], p = pm.getPropInfoById(f.item);
                        if (p && p.count > 0 && pet.lv >= f.level[0] && pet.lv <= f.level[1] && !m.checkFoodExpOverflow(pid, f.id, 1)[0]) { food = f; break; }
                    }
                    if (!food) { o.feed_note = "hết thức ăn hợp cấp pet"; return Promise.resolve(false); }
                    return req(function (d) { m.feed(pid, food.id, 1, function (ok) { d(ok ? "ok" : "lỗi"); }); }, 6000).then(function (r) {
                        if (r !== "ok") return false;
                        o.feed++;
                        return new Promise(function (ok) { setTimeout(function () { ok(true); }, 500); });
                    });
                });
            }).then(function () { o.counts = [count(81), count(82), count(59)]; return o; });
        },
        // ---- Nấu ăn (Cấp Tẩm / HomelandModel): cooking a recipe the first time unlocks it and adds its prosperity
        // (21 recipes, 93 200 in all). Ingredients: HomelandModel shop page 3 (ids 31-51: 7000xx 32 000 Bạch Ngân, others KNB),
        // except Rau Củ 700101 = grown from Hạt Rau Củ 341126 (Đình Viện shop = PetModel shop id 143, 48 000 Bạch Ngân, 6 h, 3-5 rau).
        cook_status: function () {
            var hm = model("HomelandModel"), pm = model("PropModel"), set = hm.cookIdSetting, un = hm.getHomelandData().cook.unlock, miss = [];
            Object.keys(set).forEach(function (k) {
                var r = set[k];
                if (r.isBook && un.indexOf(r.id) < 0) miss.push({ id: r.id, name: r.name, ing: r.longth, rau: (r.longth || []).indexOf(700101) >= 0 });
            });
            var rau = pm.getPropInfoById(700101), seed = pm.getPropInfoById(341126);
            return { done: hm.getCookProgress()[0], total: hm.getCookProgress()[1], prosperity: hm.getProsperity(), missing: miss,
                     rau: rau ? rau.count : 0, rau_seeds: seed ? seed.count : 0, knb: model("ResModel").getResById(window.RES_MONEY4) };
        },
        // cook every missing recipe whose ingredients are in the bag or can be bought (KNB kept >= floor); Rau Củ only from the bag
        cook_all: function (floor) {
            var hm = model("HomelandModel"), pm = model("PropModel"), rm = model("ResModel"), shop = hm.getShopSetting(), byItem = {};
            for (var k in shop) if (shop[k].page === 3) byItem[shop[k].item] = shop[k];
            function have(i) { var p = pm.getPropInfoById(i); return p ? p.count : 0; }
            var st = DT.cook_status(), out = { cooked: [], skipped: [], spent_knb: 0 };
            var todo = st.missing.slice().sort(function (a, b) { return a.id - b.id; });
            function buy(item) {
                var sh = byItem[item];
                if (!sh) return Promise.resolve(false);
                if (sh.res4Price) {
                    if (rm.getResById(window.RES_MONEY4) - sh.res4Price < floor) return Promise.resolve(false);
                } else if (sh.res2Price && rm.getResById(window.RES_MONEY2) < sh.res2Price) return Promise.resolve(false);
                return req(function (d) { hm.buyShopList(sh.id, 1, function () { setTimeout(d, 500); }); }).then(function () {
                    if (sh.res4Price && have(item) > 0) out.spent_knb += sh.res4Price;
                    return have(item) > 0;
                });
            }
            function next() {
                var r = todo.shift();
                if (!r) return Promise.resolve();
                var ing = r.ing || [], i = 0;
                if (r.rau && have(700101) < 1) { out.skipped.push(r.id + " thiếu rau"); return next(); }   // no buying for it before the vegetables
                function gather() {   // one of each ingredient, bought one at a time
                    if (i >= ing.length) return Promise.resolve(true);
                    var item = ing[i++];
                    if (have(item) > 0) return gather();
                    if (item === 700101) return Promise.resolve("thiếu rau");
                    return buy(item).then(function (ok) { return ok ? gather() : "không mua được " + item; });
                }
                return gather().then(function (ok) {
                    if (ok !== true) { out.skipped.push(r.id + " " + ok); return next(); }
                    return req(function (d) { hm.cook(ing, function (good, msg, id) { d([good, msg, id]); }); }).then(function (x) {
                        if (x && x[2] === r.id) out.cooked.push(r.id); else out.skipped.push(r.id + " nấu ra " + JSON.stringify(x));
                        return new Promise(function (ok2) { setTimeout(ok2, 400); });
                    }).then(next);
                });
            }
            return next().then(function () {   // Phồn Vinh levels: only through prosperity_up (the user keeps them for the ranking event)
                var s2 = DT.cook_status(); out.done = s2.done; out.total = s2.total; out.prosperity = s2.prosperity; out.knb = s2.knb;
                out.rau_left = s2.missing.filter(function (m) { return m.rau; }).length; out.rau = s2.rau;
                return out;
            });
        },
        // Phồn Vinh: activate every hall level the prosperity reaches (each gives attributes = sức hút)
        prosperity_up: function () {
            var hm = model("HomelandModel"), cur = hm.getProsperity(), act = hm.getHomelandData().prosperityActive || [];
            var lv = hm.getProsperityHallList().filter(function (h) { return h.prosperity <= cur && act.indexOf(h.level) < 0; }).map(function (h) { return h.level; });
            var done = [];
            return loop(lv.length, function () {
                var l = lv.shift();
                return req(function (d) { hm.activeProsperityLevel(l, function (ok) { d(ok ? "ok" : "lỗi"); }); }).then(function (r) { if (r === "ok") done.push(l); return r === "ok"; });
            }).then(function () { return done; });
        },
        // Hạt Rau Củ: buy until the bag holds `want` (Đình Viện shop row 143, Bạch Ngân)
        buy_veg_seeds: function (want) {
            var pt = model("PetModel"), pm = model("PropModel"), p = pm.getPropInfoById(341126), have = p ? p.count : 0;
            if (have >= want) return { bought: 0, have: have };
            // a purchase the server refuses (not enough Bạch Ngân) ends the session ('Xác thực dữ liệu thất bại'): check first
            var n = Math.min(want - have, Math.floor(model("ResModel").getResById(window.RES_MONEY2) / 48000));
            if (n < 1) return { bought: 0, have: have, note: "không đủ Bạch Ngân" };
            return req(function (d) { pt.buyProp(143, n, function () { setTimeout(d, 800); }); }).then(function (r) {
                var q = pm.getPropInfoById(341126); return { bought: (q ? q.count : 0) - have, have: q ? q.count : 0, note: r };
            });
        },
        // shop Cấp Tẩm opens at Cấp Tẩm level 2 (constant HOMELAND_FUNCTION_UNLOCK); level = crafting exp (homeland makeExp):
        // craft the bed "Mộng Xuân Thu" (furniture 11003, Phượng Các > Trang trí > Chế tác) up to 3 times like the player does
        homeland_shop: function () {
            var hm = model("HomelandModel"), cm = R("ConstantModel"), need = cm.default.getInstance().getConstantById(cm.ConstantType.HOMELAND_FUNCTION_UNLOCK).para1, made = 0;
            return loop(3, function () {
                if (hm.getHomelandLevel() >= need) return Promise.resolve(false);
                return req(function (d) { hm.makeFurniture(11003, 1, function (x) { d(x ? "ok" : "lỗi"); }); }).then(function (r) {
                    if (r !== "ok") return false;
                    made++;
                    return new Promise(function (ok) { setTimeout(function () { ok(true); }, 600); });
                });
            }).then(function () { return { open: hm.getHomelandLevel() >= need, level: hm.getHomelandLevel(), need: need, made: made }; });
        },
        // Phân Bón 90030: shop Cấp Tẩm, tab Đặc biệt (PetModel shop row 11, 100 KNB); buy until the bag holds `want`
        buy_fert: function (want, floor) {
            var pt = model("PetModel"), pm = model("PropModel"), rm = model("ResModel");
            function have() { var p = pm.getPropInfoById(90030); return p ? p.count : 0; }
            var h0 = have(), n = want - h0;
            if (n <= 0) return { bought: 0, have: h0 };
            if (rm.getResById(window.RES_MONEY4) - 110 * n < floor) return { bought: 0, have: h0, note: "không đủ KNB" };
            return req(function (d) { pt.buyProp(11, n, function () { setTimeout(d, 800); }); }).then(function (r) { return { bought: have() - h0, have: have(), note: r }; });
        },
        // fertilize plot idx until it is ripe (each Phân Bón cuts the growing time; 3 ripen a 6 h vegetable), then harvest everything ripe
        ripen: function (idx) {
            var mm = model("ManorModel"), pm = model("PropModel"), used = 0;
            function land() { return (mm.getManorData().lands || [])[idx]; }
            function rau() { var p = pm.getPropInfoById(700101); return p ? p.count : 0; }
            var r0 = rau();
            return loop(6, function () {
                var l = land();
                if (!l || !l.seedType || l.plantEndTime <= R("System").default.time()) return Promise.resolve(false);
                return req(function (d) { var x = mm.fertilizeOnLand(idx, function () { d(); }); if (x !== undefined) d("code " + x); }).then(function (r) {
                    if (r !== "ok") return false;
                    used++;
                    return new Promise(function (ok) { setTimeout(function () { ok(true); }, 500); });
                });
            }).then(function () {
                var l = land();
                if (!l || !l.seedType || l.plantEndTime > R("System").default.time()) return { used: used, rau_got: 0, rau: rau(), note: "chưa chín" };
                return Promise.resolve(handle({ cmd: "manor_gather", args: {} })).then(function (g) {
                    return new Promise(function (ok) { setTimeout(ok, 800); }).then(function () { return { used: used, rau_got: rau() - r0, rau: rau(), gather: g && g.plots }; });
                });
            });
        },
        // Du Ngoạn (TravelModel, the button next to Kỳ Ngộ): a trip lasts 8 h (TOTALTIME); scene 101 = at home.
        // at home -> start; 8 h passed -> finish (= take the chest) then start again; still travelling -> collect what is ready
        travel: function () {
            var tv = model("TravelModel"), d = tv.getTravelData(), now = R("System").default.time();
            function start(note) {
                return req(function (x) { tv.startTravel(null, function (ok, e) { x(ok ? "ok" : "lỗi " + e); }); }).then(function (r) {
                    return { note: note + (r === "ok" ? "đã đi Du Ngoạn" : "đi Du Ngoạn " + r) };
                });
            }
            if (!d || !d.scene || d.scene === 101) return start("");
            var h = (now - d.ts) / 3600;
            if (h >= 8) {
                return req(function (x) { tv.finishTravel(function (ok, e) { x(ok ? "ok" : "lỗi " + e); }); }).then(function (r) {
                    return start(r === "ok" ? "nhận rương Du Ngoạn, " : "nhận rương lỗi (" + r + "), ");
                });
            }
            return req(function (x) { tv.calculateTravel(function () { x(); }); }).then(function () {
                var left = Math.round((8 - h) * 60);
                return { note: "đang Du Ngoạn, còn " + Math.floor(left / 60) + "h" + ("0" + left % 60).slice(-2) };
            });
        },
        // Hội Hoa Lạc Dương (Trung Cung, next to Thỉnh An): the first comment ("bullet") of the day pays KNB.
        // Same checks as the game's buttons: the event must be on (ActivityType.FLOWER_FAIR), one comment a day (ts),
        // spaces are taken out and 2-20 letters are allowed.
        flower_bullet: function (text) {
            var am = model("ActivityModel"), fm = model("FlowerFairModel"), now = R("System").default.time();
            if (!am.getData(R("ActivityModel").ActivityType.FLOWER_FAIR)) return { done: false, note: "Hội Hoa chưa mở" };
            if (IsSameDay(now, fm.getBulletTs())) return { done: false, note: "hôm nay đã bình luận" };
            var t = String(text).replace(/\ +/g, "").replace(/[\r\n]/g, "");
            if (t.length > 20 || t.length < 2) return { done: false, note: "bình luận phải 2-20 chữ: " + t };
            var knb0 = model("ResModel").getResById(window.RES_MONEY4);
            return req(function (d) { fm.sendBullet(t, function () { d(); }); }, 10000).then(function (r) {
                var ok = IsSameDay(R("System").default.time(), fm.getBulletTs());
                return { done: ok, note: (ok ? "đã bình luận \"" + t + "\"" : "bình luận chưa được (" + r + ")"),
                         knb: model("ResModel").getResById(window.RES_MONEY4) - knb0 };
            });
        },
        // Hành trang column of Check Info: counts of the chosen item ids + what the bag is worth:
        // favor = Thiện Cảm if every gift is given (Túi Thơm 70001 = 1, Ngân Sức 70002 = 2, Phỉ Thúy 70003 = 3),
        // scrolls = Cuộn Sách Tư Chất 20003-20006 together, attr = attributes if every type-1 item is used
        // (value, or the middle of [min, max]), res = Hâm Mộ (1), Bạch Ngân (2), Nổi Tiếng (3)
        bag: function (ids) {
            var pm = model("PropModel"), rm = model("ResModel"), o = { items: {} };
            function c(i) { var p = pm.getPropInfoById(i); return p ? p.count : 0; }
            (ids || []).forEach(function (i) { o.items[i] = c(i); });
            o.favor = c(70001) + 2 * c(70002) + 3 * c(70003);
            o.scrolls = c(20003) + c(20004) + c(20005) + c(20006);
            var attr = 0;
            for (var id in pm.propInfoSetting) {
                var it = pm.propInfoSetting[id];
                if (!it || !(it.count > 0) || Number(it.type) !== 1) continue;
                var v = it.value;
                if (Array.isArray(v)) v = (Number(v[0]) + Number(v[1])) / 2;
                if (Number(v) > 0) attr += it.count * Number(v);
            }
            o.attr = Math.round(attr);
            o.hm = rm.getResById(1); o.bn = rm.getResById(2); o.nt = rm.getResById(3);
            return o;
        }
    };
})();

window.DT = DT;
})();

// PHCT mod (phone): the jobs of the menu. Ported from manager/tasks.py (run_daily, noi_chinh, nhiem_vu_ngay, story_auto strong=False);
// window.__mod_handle = the game commands of agent_patch.js, window.DT = manager/daily_lib.js.
(function () {
    var R = function (n) { return window.__require(n); };
    function model(n) { return R(n).default.getInstance(); }
    function sleep(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
    function H(cmd, args, secs) {   // a game command, never waits forever
        return new Promise(function (ok, no) {
            var t = setTimeout(function () { no(new Error("game không trả lời lệnh " + cmd)); }, (secs || 30) * 1000);
            Promise.resolve().then(function () { return window.__mod_handle({ cmd: cmd, args: args || {} }); })
                .then(function (v) { clearTimeout(t); ok(v); }, function (e) { clearTimeout(t); no(e); });
        });
    }
    var T = window.PHCT.tasks = { job: null, stop: false, log: [], onChange: null };
    function log(s) {
        T.log.push(s);
        if (T.log.length > 200) T.log.shift();
        try { console.log("PHCT " + s); } catch (e) { }
        if (T.onChange) T.onChange();
    }
    T.say = log;
    function check() { if (T.stop) throw new Error("đã dừng"); }
    T.run = function (name, fn) {   // one job at a time
        if (T.job) { log("Đang chạy " + T.job + ", chờ xong hoặc bấm Dừng"); return; }
        T.job = name; T.stop = false;
        log("--- " + name);
        Promise.resolve().then(fn).then(function (r) { log(name + ": " + (r || "xong")); }, function (e) { log(name + " dừng: " + (e && e.message || e)); })
            .then(function () { T.job = null; if (T.onChange) T.onChange(); });
    };

    // ---- 4. Nội Chính ----
    T.noiChinh = async function () {
        var names = { 1: "Hâm Mộ", 2: "Bạch Ngân", 3: "Nổi Tiếng" }, out = [];
        for (var e = 1; e <= 3; e++) {
            var got = 0;
            for (var i = 0; i < 10; i++) {
                check();
                if (!(await H("errand_take", { n: e }, 20)).ok) break;
                got++;
            }
            out.push(names[e] + " " + got);
        }
        return out.join(", ") + " lượt";
    };

    // ---- 5. Thỉnh An + Bái Kiến + Hội Hoa ----
    async function baiKien() {
        var st = await H("worship_status");
        if (!st.can.length) return "hôm nay đã bái hết";
        var r = await H("worship", {}, 120), ok = r.done.filter(function (d) { return d.ok; }).length;
        return ok + "/" + r.done.length + " cột" + (r.remaining && r.remaining.length ? ", chưa được: " + r.remaining.join(", ") : "");
    }
    async function thinhAn() {
        var r = await H("greet", { pos: 1 }, 30);   // pos 1 = the empress standing in the middle
        if (r.already) return "hôm nay đã thỉnh an";
        if (!r.greeted) throw new Error("server chưa xác nhận");
        return "OK" + (r.reward && r.reward[0] ? " (+" + r.reward[0].count + ")" : "");
    }
    async function hoiHoa() { return (await window.DT.flower_bullet("hahaha top 1 sever")).note; }
    T.thinhAn = async function () {
        var k0 = model("ResModel").getResById(window.RES_MONEY4), steps = [["Bái Kiến", baiKien], ["Thỉnh An", thinhAn], ["Hội Hoa", hoiHoa]];
        for (var i = 0; i < steps.length; i++) {
            check();
            try { log(steps[i][0] + ": " + await steps[i][1]()); } catch (e) { log(steps[i][0] + " lỗi: " + (e.message || e)); }
        }
        return "KNB " + k0 + " -> " + model("ResModel").getResById(window.RES_MONEY4);
    };

    // ---- Tri Kỷ Săn Sóc (the 'chờ đợi' button) ----
    // The game asks "Săn Sóc Nhanh tất cả?" but ConfidantShowPopup ignores the yes it receives: only one is done. Here: every Tri Kỷ and Nhân Mạch
    // still free today (canConfidantProtect = 0, more than one a day costs KNB and is never done here).
    T.sanSocAll = async function (skip) {
        var cm = model("ConfidantModel"), list = cm.getUnlockConfidants() || {}, n = 0, favor = 0, point = 0;
        for (var k in list) {
            check();
            var id = Number(k);
            if (id === skip || cm.canConfidantProtect(id) !== 0) continue;
            var r = await new Promise(function (ok) {
                cm.doProtect(id, function (res) { ok(res || {}); });
                setTimeout(function () { ok(null); }, 8000);
            });
            if (!r) { log("  server không trả lời, dừng"); break; }
            n++; favor += r.favor || 0; point += r.point || 0;
            await sleep(200);
        }
        return n + " người" + (skip ? " (thêm người vừa bấm)" : "") + ", Thiện Cảm +" + favor + ", điểm +" + point;
    };

    // ---- Nhận thưởng 1 chạm ----
    T.nhanThuong = async function () {
        var steps = [["Thư", async function () {
            var r = await H("mail_claim", {}, 25);
            if (!r.ok) throw new Error(r.why);
            return r.mails ? r.mails + " thư" : "không có thư mới";
        }], ["Thành tựu", async function () { return (await H("achievements", {}, 120)).total + " phần thưởng"; }],
            ["Giờ Vàng", async function () { return (await H("limit_claim", {}, 30)).got.length + " mốc"; }]];   // last: mail and achievements can reach new levels
        for (var i = 0; i < steps.length; i++) {
            check();
            try { log(steps[i][0] + ": " + await steps[i][1]()); } catch (e) { log(steps[i][0] + " lỗi: " + (e.message || e)); }
        }
    };

    // ---- the events running now on this server ----
    T.events = function () {
        var am = model("ActivityModel"), all = am.activityAlldata || {}, now = R("System").default.time(), out = [];
        for (var id in all) {
            var a = all[id];
            if (!a || !(a.end > now) || (a.start && a.start > now)) continue;
            var s = (am.activitListSetting || {})[id] || {};
            out.push({ id: Number(id), type: a.actType, name: a.name || s.name || ("Sự kiện " + id), left: a.end - now });
        }
        return out.sort(function (x, y) { return x.left - y.left; });
    };

    // ---- 6. Nhiệm vụ ngày ----
    function btn(st, subs, ends) {
        for (var i = 0; i < st.buttons.length; i++) {
            var b = st.buttons[i];
            if (subs.every(function (s) { return b.p.indexOf(s) >= 0; }) && (!ends || b.p.slice(-ends.length) === ends)) return b;
        }
        return null;
    }
    async function closeTop(top) {
        if (top === "CommonHintPopup") {
            var r = await H("click_path", { path: "Canvas/Top/Popup/CommonHintPopup/BtnConfirm" }, 10);
            if (r.clicked) { await sleep(2000); return; }
        }
        await H("popup_close");
    }
    async function ensureMain() {
        for (var i = 0; i < 8; i++) {
            if ((await H("top_controller", {}, 10)).name === "MainController") return true;
            var pp = (await H("popups")).popups || [];
            if (pp.length) { await closeTop(pp[pp.length - 1]); await sleep(800); continue; }
            var st = await H("state"), back = st.buttons.filter(function (x) { return /\/BtnBack$/.test(x.p) && x.p.indexOf("PHCTMod") !== 0; })[0];
            if (back) await H("click_path", { path: back.p }, 10); else await H("popup_close");
            await sleep(1200);
        }
        return false;
    }
    // Plays the stage the player is on with the buttons a player presses. Never spends team items; a stage that does not move for
    // 20 s, is lost again and again, or a boss too strong is skipped. An outfit stage lost once is played again in the best outfit.
    async function storyOnce() {
        var cur = await H("stage_info", {}, 10), ch = cur.chapter, sg = cur.stage, t0 = Date.now(), STUCK = 20000;
        var info = await H("stage_info", { chapter: ch, stage: sg }), lastSig = null, lastChange = Date.now(), starts = 0, tStart = 0, saves = 0, popN = 0, lastPop = null, clicks = 0;
        var SCEN = "Canvas/Stack/MainPanel/MainPanel/PnOutdoor/PnRight/BtnScenario";
        while (Date.now() - t0 < 240000) {
            check();
            if (info.cleared) return "đã qua " + ch + "-" + sg;
            var ps = await H("popups");
            if (ps.popups && ps.popups.length) {
                var top = ps.popups[ps.popups.length - 1];
                popN = top === lastPop ? popN + 1 : 1; lastPop = top;
                if (popN > 6) throw new Error("không đóng được bảng " + top);
                await closeTop(top); clicks++; await sleep(700);
                continue;
            }
            lastPop = null; popN = 0;
            var st = await H("state"), pick = null;
            if (btn(st, ["FightBossPanel"], "BtnStart")) {
                var bc = await H("boss_check");
                if (bc.enemyHp !== null && bc.enemyHp !== undefined && (bc.selfAtt || 0) + (bc.reviveBonus || 0) < bc.enemyHp * 1.01)
                    throw new Error("boss quá mạnh (máu " + bc.enemyHp + ", lực chiến " + bc.selfAtt + "): bỏ qua");
                var fr = await H("boss_fight", {}, 90);
                if (!fr.win) throw new Error("boss chưa thắng: " + fr.why);
                clicks++; await sleep(4000);
                info = await H("stage_info", { chapter: ch, stage: sg });
                continue;
            }
            var choose = st.buttons.filter(function (b) { return b.p.indexOf("StageClothingPanel") >= 0 && /\/Choose[^/]*$/.test(b.p); });
            if (choose.length) pick = choose.sort(function (x, y) { return x.x - y.x; })[0];
            if (!pick) {
                var so = await H("story_choose", { index: 2 });
                if (so.chose) { clicks++; await sleep(1200); continue; }
            }
            if (!pick) {
                var order = [[["ScenarioPlayPanel"], "BtnTiaoGuo"], [["FightPanel"], "BtnStart"], [["ClothingMainPanel"], "BtnBaoCun"], [["ClothingMatchPanel"], "BthClick"],
                    [["ClothingMatchPanel"], "BtnBlank"], [["ScenarioPanel", "ScenarioPanel"], "BtnStart"], [["DestinyMainPanel"], "BtnBack"], [["MainPanel", "PnRight"], "BtnScenario"]];
                for (var i = 0; i < order.length && !pick; i++) pick = btn(st, order[i][0], order[i][1]);
            }
            if (!pick && st.buttons.some(function (b) { return b.p.indexOf("MainPanel/MainPanel/PnOutdoor") >= 0; })) pick = { p: SCEN };
            var sig = st.scene + "|" + (pick ? pick.p : "") + "|" + st.buttons.length;
            if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
            else if (Date.now() - lastChange > STUCK) throw new Error("đứng yên 20s ở ải " + ch + "-" + sg);
            if (pick && /ScenarioPanel\/ScenarioPanel\/BtnStart$/.test(pick.p)) {
                starts++;
                tStart = tStart || Date.now();
                if (starts >= 3 && Date.now() - tStart > STUCK) throw new Error("thử 20s vẫn chưa qua " + ch + "-" + sg);
                for (var h = 0; h < 3; h++) if (!(await H("errand_take", { n: 3 }, 20)).ok) break;   // Nội Chính 3 pays the fight HP
                if (!(await H("money")).all[3]) throw new Error("hết máu, bỏ qua cốt truyện");
                lastChange = Date.now();
            }
            if (pick && /ClothingMainPanel\/PnDown\/BtnBaoCun$/.test(pick.p) && ++saves > 1) {
                log("  đổi đồ cho ải: " + window.DT.best_cloth().note);
                await sleep(1500);
            }
            if (pick) { await H("click_path", { path: pick.p }, 10); clicks++; }
            await sleep(800);
            if (clicks % 8 === 0) info = await H("stage_info", { chapter: ch, stage: sg });
        }
        throw new Error("quá 4 phút mà chưa qua " + ch + "-" + sg);
    }
    async function dailyClaim() {
        var r = await H("daily_claim", {}, 40);
        if (r.tasks.length || r.chests.length) log("  nhận " + r.tasks.length + " việc, " + r.chests.length + " rương, điểm " + r.active);
    }
    function status() {
        var st = window.DT.status(), o = { active: st.active, list: st.tasks };
        st.tasks.forEach(function (t) { o[t[2]] = { n: t[3], max: t[4], name: t[1] }; });
        return o;
    }
    async function plant() {
        var ms = await H("manor_status", {}, 10), lands = (ms.lands || []).filter(Boolean);
        if (!lands.length) throw new Error("chưa đọc được dữ liệu vườn");
        var plots = lands.filter(function (x) { return !x.seed || x.left <= 0; }).length, have = 0;
        for (var k in ms.seeds || {}) have += Number(ms.seeds[k]);
        if (plots > have) {   // not enough seeds of any kind: one Nấm Thuộc Tính per plot (checks the silver first)
            var b = await window.DT.buy_mushroom(plots - have);
            log("  " + plots + " ô, có " + have + " hạt: mua " + b.bought + " hạt nấm (" + b.note + ")");
        }
        await H("manor_gather", {}, 20);
        var r = await H("manor_plant", { n: 18 }, 40);
        return "trồng " + (r.planted || []).length + " ô";
    }
    async function followerUp10() {
        var fm = model("FollowerModel"), best = null;
        (fm.getAvailFolloIdListData() || []).forEach(function (id) {
            var d = fm.getFolloSvrDataById(id), g = fm.getFolloGrdLocalConfDataByGrd(d.grade);
            if (g && d.level + 10 <= g.lvMax && (!best || d.level < best.level)) best = { id: id, level: d.level };
        });
        if (!best) return "không có đồng hành nào lên được 10 cấp";
        var r = await H("follower_up", { id: best.id, to: best.level + 1 }, 60);
        return "đồng hành " + best.id + ": cấp " + r.from + " -> " + r.level;
    }
    async function errands() {
        var n = 0;
        for (var e = 1; e <= 3; e++) for (var i = 0; i < 8; i++) { if (!(await H("errand_take", { n: e }, 20)).ok) break; n++; }
        return "thu " + n + " lượt";
    }
    async function cungVu() {
        var st = await H("affairs_status");
        if (!st.hasEvent || !st.count) return "hết lượt";
        var r = await H("affairs", { choice: 2 }, 120);
        return r.done + " lần, còn " + r.left;
    }
    async function tuongNgo() {
        var n = 0;
        for (var i = 0; i < 6; i++) {
            check();
            if (!(await H("confidant_date", { prefer: "sweep" }, 25)).done) break;
            n++; await sleep(1000);
        }
        return n + " lượt";
    }
    async function khauChien() {
        var st = await H("debate_status", {}, 15), done = 0;
        if (!st.unlocked) return "chưa mở khóa";
        for (var i = 0; i < 4; i++) {
            check();
            if (!st.fighter && !st.start && (st.count >= st.free || st.cooldownLeft > 0 || !st.ready)) break;
            if ((await H("debate_run", {}, 100)).note !== "ok") break;
            done++;
            st = await H("debate_status", {}, 15);
        }
        return done + " lượt (đã dùng " + st.count + "/" + st.free + ")";
    }
    T.nhiemVuNgay = async function () {
        var st = status();
        function need(types) { return types.some(function (t) { return st[t] && st[t].n < st[t].max; }); }
        var steps = [[[2, 3, 4], "Nội Chính", errands], [[5], "Cung Vụ", cungVu], [[6], "Thận Hình Ty", function () { return window.DT.symptic(30); }],
            [[31], "Cầu Phúc", function () { return window.DT.pray_free(3); }], [[21], "Cầu Nguyện", function () { return window.DT.lottery_free(); }],
            [[36], "Kỳ Ngộ", function () { return window.DT.trip(10); }], [[23], "Tương Ngộ", tuongNgo], [[32], "Tăng cấp Đồng Hành", followerUp10],
            [[20], "Bồi Dưỡng Đồng Hành", function () { return H("follower_study", {}, 30); }], [[12], "Khẩu Chiến", khauChien], [[26], "Trồng Cây", plant],
            [[59, 81, 82], "Pet", function () { return window.DT.pet(); }], [[7], "Cốt truyện", async function () { var r = await storyOnce(); await ensureMain(); return r; }]];
        await dailyClaim();
        for (var i = 0; i < steps.length; i++) {
            check();
            if (!need(steps[i][0])) continue;
            log("• " + steps[i][1] + "...");
            try {
                var r = await steps[i][2]();
                log("  " + (typeof r === "string" ? r : JSON.stringify(r)).slice(0, 110));
            } catch (e) {
                if (T.stop) throw e;
                log("  lỗi: " + (e.message || e));
            }
            try { await dailyClaim(); } catch (e2) { log("  nhận thưởng lỗi: " + (e2.message || e2)); }
        }
        st = status();
        var miss = st.list.filter(function (t) { return t[3] < t[4] && t[2] !== 33 && t[2] !== 34; }).map(function (t) { return t[1] + " " + t[3] + "/" + t[4]; });
        if (miss.length) log("Còn thiếu: " + miss.join(", "));
        return "điểm hoạt động " + st.active + "/160";
    };

    // ---- 3. Items ----
    function useProp(id, n, param) {
        return new Promise(function (ok) {
            var fin = false;
            function end(v) { if (!fin) { fin = true; ok(v); } }
            if (!model("PropModel").useProp(id, n, param, function () { setTimeout(function () { end(true); }, 250); })) end(false);
            setTimeout(function () { end(false); }, 12000);
        });
    }
    function prop(id) { return model("PropModel").getPropInfoById(id); }
    T.confidants = function () {   // the 4 men of the story
        var cm = model("ConfidantModel"), names = { 1: "Di Thân Vương", 2: "Diệp Đình Châu", 3: "Hằng Duệ", 4: "Quý Thành Huân" }, out = [];
        [1, 2, 3, 4].forEach(function (id) {
            var d = cm.getConfidantDataById(id);
            out.push({ id: id, name: names[id], met: !!d, favor: d ? d.favor : 0 });
        });
        return out;
    };
    T.favorItems = function (cid) {   // own favourites (typevalue = id), limited gifts (typevalue - 6 = id), for everyone (5)
        var pm = model("PropModel"), own = [], all = [];
        pm.getPropListByType(R("PropModel").ItemType.ITEM_TYPE_CONFIDANT_FAVOR).forEach(function (id) {
            var p = pm.getPropInfoById(id);
            if (!p || !(p.count > 0)) return;
            if (p.typevalue === cid || p.typevalue - 6 === cid) own.push(p);
            else if (p.typevalue === 5) all.push(p);
        });
        function by(a, b) { return b.quality - a.quality || b.id - a.id; }
        return { own: own.sort(by), all: all.sort(by) };
    };
    T.buffFavor = async function (cid, ids) {
        var cm = model("ConfidantModel"), f0 = (cm.getConfidantDataById(cid) || {}).favor, used = 0;
        for (var i = 0; i < ids.length; i++) {
            check();
            var p = prop(ids[i]), n = p ? p.count : 0;
            if (!n) continue;
            if (await useProp(ids[i], n, [cid])) { used += n; log("  " + p.name + " x" + n); await sleep(250); }
            else log("  " + p.name + ": game không nhận");
        }
        return "dùng " + used + " món, Thiện Cảm " + f0 + " -> " + (cm.getConfidantDataById(cid) || {}).favor;
    };
    T.followers = function () {
        var fm = model("FollowerModel");
        return fm.getFilterSortFolloIdArray(function () { return true; }, function (a, b) { return b.level - a.level || a.id - b.id; })
            .map(function (f) { return { id: f.id, name: f.name || fm.getFolloBscInfoLocalConfDataById(f.id).name, level: f.level, aptitude: f.aptitude }; });
    };
    T.scrolls = function () {   // the aptitude scrolls of the bag
        return [20003, 20004, 20005, 20006].map(prop).filter(function (p) { return p && p.count > 0; });
    };
    T.buffAptitude = async function (fid, ids, limit) {
        var fm = model("FollowerModel"), pm = model("PropModel"), spent = 0, ups = 0;
        for (var guard = 0; guard < 2000; guard++) {
            check();
            var sv = fm.getFolloSvrDataById(fid), gr = fm.getFolloGrdLocalConfDataByGrd(sv.grade), pick = null;
            (fm.getFollowerBooksById(fid) || []).forEach(function (b) {
                var it = b.lvCostItem[0], cost = b.lvCostItem[1], pi = pm.getPropInfoById(it);
                if (b.lv >= gr.aptMax || ids.indexOf(it) < 0 || !pi || pi.count < cost) return;
                if (limit && spent + cost > limit) return;
                if (!pick || cost < pick.lvCostItem[1]) pick = b;
            });
            if (!pick) break;
            var req = { id: pick.fid, index: pick.index, skinid: pick.skinid, type: 1 };
            var ans = await new Promise(function (ok) {
                var fin = false;
                function end(v) { if (!fin) { fin = true; ok(v); } }
                fm.bookStudy(req, function (o) { end(!!o); });
                setTimeout(function () { end(false); }, 10000);
            });
            if (!ans) { log("  server không nhận, dừng"); break; }
            spent += pick.lvCostItem[1]; ups++;
            await sleep(200);
        }
        var f = fm.getFullFolloDataById(fid);
        return ups + " lần nâng, dùng " + spent + " cuộn, Tư Chất " + f.name + " = " + f.aptitude;
    };
    T.CULTURE = [["Thuộc tính ngẫu nhiên / chung", [10005, 10010, 10015, 10020, 10021, 10023]], ["Nhóm 1", [10001, 10006, 10011, 10016]], ["Nhóm 2", [10002, 10007, 10012, 10017]],
        ["Nhóm 3", [10003, 10008, 10013, 10018]], ["Nhóm 4", [10004, 10009, 10014, 10019]]];   // the 5 pages of FollowerCulturePopup
    T.cultureItems = function () {
        var out = [];
        T.CULTURE.forEach(function (g) {
            var l = g[1].map(prop).filter(function (p) { return p && p.count > 0; });
            if (l.length) out.push([g[0], l]);
        });
        return out;
    };
    T.buffCulture = async function (fid, ids, qty) {
        var used = 0;
        for (var i = 0; i < ids.length; i++) {
            check();
            var p = prop(ids[i]), n = p ? (qty ? Math.min(qty, p.count) : p.count) : 0;
            if (!n) continue;
            if (await useProp(ids[i], n, [fid])) { used += n; log("  " + p.name + " x" + n); await sleep(250); }
            else log("  " + p.name + ": game không nhận");
        }
        return "dùng " + used + " món cho " + model("FollowerModel").getFullFolloDataById(fid).name;
    };

    // ---- Lệnh: each order refills turns; the turns are played right away, so the game accepts the next order ----
    async function datesOut() {   // Du Ngoạn Tri Kỷ: all the turns there are; the "Du ngoạn nhanh" tick when it is unlocked
        var cm = model("ConfidantModel"), so = R("SysOpenModel"), n = 0;
        function left() { return (cm.getConfidantQuickData() || {}).count || 0; }
        if (!left() || !Object.keys(cm.getUnlockConfidants() || {}).length) return 0;
        var fast = so.default.getInstance().isSystemUnlocked(so.SysLockCode.SYS_ONE_KEY_CONFIND);
        for (var i = 0; i < 100 && left() > 0; i++) {
            check();
            var c0 = left(), ok = await new Promise(function (done) {
                cm.quickDate(fast ? { onekey: true } : null, function () { done(true); });
                setTimeout(function () { done(false); }, 10000);
            });
            await sleep(250);
            if (!ok || left() >= c0) break;
            n += c0 - left();
        }
        return n;
    }
    async function tripsOut() {   // Kỳ Ngộ: while there is energy
        var tp = model("TripModel"), n = 0;
        for (var i = 0; i < 100; i++) {
            check();
            var v = tp.getVisitData() || {};
            if (!v.energy || v.lucky < 2) break;
            var e0 = v.energy, ok = await new Promise(function (done) {
                var r = tp.visit(Math.min(80, v.lucky), false, false, function () { done(true); });
                if (r !== 3 && r !== 0 && r !== undefined) done(false);
                setTimeout(function () { done(false); }, 10000);
            });
            await sleep(400);
            if (!ok || (tp.getVisitData() || {}).energy >= e0) break;
            n++;
        }
        return n;
    }
    function errandOf(e) {   // the order says which of the 3 it refills: without it the server answers 500 and the game logs out
        return async function () {
            var n = 0;
            for (var i = 0; i < 10; i++) { check(); if (!(await H("errand_take", { n: e }, 20)).ok) break; n++; }
            return n;
        };
    }
    T.LENH = [
        { id: 40004, name: "Lệnh Tri Kỷ", what: "lượt Du Ngoạn", play: datesOut },
        { id: 40003, name: "Lệnh Kỳ Ngộ", what: "lượt Kỳ Ngộ", play: tripsOut },
        { id: 40001, param: [1], name: "Lệnh Nội Chính - Hâm Mộ", what: "lượt thu", play: errandOf(1) },
        { id: 40001, param: [2], name: "Lệnh Nội Chính - Bạch Ngân", what: "lượt thu", play: errandOf(2) },
        { id: 40001, param: [3], name: "Lệnh Nội Chính - Nổi Tiếng", what: "lượt thu", play: errandOf(3) },
        { id: 40002, name: "Lệnh Cung Vụ", what: "công vụ", play: cungVu }
    ];
    T.lenhCount = function (id) { var p = prop(id); return p ? p.count : 0; };
    T.dungLenh = async function (l, want) {   // want 0 = all of them
        var used = 0, played = await l.play();   // the game takes an order only when the turns are used up
        log("  " + l.what + " có sẵn: " + (typeof played === "number" ? played : played));
        while ((!want || used < want) && T.lenhCount(l.id) > 0) {
            check();
            var n0 = T.lenhCount(l.id);
            if (!await useProp(l.id, 1, l.param || null) || T.lenhCount(l.id) >= n0) { log("  game không nhận lệnh, dừng"); break; }
            used++;
            await sleep(300);
            played = await l.play();
            log("  lệnh " + used + ": " + played);
        }
        return "dùng " + used + " " + l.name + ", còn " + T.lenhCount(l.id);
    };

    // ---- 2. Khẩu Chiến: the player opens it and picks the fighter, the duels run here without their popups ----
    T.debate = { busy: false, last: "" };
    T.debateStatus = function () {
        var d = model("DebateModel").getSelfData() || {}, now = R("System").default.time(), today = d.ts && IsSameDay(d.ts, now);
        return { count: today ? d.count || 0 : 0, free: R("DebateModel").DEBATE_FREE_TIME, cooldown: Math.max(0, Math.round((d.cooldown || 0) - now)), point: d.point };
    };
    async function debateRound(ctl) {
        var dm = model("DebateModel"), so = R("SysOpenModel"), duels = 0, wins = 0, p0 = (dm.getSelfData() || {}).point;
        if (so.default.getInstance().isSystemUnlocked(so.SysLockCode.SYS_ONE_KEY_DEBATE)) {
            await new Promise(function (ok) { dm.doOneKeyFight(function () { ok(); }); setTimeout(ok, 20000); });
            duels = -1;
        } else {
            while (duels < 80) {
                var en = dm.getEnemyData();
                if (!en || !en.current || !en.current.length) break;
                var r = await new Promise(function (ok) {
                    dm.doDebateFight(en.current[0], null, function (o, msg, res) { ok({ ok: o, res: res }); });
                    setTimeout(function () { ok({ ok: false }); }, 10000);
                });
                if (!r.ok) break;
                duels++;
                if (r.res && r.res.win) wins++;
                await sleep(120);
            }
        }
        var txt = "Khẩu Chiến xong: " + (duels < 0 ? "đánh nhanh" : duels + " trận, thắng " + wins) + ", điểm " + p0 + " -> " + (dm.getSelfData() || {}).point;
        T.debate.last = txt;
        log(txt);
        try { R("Toast").default.show(txt); } catch (e) { }
        if (dm.getEnemyData() === null) { if (ctl && ctl.name === "DebateRivalController") ctl.trigger("back"); }
        else if (ctl && ctl.setRivalData) ctl.setRivalData();
    }
    setInterval(function () {
        if (!window.PHCT.cfg.autoDebate || T.debate.busy || !window.__require) return;
        try {
            var ctl = R("ControllerManager").default.getInstance().getTopController();
            if (!ctl || ctl.name !== "DebateRivalController" || (ctl.popups && ctl.popups.length)) return;
            var d = model("DebateModel").getSelfData();
            if (!d || !d.start || !model("DebateModel").getEnemyData()) return;
            T.debate.busy = true;
            debateRound(ctl).catch(function (e) { log("Khẩu Chiến lỗi: " + (e.message || e)); }).then(function () { setTimeout(function () { T.debate.busy = false; }, 1500); });
        } catch (e) { }
    }, 700);

    // Nội Chính every 30 minutes while the option is on and the player is in the game
    setInterval(function () {
        if (!window.PHCT.cfg.autoErrand || T.job) return;
        try {
            if (R("ControllerManager").default.getInstance().getTopController().name === "AccountMainController") return;
            T.run("Tự thu Nội Chính", T.noiChinh);
        } catch (e) { }
    }, 1800000);
})();

// PHCT mod (phone): switch account without typing. The FunTap SDK keeps its session in shared_prefs/vParentalControl.xml (PREF_TOKEN, PREF_USER_JSON)
// and logs that FunID back in at the next start. "Lưu" copies those lines to files/phct/accounts.json (private to the app, no password);
// "Vào" writes them back and closes the game; at the next start the saved server is chosen and the game entered. Also: event countdown alerts.
(function () {
    var P = window.PHCT, T = P.tasks, F = jsb.fileUtils, R = function (n) { return window.__require(n); };
    var W = F.getWritablePath(), DIR = W + "phct/", FILE = DIR + "accounts.json", PEND = DIR + "pending.json";
    var PREFS = W.replace(/files\/?$/, "") + "shared_prefs/vParentalControl.xml";
    function line(xml, name) { var m = xml.match(new RegExp('^\\s*<[a-z]+ name="' + name + '"[^\\n]*$', "m")); return m ? m[0] : null; }
    function load() { try { return JSON.parse(F.getStringFromFile(FILE)) || []; } catch (e) { return []; } }
    function store(l) { F.createDirectory(DIR); return F.writeStringToFile(JSON.stringify(l), FILE); }
    var A = P.accounts = { list: load };
    A.save = function () {
        var xml = F.getStringFromFile(PREFS), tok = line(xml, "PREF_TOKEN"), usr = line(xml, "PREF_USER_JSON"), zone = line(xml, "MOB_AREA_ID");
        if (!tok || !usr) return "Chưa đăng nhập FunTap";
        var nm = usr.match(/&quot;name&quot;:&quot;([^&]*)&quot;/), login = nm ? nm[1] : "?", z = zone ? (zone.match(/>(\d+)</) || [])[1] : "", role = "";
        try { role = R("ProfileModel").default.getInstance().getRoleName(); } catch (e) { }
        var l = load().filter(function (a) { return !(a.login === login && a.zone === z); });
        l.push({ login: login, role: role, zone: z, tok: tok, usr: usr });
        l.sort(function (x, y) { return x.login < y.login ? -1 : 1; });
        return store(l) ? "Đã lưu " + login + (role ? " (" + role + ")" : "") : "Không ghi được file";
    };
    A.remove = function (i) { var l = load(); l.splice(i, 1); store(l); };
    A.enter = function (i) {
        var a = load()[i];
        if (!a) return;
        var xml = F.getStringFromFile(PREFS).split("\n").filter(function (s) { return s.indexOf('name="PREF_TOKEN"') < 0 && s.indexOf('name="PREF_USER_JSON"') < 0; }).join("\n");
        xml = xml.replace("</map>", a.tok.trim() + "\n" + a.usr.trim() + "\n</map>");
        if (!F.writeStringToFile(xml, PREFS)) return T.say("Không đổi được phiên đăng nhập");
        F.writeStringToFile(JSON.stringify({ zone: a.zone, login: a.login, tm: Date.now() }), PEND);
        cc.game.end();   // the SDK reads the session when the app starts
    };
    // after a switch: choose the saved server and press Vào trò chơi as soon as the login screen is ready
    var pend = null;
    try { if (F.isFileExist(PEND)) pend = JSON.parse(F.getStringFromFile(PEND)); } catch (e) { }
    if (pend) {
        var tries = 0, tick = setInterval(function () {
            function done(msg) { clearInterval(tick); F.removeFile(PEND); if (msg) T.say(msg); }
            if (Date.now() - pend.tm > 600000 || ++tries > 120) return done("Không tự vào được " + pend.login + ", hãy đăng nhập lại rồi bấm Lưu");
            try {
                var c = R("ControllerManager").default.getInstance().getTopController();
                if (!c) return;
                if (c.name === "MainController") return done("Đã vào " + pend.login);
                if (c.name !== "AccountMainController" || !c.serverIdTable || !c.serverIdTable[pend.zone]) return;
                window.__mod_handle({ cmd: "pick_server", args: { id: Number(pend.zone) } });
                window.__mod_handle({ cmd: "click_path", args: { path: "Canvas/Stack/AccountMainPanel/AccountMainPanel/BtnEntrance" } });
            } catch (e) { }
        }, 2500);
    }

    // ---- countdown: the events about to open or about to end ----
    var told = {};
    T.upcoming = function () {
        var am = R("ActivityModel").default.getInstance(), all = am.activityAlldata || {}, now = R("System").default.time(), out = [];
        for (var id in all) {
            var a = all[id];
            if (a && a.start > now) out.push({ id: Number(id), type: a.actType, name: ((am.activitListSetting || {})[id] || {}).name || ("Sự kiện " + id), wait: a.start - now });
        }
        return out.sort(function (x, y) { return x.wait - y.wait; });
    };
})();

// PHCT mod (phone): "Làm sự kiện": does what is free in the events running now, one handler per kind of event. Never spends KNB, never recharges.
// To add an event: EV[actType] = { name, run: async function (ids) { return "text"; } }. The list of all events: work/phone_mod/danh_sach_su_kien.csv
(function () {
    var P = window.PHCT, T = P.tasks, R = function (n) { return window.__require(n); };
    function model(n) { return R(n).default.getInstance(); }
    function sleep(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
    function ask(f, ms) {   // f(done): a request of the game; null when no answer
        return new Promise(function (ok) {
            var fin = false;
            function end(v) { if (!fin) { fin = true; ok(v === undefined ? true : v); } }
            f(end);
            setTimeout(function () { if (!fin) { fin = true; ok(null); } }, ms || 10000);
        });
    }
    // tasks of the shared kind (commontask): any event that has them, finished and not taken yet
    async function commonTasks() {
        var am = model("ActivityModel"), data = am.commonTaskData || {}, got = 0;
        for (var id in data) {
            var act = Number(id);
            if (!am.getActivityDataById(act)) continue;
            var d = data[id], seen = {}, rows = [];
            [0, 1].forEach(function (k) { try { rows = rows.concat(am.getCommonTaskSetting(act, k) || []); } catch (e) { } });
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (!r || seen[r.id]) continue;
                seen[r.id] = 1;
                if ((d.received || []).indexOf(r.id) >= 0 || !((d.task || {})[r.id] >= r.parameter)) continue;
                if (await ask(function (end) { am.takeTask(r.id, function () { end(); }); })) got++;
                await sleep(250);
            }
        }
        return got + " nhiệm vụ";
    }
    var EV = T.EV = {
        322: { name: "Mai Lâm Xuân Hiểu", run: async function () {   // Mài Mực: only the free turns
            var M = model("Activity32201Model"), n = 0;
            for (var i = 0; i < 5 && (M.get32202Data() || {}).free > 0; i++) {
                if (!await ask(function (end) { M.doGame(false, function () { end(); }); })) break;
                n++; await sleep(300);
            }
            return "lượt miễn phí " + n;
        } },
        56: { name: "Nhớ Lại Quá Khứ", run: async function () {   // today's sign-in + the finished tasks
            var M = model("ThanksGivingModel"), d = M.getData() || {}, n = 0, sign = "";
            if (d.day && (d.sign || []).indexOf(d.day) < 0 && M.getSignSettingByDay(d.day)) {
                if (await ask(function (end) { M.takeSignReward(d.day, function () { end(); }); })) sign = "điểm danh ngày " + d.day + ", ";
                await sleep(300);
            }
            var rows = [];
            (function walk(o) { if (!o || typeof o !== "object") return; if (o.id && o.parameter !== undefined) rows.push(o); else for (var k in o) walk(o[k]); })(M.taskSetting);
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                d = M.getData() || {};
                if ((d.take || []).indexOf(r.id) >= 0 || !((d.list || {})[r.id] >= r.parameter)) continue;
                if (await ask(function (end) { M.takeTask(r.id, function () { end(); }); })) n++;
                await sleep(250);
            }
            return sign + n + " nhiệm vụ";
        } },
        65: { name: "Phượng Múa Cửu Thiên", run: async function () {   // same shape as the 7-day festival
            var M = model("DoubleWeekModel"), today = M.today(), n = 0, p = 0;
            for (var t in M.typeSettings) {
                var l = M.typeSettings[t];
                for (var i = 0; i < l.length; i++) {
                    var row = l[i], fin = false;
                    try { fin = row.day <= today && M.isTaskFinish(Number(t), i) && !M.isTaskRewardTaken(Number(t), i, row.day); } catch (e) { }
                    if (!fin) continue;
                    if (await ask(function (end) { M.takeTaskReward(Number(t), i, function () { end(); }); })) n++;
                    await sleep(300);
                }
            }
            var info = M.getDoubleWeekInfo() || {}, pts = M.getPointRewardSetting() || [];
            for (var j = 0; j < pts.length; j++) {
                if ((info.reward || []).indexOf(pts[j].id) >= 0 || !(info.score >= pts[j].cost)) continue;
                if (await ask(function (end) { M.takePointReward(pts[j].id, function () { end(); }); })) p++;
                await sleep(300);
            }
            return n + " nhiệm vụ, " + p + " mốc điểm";
        } },
        162: { name: "Cẩm Tú Niên Hoa", run: async function () {   // the daily lucky gift, when this account is the lucky one
            var M = model("Activity16201Model"), me = R("ProfileModel").default.getInstance().getProfiledData().account;
            var d = await ask(function (end) { M.getLuckyData(function (a, b, c) { end(c || {}); }); });
            if (d && d.a == me && d.g == 0) { await ask(function (end) { M.setLuckyReward(function () { end(); }); }); return "nhận quà may mắn"; }
            return "hôm nay không có quà may mắn";
        } }
    };
    // ---- every event, the same way: open its screen like a player and press only what is free ----
    // A button is pressed only when its text is on this list, or when it has no text and its node name says "take the reward". A popup that
    // opens is always closed with cancel, so "spend X KNB?" can never be confirmed. Works for events never seen before: nothing is written per event.
    var FREE_TEXT = /^(Nhận|Nhận thưởng|Nhận quà|Lĩnh|Lĩnh thưởng|Điểm danh|Ký danh|Miễn phí|Quay miễn phí|Nhận tất cả|Nhận hết)$/i;
    var FREE_NAME = /\/(BtnGet|BtnTake|BtnReceive|BtnReward|BtnSign|BtnLingQu|BtnFree|BtnGetReward|BtnTakeReward)\d*$/i;
    var NEVER = /Buy|Shop|Recharge|Pay|Purchase|Go$|Exchange|Back|Close|Help|PHCTMod/i;
    var SKIP_TYPE = { 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 12: 1, 13: 1, 14: 1, 45: 1, 46: 1, 100: 1, 101: 1 };   // recharge and paid packs
    function H(cmd, args, secs) {
        return new Promise(function (ok, no) {
            var t = setTimeout(function () { no(new Error("game không trả lời " + cmd)); }, (secs || 15) * 1000);
            Promise.resolve().then(function () { return window.__mod_handle({ cmd: cmd, args: args || {} }); }).then(function (v) { clearTimeout(t); ok(v); }, function (e) { clearTimeout(t); no(e); });
        });
    }
    function top() { var c = R("ControllerManager").default.getInstance().getTopController(); return c ? c.name : ""; }
    async function closePopups() {
        for (var i = 0; i < 6; i++) {
            if (!((await H("popups")).popups || []).length) return;
            await H("popup_close");
            await sleep(450);
        }
    }
    function scrollDown(ctlName) {   // long lists only show their visible rows: move them so the next scan sees the rest
        var c = R("ControllerManager").default.getInstance().getTopController(), n = 0;
        if (!c || !c.ui || c.name !== ctlName) return 0;
        (function walk(x) {
            if (!x.active) return;
            var s = x.getComponent(cc.ScrollView);
            if (s) { n++; try { s.scrollToBottom(0); } catch (e) { } }
            x.children.forEach(walk);
        })(c.ui);
        return n;
    }
    async function pressFree(ctlName, tries) {   // presses until nothing is left on this view; a button the server does not accept is tried 3 times at most
        var n = 0;
        for (var i = 0; i < 25; i++) {
            if (T.stop) throw new Error("đã dừng");
            await closePopups();
            if (top() !== ctlName) return n;
            var st = await H("state"), b = st.buttons.filter(function (x) {
                return !NEVER.test(x.p) && (tries[x.p] || 0) < 3 && (FREE_TEXT.test(String(x.t || "").trim()) || (!x.t && FREE_NAME.test(x.p)));
            })[0];
            if (!b) return n;
            tries[b.p] = (tries[b.p] || 0) + 1;
            await H("click_path", { path: b.p }, 8);
            n++;
            await sleep(700);
        }
        return n;
    }
    async function sweepOne(e) {
        var row = (model("ActivityModel").activitListSetting || {})[e.id] || {}, jump = row.jump && row.jump[0];
        if (!jump) return null;
        await closePopups();
        var before = top();
        R("JumpHelper").default.gotoGetWay(jump);
        for (var w = 0; w < 12 && top() === before; w++) await sleep(400);
        var name = top();
        if (name === before) { await closePopups(); return null; }
        await sleep(1000);
        var tries = {}, n = await pressFree(name, tries);
        if (top() === name && scrollDown(name)) { await sleep(500); n += await pressFree(name, tries); }
        // the other pages of the screen: its tab buttons, once each
        var st = await H("state"), tabs = st.buttons.filter(function (x) { return /\/(Tab|BtnTab|Toggle|Page|BtnPage|RadioBox)[^/]*(\/[^/]*)?$/i.test(x.p) && !NEVER.test(x.p); }).slice(0, 8);
        for (var t = 0; t < tabs.length && top() === name; t++) {
            await H("click_path", { path: tabs[t].p }, 8);
            await sleep(600);
            n += await pressFree(name, tries);
        }
        for (var b = 0; b < 4 && top() !== before; b++) {   // back to where the player was
            await closePopups();
            try { R("ControllerManager").default.getInstance().getTopController().trigger("back"); } catch (x) { }
            await sleep(800);
        }
        return n;
    }
    T.quetSuKien = async function () {
        var seen = {}, list = T.events().filter(function (e) { return !SKIP_TYPE[e.type]; }), total = 0, opened = 0;
        for (var i = 0; i < list.length; i++) {
            if (T.stop) throw new Error("đã dừng");
            var row = (model("ActivityModel").activitListSetting || {})[list[i].id] || {}, key = JSON.stringify(row.jump || list[i].id);
            if (seen[key]) continue;
            seen[key] = 1;
            try {
                var n = await sweepOne(list[i]);
                if (n === null) continue;
                opened++; total += n;
                log("  " + list[i].name + ": bấm " + n);
            } catch (e) { if (T.stop) throw e; log("  " + list[i].name + " lỗi: " + (e.message || e)); }
        }
        return "mở " + opened + " màn, bấm " + total + " nút";
    };
    // ---- Trích Tinh Các: same call as the floor button, floor after floor, while there is Nổi Tiếng (the HP of the fight). A lost fight also
    // costs Nổi Tiếng and the boss keeps its damage, so it just goes on. Costs no KNB. ----
    T.leoTrichTinh = async function () {
        var M = model("PickStarModel"), rm = model("ResModel"), d = M.getTowerData() || {}, set = M.getTowerSetting() || {};
        // the server does not refuse a player below 15-10, and the fight still takes all the Nổi Tiếng: check it here
        var sm = model("StageModel"), open = false;
        for (var s in sm.stageSetting) if (sm.stageSetting[s].chapter === 15 && sm.stageSetting[s].stage === 10) open = !!sm.isStageCleared(Number(s));
        if (!open || !d.now) return "chưa mở (cần qua ải 15-10), không đánh";
        var from = d.now, r0 = rm.getResById(window.RES_MONEY3), fights = 0;
        function has(stage) { for (var k in set) if (set[k].stage === stage) return true; return false; }
        for (var i = 0; i < 2000; i++) {
            if (T.stop) break;
            var now = (M.getTowerData() || {}).now, res = rm.getResById(window.RES_MONEY3);
            if (!(res > 0) || !has(now)) break;
            if (!await ask(function (end) { M.fight(now, function () { end(); }); })) { log("  server không trả lời, dừng"); break; }
            fights++;
            await sleep(250);
            if ((M.getTowerData() || {}).now === now && rm.getResById(window.RES_MONEY3) === res) { log("  đánh không có tác dụng, dừng"); break; }
            if (fights % 10 === 0) log("  tầng " + (M.getTowerData() || {}).now + ", còn " + rm.getResById(window.RES_MONEY3) + " Nổi Tiếng");
        }
        return fights + " trận, tầng " + from + " -> " + (M.getTowerData() || {}).now + ", Nổi Tiếng " + r0 + " -> " + rm.getResById(window.RES_MONEY3);
    };
    T.eventHandled = function (type) { return !!EV[type] || !SKIP_TYPE[type]; };
    T.lamSuKien = async function () {
        log("• Nhiệm vụ sự kiện...");
        try { log("  " + await commonTasks()); } catch (e) { log("  lỗi: " + (e.message || e)); }
        var run = {};
        T.events().forEach(function (e) { (run[e.type] = run[e.type] || []).push(e.id); });
        for (var t in EV) {
            if (T.stop) throw new Error("đã dừng");
            if (!run[t]) continue;
            log("• " + EV[t].name + "...");
            try { log("  " + await EV[t].run(run[t])); } catch (e2) { log("  lỗi: " + (e2.message || e2)); }
        }
        log("• Quét màn hình các sự kiện...");
        log("  " + await T.quetSuKien());
    };
    function log(s) { T.say(s); }
})();

// PHCT mod (phone): the floating button + the menu, drawn with cc.Graphics in the colours of the game's buttons.
(function () {
    var P = window.PHCT, cfg = P.cfg, T = P.tasks;
    var C = { btn: cc.color(201, 162, 126), on: cc.color(181, 89, 79), panel: cc.color(248, 240, 230), line: cc.color(226, 205, 184), text: cc.color(94, 59, 46),
              white: cc.color(255, 255, 255), title: cc.color(181, 89, 79), shade: cc.color(40, 25, 20, 130), row: cc.color(255, 250, 244), off: cc.color(214, 200, 186) };
    var ROOT = null, BODY = null, LOGN = null, FLOAT = null, STATUS = null, PANEL = null;
    var S = { tab: "speed", sub: "favor", conf: 1, fol: null, sel: {}, qty: "", scroll: {}, confirm: 0 };

    function node(name, parent, w, h, x, y) {
        var n = new cc.Node(name);
        n.setContentSize(w, h);
        n.setPosition(x || 0, y || 0);
        if (parent) parent.addChild(n);
        return n;
    }
    function box(n, color, r) {
        var g = n.getComponent(cc.Graphics) || n.addComponent(cc.Graphics), w = n.width, h = n.height;
        g.clear();
        g.fillColor = color;
        g.roundRect(-w / 2, -h / 2, w, h, r === undefined ? 14 : r);
        g.fill();
        return g;
    }
    function label(parent, text, size, color, w, h, x, y, align) {
        var n = node("t", parent, w, h, x, y), l = n.addComponent(cc.Label);
        l.overflow = cc.Label.Overflow.SHRINK;
        l.enableWrapText = true;
        l.fontSize = size;
        l.lineHeight = size + 6;
        l.verticalAlign = cc.Label.VerticalAlign.CENTER;
        l.horizontalAlign = align === undefined ? cc.Label.HorizontalAlign.CENTER : align;
        l.string = String(text);
        n.setContentSize(w, h);   // the label resized the node when it was added: shrink would work on width 0
        n.color = color || C.text;
        return n;
    }
    var LEFT = cc.Label.HorizontalAlign.LEFT;
    function button(parent, text, w, h, x, y, cb, on, size) {
        var n = node("b", parent, w, h, x, y);
        box(n, on ? C.on : C.btn, Math.min(16, h / 2));
        label(n, text, size || 28, C.white, w - 12, h - 4, 0, 0);
        n.addComponent(cc.Button);
        n.on("click", function () { try { cb(); } catch (e) { T.say("Lỗi menu: " + e); render(); } });
        return n;
    }
    function row(parent, label_, items, y, W, cur, pick) {   // a caption and a line of choices
        label(parent, label_, 26, C.text, W, 36, 0, y, LEFT);
        var n = items.length, gap = 8, bw = (W - gap * (n - 1)) / n;
        items.forEach(function (it, i) {
            button(parent, it[0], bw, 54, -W / 2 + bw / 2 + i * (bw + gap), y - 48, function () { pick(it[1]); }, cur === it[1]);
        });
    }
    function toggle(parent, text, y, W, on, cb) {
        var bg = node("r", parent, W, 58, 0, y);
        box(bg, C.row, 12);
        label(bg, text, 26, C.text, W - 130, 50, -55, 0, LEFT);
        button(bg, on ? "BẬT" : "TẮT", 100, 44, W / 2 - 60, 0, cb, on, 24);
    }
    // a scrolling list; build(content) returns the height it used
    function list(parent, key, W, H, y, build) {
        var sv = node("list", parent, W, H, 0, y);
        box(sv, C.line, 12);
        var view = node("view", sv, W - 8, H - 8, 0, 0);
        var mask = view.addComponent(cc.Mask);
        mask.type = cc.Mask.Type.RECT;
        var content = node("content", view, W - 8, H - 8, 0, 0);
        content.anchorY = 1;
        content.y = (H - 8) / 2;
        var used = build(content, W - 8);
        content.height = Math.max(used, H - 8);
        var s = sv.addComponent(cc.ScrollView);
        s.content = content;
        s.horizontal = false;
        s.vertical = true;
        s.brake = 0.75;
        s.elastic = true;
        sv.on("scrolling", function () { S.scroll[key] = s.getScrollOffset().y; });
        if (S.scroll[key]) s.scheduleOnce(function () { s.scrollToOffset(cc.v2(0, S.scroll[key]), 0); }, 0);
        return sv;
    }
    function listRow(content, W, y, text, selected, cb) {
        var n = node("i", content, W - 8, 52, 0, y - 28);
        box(n, selected ? C.on : C.row, 10);
        label(n, text, 25, selected ? C.white : C.text, W - 30, 46, 0, 0, LEFT);
        n.addComponent(cc.Button);
        n.on("click", cb);
    }
    function field(parent, W, y, placeholder, value, cb) {
        var n = node("edit", parent, W, 56, 0, y), bg = node("bg", n, W, 56);
        box(bg, C.row, 10);
        var eb = n.addComponent(cc.EditBox);
        eb.inputMode = cc.EditBox.InputMode.NUMERIC;
        eb.maxLength = 6;
        eb.placeholder = placeholder;
        eb.fontSize = 26; eb.placeholderFontSize = 24;
        eb.fontColor = C.text; eb.placeholderFontColor = cc.color(150, 125, 110);
        eb.string = value || "";
        n.on("editing-did-ended", function () { cb(eb.string); });
        n.on("text-changed", function () { cb(eb.string); });
        return n;
    }

    // ---- pages ----
    function pageSpeed(b, W, top) {
        var y = top - 20;
        function set(k, v) { cfg[k] = v; P.save(); render(); }
        row(b, "Sẵn có", [["Gốc", 1], ["Nhanh", 2], ["Rất nhanh", 3]], y, W, cfg.ka === 1 && cfg.kn === 1 ? 1 : cfg.ka === 4 && cfg.kn === 2 ? 2 : cfg.ka === 8 && cfg.kn === 3 ? 3 : 0, function (v) {
            if (v === 1) { cfg.ka = 1; cfg.kn = 1; cfg.kb = false; cfg.noPop = false; cfg.noLock = false; }
            if (v === 2) { cfg.ka = 4; cfg.kn = 2; cfg.kb = true; cfg.noPop = true; cfg.noLock = true; }
            if (v === 3) { cfg.ka = 8; cfg.kn = 3; cfg.kb = true; cfg.noPop = true; cfg.noLock = true; }
            P.save(); render();
        });
        y -= 104;
        row(b, "Bảng, di chuyển, hiệu ứng trượt", [["x1", 1], ["x2", 2], ["x4", 4], ["x8", 8], ["x12", 12]], y, W, cfg.ka, function (v) { set("ka", v); });
        y -= 104;
        row(b, "Hoạt ảnh clip", [["x1", 1], ["x2", 2], ["x3", 3], ["x4", 4]], y, W, cfg.kn, function (v) { set("kn", v); });
        y -= 124;
        [["Nút bấm phản hồi ngay", "kb"], ["Bảng hiện ngay, không phóng to dần", "noPop"], ["Bỏ khóa nút 0,3 giây sau mỗi lần bấm", "noLock"],
         ["Tắt vòng sáng mỗi lần chạm", "noTouchFx"], ["Chặn bảng tự mở (thông báo, banner)", "block"]].forEach(function (t) {
            toggle(b, t[0], y, W, !!cfg[t[1]], function () { set(t[1], !cfg[t[1]]); });
            y -= 66;
        });
    }
    function pageDebate(b, W, top) {
        var y = top - 30;
        toggle(b, "Tự đánh nhanh Khẩu Chiến", y, W, !!cfg.autoDebate, function () { cfg.autoDebate = !cfg.autoDebate; P.save(); render(); });
        y -= 110;
        label(b, "Cách dùng:\n1. Bật ở trên, đóng menu.\n2. Vào Khẩu Chiến, chọn người như bình thường.\n3. Khi tới màn chọn đối thủ, mod đánh hết các trận và không hiện bảng kết quả từng trận.\nKhông tự mua buff, không tốn KNB.", 26, C.text, W, 240, 0, y - 60, LEFT);
        y -= 210;
        try {
            var d = T.debateStatus();
            label(b, "Hôm nay đã dùng " + d.count + "/" + d.free + " lượt miễn phí" + (d.cooldown > 0 ? ", đang hồi " + Math.ceil(d.cooldown / 60) + " phút" : "") + ", điểm " + d.point, 26, C.title, W, 70, 0, y, LEFT);
        } catch (e) { label(b, "Chưa vào game", 26, C.title, W, 40, 0, y, LEFT); }
        if (T.debate.last) label(b, T.debate.last, 25, C.text, W, 70, 0, y - 76, LEFT);
    }
    function toggleSel(id) { if (S.sel[id]) delete S.sel[id]; else S.sel[id] = true; render(); }
    function chosen() { return Object.keys(S.sel).map(Number); }
    function confirmBuff(b, W, y, text, ok) {   // items are precious: the first press only shows what will happen
        var armed = S.confirm && Date.now() - S.confirm < 5000;
        button(b, armed ? "Bấm lần nữa để dùng thật" : text, W, 64, 0, y, function () {
            if (T.job) { T.say("Đang chạy " + T.job); return; }
            if (!armed) { S.confirm = Date.now(); render(); return; }
            S.confirm = 0; ok();
        }, armed);
    }
    function followerList(b, W, H, y) {
        var fs = T.followers();
        list(b, "fol", W, H, y, function (c, w) {
            var yy = 0;
            fs.forEach(function (f) {
                listRow(c, w, yy, f.name + "   Cấp " + f.level + "   Tư Chất " + f.aptitude, S.fol === f.id, function () { S.fol = f.id; render(); });
                yy -= 56;
            });
            return -yy + 4;
        });
    }
    function pageFavor(b, W, top) {
        var cs = T.confidants(), bw = (W - 24) / 4;
        cs.forEach(function (c, i) {
            button(b, c.name, bw, 62, -W / 2 + bw / 2 + i * (bw + 8), top - 34, function () { S.conf = c.id; S.sel = {}; render(); }, S.conf === c.id, 22);
        });
        var c = cs[S.conf - 1];
        label(b, c.met ? "Thiện Cảm hiện tại: " + c.favor : "Chưa gặp " + c.name, 26, C.title, W, 40, 0, top - 92, LEFT);
        var it = T.favorItems(S.conf);
        function line(p) { return p.name + "  x" + p.count + "  (+" + (Array.isArray(p.value) ? p.value.join("-") : p.value) + "/món)"; }
        var H = top + 140;   // leaves the Buff button
        list(b, "fav", W, top * 2 - 240, 0 - 20, function (cc_, w) {
            var yy = 0;
            function head(t) { label(cc_, t, 24, C.title, w - 20, 34, 0, yy - 18, LEFT); yy -= 38; }
            head("Riêng " + c.name + (it.own.length ? "" : ": không có"));
            it.own.forEach(function (p) { listRow(cc_, w, yy, line(p), !!S.sel[p.id], function () { toggleSel(p.id); }); yy -= 56; });
            head("Dùng cho mọi người" + (it.all.length ? "" : ": không có"));
            it.all.forEach(function (p) { listRow(cc_, w, yy, line(p), !!S.sel[p.id], function () { toggleSel(p.id); }); yy -= 56; });
            return -yy + 4;
        });
        var ids = chosen();
        confirmBuff(b, W, -top + 36, "Buff " + ids.length + " loại (dùng hết)", function () {
            if (!ids.length) { T.say("Chưa chọn món nào"); render(); return; }
            T.run("Thiện Cảm " + c.name, function () { return T.buffFavor(S.conf, ids); });
        });
    }
    function pageApt(b, W, top) {
        label(b, "1. Chọn đồng hành", 25, C.title, W, 34, 0, top - 18, LEFT);
        followerList(b, W, 300, top - 190);
        label(b, "2. Chọn cuộn (được chọn nhiều)", 25, C.title, W, 34, 0, top - 360, LEFT);
        var y = top - 416, sc = T.scrolls();
        if (!sc.length) label(b, "Không có cuộn tư chất", 25, C.text, W, 40, 0, y, LEFT);
        sc.forEach(function (p, i) {
            var bw = (W - 8) / 2, xi = i % 2, yi = y - Math.floor(i / 2) * 60;
            var n = node("i", b, bw, 54, -W / 2 + bw / 2 + xi * (bw + 8), yi);
            box(n, S.sel[p.id] ? C.on : C.row, 10);
            label(n, p.name + " x" + p.count, 23, S.sel[p.id] ? C.white : C.text, bw - 16, 48, 0, 0);
            n.addComponent(cc.Button);
            n.on("click", function () { toggleSel(p.id); });
        });
        y -= 124;
        field(b, W, y, "Tối đa bao nhiêu cuộn (trống = dùng hết)", S.qty, function (v) { S.qty = v; });
        var ids = chosen(), lim = parseInt(S.qty, 10) || 0;
        confirmBuff(b, W, -top + 36, "Buff" + (lim ? " tối đa " + lim + " cuộn" : " (dùng hết cuộn đã chọn)"), function () {
            if (!S.fol || !ids.length) { T.say("Chọn đồng hành và cuộn trước"); render(); return; }
            T.run("Tư Chất", function () { return T.buffAptitude(S.fol, ids, parseInt(S.qty, 10) || 0); });
        });
    }
    function pageCulture(b, W, top) {
        label(b, "1. Chọn đồng hành", 25, C.title, W, 34, 0, top - 18, LEFT);
        followerList(b, W, 260, top - 170);
        label(b, "2. Chọn món (được chọn nhiều)", 25, C.title, W, 34, 0, top - 320, LEFT);
        var gs = T.cultureItems();
        list(b, "cul", W, top * 2 - 500, -top + 266 - 8, function (c, w) {
            var yy = 0;
            if (!gs.length) label(c, "Không có món bồi dưỡng", 25, C.text, w - 20, 40, 0, -24, LEFT);
            gs.forEach(function (g) {
                label(c, g[0], 24, C.title, w - 20, 34, 0, yy - 18, LEFT); yy -= 38;
                g[1].forEach(function (p) { listRow(c, w, yy, p.name + "  x" + p.count, !!S.sel[p.id], function () { toggleSel(p.id); }); yy -= 56; });
            });
            return -yy + 4;
        });
        field(b, W, -top + 108, "Số lượng mỗi món (trống = dùng hết)", S.qty, function (v) { S.qty = v; });
        var ids = chosen();
        confirmBuff(b, W, -top + 36, "Buff " + ids.length + " loại", function () {
            if (!S.fol || !ids.length) { T.say("Chọn đồng hành và món trước"); render(); return; }
            T.run("Bồi Dưỡng", function () { return T.buffCulture(S.fol, ids, parseInt(S.qty, 10) || 0); });
        });
    }
    function pageLenh(b, W, top) {
        field(b, W, top - 34, "Số lệnh cần dùng (trống = dùng hết)", S.qty, function (v) { S.qty = v; });
        var y = top - 106;
        T.LENH.forEach(function (l) {
            var n = T.lenhCount(l.id), r = node("r", b, W, 76, 0, y);
            box(r, C.row, 12);
            label(r, l.name + "  x" + n, 26, C.text, W - 170, 66, -75, 0, LEFT);
            var armed = S.confirm === l.id && Date.now() - S.armAt < 5000;
            button(r, armed ? "Bấm nữa" : "Buff", 130, 56, W / 2 - 78, 0, function () {
                if (T.job) { T.say("Đang chạy " + T.job); return; }
                if (!armed) { S.confirm = l.id; S.armAt = Date.now(); render(); return; }
                S.confirm = 0;
                T.run(l.name, function () { return T.dungLenh(l, parseInt(S.qty, 10) || 0); });
                render();
            }, armed, 25);
            y -= 84;
        });
    }
    function pageItem(b, W, top) {
        var bw = (W - 24) / 4;
        [["Thiện Cảm", "favor"], ["Tư Chất", "apt"], ["Bồi Dưỡng", "cul"], ["Lệnh", "lenh"]].forEach(function (t, i) {
            button(b, t[0], bw, 54, -W / 2 + bw / 2 + i * (bw + 8), top - 30, function () { S.sub = t[1]; S.sel = {}; S.qty = ""; S.confirm = 0; render(); }, S.sub === t[1]);
        });
        var inner = node("inner", b, W, top * 2 - 70, 0, -35), t2 = inner.height / 2;
        try {
            if (S.sub === "favor") pageFavor(inner, W, t2);
            if (S.sub === "apt") pageApt(inner, W, t2);
            if (S.sub === "cul") pageCulture(inner, W, t2);
            if (S.sub === "lenh") pageLenh(inner, W, t2);
        } catch (e) {
            label(inner, "Vào game rồi mở lại mục này\n(" + e + ")", 26, C.text, W, 120, 0, 0);
        }
    }
    function pageAuto(b, W, top) {
        var y = top - 44;
        function go(text, name, fn) {
            button(b, text, W, 72, 0, y, function () { T.run(name, fn); render(); }, T.job === name);
            y -= 84;
        }
        go("Thu Nội Chính", "Nội Chính", T.noiChinh);
        toggle(b, "Tự thu Nội Chính mỗi 30 phút", y + 8, W, !!cfg.autoErrand, function () { cfg.autoErrand = !cfg.autoErrand; P.save(); render(); });
        y -= 76;
        go("Nhận thưởng: Thư, Thành tựu, Giờ Vàng", "Nhận thưởng", T.nhanThuong);
        go("Săn Sóc tất cả Tri Kỷ (lượt miễn phí)", "Săn Sóc tất cả", function () { return T.sanSocAll(0); });
        go("Thỉnh An + Bái Kiến + Hội Hoa", "Thỉnh An", T.thinhAn);
        go("Chạy Nhiệm vụ ngày", "Nhiệm vụ ngày", T.nhiemVuNgay);
        go("Leo Trích Tinh Các (đến khi hết Nổi Tiếng)", "Trích Tinh Các", T.leoTrichTinh);
        if (T.job) button(b, "Dừng " + T.job, W, 64, 0, y, function () { T.stop = true; T.say("Đang dừng..."); }, true);
    }

    function pageEvents(b, W, top) {
        var ev = T.events(), up = T.upcoming();
        toggle(b, "Báo khi sự kiện sắp mở / sắp hết", top - 30, W, !!P.cfg.alerts, function () { P.cfg.alerts = !P.cfg.alerts; P.save(); render(); });
        button(b, "Làm sự kiện (phần miễn phí)", W, 60, 0, top - 94, function () { T.run("Làm sự kiện", T.lamSuKien); }, T.job === "Làm sự kiện");
        label(b, ev.length + " đang diễn ra, " + up.length + " sắp mở. Dấu * = có auto", 24, C.title, W, 36, 0, top - 146, LEFT);
        list(b, "ev", W, top * 2 - 176, -86, function (c, w) {
            var yy = 0;
            up.forEach(function (e) {
                var n = node("i", c, w - 8, 52, 0, yy - 28);
                box(n, C.off, 10);
                label(n, e.name, 24, C.text, w - 170, 46, -70, 0, LEFT);
                label(n, "mở sau " + (e.wait >= 86400 ? Math.floor(e.wait / 86400) + " ngày" : Math.floor(e.wait / 3600) + "g" + Math.floor(e.wait % 3600 / 60) + "p"), 21, C.title, 150, 46, w / 2 - 80, 0);
                yy -= 56;
            });
            ev.forEach(function (e) {
                var d = Math.floor(e.left / 86400), h = Math.floor(e.left % 86400 / 3600), m = Math.floor(e.left % 3600 / 60);
                var n = node("i", c, w - 8, 52, 0, yy - 28);
                box(n, C.row, 10);
                label(n, (T.eventHandled(e.type) ? "* " : "") + e.name, 24, C.text, w - 170, 46, -70, 0, LEFT);
                label(n, d ? "còn " + d + " ngày" : "còn " + h + "g" + m + "p", 22, C.title, 140, 46, w / 2 - 80, 0);
                yy -= 56;
            });
            return -yy + 4;
        });
    }
    function pageAcc(b, W, top) {
        button(b, "Lưu acc đang chơi", W, 64, 0, top - 36, function () { T.say(P.accounts.save()); render(); });
        label(b, "Bấm Vào: game tự đóng, bạn mở lại là tự vào đúng acc và server. Không lưu mật khẩu. Phiên hết hạn thì đăng nhập tay rồi Lưu lại.", 23, C.text, W, 76, 0, top - 110, LEFT);
        var l = P.accounts.list();
        button(b, "Xem lỗi gần nhất của game", W, 44, 0, -top + 24, function () {
            var f = jsb.fileUtils.getWritablePath() + "phct/err.log";
            T.say(jsb.fileUtils.isFileExist(f) ? jsb.fileUtils.getStringFromFile(f).slice(-300) : "Chưa ghi nhận lỗi nào");
        }, false, 22);
        list(b, "acc", W, top * 2 - 208, -52, function (c, w) {
            var yy = 0;
            l.forEach(function (a, i) {
                var n = node("i", c, w - 8, 62, 0, yy - 33);
                box(n, C.row, 10);
                label(n, a.login + (a.role ? " - " + a.role : "") + "  (" + a.zone + ")", 23, C.text, w - 230, 56, -105, 0, LEFT);
                var armed = S.accArm === i && Date.now() - S.accAt < 5000;
                button(n, armed ? "Đóng game?" : "Vào", 96, 48, w / 2 - 170, 0, function () {   // closing the game is how the SDK takes the session: say so first
                    if (!armed) { S.accArm = i; S.accAt = Date.now(); T.say("Bấm lần nữa: game sẽ ĐÓNG, bạn mở lại là vào " + a.login); render(); return; }
                    S.accArm = -1;
                    P.accounts.enter(i);
                }, true, armed ? 18 : 24);
                button(n, "Xóa", 76, 48, w / 2 - 66, 0, function () { P.accounts.remove(i); render(); }, false, 22);
                yy -= 66;
            });
            return -yy + 4;
        });
    }
    function logText(n) { return T.log.slice(-n).join("\n"); }
    function render() {
        if (!PANEL || !PANEL.active) return;
        BODY.removeAllChildren();
        var W = BODY.width - 8, top = BODY.height / 2, y = top;
        try {
            if (S.tab === "speed") pageSpeed(BODY, W, top);
            if (S.tab === "debate") pageDebate(BODY, W, top);
            if (S.tab === "item") pageItem(BODY, W, top);
            if (S.tab === "auto") pageAuto(BODY, W, top);
            if (S.tab === "acc") pageAcc(BODY, W, top);
        } catch (e) { label(BODY, "Lỗi trang: " + e, 26, C.text, W, 200, 0, 0); }
        PANEL.getChildByName("tabs").children.forEach(function (t) { box(t, t._tab === S.tab ? C.on : C.btn, 14); });
    }
    function refreshLog() {
        if (LOGN && LOGN.isValid) LOGN.getComponent(cc.Label).string = logText(4);
        if (STATUS && STATUS.isValid) {
            STATUS.active = !!T.job;
            if (T.job) STATUS.getComponent(cc.Label).string = T.log.slice(-1)[0] || T.job;
        }
    }
    T.onChange = function () { refreshLog(); if (PANEL && PANEL.active && S.tab === "auto") render(); };

    function buildPanel() {
        var wz = cc.winSize, PW = Math.min(wz.width - 20, 700), PH = Math.min(wz.height - 90, 1160);
        var shade = node("shade", ROOT, wz.width, wz.height, wz.width / 2, wz.height / 2);
        var g = shade.addComponent(cc.Graphics);
        g.fillColor = C.shade; g.rect(-wz.width / 2, -wz.height / 2, wz.width, wz.height); g.fill();
        shade.addComponent(cc.BlockInputEvents);
        PANEL = shade;
        var card = node("card", shade, PW, PH, 0, 0);
        box(card, C.line, 22);
        var inner = node("inner", card, PW - 8, PH - 8);
        box(inner, C.panel, 20);
        label(inner, "Phượng Hoàng Mod  v" + (window.PHCT_VERSION || 0), 32, C.title, PW - 270, 60, -105, PH / 2 - 44, LEFT);
        button(inner, "Cập nhật", 130, 56, PW / 2 - 156, PH / 2 - 44, function () { P.update.install(); }, false, 25);
        button(inner, "X", 62, 56, PW / 2 - 50, PH / 2 - 44, function () { PANEL.active = false; FLOAT.active = true; }, true);
        var tabs = node("tabs", shade, PW - 20, 60, 0, PH / 2 - 112), names = [["Tốc độ", "speed"], ["K.Chiến", "debate"], ["Item", "item"], ["Tự động", "auto"], ["Acc", "acc"]];
        var tw = (PW - 52) / 5;
        names.forEach(function (t, i) {
            var n = button(tabs, t[0], tw, 56, -(PW - 20) / 2 + tw / 2 + i * (tw + 8), 0, function () { S.tab = t[1]; S.sel = {}; S.confirm = 0; render(); }, S.tab === t[1], 23);
            n._tab = t[1];
        });
        var logH = 130;
        BODY = node("body", shade, PW - 28, PH - 160 - logH - 22, 0, -(160 - logH - 16) / 2 - 0);
        BODY.y = PH / 2 - 150 - BODY.height / 2;
        var lb = node("logbg", shade, PW - 28, logH, 0, -PH / 2 + logH / 2 + 12);
        box(lb, C.row, 12);
        LOGN = label(lb, "", 21, C.text, PW - 48, logH - 8, 0, 0, LEFT);
        LOGN.getComponent(cc.Label).overflow = cc.Label.Overflow.CLAMP;
        LOGN.getComponent(cc.Label).verticalAlign = cc.Label.VerticalAlign.BOTTOM;
        PANEL.active = false;
    }
    function buildFloat() {
        var wz = cc.winSize, F = node("float", ROOT, 92, 92, cfg.x || wz.width - 60, cfg.y || wz.height * 0.62);
        var g = F.addComponent(cc.Graphics);
        g.fillColor = C.line; g.circle(0, 0, 46); g.fill();
        g.fillColor = C.btn; g.circle(0, 0, 40); g.fill();
        label(F, "MOD", 26, C.white, 76, 40, 0, 0);
        FLOAT = F;
        STATUS = label(ROOT, "", 22, C.white, 420, 60, wz.width / 2, 34);
        STATUS.active = false;
        var moved = false, sx = 0, sy = 0;
        F.on(cc.Node.EventType.TOUCH_START, function (e) { moved = false; var p = e.getLocation(); sx = p.x; sy = p.y; });
        F.on(cc.Node.EventType.TOUCH_MOVE, function (e) {
            var p = e.getLocation();
            if (!moved && Math.abs(p.x - sx) + Math.abs(p.y - sy) < 14) return;
            moved = true;
            var q = ROOT.convertToNodeSpaceAR(p);
            F.setPosition(Math.max(46, Math.min(wz.width - 46, q.x)), Math.max(46, Math.min(wz.height - 46, q.y)));
        });
        function end() {
            if (moved) { cfg.x = F.x; cfg.y = F.y; P.save(); return; }
            PANEL.active = true;
            F.active = false;
            render(); refreshLog();
        }
        F.on(cc.Node.EventType.TOUCH_END, end);
    }
    function install() {
        var scene = cc.director.getScene();
        if (!scene || !window.__require) return;
        if (ROOT && ROOT.isValid) return;
        ROOT = node("PHCTMod", null, cc.winSize.width, cc.winSize.height, 0, 0);
        ROOT.anchorX = 0; ROOT.anchorY = 0;
        scene.addChild(ROOT);
        ROOT.zIndex = cc.macro.MAX_ZINDEX;
        cc.game.addPersistRootNode(ROOT);
        buildPanel();
        buildFloat();
        console.log("PHCT menu ready v" + window.PHCT_VERSION + " " + cc.winSize.width + "x" + cc.winSize.height);
        setTimeout(function () { try { jsb.fileUtils.removeFile(jsb.fileUtils.getWritablePath() + "phct/booting"); } catch (e) { } }, 15000);   // the game started: see the loader in main.js
    }
    P.install = install;
    setInterval(function () { try { install(); } catch (e) { console.log("PHCT install: " + e); } }, 1000);
})();

// PHCT mod (phone): update of the mod itself, from the public dist repo. The file is taken only from this https address and
// must match the md5 and size in version.json. It goes to files/phct/, where the loader in main.js finds it at the next start.
(function () {
    var P = window.PHCT, BASE = window.PHCT_UPDATE_BASE || "https://raw.githubusercontent.com/LukeZhen/phct-mod-dist/main/", T = P.tasks;   // the override is only set by a test build (--extra)
    function get(path, cb) {
        var fin = false;
        function end(v) { if (!fin) { fin = true; cb(v); } }
        var x = new XMLHttpRequest();
        x.open("GET", BASE + path + "?t=" + Date.now(), true);
        x.onreadystatechange = function () { if (x.readyState === 4) end(x.status === 200 ? x.responseText : null); };
        x.onerror = function () { end(null); };
        x.send();
        setTimeout(function () { end(null); try { x.abort(); } catch (e) { } }, 60000);
    }
    var U = P.update = { version: window.PHCT_VERSION || 0, latest: 0, note: "", state: "", busy: false, onChange: null };
    function changed() { if (U.onChange) U.onChange(); }
    U.check = function (done) {
        get("version.json", function (t) {
            var j = null;
            try { j = JSON.parse(t); } catch (e) { }
            if (j && j.version) { U.latest = j.version; U.note = j.note || ""; U.info = j; }
            changed();
            if (done) done(j);
        });
    };
    function save(text, info) {
        var F = jsb.fileUtils, D = F.getWritablePath() + "phct/";
        F.createDirectory(D);
        if (!F.writeStringToFile(text, D + "mod.js")) return false;
        F.writeStringToFile(String(info.version), D + "version.txt");
        F.removeFile(D + "booting");
        return true;
    }
    U.install = function () {
        if (U.busy) return;
        if (U.ready) { cc.game.end(); return; }   // the new code loads when the app really starts again; going to the home screen is not enough
        U.busy = true;
        T.say("Cập nhật mod: đang kiểm tra...");
        function end(msg) {
            U.busy = false; U.state = msg; T.say("Cập nhật mod: " + msg); changed();
            try { window.__require("Toast").default.show(msg); } catch (e) { }
        }
        U.check(function (info) {
            if (!info) return end("không kết nối được, thử lại sau");
            if (info.version <= U.version) return end("đang là bản mới nhất (v" + U.version + ")");
            get(info.file || "phct_mod.js", function (text) {   // a new name per version: GitHub caches a file for 5 minutes, the list and the file could disagree

                if (!text) return end("tải file lỗi, thử lại sau");
                if (md5(text) !== info.md5) return end("file tải về không khớp, không cài");
                U.ready = save(text, info);
                end(U.ready ? "đã tải v" + info.version + ". Bấm Cập nhật lần nữa: game đóng, mở lại là dùng bản mới" : "không ghi được file");
            });
        });
    };
    setTimeout(function () { U.check(function (j) { if (j && j.version > U.version) T.say("Có bản mod mới v" + j.version + (j.note ? ": " + j.note : "") + ". Bấm Cập nhật."); }); }, 8000);
})();
