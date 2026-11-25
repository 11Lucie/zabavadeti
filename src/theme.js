/* Zábava pro děti – přepínač vzhledu (světlý / tmavý / podle systému).
 *
 * Pořadí přepínání se řídí systémem, aby první klepnutí vždy viditelně
 * změnilo vzhled: podle systému → opačný motiv, než má systém → motiv
 * systému (ručně) → zpět podle systému. Při světlém systému tedy
 * auto → tmavý → světlý → auto, při tmavém auto → světlý → tmavý → auto.
 *
 * Načítá se v <head> hned za CSS bez defer, aby nastavil data-theme na <html>
 * ještě před vykreslením stránky (žádné probliknutí). Volba se ukládá do
 * localStorage pod klíčem "zabavadeti-vzhled" ("light" | "dark"); režim
 * "podle systému" = klíč smazaný. Když úložiště nejde použít (soukromé okno,
 * zakázané cookies), web prostě funguje podle nastavení systému.
 *
 * Bezpečnost (CSP script-src 'self'): samostatný soubor, žádné eval,
 * innerHTML ani document.write – jen setAttribute/removeAttribute. */
(function () {
  'use strict';

  var KEY = 'zabavadeti-vzhled';
  var NAME = { light: 'světlý', dark: 'tmavý' };
  var TARGET = { auto: 'automatický podle systému', light: 'světlý', dark: 'tmavý' };

  var root = document.documentElement;
  var media = null;
  try {
    media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  } catch (e) {
    media = null;
  }

  // Barva lišty prohlížeče: dvě značky <meta name="theme-color" media="…">.
  // Při ruční volbě dostanou obě barvu zvoleného motivu, v automatice původní.
  var metaLight = document.querySelector('meta[name="theme-color"][media*="light"]');
  var metaDark = document.querySelector('meta[name="theme-color"][media*="dark"]');
  var colorLight = metaLight ? metaLight.getAttribute('content') : null;
  var colorDark = metaDark ? metaDark.getAttribute('content') : null;

  function readChoice() {
    var value = null;
    try {
      value = window.localStorage.getItem(KEY);
    } catch (e) {
      value = null;
    }
    return value === 'light' || value === 'dark' ? value : 'auto';
  }

  function saveChoice(mode) {
    try {
      if (mode === 'auto') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, mode);
    } catch (e) {
      // Úložiště není k dispozici – volba platí jen do zavření stránky.
    }
  }

  function systemTheme() {
    return media && media.matches ? 'dark' : 'light';
  }

  // Další režim po klepnutí (viz pořadí v úvodním komentáři).
  function next(mode) {
    var system = systemTheme();
    var other = system === 'dark' ? 'light' : 'dark';
    if (mode === 'auto') return other;
    if (mode === other) return system;
    return 'auto';
  }

  function setThemeColor(mode) {
    var forced = mode === 'light' ? colorLight : mode === 'dark' ? colorDark : null;
    if (metaLight && colorLight) metaLight.setAttribute('content', forced || colorLight);
    if (metaDark && colorDark) metaDark.setAttribute('content', forced || colorDark);
  }

  var current = readChoice();
  var buttons = [];

  function label(mode) {
    var now = mode === 'auto'
      ? 'podle systému (teď ' + NAME[systemTheme()] + ')'
      : NAME[mode];
    return 'Vzhled: ' + now + '. Přepnout na ' + TARGET[next(mode)] + '.';
  }

  function updateButtons() {
    var text = label(current);
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('data-mode', current);
      buttons[i].setAttribute('aria-label', text);
      buttons[i].setAttribute('title', text);
    }
  }

  function apply(mode) {
    current = mode;
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    setThemeColor(mode);
    updateButtons();
  }

  // Hned při načtení – ještě před vykreslením <body>.
  apply(current);

  // Změna nastavení systému: v automatice přepíše CSS barvy samo,
  // tady stačí aktualizovat popisek tlačítka (i při ruční volbě – pořadí
  // přepínání závisí na systému).
  if (media) {
    var onSystemChange = function () {
      updateButtons();
    };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  // Volba změněná v jiné záložce téhož webu.
  window.addEventListener('storage', function (event) {
    if (event.key === KEY || event.key === null) apply(readChoice());
  });

  // Návrat na stránku tlačítkem Zpět/Vpřed z mezipaměti prohlížeče (bfcache):
  // skript se znovu nespustí a událost storage mezitím nedorazila, proto
  // volbu načíst znovu.
  window.addEventListener('pageshow', function (event) {
    if (event && event.persisted) apply(readChoice());
  });

  function init() {
    var found = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < found.length; i++) {
      var button = found[i];
      buttons.push(button);
      button.addEventListener('click', function () {
        var mode = next(current);
        saveChoice(mode);
        apply(mode);
      });
      button.removeAttribute('hidden');
    }
    updateButtons();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
