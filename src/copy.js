/* Zábava pro děti – tlačítka „Kopírovat“ u telefonu a e-mailu v části Kontakt.
 *
 * Progresivní vylepšení: tlačítka jsou v HTML skrytá (atribut hidden) a tento
 * skript je odkryje jen tehdy, když prohlížeč umí kopírovat do schránky
 * (navigator.clipboard.writeText v zabezpečeném kontextu). Bez JavaScriptu
 * zůstává číslo i e-mail na stránce jako čitelný text, který jde označit.
 *
 * Kopíruje se hodnota z atributu data-copy. Potvrzení „Zkopírováno“ se ukáže
 * na tlačítku a ohlásí čtečkám obrazovky přes oblast role="status"
 * (aria-live). Načítá se s defer (po sestavení stránky).
 *
 * Bezpečnost (CSP script-src 'self'): samostatný soubor, žádné eval,
 * innerHTML ani document.write – jen textContent a removeAttribute. */
(function () {
  'use strict';

  var DONE = 'Zkopírováno';
  var FAILED = 'Kopírování se nepodařilo. Označte prosím text a zkopírujte ho ručně.';
  var RESET_MS = 2500;

  function canCopy() {
    try {
      return !!(window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function');
    } catch (e) {
      return false;
    }
  }

  function setup(button, status) {
    var label = button.querySelector('.copy-label');
    var original = label ? label.textContent : '';
    var timer = null;

    function show(text, statusText) {
      if (label) label.textContent = text;
      if (status) status.textContent = statusText;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        if (label) label.textContent = original;
        if (status) status.textContent = '';
        timer = null;
      }, RESET_MS);
    }

    button.addEventListener('click', function () {
      var value = button.getAttribute('data-copy') || '';
      if (!value) return;
      var done;
      try {
        done = navigator.clipboard.writeText(value);
      } catch (e) {
        done = null;
      }
      if (!done || typeof done.then !== 'function') {
        show(original, FAILED);
        return;
      }
      done.then(function () {
        show(DONE, DONE + ': ' + value);
      }, function () {
        show(original, FAILED);
      });
    });
    button.removeAttribute('hidden');
  }

  function init() {
    if (!canCopy()) return;
    var status = document.querySelector('.copy-status');
    var buttons = document.querySelectorAll('.copy-btn');
    for (var i = 0; i < buttons.length; i++) setup(buttons[i], status);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
