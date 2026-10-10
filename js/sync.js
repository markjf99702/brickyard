// Sync through Google Drive: the catalog (sets, bookcases and loose pieces) in one file, "Brickyard catalog.json", in a
// Brickyard folder in the person's own Drive, the same way the other junkdrawer.works apps do it. Each device
// keeps working from its own copy; a sync reads the file, merges it with this device's catalog set by set
// (newest change wins, removals included) and writes it back if this device had anything new.
// With the drive.file scope Brickyard sees only the files it made. Only at Brickyard's own address: Google
// refuses the sign-in anywhere else, so the Drive controls stay hidden there (and in the claude.ai copy).
(function () {
  'use strict';
  var C = window.BrickCore, app = window.brickyard;
  var ORIGINS = ['https://brickyard.junkdrawer.works'];
  var CLIENT_ID = '897653851078-p5jrh2bto6h3bj0lc4jist3k1vsc1pj4.apps.googleusercontent.com'; // not a secret
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var LSD = 'brickyard.drive', LSG = 'junkdrawer.google';
  var API = 'https://www.googleapis.com/drive/v3/files', UP = 'https://www.googleapis.com/upload/drive/v3/files';
  var here = ORIGINS.indexOf(location.origin) >= 0 && !app.FRAMED;
  function $(id) { return document.getElementById(id); }

  function fresh() { return { on: false, fileId: '', version: '', token: '', exp: 0, last: 0, err: '', pending: false }; }
  var D = fresh();
  try { Object.assign(D, JSON.parse(localStorage.getItem(LSD) || '{}')); } catch (e) { /* starts off */ }
  function saveD() { try { localStorage.setItem(LSD, JSON.stringify(D)); } catch (e) { /* nothing to do */ } }

  // ---------- sign-in, shared with every junkdrawer.works app at this address ----------
  function readShared() { try { return JSON.parse(localStorage.getItem(LSG) || 'null'); } catch (e) { return null; } }
  function useShared() {
    var g = readShared();
    if (!g || !g.token || !(g.exp - 60000 > Date.now()) || String(g.scope || '').indexOf(SCOPE) < 0) return false;
    D.token = g.token; D.exp = g.exp - 60000; return true;
  }
  function shareToken() {
    var g = readShared();
    try { localStorage.setItem(LSG, JSON.stringify({ token: D.token, exp: D.exp + 60000, scope: SCOPE, email: g && g.email || '' })); } catch (e) { /* nothing to do */ }
  }
  function dropShared(token) { var g = readShared(); if (g && g.token === token) try { localStorage.removeItem(LSG); } catch (e) { /* nothing to do */ } }
  function hasToken() { if (!(D.token && Date.now() < D.exp) && D.on) useShared(); return !!D.token && Date.now() < D.exp; }

  var tokenClient = null, gisLoading = false;
  function loadGis() {
    if (!here || tokenClient || gisLoading) return;
    if (window.google && google.accounts && google.accounts.oauth2) { initToken(); return; }
    gisLoading = true;
    var s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = function () { gisLoading = false; initToken(); };
    s.onerror = function () { gisLoading = false; D.err = 'Couldn’t load Google sign-in. Check your connection.'; render(); };
    document.head.appendChild(s);
  }
  function initToken() {
    try {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE,
        callback: function (r) {
          if (!r || r.error || !r.access_token) { D.err = 'Google didn’t allow access' + (r && r.error ? ' (' + r.error + ')' : '') + '.'; saveD(); render(); return; }
          if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
            D.err = 'Brickyard needs permission to keep its own file in your Drive. Try again and leave that box ticked.'; saveD(); render(); return;
          }
          D.token = r.access_token; D.exp = Date.now() + (Math.max(+r.expires_in || 3600, 120) - 60) * 1000; D.on = true; D.err = '';
          saveD(); shareToken(); sync(); rememberEmail();
        },
        error_callback: function (e) {
          if (e && e.type !== 'popup_closed') { D.err = 'Google sign-in didn’t open. If your browser blocks pop-ups, allow them for this page.'; saveD(); }
          render();
        },
      });
    } catch (e) { D.err = 'Google sign-in couldn’t start: ' + e.message; }
    render();
  }
  // Runs inside a tap: Google's sign-in is a pop-up. Not needed at all within the hour after signing in here.
  function askToken() {
    if (useShared()) { D.on = true; D.err = ''; saveD(); sync(); render(); return; }
    if (!tokenClient) { loadGis(); app.toast('Google sign-in is still loading. Try again in a moment.'); return; }
    var g = readShared(), hint = g && g.email;
    tokenClient.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: 'select_account' });
  }
  // The account's email, so signing in again skips Google's account chooser.
  function rememberEmail() {
    api('GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)').then(function (r) { return r.json(); }).then(function (j) {
      var g = readShared(), email = j && j.user && j.user.emailAddress;
      if (g && email) { g.email = email; try { localStorage.setItem(LSG, JSON.stringify(g)); } catch (e) { /* nothing to do */ } }
    }).catch(function () { /* only a convenience */ });
  }

  // ---------- Drive ----------
  function api(method, url, body, type) {
    var h = { Authorization: 'Bearer ' + D.token }; if (type) h['Content-Type'] = type;
    return fetch(url, { method: method, headers: h, body: body }).then(function (r) {
      if (r.status === 401) { var e = new Error('auth'); e.auth = true; throw e; }
      if (r.status === 404) { var n = new Error('gone'); n.gone = true; throw n; }
      if (!r.ok) return r.text().then(function (t) { var m = /"message":\s*"([^"]+)"/.exec(t); throw new Error('Drive said: ' + (m ? m[1] : r.status)); });
      return r;
    });
  }
  function q(s) { return encodeURIComponent(s); }
  function find(kind) {
    return api('GET', API + '?spaces=drive&orderBy=createdTime&fields=files(id,version)&q=' + q("appProperties has { key='brickyard' and value='" + kind + "' } and trashed = false"))
      .then(function (r) { return r.json(); }).then(function (j) { return j.files || []; });
  }
  function body(doc) { return JSON.stringify({ brickyard: 1, catalog: doc }); }
  function read(id) {
    return api('GET', API + '/' + id + '?alt=media').then(function (r) { return r.text(); }).then(function (t) {
      var o; try { o = JSON.parse(t); } catch (e) { o = null; }
      if (!o || !o.catalog) throw new Error('The catalog file in your Drive isn’t readable, so Brickyard left it alone.');
      return C.cleanDoc(o);
    });
  }
  function version(id) { return api('GET', API + '/' + id + '?fields=version,trashed').then(function (r) { return r.json(); }); }
  function write(id, doc) {
    return api('PATCH', UP + '/' + id + '?uploadType=media&fields=id,version', body(doc), 'application/json')
      .then(function (r) { return r.json(); }).then(function (j) { return String(j.version || ''); });
  }
  function create(meta, text) {
    var bd = 'brickyard' + Date.now().toString(36);
    var payload = '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + bd +
      '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + bd + '--';
    return api('POST', UP + '?uploadType=multipart&fields=id,version', payload, 'multipart/related; boundary=' + bd).then(function (r) { return r.json(); });
  }
  function take(doc) { app.takeDoc(doc); }

  // The catalog file's id and version, making it (and its folder) the first time. If two devices each made
  // one, their catalogs are merged here and the extra goes to the Drive trash.
  function ensureFile() {
    var known = D.fileId ? version(D.fileId).then(function (f) { return f.trashed ? null : { id: D.fileId, version: String(f.version) }; }, function (e) { if (e.gone) return null; throw e; }) : Promise.resolve(null);
    return known.then(function (f) {
      if (f) return f;
      D.version = '';
      return find('catalog').then(function (fs) {
        if (fs.length) {
          return fs.slice(1).reduce(function (p, x) {
            return p.then(function () { return read(x.id); }).then(function (d) {
              take(C.mergeDocs(app.doc(), d)); D.pending = true;
              return api('PATCH', API + '/' + x.id, JSON.stringify({ trashed: true }), 'application/json');
            });
          }, Promise.resolve()).then(function () { D.fileId = fs[0].id; return { id: fs[0].id, version: String(fs[0].version) }; });
        }
        return find('folder').then(function (fo) {
          return fo.length ? fo[0].id : api('POST', API + '?fields=id', JSON.stringify({ name: 'Brickyard', mimeType: 'application/vnd.google-apps.folder', appProperties: { brickyard: 'folder' } }), 'application/json')
            .then(function (r) { return r.json(); }).then(function (x) { return x.id; });
        }).then(function (folder) {
          return create({ name: 'Brickyard catalog.json', mimeType: 'application/json', parents: [folder], appProperties: { brickyard: 'catalog' } }, body(app.doc()));
        }).then(function (x) { D.fileId = x.id; D.version = String(x.version); D.pending = false; return { id: x.id, version: D.version, made: true }; });
      });
    });
  }

  var syncing = false, again = false, timer = null, edits = 0;
  function sync() {
    if (!here || !D.on) return Promise.resolve();
    if (syncing) { again = true; return Promise.resolve(); }
    if (!hasToken()) { render(); return Promise.resolve(); }
    syncing = true; clearTimeout(timer); var seq = edits, wrote = false; render();
    function round(tries) {
      return ensureFile().then(function (f) {
        if (f.made || (f.version === D.version && !D.pending)) return;
        var got = f.version === D.version ? Promise.resolve(null) : read(f.id);
        return got.then(function (remote) {
          var merged = remote ? C.mergeDocs(app.doc(), remote) : app.doc();
          if (remote && !C.sameDoc(merged, app.doc())) take(merged);
          if (remote && C.sameDoc(merged, remote)) { D.version = f.version; return; }
          // Someone else may have written since we read: check, and if so merge their copy in first.
          return version(f.id).then(function (now) {
            if (String(now.version) !== f.version && tries < 3) { D.version = ''; return round(tries + 1); }
            return write(f.id, merged).then(function (v) { D.version = v; wrote = true; });
          });
        });
      });
    }
    return round(0).then(function () {
      if (edits === seq) D.pending = false;
      D.last = Date.now(); D.err = ''; saveD(); syncing = false; render();
      if (again || D.pending) { again = false; soon(); }
      // Drive can't refuse a write that crosses another device's, so look again shortly after writing: if the
      // file moved on, the next round merges this device's changes back in.
      else if (wrote) { clearTimeout(timer); timer = setTimeout(sync, 5000); }
    }, function (e) {
      syncing = false; again = false;
      if (e.auth) { dropShared(D.token); D.token = ''; D.exp = 0; } else D.err = e.message || 'Sync didn’t work';
      saveD(); render();
    });
  }
  function soon() { if (!D.on || !hasToken()) { render(); return; } clearTimeout(timer); timer = setTimeout(sync, 2000); }

  // ---------- on the page ----------
  function state() {
    if (!D.on) return 'off';
    if (syncing) return 'busy';
    if (!hasToken()) return 'tap';
    if (D.err) return 'err';
    return 'ok';
  }
  var WORDS = { busy: 'Syncing', tap: 'Sync', err: 'Sync failed', ok: 'Synced' };
  function render() {
    var s = state();
    document.querySelectorAll('.sync-btn').forEach(function (b) {
      b.hidden = !here || s === 'off'; b.dataset.s = s;
      b.querySelector('span').textContent = s === 'ok' && D.pending ? 'Saving' : WORDS[s] || '';
      b.title = s === 'tap' ? 'Google signs Brickyard out after an hour. Tap to sync again.' : s === 'err' ? D.err : 'Synced with Google Drive';
    });
    if ($('sync-offer')) $('sync-offer').hidden = !here || D.on;
    if ($('drive-sheet')) sheetBody();
  }
  function ago(t) {
    var m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(t).toLocaleDateString();
  }
  function sheet() {
    loadGis();
    var panel = app.openSheet('<div class="hd"><h2 id="sheetTitle">Sync with Google Drive</h2><button class="btn sm quiet" type="button" data-close>Close</button></div><div class="bd" id="drive-sheet"></div>');
    panel.querySelector('[data-close]').onclick = app.closeSheet;
    sheetBody();
  }
  function sheetBody() {
    var el = $('drive-sheet'), html;
    if (!D.on) {
      html = '<p class="lede">Keep your catalog and bookcases in your own Google Drive, the same on every device where you turn this on.</p>' +
        '<p class="note">Brickyard can only see files it makes itself: one folder, <b>Brickyard</b>, with your catalog in it. Your models from Claude stay on each device. <a href="https://junkdrawer.works/privacy.html">Privacy</a></p>' +
        (D.err ? '<p class="flag bad"><span>' + app.esc(D.err) + '</span></p>' : '') +
        '<button class="btn" type="button" id="dv-go">Connect Google Drive</button>';
    } else {
      html = '<p class="lede">' + (syncing ? 'Syncing now…' : !hasToken() ? 'Google signs Brickyard out after an hour. Tap <b>Sync now</b> to sign in again; your changes are safe here meanwhile.' : D.last ? 'Last synced ' + ago(D.last) + '.' : 'Connected.') + '</p>' +
        (D.err ? '<p class="flag bad"><span>' + app.esc(D.err) + '</span></p>' : '') +
        '<p class="note">Your catalog is in <b>My Drive › Brickyard › Brickyard catalog.json</b>. Drive keeps earlier versions of it for 30 days. To take back Brickyard’s access, remove junkdrawer.works under Third-party apps &amp; services in your Google Account.</p>' +
        '<div class="acts-row"><button class="btn" type="button" id="dv-sync">Sync now</button><button class="btn quiet" type="button" id="dv-off">Stop syncing on this device</button></div>';
    }
    el.innerHTML = html;
    if ($('dv-go')) $('dv-go').onclick = askToken;
    if ($('dv-sync')) $('dv-sync').onclick = function () { if (hasToken()) { D.err = ''; sync(); } else askToken(); };
    if ($('dv-off')) $('dv-off').onclick = function () {
      // Never revoke: that would sign every junkdrawer.works app out of Google, not just this one.
      D = fresh(); saveD(); render(); app.closeSheet();
      app.toast('Stopped syncing on this device. Your catalog is still here and in Drive.');
    };
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.sync-btn, #sync-offer');
    if (!b) return;
    if (b.classList.contains('sync-btn') && state() === 'tap') askToken();
    else if (b.classList.contains('sync-btn') && state() === 'err') { D.err = ''; sync(); }
    else sheet();
  });
  document.addEventListener('brickyard:saved', function () { edits++; if (D.on) { D.pending = true; saveD(); soon(); render(); } });
  window.addEventListener('storage', function (e) {
    if (e.key === LSG) render();
    if (e.key === LSD) { try { D = Object.assign(fresh(), JSON.parse(e.newValue || '{}')); } catch (x) { /* keep ours */ } render(); }
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && D.on && hasToken()) sync(); render(); });
  setInterval(function () { if (document.visibilityState === 'visible' && D.on && hasToken() && !syncing) sync(); else render(); }, 60000);

  window.BrickyardSync = { here: here, sheet: sheet };
  render();
  if (here && D.on) { loadGis(); if (hasToken()) sync(); }
})();
