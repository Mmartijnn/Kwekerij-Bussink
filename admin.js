/* ==========================================================================
   KWEKERIJ BUSSINK – beheerpagina (admin.html)

   Werking in het kort:
   - De site staat op GitHub Pages (geen server). Deze pagina schrijft
     wijzigingen rechtstreeks naar de GitHub-repository via de GitHub API.
   - "Inloggen" = wachtwoord invullen. Daarmee wordt in de browser het
     (versleutelde) GitHub-token uit admin-config.json ontsleuteld.
   - Alles wat bewerkbaar is, wordt automatisch uit de HTML-pagina's gelezen
     (elementen met data-key / data-list). Wijzigingen komen in content.json,
     nieuwe foto's in images/uploads/. Alles gaat in één commit.
   ========================================================================== */
(function () {
    'use strict';

    var PAGES = [
        { file: 'index.html', title: 'Home' },
        { file: 'winkel.html', title: 'Winkel' },
        { file: 'kwekersadvies.html', title: 'Kwekersadvies' },
        { file: 'acties.html', title: 'Acties' },
        { file: 'overons.html', title: 'Over ons' },
        { file: 'contact.html', title: 'Contact' }
    ];
    var CONFIG_FILE = 'admin-config.json';
    var CONTENT_FILE = 'content.json';
    var SESSION_KEY = 'kb_beheer_sessie';
    var MAX_IMAGE = 1800;       // langste zijde van geüploade foto's (pixels)
    var PBKDF2_ROUNDS = 600000;

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    var clone = function (x) { return JSON.parse(JSON.stringify(x)); };

    /* kleine helper om elementen te maken (gebruikt nooit innerHTML) */
    function h(tag, attrs) {
        var el = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            var v = attrs[k];
            if (v == null || v === false) return;
            if (k === 'class') el.className = v;
            else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
            else if (k === 'value') el.value = v;
            else el.setAttribute(k, v === true ? '' : v);
        });
        for (var i = 2; i < arguments.length; i++) {
            [].concat(arguments[i]).forEach(function (c) {
                if (c == null || c === false) return;
                el.append(c.nodeType ? c : document.createTextNode(c));
            });
        }
        return el;
    }

    /* ---------------------------------------------------------------- */
    /* Versleuteling van het token (wachtwoord -> AES-GCM)              */
    /* ---------------------------------------------------------------- */
    var b64 = {
        enc: function (buf) {
            var s = '', a = new Uint8Array(buf);
            for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
            return btoa(s);
        },
        dec: function (str) { return Uint8Array.from(atob(str), function (c) { return c.charCodeAt(0); }); }
    };

    function deriveKey(password, salt) {
        return crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
            .then(function (km) {
                return crypto.subtle.deriveKey(
                    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
                    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            });
    }

    function encryptToken(token, password) {
        var salt = crypto.getRandomValues(new Uint8Array(16));
        var iv = crypto.getRandomValues(new Uint8Array(12));
        return deriveKey(password, salt).then(function (key) {
            return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(token));
        }).then(function (data) {
            return { salt: b64.enc(salt), iv: b64.enc(iv), data: b64.enc(data) };
        });
    }

    function decryptToken(cfg, password) {
        return deriveKey(password, b64.dec(cfg.salt)).then(function (key) {
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(cfg.iv) }, key, b64.dec(cfg.data));
        }).then(function (buf) { return new TextDecoder().decode(buf); });
    }

    /* ---------------------------------------------------------------- */
    /* GitHub API                                                       */
    /* ---------------------------------------------------------------- */
    var gh = {
        repo: '', branch: 'main', token: '',

        api: function (path, opts) {
            opts = opts || {};
            var self = this;
            var headers = {
                'Accept': 'application/vnd.github+json',
                'Authorization': 'Bearer ' + self.token,
                'X-GitHub-Api-Version': '2022-11-28'
            };
            if (opts.body) headers['Content-Type'] = 'application/json';
            return fetch('https://api.github.com/repos/' + self.repo + path, {
                method: opts.method || 'GET', headers: headers, body: opts.body, cache: 'no-store'
            }).catch(function () {
                throw new Error('Geen verbinding met GitHub. Controleer uw internet en probeer het opnieuw.');
            }).then(function (r) {
                if (r.ok) return r.status === 204 ? null : r.json();
                return r.json().catch(function () { return {}; }).then(function (j) {
                    var msg = {
                        401: 'Het GitHub-token is ongeldig of verlopen. Vraag de beheerder om het token te vernieuwen.',
                        403: 'Geen toestemming (of te veel verzoeken). Probeer het over een paar minuten opnieuw.',
                        404: 'Repository of branch niet gevonden, of het token heeft geen toegang tot deze repository.',
                        409: 'Er is intussen iets anders gewijzigd. Herlaad de pagina en probeer het opnieuw.',
                        422: 'GitHub kon de wijziging niet verwerken. Herlaad de pagina en probeer het opnieuw.'
                    }[r.status] || ('GitHub-fout: ' + (j.message || r.status));
                    var e = new Error(msg);
                    e.status = r.status;
                    throw e;
                });
            });
        },

        readJson: function (path) {
            var self = this;
            return self.api('/contents/' + path + '?ref=' + encodeURIComponent(self.branch)).then(function (f) {
                return JSON.parse(new TextDecoder().decode(b64.dec(f.content.replace(/\n/g, ''))));
            }).catch(function (e) {
                if (e.status === 404) return null;
                throw e;
            });
        },

        /* Schrijf meerdere bestanden in één commit.
           files: [{ path, text } | { path, base64 }] */
        commit: function (files, message) {
            var self = this, baseSha, baseTree;
            var post = function (p, body) { return self.api(p, { method: 'POST', body: JSON.stringify(body) }); };
            return self.api('/git/ref/heads/' + self.branch).then(function (ref) {
                baseSha = ref.object.sha;
                return self.api('/git/commits/' + baseSha);
            }).then(function (c) {
                baseTree = c.tree.sha;
                return Promise.all(files.map(function (f) {
                    return post('/git/blobs', f.base64
                        ? { content: f.base64, encoding: 'base64' }
                        : { content: f.text, encoding: 'utf-8' });
                }));
            }).then(function (blobs) {
                return post('/git/trees', {
                    base_tree: baseTree,
                    tree: files.map(function (f, i) { return { path: f.path, mode: '100644', type: 'blob', sha: blobs[i].sha }; })
                });
            }).then(function (tree) {
                return post('/git/commits', { message: message, tree: tree.sha, parents: [baseSha] });
            }).then(function (commit) {
                return self.api('/git/refs/heads/' + self.branch, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
            });
        }
    };

    /* ---------------------------------------------------------------- */
    /* Status                                                           */
    /* ---------------------------------------------------------------- */
    var S = {
        pages: [],            // [{ title, blocks: [...] }]
        current: 0,
        content: { fields: {}, lists: {} },
        saved: '',            // JSON van laatst opgeslagen inhoud
        images: {},           // pad -> { base64, url, uploaded }
        cfg: null
    };

    function cleanContent() {
        return { fields: S.content.fields, lists: S.content.lists };
    }
    function isDirty() { return JSON.stringify(cleanContent()) !== S.saved; }

    function touch() {
        var dirty = isDirty();
        $('#btn-save').disabled = !dirty;
        $('#save-status').textContent = dirty ? 'U heeft wijzigingen die nog niet zijn opgeslagen' : 'Geen wijzigingen';
        document.querySelector('.savebar').classList.toggle('dirty', dirty);
    }
    window.addEventListener('beforeunload', function (e) {
        if (S.pages.length && isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });

    function toast(msg, isError) {
        var t = h('div', { class: 'toast' + (isError ? ' error' : ''), role: 'status' }, msg);
        document.body.append(t);
        setTimeout(function () { t.remove(); }, isError ? 9000 : 6000);
    }

    function show(name) {
        ['login', 'setup', 'editor'].forEach(function (n) { $('#screen-' + n).hidden = n !== name; });
        $('#loading').hidden = true;
    }

    /* ---------------------------------------------------------------- */
    /* Pagina's inlezen: welke teksten/foto's zijn er te bewerken?      */
    /* ---------------------------------------------------------------- */
    var norm = function (s) { return s.replace(/\s+/g, ' ').trim(); };
    function typeOf(el) { return el.dataset.type || (el.tagName === 'IMG' ? 'image' : 'text'); }
    function readValue(el) {
        var t = typeOf(el);
        if (t === 'image') return el.getAttribute('src') || '';
        if (t === 'paragraphs') {
            var ps = [].slice.call(el.querySelectorAll('p'));
            if (ps.length) return ps.map(function (p) { return norm(p.textContent); }).join('\n\n');
        }
        return norm(el.textContent);
    }
    function groupOf(el) {
        var s = el.closest('[data-section]');
        return s ? s.dataset.section : 'Titel en grote foto';
    }

    function parsePage(p) {
        return fetch(p.file + '?v=' + Date.now(), { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('lokaal niet beschikbaar');
            return r.text();
        }).catch(function () {
            // Bijv. bij openen via file:// : lees de pagina dan rechtstreeks uit de repository
            return gh.api('/contents/' + p.file + '?ref=' + encodeURIComponent(gh.branch)).then(function (f) {
                return new TextDecoder().decode(b64.dec(f.content.replace(/\n/g, '')));
            });
        }).then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var blocks = [];
            doc.querySelectorAll('[data-key],[data-list]').forEach(function (el) {
                if (el.dataset.list) {
                    var items = [].slice.call(el.children).filter(function (c) { return c.hasAttribute('data-item'); });
                    if (!items.length) return;
                    var defs = [].slice.call(items[0].querySelectorAll('[data-field]')).map(function (f) {
                        return { name: f.dataset.field, label: f.dataset.label || f.dataset.field, type: typeOf(f) };
                    });
                    blocks.push({
                        kind: 'list', name: el.dataset.list, label: el.dataset.label || el.dataset.list,
                        itemLabel: el.dataset.itemLabel || 'Item', group: groupOf(el), defs: defs,
                        def: items.map(function (it) {
                            var o = {};
                            defs.forEach(function (d) {
                                var f = it.querySelector('[data-field="' + d.name + '"]');
                                o[d.name] = f ? readValue(f) : '';
                            });
                            return o;
                        })
                    });
                } else if (!el.closest('[data-list]')) {
                    blocks.push({
                        kind: 'field', key: el.dataset.key, label: el.dataset.label || el.dataset.key,
                        type: typeOf(el), group: groupOf(el), def: readValue(el)
                    });
                }
            });
            return { title: p.title, blocks: blocks };
        });
    }

    /* ---------------------------------------------------------------- */
    /* Foto's                                                           */
    /* ---------------------------------------------------------------- */
    function preview(path) { return S.images[path] ? S.images[path].url : path; }

    function toBitmap(file) {
        return createImageBitmap(file, { imageOrientation: 'from-image' })
            .catch(function () { return createImageBitmap(file); });
    }

    function processImage(file) {
        return toBitmap(file).then(function (bmp) {
            var k = Math.min(1, MAX_IMAGE / Math.max(bmp.width, bmp.height));
            var w = Math.round(bmp.width * k), hgt = Math.round(bmp.height * k);
            var cv = document.createElement('canvas');
            cv.width = w; cv.height = hgt;
            var ctx = cv.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, w, hgt);
            ctx.drawImage(bmp, 0, 0, w, hgt);
            return new Promise(function (res) { cv.toBlob(res, 'image/jpeg', 0.82); });
        }).then(function (blob) {
            return new Promise(function (res, rej) {
                var fr = new FileReader();
                fr.onload = function () { res({ blob: blob, base64: String(fr.result).split(',')[1] }); };
                fr.onerror = rej;
                fr.readAsDataURL(blob);
            });
        }).then(function (r) {
            var base = (file.name.replace(/\.[^.]+$/, '') || 'foto').toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'foto';
            var path = 'images/uploads/' + base + '-' + Date.now().toString(36) + '.jpg';
            S.images[path] = { base64: r.base64, url: URL.createObjectURL(r.blob), uploaded: false };
            return path;
        });
    }

    /* ---------------------------------------------------------------- */
    /* Invoervelden                                                     */
    /* ---------------------------------------------------------------- */
    var uid = 0;

    function widget(type, value, onChange) {
        var id = 'f' + (++uid);
        if (type === 'image') return photoWidget(value, onChange);
        if (type === 'paragraphs') {
            var rows = Math.min(16, Math.max(4, Math.ceil(value.length / 70) + (value.match(/\n/g) || []).length));
            return h('textarea', { id: id, rows: rows, value: value, oninput: function (e) { onChange(e.target.value); } });
        }
        return h('input', { id: id, type: 'text', value: value, oninput: function (e) { onChange(e.target.value); } });
    }

    function photoWidget(value, onChange) {
        var thumb = value ? h('img', { class: 'thumb', src: preview(value), alt: '' }) : h('div', { class: 'thumb empty' }, 'Geen foto');
        var note = h('span', { class: 'photo-note' }, 'JPG of PNG. De foto wordt automatisch verkleind.');
        var file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: function (e) {
            var f = e.target.files[0];
            if (!f) return;
            note.textContent = 'Foto wordt verwerkt…';
            processImage(f).then(function (path) {
                var img = h('img', { class: 'thumb', src: preview(path), alt: '' });
                thumb.replaceWith(img); thumb = img;
                note.textContent = 'Nieuwe foto gekozen. Klik onderaan op Opslaan en publiceren.';
                onChange(path);
            }).catch(function () {
                note.textContent = 'Deze foto kon niet worden gelezen. Kies een JPG of PNG.';
            });
            e.target.value = '';
        } });
        return h('div', { class: 'photo' }, thumb,
            h('div', { class: 'photo-actions' },
                h('button', { class: 'btn ghost', type: 'button', onclick: function () { file.click(); } }, value ? 'Andere foto kiezen' : 'Foto kiezen'),
                note, file));
    }

    function fieldUI(b) {
        var wrap = h('div', { class: 'field' });
        var cur = function () { return has(S.content.fields, b.key) ? S.content.fields[b.key] : b.def; };
        var sync = function () { wrap.classList.toggle('changed', has(S.content.fields, b.key)); };
        var reset = h('button', { class: 'link reset', type: 'button', onclick: function () {
            delete S.content.fields[b.key]; touch(); renderPanel();
        } }, 'Origineel terugzetten');
        var label = h('label', {}, h('span', {}, b.label), reset);
        wrap.append(label, widget(b.type, cur(), function (v) {
            if (v === b.def) delete S.content.fields[b.key]; else S.content.fields[b.key] = v;
            sync(); touch();
        }));
        sync();
        return wrap;
    }

    function listUI(b) {
        var box = h('div', { class: 'field' });
        var items = function () { return S.content.lists[b.name] || b.def; };
        var edit = function (fn) {
            var arr = S.content.lists[b.name] || clone(b.def);
            fn(arr);
            if (JSON.stringify(arr) === JSON.stringify(b.def)) delete S.content.lists[b.name];
            else S.content.lists[b.name] = arr;
            touch();
        };

        if (b.label !== b.group) box.append(h('h3', { style: 'font-size:1rem' }, b.label));

        items().forEach(function (item, i) {
            var firstText = b.defs.filter(function (d) { return d.type !== 'image'; })[0];
            var sub = firstText && item[firstText.name] ? ' – ' + String(item[firstText.name]).slice(0, 40) : '';
            var n = items().length;
            var card = h('div', { class: 'item' },
                h('div', { class: 'item-head' },
                    h('strong', {}, b.itemLabel + ' ' + (i + 1) + sub),
                    h('button', { class: 'icon', type: 'button', title: 'Omhoog', 'aria-label': 'Omhoog', disabled: i === 0, onclick: function () {
                        edit(function (a) { var t = a[i]; a[i] = a[i - 1]; a[i - 1] = t; }); renderPanel();
                    } }, '↑'),
                    h('button', { class: 'icon', type: 'button', title: 'Omlaag', 'aria-label': 'Omlaag', disabled: i === n - 1, onclick: function () {
                        edit(function (a) { var t = a[i]; a[i] = a[i + 1]; a[i + 1] = t; }); renderPanel();
                    } }, '↓'),
                    h('button', { class: 'link danger', type: 'button', onclick: function () {
                        if (confirm('Weet u zeker dat u dit onderdeel wilt verwijderen?')) {
                            edit(function (a) { a.splice(i, 1); }); renderPanel();
                        }
                    } }, 'Verwijderen')));
            b.defs.forEach(function (d) {
                card.append(h('div', { class: 'field' }, h('label', {}, d.label),
                    widget(d.type, item[d.name] || '', function (v) { edit(function (a) { a[i][d.name] = v; }); })));
            });
            box.append(card);
        });

        var actions = h('div', { class: 'list-actions' },
            h('button', { class: 'btn ghost', type: 'button', onclick: function () {
                edit(function (a) { var o = {}; b.defs.forEach(function (d) { o[d.name] = ''; }); a.push(o); });
                renderPanel();
            } }, '+ ' + b.itemLabel + ' toevoegen'));
        if (has(S.content.lists, b.name)) {
            actions.append(h('button', { class: 'link', type: 'button', onclick: function () {
                if (confirm('Alle wijzigingen aan deze lijst ongedaan maken?')) { delete S.content.lists[b.name]; touch(); renderPanel(); }
            } }, 'Lijst terugzetten naar origineel'));
        }
        box.append(actions);
        return box;
    }

    /* ---------------------------------------------------------------- */
    /* Scherm opbouwen                                                  */
    /* ---------------------------------------------------------------- */
    function renderTabs() {
        var nav = $('#tabs');
        nav.replaceChildren();
        S.pages.forEach(function (p, i) {
            nav.append(h('button', { class: 'tab', type: 'button', 'aria-selected': String(i === S.current), onclick: function () {
                S.current = i; renderTabs(); renderPanel(); window.scrollTo(0, 0);
            } }, p.title));
        });
    }

    function renderPanel() {
        var panel = $('#panel');
        panel.replaceChildren();
        var page = S.pages[S.current];
        var lastGroup = null, card = null;
        page.blocks.forEach(function (b) {
            if (b.group !== lastGroup) {
                card = h('section', { class: 'card' }, h('h2', {}, b.group));
                panel.append(card);
                lastGroup = b.group;
            }
            card.append(b.kind === 'list' ? listUI(b) : fieldUI(b));
        });
        if (!page.blocks.length) panel.append(h('p', { class: 'hint' }, 'Op deze pagina is niets te bewerken.'));
    }

    function startEditor() {
        $('#loading').hidden = false;
        return Promise.all([
            gh.readJson(CONTENT_FILE),
            Promise.all(PAGES.map(parsePage))
        ]).then(function (res) {
            var c = res[0] || {};
            S.content = { fields: c.fields || {}, lists: c.lists || {} };
            S.pages = res[1];
            S.saved = JSON.stringify(cleanContent());
            renderTabs(); renderPanel(); touch();
            show('editor');
        });
    }

    function save() {
        var btn = $('#btn-save');
        btn.disabled = true;
        $('#save-status').textContent = 'Bezig met opslaan…';
        var clean = cleanContent();
        var used = JSON.stringify(clean);
        var files = [{ path: CONTENT_FILE, text: JSON.stringify(clean, null, 2) + '\n' }];
        Object.keys(S.images).forEach(function (p) {
            if (!S.images[p].uploaded && used.indexOf(p) !== -1) files.push({ path: p, base64: S.images[p].base64 });
        });
        return gh.commit(files, 'Website bijgewerkt via beheerpagina').then(function () {
            files.forEach(function (f) { if (S.images[f.path]) S.images[f.path].uploaded = true; });
            S.saved = used;
            toast('Opgeslagen! Het kan 1 à 2 minuten duren voordat de wijziging op de website staat.');
        }).catch(function (e) {
            toast(e.message, true);
        }).then(touch);
    }

    /* ---------------------------------------------------------------- */
    /* Inloggen en instellen                                            */
    /* ---------------------------------------------------------------- */
    function friendly(err, fallback) {
        var m = (err && err.message) || '';
        if (/failed to fetch|networkerror|load failed/i.test(m)) {
            return 'Er kon geen verbinding worden gemaakt. Open de beheerpagina via de website zelf (https://…/admin.html) en niet als bestand op uw computer.';
        }
        return m || fallback;
    }

    function showError(id, msg) { var e = $(id); e.textContent = msg; e.hidden = !msg; }

    function startSession(info) {
        gh.repo = info.repo; gh.branch = info.branch; gh.token = info.token;
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(info));
        return startEditor();
    }

    function detectRepo() {
        var m = location.hostname.match(/^(.+)\.github\.io$/);
        if (!m) return '';
        var first = location.pathname.split('/').filter(Boolean)[0];
        return m[1] + '/' + (first && !/\.html$/.test(first) ? first : m[1] + '.github.io');
    }

    function onLogin(e) {
        e.preventDefault();
        showError('#login-error', '');
        var btn = e.target.querySelector('button');
        btn.disabled = true; btn.textContent = 'Even geduld…';
        decryptToken(S.cfg, $('#login-password').value).then(function (token) {
            return startSession({ repo: S.cfg.repo, branch: S.cfg.branch, token: token });
        }).catch(function (err) {
            // OperationError = verkeerd wachtwoord; andere fouten komen van GitHub
            if (err && err.name === 'OperationError') showError('#login-error', 'Dit wachtwoord klopt niet.');
            else { showError('#login-error', friendly(err, 'Inloggen is mislukt.')); sessionStorage.removeItem(SESSION_KEY); }
            show('login');
        }).then(function () { btn.disabled = false; btn.textContent = 'Inloggen'; });
    }

    function onSetup(e) {
        e.preventDefault();
        showError('#setup-error', '');
        var repo = $('#setup-repo').value.trim(), branch = $('#setup-branch').value.trim();
        var token = $('#setup-token').value.trim(), pw = $('#setup-pw').value;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return showError('#setup-error', 'Vul de repository in als gebruikersnaam/repo.');
        if (pw.length < 12) return showError('#setup-error', 'Kies een wachtwoord van minimaal 12 tekens.');
        if (pw !== $('#setup-pw2').value) return showError('#setup-error', 'De twee wachtwoorden zijn niet gelijk.');

        var btn = e.target.querySelector('button');
        btn.disabled = true; btn.textContent = 'Bezig…';
        gh.repo = repo; gh.branch = branch; gh.token = token;
        gh.api('').then(function (info) {
            if (info.permissions && info.permissions.push === false) throw new Error('Dit token mag niet schrijven naar de repository. Geef het "Contents: Read and write".');
            return gh.api('/git/ref/heads/' + branch);
        }).then(function () {
            return encryptToken(token, pw);
        }).then(function (enc) {
            var cfg = { repo: repo, branch: branch, salt: enc.salt, iv: enc.iv, data: enc.data };
            return gh.commit([{ path: CONFIG_FILE, text: JSON.stringify(cfg, null, 2) + '\n' }], 'Beheer ingesteld');
        }).then(function () {
            toast('Ingesteld. Geef het wachtwoord aan de klant. Na 1 à 2 minuten werkt inloggen op de live website.');
            return startSession({ repo: repo, branch: branch, token: token });
        }).catch(function (err) {
            showError('#setup-error', friendly(err, 'Instellen is mislukt.'));
        }).then(function () { btn.disabled = false; btn.textContent = 'Opslaan'; });
    }

    function init() {
        if (!window.crypto || !crypto.subtle) {
            $('#loading').textContent = 'Deze pagina werkt alleen via https:// (of http://localhost).';
            return;
        }
        $('#form-login').addEventListener('submit', onLogin);
        $('#form-setup').addEventListener('submit', onSetup);
        $('#to-setup').addEventListener('click', function (e) { e.preventDefault(); show('setup'); });
        $('#to-login').addEventListener('click', function (e) {
            e.preventDefault();
            if (S.cfg && S.cfg.data) show('login'); else toast('Er is nog geen beheer ingesteld.', true);
        });
        $('#btn-save').addEventListener('click', save);
        $('#btn-logout').addEventListener('click', function () {
            if (isDirty() && !confirm('U heeft niet-opgeslagen wijzigingen. Toch uitloggen?')) return;
            S.pages = [];
            sessionStorage.removeItem(SESSION_KEY);
            location.reload();
        });
        $('#setup-repo').value = detectRepo();
        if (location.protocol === 'file:') {
            var warn = 'Let op: u opent deze pagina als bestand op uw computer. Dat werkt niet goed. Zet de site eerst online (GitHub Pages) en open https://…/admin.html, of test lokaal met "python -m http.server" en ga naar http://localhost:8000/admin.html.';
            ['#form-login', '#form-setup'].forEach(function (id) { $(id).prepend(h('p', { class: 'error' }, warn)); });
        }

        fetch(CONFIG_FILE + '?v=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (cfg) {
                S.cfg = cfg && cfg.data ? cfg : null;
                var saved = null;
                try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { /* negeren */ }
                if (saved && saved.token) {
                    return startSession(saved).catch(function (err) {
                        sessionStorage.removeItem(SESSION_KEY);
                        show(S.cfg ? 'login' : 'setup');
                        showError(S.cfg ? '#login-error' : '#setup-error', friendly(err, 'Sessie verlopen.'));
                    });
                }
                show(S.cfg ? 'login' : 'setup');
            });
    }

    init();
})();
