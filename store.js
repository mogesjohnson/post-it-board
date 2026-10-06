/* Post-it Board — storage layer.
 *
 * Interface (every method returns a Promise):
 *   listDays()                      -> [{id, board_date, title}]  newest first
 *   listPins(dayId)                 -> [{id, day_id, title, color, position, page_count}]
 *   listPages(pinId)                -> [{id, pin_id, title, body, position}]
 *   createDay({board_date, title})
 *   createPin({day_id, title, color, position})
 *   createPage({pin_id, title, body, position})
 *   updatePin(id, patch) / updatePage(id, patch)
 *   deletePins(ids) / deletePages(ids)   (hard delete; pins cascade to pages)
 *
 * Backends:
 *   SupabaseStore — PostgREST over fetch, used when config.js is filled in.
 *   LocalStore    — localStorage demo board, used when config.js is empty.
 *
 * Auth (Supabase only): owner email+password via Supabase Auth REST.
 * The session lives in localStorage; writes send its access token and
 * Row Level Security decides what is allowed.
 */
(function () {
  "use strict";

  var cfg = window.POSTIT_CONFIG || {};
  var SUPABASE_URL = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "");
  var ANON_KEY = String(cfg.SUPABASE_ANON_KEY || "");
  var configured =
    /^https?:\/\//.test(SUPABASE_URL) &&
    ANON_KEY.length > 20 &&
    SUPABASE_URL.indexOf("YOUR-PROJECT") === -1;

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  }
  function nowIso() { return new Date().toISOString(); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function byPos(a, b) {
    return (a.position || 0) - (b.position || 0) || String(a.created_at).localeCompare(String(b.created_at));
  }

  /* ------------------------------------------------------------------ */
  /* Auth (Supabase Auth REST, email + password)                         */
  /* ------------------------------------------------------------------ */
  var SESSION_KEY = "postit.session.v1";
  var EXPIRED = "Session expired — please sign in again.";
  var OFFLINE = "Can't reach the board's database — check your connection.";
  var Auth = {
    session: null,
    onExpired: null,   // set by the UI: called when a session is dropped because it expired (not on sign-out)
    onChange: null,    // set by the UI: called when another tab signs in or out
    _refreshing: null, // the one refresh in flight, shared by every request that needs it
    _reported: false,  // signed-in state the UI last knew about (for the cross-tab storage event)
    // Read the session from localStorage: another tab may have refreshed it or signed out.
    load: function () {
      var raw;
      try { raw = localStorage.getItem(SESSION_KEY); } catch (e) { return this.session; } // storage unavailable: keep ours
      try { this.session = JSON.parse(raw || "null"); } catch (e) { this.session = null; }
      return this.session;
    },
    save: function (s) {
      if (s && !s.expires_at && s.expires_in) s.expires_at = Math.floor(Date.now() / 1000) + Number(s.expires_in);
      this.session = s;
      this._reported = this.isSignedIn(); // this tab's own change: its UI already knows
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    },
    isSignedIn: function () { return !!(this.session && this.session.access_token); },
    email: function () { return (this.session && this.session.user && this.session.user.email) || ""; },
    signIn: async function (email, password) {
      var res;
      try {
        res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
          method: "POST",
          headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, password: password }),
        });
      } catch (e) { throw new Error(OFFLINE); }
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error_description || data.msg || data.message || "Sign-in failed (" + res.status + ")");
      this.save(data);
      return data;
    },
    // Resolves to a fresh session. `stale` is the access token a request was rejected with: if the session has
    // moved on since (refreshed here or in another tab), that newer session is used without asking the server.
    // Concurrent callers share one request, because a refresh token only works once.
    refresh: function (stale) {
      var self = this;
      if (this._refreshing) return this._refreshing;
      this.load();
      if (!this.session || !this.session.refresh_token) return Promise.reject(new Error(EXPIRED));
      if (stale && this.session.access_token !== stale) return Promise.resolve(this.session);
      this._refreshing = this._refresh().finally(function () { self._refreshing = null; });
      return this._refreshing;
    },
    _refresh: async function () {
      var sent = this.session.refresh_token, res;
      try {
        res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: sent }),
          // every request waits on this one refresh, so it must not hang forever
          signal: window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
        });
      } catch (e) { throw new Error(OFFLINE); }                               // network blip: keep the session
      var data = await res.json().catch(function () { return {}; });
      // Signed out, or another tab refreshed, while we waited: never overwrite or drop that newer state.
      this.load();
      if (!this.session || this.session.refresh_token !== sent) {
        if (this.isSignedIn()) return this.session;
        throw new Error(EXPIRED);
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) { this.expire(); throw new Error(EXPIRED); } // token rejected
      if (!res.ok || !data.access_token) throw new Error("Couldn't refresh the session (" + res.status + ")."); // 429/5xx: keep it
      this.save(data);
      return data;
    },
    // Drop a session the server no longer accepts and tell the UI.
    expire: function () {
      if (!this.session) return;
      this.save(null);
      if (typeof this.onExpired === "function") {
        try { this.onExpired(); } catch (e) { console.error(e); }
      }
    },
    // Returns a usable access token (refreshing if it expires within 60s), or null.
    token: async function () {
      this.load();
      if (!this.isSignedIn()) return null;
      var exp = Number(this.session.expires_at || 0);
      if (exp && exp - 60 < Date.now() / 1000) return (await this.refresh()).access_token;
      return this.session.access_token;
    },
    signOut: async function () {
      var t = this.session && this.session.access_token;
      this.save(null);
      if (t) {
        try {
          await fetch(SUPABASE_URL + "/auth/v1/logout", {
            method: "POST", headers: { apikey: ANON_KEY, Authorization: "Bearer " + t },
          });
        } catch (e) { /* ignore network errors on logout */ }
      }
    },
  };

  /* ------------------------------------------------------------------ */
  /* Supabase backend (PostgREST)                                        */
  /* ------------------------------------------------------------------ */
  function SupabaseStore() { this.mode = "supabase"; }

  // attempt: undefined = first try, "refreshed" = after a token refresh,
  // "anon" = a read retried with the public key after the session failed.
  SupabaseStore.prototype.req = async function (method, path, body, attempt) {
    var write = method !== "GET";
    var token = null;
    if (attempt !== "anon") {
      try { token = await Auth.token(); }
      catch (e) { if (write) throw e; } // reads fall back to the public anon key
    }
    if (write && !token) throw new Error(EXPIRED); // session gone (e.g. while a form was open): don't send it anonymously
    var headers = {
      apikey: ANON_KEY,
      Authorization: "Bearer " + (token || ANON_KEY),
      "Content-Type": "application/json",
    };
    if (write) headers.Prefer = "return=representation";
    var res;
    try {
      res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
        method: method, headers: headers, body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(OFFLINE);
    }
    if (res.status === 401 && token && !attempt) {
      var next = "refreshed";
      try { await Auth.refresh(token); }
      catch (e) { if (write) throw e; next = "anon"; }
      return this.req(method, path, body, next);
    }
    // The board is public: a session the database still rejects must never hide it.
    if (!write && token && (res.status === 401 || res.status === 403)) return this.req(method, path, body, "anon");
    var text = await res.text();
    var data = null, parsed = !text;
    try { if (text) { data = JSON.parse(text); parsed = true; } } catch (e) { /* not JSON, e.g. a proxy error page */ }
    if (!res.ok) {
      var msg = (data && (data.message || data.hint)) || "Server error (" + res.status + (res.statusText ? " " + res.statusText : "") + ")";
      if (write && (res.status === 401 || res.status === 403 || /row-level security/i.test(msg))) {
        msg = "Not allowed — sign in as the board owner to make changes.";
      }
      throw new Error(msg);
    }
    if (!parsed) throw new Error("Unexpected response from the server (" + res.status + ").");
    return data;
  };
  function enc(v) { return encodeURIComponent(v); }
  function inList(ids) { return "in.(" + ids.map(enc).join(",") + ")"; }
  function first(rows) {
    if (!rows || !rows.length) throw new Error("Not allowed — sign in as the board owner to make changes.");
    return rows[0];
  }
  function writeCheck(rows, ids, what) {
    // With RLS, a forbidden delete/update silently affects 0 rows.
    if (ids.length && (!rows || rows.length === 0)) throw new Error("Nothing was " + what + " — are you signed in as the owner?");
    return rows;
  }

  SupabaseStore.prototype.listDays = function () {
    return this.req("GET", "days?select=id,board_date,title,created_at&order=board_date.desc");
  };
  SupabaseStore.prototype.listPins = async function (dayId) {
    var rows = await this.req("GET", "pins?select=*,pages(count)&day_id=eq." + enc(dayId) + "&order=position.asc,created_at.asc");
    return rows.map(function (p) {
      p.page_count = p.pages && p.pages[0] ? p.pages[0].count : 0;
      delete p.pages;
      return p;
    });
  };
  SupabaseStore.prototype.listPages = function (pinId) {
    return this.req("GET", "pages?select=*&pin_id=eq." + enc(pinId) + "&order=position.asc,created_at.asc");
  };
  SupabaseStore.prototype.createDay = async function (d) {
    return first(await this.req("POST", "days", { board_date: d.board_date, title: d.title || null }));
  };
  SupabaseStore.prototype.createPin = async function (p) {
    return first(await this.req("POST", "pins", { day_id: p.day_id, title: p.title, color: p.color || "yellow", position: p.position || 0 }));
  };
  SupabaseStore.prototype.createPage = async function (p) {
    return first(await this.req("POST", "pages", { pin_id: p.pin_id, title: p.title || null, body: p.body || "", position: p.position || 0 }));
  };
  SupabaseStore.prototype.updatePin = async function (id, patch) {
    return first(writeCheck(await this.req("PATCH", "pins?id=eq." + enc(id), patch), [id], "updated"));
  };
  SupabaseStore.prototype.updatePage = async function (id, patch) {
    return first(writeCheck(await this.req("PATCH", "pages?id=eq." + enc(id), patch), [id], "updated"));
  };
  SupabaseStore.prototype.deletePins = async function (ids) {
    if (!ids.length) return [];
    return writeCheck(await this.req("DELETE", "pins?id=" + inList(ids)), ids, "deleted");
  };
  SupabaseStore.prototype.deletePages = async function (ids) {
    if (!ids.length) return [];
    return writeCheck(await this.req("DELETE", "pages?id=" + inList(ids)), ids, "deleted");
  };

  /* ------------------------------------------------------------------ */
  /* Local demo backend (localStorage)                                   */
  /* ------------------------------------------------------------------ */
  var LOCAL_KEY = "postit.demo.v1";
  function LocalStore() { this.mode = "local"; this.db = this.load(); }

  LocalStore.prototype.seed = function () {
    var t = nowIso();
    var day = { id: "demo-day", board_date: todayStr(), title: "Demo day", created_at: t };
    return {
      days: [day],
      pins: [
        { id: "demo-pin-ai", day_id: day.id, title: "AI", color: "yellow", position: 0, created_at: t, updated_at: t },
        { id: "demo-pin-agents", day_id: day.id, title: "Agents", color: "pink", position: 1, created_at: t, updated_at: t },
      ],
      pages: [
        { id: "demo-page-1", pin_id: "demo-pin-ai", title: "What is AI", position: 0, created_at: t, updated_at: t,
          body: "Artificial Intelligence = computer programs that do things we usually think need human smarts.\n\nExamples:\n- recognizing pictures\n- translating languages\n- answering questions" },
        { id: "demo-page-2", pin_id: "demo-pin-ai", title: "LLMs", position: 1, created_at: t, updated_at: t,
          body: "LLM = Large Language Model.\n\nIt reads a LOT of text and learns to predict the next word. That simple trick lets it chat, summarize and write code." },
        { id: "demo-page-3", pin_id: "demo-pin-agents", title: "LLMs with loops", position: 0, created_at: t, updated_at: t,
          body: "An agent is an LLM in a loop:\n1. look at the goal\n2. pick a tool / action\n3. check the result\n4. repeat until done" },
      ],
    };
  };
  LocalStore.prototype.load = function () {
    try {
      var db = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
      if (db && db.days && db.pins && db.pages) return db;
    } catch (e) { /* fall through to seed */ }
    var fresh = this.seed();
    this.persist(fresh);
    return fresh;
  };
  LocalStore.prototype.persist = function (db) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(db || this.db)); } catch (e) { /* private mode */ }
  };
  LocalStore.prototype.reset = function () { this.db = this.seed(); this.persist(); };
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function done(v) { return Promise.resolve(clone(v)); }

  LocalStore.prototype.listDays = function () {
    return done(this.db.days.slice().sort(function (a, b) { return b.board_date.localeCompare(a.board_date); }));
  };
  LocalStore.prototype.listPins = function (dayId) {
    var pages = this.db.pages;
    return done(this.db.pins.filter(function (p) { return p.day_id === dayId; }).sort(byPos).map(function (p) {
      var c = Object.assign({}, p);
      c.page_count = pages.filter(function (pg) { return pg.pin_id === p.id; }).length;
      return c;
    }));
  };
  LocalStore.prototype.listPages = function (pinId) {
    return done(this.db.pages.filter(function (p) { return p.pin_id === pinId; }).sort(byPos));
  };
  LocalStore.prototype.createDay = function (d) {
    if (this.db.days.some(function (x) { return x.board_date === d.board_date; })) return Promise.reject(new Error("That day already exists."));
    var row = { id: uuid(), board_date: d.board_date, title: d.title || null, created_at: nowIso() };
    this.db.days.push(row); this.persist(); return done(row);
  };
  LocalStore.prototype.createPin = function (p) {
    var t = nowIso();
    var row = { id: uuid(), day_id: p.day_id, title: p.title, color: p.color || "yellow", position: p.position || 0, created_at: t, updated_at: t };
    this.db.pins.push(row); this.persist(); return done(row);
  };
  LocalStore.prototype.createPage = function (p) {
    var t = nowIso();
    var row = { id: uuid(), pin_id: p.pin_id, title: p.title || null, body: p.body || "", position: p.position || 0, created_at: t, updated_at: t };
    this.db.pages.push(row); this.persist(); return done(row);
  };
  LocalStore.prototype._update = function (table, id, patch) {
    var row = this.db[table].find(function (r) { return r.id === id; });
    if (!row) return Promise.reject(new Error("Not found"));
    Object.assign(row, patch, { updated_at: nowIso() }); this.persist(); return done(row);
  };
  LocalStore.prototype.updatePin = function (id, patch) { return this._update("pins", id, patch); };
  LocalStore.prototype.updatePage = function (id, patch) { return this._update("pages", id, patch); };
  LocalStore.prototype.deletePins = function (ids) {
    var set = new Set(ids);
    var removed = this.db.pins.filter(function (p) { return set.has(p.id); });
    this.db.pins = this.db.pins.filter(function (p) { return !set.has(p.id); });
    this.db.pages = this.db.pages.filter(function (pg) { return !set.has(pg.pin_id); }); // cascade
    this.persist(); return done(removed);
  };
  LocalStore.prototype.deletePages = function (ids) {
    var set = new Set(ids);
    var removed = this.db.pages.filter(function (p) { return set.has(p.id); });
    this.db.pages = this.db.pages.filter(function (p) { return !set.has(p.id); });
    this.persist(); return done(removed);
  };

  /* ------------------------------------------------------------------ */
  if (configured) {
    Auth.load();
    Auth._reported = Auth.isSignedIn();
    // Another tab signed in or out: follow it.
    window.addEventListener("storage", function (e) {
      if (e.key !== SESSION_KEY && e.key !== null) return;
      // Compare with what the UI was last told, not Auth.session: token() may already have loaded the change.
      Auth.load();
      if (Auth._reported === Auth.isSignedIn()) return;
      Auth._reported = Auth.isSignedIn();
      if (typeof Auth.onChange === "function") Auth.onChange();
    });
  }
  window.PostItStore = configured ? new SupabaseStore() : new LocalStore();
  window.PostItAuth = Auth;
  window.PostItUtil = { todayStr: todayStr };
})();
