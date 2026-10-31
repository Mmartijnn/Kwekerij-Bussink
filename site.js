/* ==========================================================================
   KWEKERIJ BUSSINK – site.js
   1. Zet teksten/foto's uit content.json (de beheerpagina) over de standaard-
      inhoud van de HTML heen.
   2. Menu op mobiel, schuifbalk met foto's, contactformulier.

   Hoe werkt het koppelen?
   - Element met  data-key="home.titel"      -> één tekst of foto
   - Element met  data-list="acties"         -> een lijst die je kunt uitbreiden
       met kinderen  data-item  en daarin  data-field="titel"
   - data-type="paragraphs" = meerdere alinea's (lege regel = nieuwe alinea)
   - Staat er niets in content.json, dan blijft de tekst uit de HTML staan.
   ========================================================================== */
(function () {
    'use strict';

    /* ---- 1. Inhoud uit content.json ---- */
    function setValue(el, type, value) {
        value = value == null ? '' : String(value);

        if (el.tagName === 'IMG') {
            if (value) { el.src = value; el.hidden = false; }
            else { el.removeAttribute('src'); el.hidden = true; }
            return;
        }
        if (type === 'paragraphs') {
            el.textContent = '';
            value.split(/\n\s*\n/).filter(function (t) { return t.trim(); }).forEach(function (t) {
                var p = document.createElement('p');
                p.textContent = t.trim();
                el.appendChild(p);
            });
            return;
        }
        el.textContent = value;
    }

    function applyContent(content) {
        var fields = content.fields || {};
        var lists = content.lists || {};

        document.querySelectorAll('[data-key]').forEach(function (el) {
            var key = el.dataset.key;
            if (Object.prototype.hasOwnProperty.call(fields, key)) {
                setValue(el, el.dataset.type, fields[key]);
            }
        });

        document.querySelectorAll('[data-list]').forEach(function (box) {
            var items = lists[box.dataset.list];
            if (!Array.isArray(items)) return;
            var first = box.querySelector(':scope > [data-item]');
            if (!first) return;
            var proto = first.cloneNode(true);
            box.querySelectorAll(':scope > [data-item]').forEach(function (n) { n.remove(); });

            items.forEach(function (item) {
                var node = proto.cloneNode(true);
                node.querySelectorAll('[data-field]').forEach(function (el) {
                    setValue(el, el.dataset.type, item[el.dataset.field]);
                    if (el.tagName === 'IMG' && item.titel) el.alt = item.titel;
                });
                box.appendChild(node);
            });
        });
    }

    function loadContent() {
        return fetch('content.json', { cache: 'no-cache' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; });
    }

    /* ---- 2. Interactie ---- */
    function initMenu() {
        var header = document.querySelector('.site-header');
        var btn = document.querySelector('.nav-toggle');
        if (!header || !btn) return;
        btn.addEventListener('click', function () {
            var open = header.classList.toggle('is-open');
            btn.setAttribute('aria-expanded', open);
        });
    }

    function initSliders() {
        document.querySelectorAll('.slider').forEach(function (slider) {
            var track = slider.querySelector('.slider-track');
            var step = function (dir) {
                var slide = track.querySelector('.slide');
                if (slide) track.scrollBy({ left: dir * slide.offsetWidth, behavior: 'smooth' });
            };
            slider.querySelector('.slider-arrow.left').addEventListener('click', function () { step(-1); });
            slider.querySelector('.slider-arrow.right').addEventListener('click', function () { step(1); });
        });
    }

    function initContactForm() {
        var form = document.querySelector('.contact-form');
        if (!form) return;
        // FormSubmit heeft een volledig webadres nodig om terug te keren
        var next = form.querySelector('input[name="_next"]');
        if (next) next.value = location.origin + location.pathname + '?verzonden=1';
        if (new URLSearchParams(location.search).get('verzonden') === '1') {
            var msg = document.getElementById('form-message');
            if (msg) msg.hidden = false;
        }
    }

    function initYear() {
        document.querySelectorAll('[data-year]').forEach(function (el) {
            el.textContent = new Date().getFullYear();
        });
    }

    initMenu();
    initYear();
    initContactForm();
    loadContent().then(function (content) {
        applyContent(content);
        initSliders();   // pas na het opbouwen van de lijsten
    });
})();
