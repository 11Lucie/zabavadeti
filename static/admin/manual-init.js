// Administraci (Decap CMS) spouští až pojistka zveřejnění (publish-guard.js) voláním CMS.init(),
// když má zaregistrované všechny kontroly. Tento soubor se proto načítá PŘED decap-cms.js a
// říká Decapu, ať se nespouští sám. Když se pojistka nenačte, administrace se nespustí vůbec.
window.CMS_MANUAL_INIT = true;
