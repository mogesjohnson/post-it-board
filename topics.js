/* Post-it Board — Topics view helpers (pure functions, no DOM; also loaded by the node tests).
 *
 * A topic is a pin; its page 1 (first page by position, then created_at) is the topic's living summary.
 * The Topics view lists every pin across all days, most recently updated first, where "updated" is the
 * latest updated_at/created_at of the pin itself or any of its pages (the database keeps updated_at
 * current with triggers, so an edited page 1 moves its topic to the top).
 */
(function (root) {
  "use strict";

  function ts(v) { var t = Date.parse(v || ""); return isNaN(t) ? 0 : t; }
  function byPos(a, b) {
    return (a.position || 0) - (b.position || 0) || String(a.created_at || "").localeCompare(String(b.created_at || ""));
  }
  // latest change of the pin or any of its pages, as an ISO string ("" if none known)
  function lastUpdated(pin) {
    var best = 0, iso = "";
    [pin].concat(pin.pages || []).forEach(function (r) {
      [r.updated_at, r.created_at].forEach(function (v) { var t = ts(v); if (t > best) { best = t; iso = v; } });
    });
    return iso;
  }
  // rows: [{id, title, color, created_at, updated_at, day: {board_date} | board_date, pages: [{title, body, position, ...}]}]
  // -> [{id, title, color, board_date, updated_at, summary, page_title, page_count}] newest first
  function fromRows(rows) {
    return (rows || []).map(function (p) {
      var pages = (p.pages || []).slice().sort(byPos);
      var first = pages[0] || null;
      return {
        id: p.id,
        title: p.title,
        color: p.color,
        board_date: (p.day && p.day.board_date) || p.board_date || "",
        updated_at: lastUpdated(p),
        summary: first ? String(first.body || "") : "",
        page_title: first ? first.title || "" : "",
        page_count: pages.length,
      };
    }).sort(compare);
  }
  // newest update first; ties: newer day first, then title, then id (stable across reloads)
  function compare(a, b) {
    return ts(b.updated_at) - ts(a.updated_at) ||
      String(b.board_date).localeCompare(String(a.board_date)) ||
      String(a.title).localeCompare(String(b.title)) ||
      String(a.id).localeCompare(String(b.id));
  }

  var api = { fromRows: fromRows, lastUpdated: lastUpdated, compare: compare };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PostItTopics = api;
})(typeof window !== "undefined" ? window : this);
