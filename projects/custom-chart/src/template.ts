const MARK = `<svg class="mark" viewBox="0 0 40 40" aria-hidden="true"><g stroke="none">
  <rect width="40" height="40" rx="10" fill="#e3132c"/><rect x="13" width="14" height="40" fill="#0d0f14"/>
  <g stroke="#fff" stroke-width="2.7" stroke-linecap="butt"><path d="M16.6 6.1l6.8 6.8M23.4 6.1l-6.8 6.8"/><path d="M16.6 16.6l6.8 6.8M23.4 16.6l-6.8 6.8"/><path d="M16.6 27.1l6.8 6.8M23.4 27.1l-6.8 6.8"/></g></g></svg>`;

const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>';

export const CREDIT = 'Buildings: <a href="https://3dbag.nl" target="_blank" rel="noopener">3DBAG</a> (3DGI, TU Delft). Topography: TOP10NL © Kadaster. Both CC BY 4.0.';

export const TEMPLATE = `
<canvas class="gl" aria-label="3D map of Amsterdam with data shown as pillars"></canvas>
<div class="labels"></div>

<aside class="side" aria-label="Search and ranking">
  <button class="handle" type="button" aria-label="Expand or collapse the panel"></button>
  <header class="brand">${MARK}<div><h1 class="ttl-h"></h1><p class="ttl-p"></p></div></header>
  <div class="search">${SEARCH_ICON}<input class="q" type="search" placeholder="Search the map" autocomplete="off" aria-label="Search the map"><kbd>/</kbd></div>
  <ul class="results" role="listbox" aria-label="Search results"></ul>
  <section class="rankpanel">
    <div class="chips legend-in" aria-label="Legend"></div>
    <div class="listhead"><span class="rank-label"></span><span class="rank-count"></span></div>
    <ol class="rank-list"></ol>
  </section>
  <footer class="foot"><span class="src"></span> ${CREDIT}</footer>
</aside>

<div class="float-legend"></div>
<aside class="card" hidden aria-live="polite"></aside>

<div class="ctrl">
  <div class="grp"><button class="b-zin" type="button" aria-label="Zoom in"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button><button class="b-zout" type="button" aria-label="Zoom out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button></div>
  <div class="grp">
    <button class="b-compass" type="button" aria-label="Reset to north"><svg class="needle" viewBox="0 0 16 22" aria-hidden="true" style="stroke:none"><path d="M8 1l4 10H4z" fill="var(--accent)"/><path d="M8 21L4 11h8z" fill="var(--muted)"/></svg></button>
    <button class="b-tilt" type="button" aria-label="Switch to top-down view">2D</button>
    <button class="b-home" type="button" aria-label="Back to the start view"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
    <button class="b-layers" type="button" aria-label="Map layers" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg></button>
  </div>
  <div class="grp search-btn"><button class="b-search" type="button" aria-label="Search and ranking">${SEARCH_ICON}</button></div>
</div>

<div class="layers" hidden>
  <h3>Layers</h3>
  <label>Pillars<input type="checkbox" data-l="pillars" checked></label>
  <label>Metro 52 &amp; 54<input type="checkbox" data-l="metro" checked></label>
  <label>Street names<input type="checkbox" data-l="streets" checked></label>
  <label>Neighbourhoods<input type="checkbox" data-l="districts" checked></label>
  <label>Trees<input type="checkbox" data-l="trees" checked></label>
</div>

<div class="hud"><div class="scale"><span></span><b></b></div><span class="stat"></span></div>
<div class="attr"><span class="src"></span> ${CREDIT}</div>
<div class="notice" hidden></div>
<div class="tip" hidden></div>
<div class="loader">${MARK}<strong>Amsterdam</strong><div class="bar"><i></i></div><span class="msg">Starting…</span></div>
`;
