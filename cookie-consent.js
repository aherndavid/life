/* Life - Student Edition — cookie consent + analytics loader
   dPaul Software (CitiIT Limited)

   Two separate choices are held here, because they are set at different moments
   and for different reasons:

     analytics — Google Analytics. Not loaded at all until the visitor accepts.
     youtube   — the background music player. YouTube sets its own cookies the
                 moment the iframe loads, so the app asks at the point someone
                 presses play rather than burying it in a banner nobody reads.

   Re-open the banner anywhere with:  dpaulCookies.open()
   Ask about the player with:         dpaulCookies.youtubeAllowed()
*/
(function () {
  'use strict';

  var GA_ID   = 'G-70HG5SM804';          // life-student.uk property
  var KEY     = 'dpaul_student_consent';
  var VERSION = 1;                       // bump this to re-ask everyone
  var POLICY  = 'privacy-policy.html';   // relative on purpose: works on the
                                         // custom domain and on github.io/student/

  /* ---------- stored choice ---------- */

  function readChoice() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj && obj.v === VERSION) return obj;
    } catch (e) {}
    return null;
  }

  function saveChoice(patch) {
    var cur = readChoice() || {};
    var next = {
      v: VERSION,
      analytics: 'analytics' in patch ? !!patch.analytics : !!cur.analytics,
      youtube:   'youtube'   in patch ? !!patch.youtube   : !!cur.youtube,
      ts: new Date().toISOString()
    };
    try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) {}
    return next;
  }

  /* ---------- analytics ---------- */

  var gaLoaded = false;

  function loadAnalytics() {
    if (gaLoaded) return;
    gaLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, { anonymize_ip: true });
  }

  function clearAnalyticsCookies() {
    var host = location.hostname;
    var domains = ['', '; domain=' + host, '; domain=.' + host];
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (name.indexOf('_ga') === 0 || name === '_gid' || name === '_gat') {
        domains.forEach(function (d) {
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d;
        });
      }
    });
  }

  /* ---------- youtube ---------- */

  function youtubeAllowed() {
    var c = readChoice();
    return !!(c && c.youtube);
  }
  function allowYouTube()  { saveChoice({ youtube: true  }); }
  function revokeYouTube() { saveChoice({ youtube: false }); }

  /* ---------- banner ---------- */

  var el = null;

  function css() {
    if (document.getElementById('dpaul-consent-css')) return;
    var st = document.createElement('style');
    st.id = 'dpaul-consent-css';
    /* Uses the app's own theme variables where they exist, with plain fallbacks
       so the banner still looks right on the sign-in screen and on the policy
       pages, which don't load the app's stylesheet. */
    st.textContent = [
      '#dpaul-consent{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;',
      'background:var(--panel,#f9f9f9);border-top:1px solid var(--line,#ccc);',
      'box-shadow:0 -10px 30px rgba(0,0,0,0.18);',
      'font-family:inherit;color:var(--fg,#333);',
      'padding:16px clamp(14px,4vw,40px);',
      'padding-bottom:calc(16px + env(safe-area-inset-bottom));box-sizing:border-box;}',
      '#dpaul-consent .dpc-inner{max-width:1100px;margin:0 auto;display:flex;',
      'align-items:center;gap:18px;flex-wrap:wrap;}',
      '#dpaul-consent .dpc-text{flex:1 1 320px;min-width:240px;font-size:0.95rem;',
      'line-height:1.6;color:var(--fg-soft,#555);margin:0;}',
      '#dpaul-consent .dpc-text a{color:var(--link,#0056b3);text-underline-offset:2px;}',
      '#dpaul-consent .dpc-actions{display:flex;gap:10px;flex-wrap:wrap;}',
      '#dpaul-consent button{font-family:inherit;font-size:1rem;padding:11px 22px;',
      'border-radius:5px;cursor:pointer;border:1px solid var(--line,#ccc);',
      'background:var(--panel-2,#e9ecef);color:var(--fg,#333);}',
      '#dpaul-consent button:hover{background:var(--panel-3,#dfe3e7);}',
      '#dpaul-consent button.dpc-accept{background:var(--accent,#007bff);',
      'border-color:var(--accent,#007bff);color:var(--on-accent,#fff);font-weight:bold;}',
      '#dpaul-consent button.dpc-accept:hover{background:var(--accent-hi,#0056b3);',
      'border-color:var(--accent-hi,#0056b3);}',
      '#dpaul-consent button:focus-visible{outline:2px solid var(--fg,#333);outline-offset:2px;}',
      '@media (max-width:600px){#dpaul-consent .dpc-actions{width:100%;}',
      '#dpaul-consent .dpc-actions button{flex:1 1 auto;}}'
    ].join('');
    document.head.appendChild(st);
  }

  function close() {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
  }

  function accept() { saveChoice({ analytics: true  }); loadAnalytics();        close(); }
  function reject() { saveChoice({ analytics: false }); clearAnalyticsCookies(); close(); }

  function open() {
    if (el) return;
    css();
    el = document.createElement('div');
    el.id = 'dpaul-consent';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cookie choices');
    el.innerHTML =
      '<div class="dpc-inner">' +
        '<p class="dpc-text">Can we count visits? It tells us which parts of the app get used, ' +
        'so time goes on the parts that matter. Nothing you put in the app is ever included, ' +
        'and saying no changes nothing else. ' +
        '<a href="' + POLICY + '">Read the privacy notice</a>.</p>' +
        '<div class="dpc-actions">' +
          '<button type="button" class="dpc-reject">No thanks</button>' +
          '<button type="button" class="dpc-accept">Yes, count visits</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelector('.dpc-accept').addEventListener('click', accept);
    el.querySelector('.dpc-reject').addEventListener('click', reject);
  }

  /* ---------- boot ---------- */

  // On a first visit the welcome screen is already up. Two things asking for
  // attention at once is one too many, so the banner waits its turn.
  function whenWelcomeClosed(fn) {
    var w = document.getElementById('welcome');
    if (!w || !w.classList.contains('open')) { fn(); return; }
    var obs = new MutationObserver(function () {
      if (!w.classList.contains('open')) { obs.disconnect(); fn(); }
    });
    obs.observe(w, { attributes: true, attributeFilter: ['class'] });
  }

  function start() {
    var choice = readChoice();
    if (choice === null) { whenWelcomeClosed(open); return; }
    if (choice.analytics) loadAnalytics();
  }

  window.dpaulCookies = {
    open: open,
    accept: accept,
    reject: reject,
    choice: readChoice,
    youtubeAllowed: youtubeAllowed,
    allowYouTube: allowYouTube,
    revokeYouTube: revokeYouTube
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
