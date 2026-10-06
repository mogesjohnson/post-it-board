/* Post-it Board — UI. Vanilla JS; all user text is inserted with textContent (no HTML injection). */
(function () {
  "use strict";

  var store = window.PostItStore;
  var Auth = window.PostItAuth;
  var COLORS = ["yellow", "pink", "blue", "green"];

  var state = {
    days: [],
    dayId: null,
    pins: [],
    pinId: null,      // opened pin (null = board view)
    pages: [],
    pageIdx: 0,
    selecting: false,
    selPins: new Set(),
    selPages: new Set(),
    freshIds: new Set(), // ids to animate as "just pinned"
    animateAll: true,    // drop-in animation for every note (first load / day change)
    focusNext: null,     // data-focus key to focus after the next render (view changes)
    ready: false,        // first load finished (until then start() owns rendering)
  };

  var $ = function (id) { return document.getElementById(id); };
  var view = $("view");

  /* ---------- helpers ---------- */
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function tack() { return el("span", { class: "tack", "aria-hidden": "true" }); }
  function hash(str) { var h = 0; for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h); }
  function tilt(id) { return ((hash(id) % 70) / 10 - 3.5).toFixed(1) + "deg"; } // -3.5..+3.5deg, stable per id
  function colorOf(pin) { return COLORS.indexOf(pin.color) >= 0 ? pin.color : COLORS[hash(pin.id) % COLORS.length]; }
  function fmtDate(s) {
    var p = String(s).split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    var narrow = window.matchMedia && window.matchMedia("(max-width: 640px)").matches; // phones: drop the weekday
    return d.toLocaleDateString(undefined, { weekday: narrow ? undefined : "short", month: "short", day: "numeric", year: "numeric" });
  }
  function canEdit() { return store.mode === "local" || Auth.isSignedIn(); }
  var toastTimer;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function fail(e) { console.error(e); toast(e && e.message ? e.message : String(e)); }
  function currentDay() { return state.days.find(function (d) { return d.id === state.dayId; }); }
  function currentPin() { return state.pins.find(function (p) { return p.id === state.pinId; }); }

  /* ---------- URL hash: #day=YYYY-MM-DD&pin=<id>&page=N ---------- */
  function readHash() {
    var q = new URLSearchParams(location.hash.replace(/^#/, ""));
    return { day: q.get("day"), pin: q.get("pin"), page: parseInt(q.get("page") || "1", 10) || 1 };
  }
  function writeHash() {
    var d = currentDay(), q = new URLSearchParams();
    if (d) q.set("day", d.board_date);
    if (state.pinId) { q.set("pin", state.pinId); q.set("page", String(state.pageIdx + 1)); }
    var h = "#" + q.toString();
    if (location.hash !== h) history.replaceState(null, "", h);
  }

  /* ---------- data loading ---------- */
  async function loadDays(preferDate) {
    state.days = await store.listDays();
    var pick = preferDate && state.days.find(function (d) { return d.board_date === preferDate; });
    var keep = state.days.find(function (d) { return d.id === state.dayId; });
    state.dayId = (pick || keep || state.days[0] || {}).id || null;
  }
  async function loadPins() {
    state.pins = state.dayId ? await store.listPins(state.dayId) : [];
  }
  // Every navigation bumps this, so a slow page load can't open a pin after the user has moved on.
  var navSeq = 0;
  // Selections only ever cover what the current view shows: pins on the board, pages in a pin.
  // The pages load first, so a failed load leaves the current view untouched.
  async function openPin(pinId, pageIdx, focusKey) {
    var seq = ++navSeq;
    var pages = await store.listPages(pinId);
    if (seq !== navSeq) return;
    state.pinId = pinId; state.pages = pages;
    state.pageIdx = Math.max(0, Math.min(pageIdx || 0, pages.length - 1));
    state.selPins.clear(); state.selPages.clear();
    if (focusKey) state.focusNext = focusKey;
    render();
  }
  function closePin() {
    navSeq++;
    if (state.pinId) state.focusNext = "note:" + state.pinId; // back to the note we came from
    state.animateAll = true;
    state.pinId = null; state.pages = []; state.pageIdx = 0; state.selPages.clear();
    render();
  }
  async function goDay(dayId) {
    navSeq++;
    state.dayId = dayId; state.pinId = null; state.pages = []; state.animateAll = true;
    state.selPins.clear(); state.selPages.clear();
    await loadPins();
    render();
  }

  /* ---------- rendering ---------- */
  function render() {
    // Re-rendering replaces the view, so remember which control had focus and restore it afterwards.
    var a = document.activeElement;
    var viewChange = !!state.focusNext; // opening or closing a pin: the focused control may be far down the page
    var focusKey = state.focusNext || (a && view.contains(a) ? a.getAttribute("data-focus") : null);
    state.focusNext = null;
    document.body.classList.toggle("can-edit", canEdit());
    if (!canEdit() && state.selecting) setSelecting(false);
    document.body.classList.toggle("selecting", state.selecting);
    renderHeader();
    view.textContent = "";
    view.appendChild(state.pinId ? renderPinView() : renderBoard());
    writeHash();
    restoreFocus(focusKey, viewChange);
  }
  // A pager button can become disabled at either end, so fall back to its partner, then "← All pins".
  // A selection checkbox is hidden when select mode ends, so fall back to its note or page chip.
  function focusCandidates(key) {
    if (key === "next") return ["next", "prev", "back"];
    if (key === "prev") return ["prev", "next", "back"];
    if (key.indexOf("pick-pin:") === 0) return [key, "note:" + key.slice(9)];
    if (key.indexOf("pick-page:") === 0) return [key, "chip:" + key.slice(10)];
    return [key];
  }
  function restoreFocus(key, scroll) {
    if (!key) return;
    var keys = focusCandidates(key);
    var nodes = view.querySelectorAll("[data-focus]");
    for (var k = 0; k < keys.length; k++) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.getAttribute("data-focus") !== keys[k] || n.disabled) continue;
        n.focus({ preventScroll: true });
        if (document.activeElement !== n) continue; // hidden (display:none) controls can't take focus
        if (scroll) n.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  }

  function renderHeader() {
    var sel = $("daySelect"); sel.textContent = "";
    if (!state.days.length) sel.appendChild(el("option", { text: "No days yet" }));
    state.days.forEach(function (d) {
      sel.appendChild(el("option", { value: d.id, text: fmtDate(d.board_date) + (d.title ? " — " + d.title : ""), selected: d.id === state.dayId }));
    });
    var i = state.days.findIndex(function (d) { return d.id === state.dayId; });
    $("olderBtn").disabled = i < 0 || i >= state.days.length - 1; // days are newest-first
    $("newerBtn").disabled = i <= 0;

    var n = state.selPins.size + state.selPages.size;
    $("selectBtn").setAttribute("aria-pressed", String(state.selecting));
    $("trashBtn").hidden = !state.selecting;
    $("trashCount").textContent = String(n);
    $("trashBtn").disabled = n === 0;
    $("addBtn").title = state.pinId ? "Add a page to this pin" : "Pin a new topic";

    var lock = $("lockBtn");
    lock.hidden = store.mode !== "supabase";
    lock.classList.toggle("signed-in", Auth.isSignedIn());
    lock.title = Auth.isSignedIn() ? "Signed in as " + Auth.email() + " — click to sign out" : "Owner sign in";
    $("lockShackle").setAttribute("d", Auth.isSignedIn() ? "M8 11V8a4 4 0 0 1 8 0v3" : "M8 11V8a4 4 0 0 1 7.5-2");
  }

  function emptyCard(title, text) {
    return el("div", { class: "empty" }, [tack(), el("h3", { text: title }), el("p", { text: text })]);
  }

  function renderBoard() {
    if (!state.days.length) return emptyCard("No days yet", canEdit() ? "Use “+ day” to start a new day." : "Check back soon!");
    if (!state.pins.length) return emptyCard("Nothing pinned yet", canEdit() ? "Use + to pin a topic." : "No topics for this day yet.");
    var list = el("ul", { class: "notes" });
    state.pins.forEach(function (pin, i) {
      var selected = state.selPins.has(pin.id);
      var fresh = state.freshIds.has(pin.id);
      var still = !fresh && !state.animateAll;
      var note = el("li", {
        class: "note paper-" + colorOf(pin) + (selected ? " selected" : "") + (still ? " still" : ""),
        tabindex: "0", role: "button", "data-focus": "note:" + pin.id,
        "aria-label": "Open pin " + pin.title,
        style: "--r:" + tilt(pin.id) + ";--delay:" + (fresh ? 0 : Math.min(i * 0.07, 0.6)) + "s",
        onclick: function (e) {
          if (e.target.classList.contains("pick")) return;
          if (state.selecting) toggleSel(state.selPins, pin.id);
          else openPin(pin.id, 0, "back").catch(fail);
        },
        onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } },
        onanimationend: function (e) { if (e.target === e.currentTarget) e.currentTarget.style.animation = "none"; },
      }, [
        tack(),
        el("input", { type: "checkbox", class: "pick", "aria-label": "Select pin " + pin.title, checked: selected,
          "data-focus": "pick-pin:" + pin.id, onchange: function () { toggleSel(state.selPins, pin.id); } }),
        el("h3", { text: pin.title }),
        el("div", { class: "meta", text: pin.page_count + (pin.page_count === 1 ? " page" : " pages") }),
      ]);
      list.appendChild(note);
    });
    state.freshIds.clear();
    state.animateAll = false;
    return list;
  }

  function renderPinView() {
    var pin = currentPin() || { id: state.pinId, title: "", color: "yellow" };
    var color = colorOf(pin);
    var wrap = el("section", { class: "pin-view paper-" + color });

    var head = el("div", { class: "pin-view-head" }, [
      el("button", { class: "chip-btn", text: "← All pins", "data-focus": "back", onclick: closePin }),
      el("h2", { text: pin.title }),
      el("span", { class: "spacer" }),
      canEdit() ? el("button", { class: "chip-btn", text: "✎ Rename pin", onclick: renamePin }) : null,
      canEdit() && state.pages.length ? el("button", { class: "chip-btn", text: "✎ Edit page", onclick: editPage }) : null,
    ]);
    wrap.appendChild(head);

    if (!state.pages.length) { wrap.appendChild(emptyCard("No pages", canEdit() ? "Use + to add a page." : "This pin is empty.")); return wrap; }

    var strip = el("ul", { class: "page-strip", "aria-label": "Pages" });
    state.pages.forEach(function (pg, i) {
      var selected = state.selPages.has(pg.id);
      strip.appendChild(el("li", {
        class: "page-chip" + (i === state.pageIdx ? " current" : "") + (selected ? " selected" : ""),
        role: "button", tabindex: "0", "data-focus": "chip:" + pg.id,
        onclick: function (e) {
          if (e.target.classList.contains("pick")) return;
          if (state.selecting) toggleSel(state.selPages, pg.id);
          else { state.pageIdx = i; render(); }
        },
        onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } },
      }, [
        el("input", { type: "checkbox", class: "pick", "aria-label": "Select page " + (i + 1), checked: selected,
          "data-focus": "pick-page:" + pg.id, onchange: function () { toggleSel(state.selPages, pg.id); } }),
        el("span", { text: (i + 1) + (pg.title ? " · " + pg.title : "") }),
      ]));
    });
    wrap.appendChild(strip);

    var page = state.pages[state.pageIdx];
    wrap.appendChild(el("article", { class: "page-paper" }, [
      tack(),
      el("span", { class: "page-no", text: "Page " + (state.pageIdx + 1) + " of " + state.pages.length }),
      page.title ? el("h3", { text: page.title }) : null,
      el("div", { class: "body", text: page.body || "" }),
    ]));

    wrap.appendChild(el("div", { class: "pager" }, [
      el("button", { class: "chip-btn", text: "‹ Prev page", disabled: state.pageIdx === 0, "data-focus": "prev",
        onclick: function () { state.pageIdx--; render(); } }),
      el("span", { class: "count", text: (state.pageIdx + 1) + " / " + state.pages.length }),
      el("button", { class: "chip-btn", text: "Next page ›", disabled: state.pageIdx >= state.pages.length - 1, "data-focus": "next",
        onclick: function () { state.pageIdx++; render(); } }),
    ]));
    return wrap;
  }

  /* ---------- selection + delete ---------- */
  function toggleSel(set, id) { if (set.has(id)) set.delete(id); else set.add(id); render(); }
  function setSelecting(on) {
    state.selecting = on;
    if (!on) { state.selPins.clear(); state.selPages.clear(); }
  }

  async function deleteSelected() {
    var np = state.selPins.size, ng = state.selPages.size;
    if (!np && !ng) return;
    var parts = [];
    if (np) parts.push(np + (np === 1 ? " pin (and all its pages)" : " pins (and all their pages)"));
    if (ng) parts.push(ng + (ng === 1 ? " page" : " pages"));
    if (!confirm("Permanently delete " + parts.join(" and ") + "?\n\nThis cannot be undone — there is no recycle bin.")) return;
    try {
      if (ng) await store.deletePages(Array.from(state.selPages));
      if (np) await store.deletePins(Array.from(state.selPins));
      state.selPins.clear(); state.selPages.clear();
      await loadPins();
      if (state.pinId) {
        state.pages = await store.listPages(state.pinId);
        state.pageIdx = Math.max(0, Math.min(state.pageIdx, state.pages.length - 1));
      }
      toast("Deleted.");
      render();
    } catch (e) { fail(e); }
  }

  /* ---------- modal form ---------- */
  // fields: [{name, label, type: text|textarea|date|email|password|color, value, required, hint}]
  function formDialog(title, fields, okLabel, onSubmit) {
    var dlg = $("modal"), box = $("modalFields"), err = $("modalError");
    $("modalTitle").textContent = title;
    $("modalOk").textContent = okLabel || "Save";
    box.textContent = ""; err.hidden = true;
    fields.forEach(function (f, i) {
      var id = "f_" + f.name;
      box.appendChild(el("label", { for: id, text: f.label }));
      var input;
      if (f.type === "textarea") input = el("textarea", { id: id, name: f.name, required: f.required });
      else if (f.type === "color") {
        input = el("select", { id: id, name: f.name });
        COLORS.forEach(function (c) { input.appendChild(el("option", { value: c, text: c, selected: c === f.value })); });
      } else input = el("input", { id: id, name: f.name, type: f.type || "text", required: f.required, autocomplete: f.autocomplete || "off" });
      if (f.value != null && f.type !== "color") input.value = f.value;
      box.appendChild(input);
      if (f.hint) box.appendChild(el("p", { class: "hint", text: f.hint }));
      if (i === 0) setTimeout(function () { input.focus(); }, 30);
    });
    var form = $("modalForm");
    form.onsubmit = async function (e) {
      if (e.submitter && e.submitter.value === "cancel") return; // let dialog close
      e.preventDefault();
      var data = {};
      fields.forEach(function (f) { data[f.name] = form.elements[f.name].value.trim(); });
      try { await onSubmit(data); dlg.close(); }
      catch (ex) { err.textContent = ex.message || String(ex); err.hidden = false; }
    };
    dlg.showModal();
  }

  function nextPos(list) { return list.reduce(function (m, x) { return Math.max(m, (x.position || 0) + 1); }, 0); }

  function addDay() {
    formDialog("Start a new day", [
      { name: "date", label: "Date", type: "date", value: window.PostItUtil.todayStr(), required: true },
      { name: "title", label: "Title (optional)" },
    ], "Add day", async function (d) {
      var day = await store.createDay({ board_date: d.date, title: d.title || null });
      await loadDays(day.board_date); await goDay(day.id);
    });
  }

  function addPin() {
    formDialog("Pin a new topic", [
      { name: "title", label: "Topic (shown on the pin)", required: true },
      { name: "color", label: "Paper color", type: "color", value: COLORS[state.pins.length % COLORS.length] },
      { name: "pageTitle", label: "First page title (optional)" },
      { name: "body", label: "First page text", type: "textarea" },
    ], "Pin it", async function (d) {
      if (!state.dayId) {
        var day = await store.createDay({ board_date: window.PostItUtil.todayStr(), title: null });
        await loadDays(day.board_date);
      }
      var pin = await store.createPin({ day_id: state.dayId, title: d.title, color: d.color, position: nextPos(state.pins) });
      if (d.pageTitle || d.body) await store.createPage({ pin_id: pin.id, title: d.pageTitle || null, body: d.body, position: 0 });
      state.freshIds.add(pin.id);
      await loadPins(); render();
    });
  }

  function addPage() {
    formDialog("Add a page", [
      { name: "title", label: "Page title (optional)" },
      { name: "body", label: "Text", type: "textarea", required: true },
    ], "Add page", async function (d) {
      await store.createPage({ pin_id: state.pinId, title: d.title || null, body: d.body, position: nextPos(state.pages) });
      state.pages = await store.listPages(state.pinId);
      state.pageIdx = state.pages.length - 1;
      await loadPins(); render();
    });
  }

  function editPage() {
    var pg = state.pages[state.pageIdx]; if (!pg) return;
    formDialog("Edit page " + (state.pageIdx + 1), [
      { name: "title", label: "Page title (optional)", value: pg.title || "" },
      { name: "body", label: "Text", type: "textarea", value: pg.body || "" },
    ], "Save", async function (d) {
      await store.updatePage(pg.id, { title: d.title || null, body: d.body });
      state.pages = await store.listPages(state.pinId); render();
    });
  }

  function renamePin() {
    var pin = currentPin(); if (!pin) return;
    formDialog("Rename pin", [
      { name: "title", label: "Topic", value: pin.title, required: true },
      { name: "color", label: "Paper color", type: "color", value: colorOf(pin) },
    ], "Save", async function (d) {
      await store.updatePin(pin.id, { title: d.title, color: d.color });
      await loadPins(); render();
    });
  }

  function lockClicked() {
    if (Auth.isSignedIn()) {
      if (!confirm("Sign out " + Auth.email() + "?")) return;
      Auth.signOut().then(function () { setSelecting(false); render(); toast("Signed out — read-only view."); });
      return;
    }
    formDialog("Owner sign in", [
      { name: "email", label: "Email", type: "email", required: true, autocomplete: "username" },
      { name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password",
        hint: "Only the board owner can add or delete notes. Everyone else sees a read-only board." },
    ], "Sign in", async function (d) {
      await Auth.signIn(d.email, d.password);
      render(); toast("Signed in as " + Auth.email());
    });
  }

  /* ---------- wire up ---------- */
  $("daySelect").addEventListener("change", function (e) { goDay(e.target.value).catch(fail); });
  $("olderBtn").addEventListener("click", function () {
    var i = state.days.findIndex(function (d) { return d.id === state.dayId; });
    if (i < state.days.length - 1) goDay(state.days[i + 1].id).catch(fail);
  });
  $("newerBtn").addEventListener("click", function () {
    var i = state.days.findIndex(function (d) { return d.id === state.dayId; });
    if (i > 0) goDay(state.days[i - 1].id).catch(fail);
  });
  $("addDayBtn").addEventListener("click", addDay);
  $("addBtn").addEventListener("click", function () { if (state.pinId) addPage(); else addPin(); });
  $("selectBtn").addEventListener("click", function () { setSelecting(!state.selecting); render(); });
  $("trashBtn").addEventListener("click", deleteSelected);
  $("lockBtn").addEventListener("click", lockClicked);
  document.addEventListener("keydown", function (e) {
    if (!state.pinId || $("modal").open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === "ArrowLeft" && state.pageIdx > 0) { state.pageIdx--; render(); }
    else if (e.key === "ArrowRight" && state.pageIdx < state.pages.length - 1) { state.pageIdx++; render(); }
    else if (e.key === "Escape") closePin();
  });

  // Follow manual hash edits / shared links (our own updates use replaceState, which doesn't fire this).
  window.addEventListener("hashchange", function () { route().catch(fail); });

  async function route() {
    var h = readHash();
    var day = h.day && state.days.find(function (d) { return d.board_date === h.day; });
    if (day && day.id !== state.dayId) { navSeq++; state.dayId = day.id; state.selPins.clear(); await loadPins(); }
    if (h.pin && state.pins.some(function (p) { return p.id === h.pin; })) await openPin(h.pin, h.page - 1);
    else { navSeq++; state.pinId = null; state.pages = []; state.selPages.clear(); render(); }
  }

  // The store drops a session the server no longer accepts; switch to the read-only view and say why.
  Auth.onExpired = function () {
    setSelecting(false);
    if (state.ready) render();
    else document.body.classList.toggle("can-edit", canEdit()); // first load still running; start() renders the board
    toast("Signed out — your session expired. The board is read-only.");
  };
  // Another tab signed in or out.
  Auth.onChange = function () {
    if (!state.ready) return;
    render();
    toast(Auth.isSignedIn() ? "Signed in as " + Auth.email() : "Signed out in another tab — read-only view.");
  };
  // Phones drop the weekday from the day picker (see fmtDate); relabel when the width crosses that line.
  if (window.matchMedia) {
    var narrowQuery = window.matchMedia("(max-width: 640px)");
    var relabel = function () { if (state.ready) renderHeader(); };
    if (narrowQuery.addEventListener) narrowQuery.addEventListener("change", relabel);
    else if (narrowQuery.addListener) narrowQuery.addListener(relabel);
  }

  async function start() {
    $("banner").hidden = store.mode !== "local";
    var h = readHash();
    try {
      await loadDays(h.day);
      await loadPins();
      if (h.pin && state.pins.some(function (p) { return p.id === h.pin; })) await openPin(h.pin, h.page - 1);
      else render();
    } catch (e) {
      render();
      view.textContent = "";
      view.appendChild(emptyCard("Couldn’t load the board", e.message || String(e)));
    }
    state.ready = true;
  }
  start();
})();
