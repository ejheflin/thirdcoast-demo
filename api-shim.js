/* api-shim.js — routes /api/ requests to the in-browser server.
 *
 * WHY THIS EXISTS. The board and controller pages talk to the Go server
 * over fetch(). In the hosted demo (prototype/demo.html) there is no
 * server and no network: the same Go code is compiled to WebAssembly and
 * running in the top window. This shim makes fetch("/api/board") reach it.
 *
 * THE ONE RULE THAT MATTERS: this file must be COMPLETELY INERT anywhere
 * but the demo. control2.html is the real controller an operator opens at
 * a real tournament, off the real server, and it is never allowed to
 * behave differently because this script tag is in it. So the shim
 * activates only when it finds a live bridge in the top window, which
 * only demo.html ever installs. Loaded from the Go server -- top window
 * is the page itself, no bridge -- install() returns immediately and
 * window.fetch is left exactly as the browser supplied it. Same outcome
 * if the page is opened standalone from the filesystem.
 *
 * NESTING. demo.html frames board.html, which frames the screen pages
 * (playoff.html, bracket-split.html, bracket-final.html,
 * announce-call.html). That is two levels, so the bridge is addressed as
 * window.top rather than window.parent.
 */
(function () {
  "use strict";

  /* Reaching across frames is same-origin only. On GitHub Pages every
     frame IS same origin, but a cross-origin top window throws on property
     access rather than returning undefined, so the probe is wrapped. A
     throw here means "not the demo", which is the safe answer. */
  function bridge() {
    try {
      if (window.top === window) return null;   // not framed: never the demo
      return window.top.tcAPIBridge || null;
    } catch (_) {
      return null;                              // cross-origin top: not the demo
    }
  }

  var host = bridge();
  if (!host) return;                            // venue path: change nothing

  var seq = 0;
  var pending = new Map();

  window.addEventListener("message", function (ev) {
    /* Same-origin only, and only our own reply shape. */
    if (ev.source !== window.top) return;
    var d = ev.data;
    if (!d || d.tcReply !== true) return;
    var resolve = pending.get(d.id);
    if (!resolve) return;
    pending.delete(d.id);
    resolve(d);
  });

  var nativeFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = (typeof input === "string") ? input
            : (input && input.url) ? input.url
            : String(input);

    /* Only the API is intercepted. Everything else -- fixture JSON under
       data/, fonts, the screen pages themselves -- is a real static file
       on the host and must go to the real network. */
    var path = url;
    if (/^https?:\/\//i.test(path)) {
      try { path = new URL(path).pathname; } catch (_) { /* leave as-is */ }
    }
    if (path.indexOf("/api/") !== 0) return nativeFetch(input, init);

    init = init || {};
    var method = (init.method || (input && input.method) || "GET").toUpperCase();
    var body = init.body;
    if (body != null && typeof body !== "string") {
      /* Nothing in these pages sends anything but a JSON string today;
         be explicit rather than silently posting "[object Object]". */
      try { body = JSON.stringify(body); } catch (_) { body = String(body); }
    }

    var id = ++seq;
    return new Promise(function (resolve) {
      pending.set(id, function (reply) {
        resolve(new Response(reply.body, {
          status: reply.status,
          headers: { "Content-Type": "application/json" },
        }));
      });
      window.top.postMessage(
        { tcRequest: true, id: id, method: method, path: path, body: body || "" },
        window.location.origin
      );
    });
  };
})();
