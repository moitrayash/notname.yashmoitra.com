/* Not Name — lazy-loading single-page app
 * (engine ported from Oeuvre v2)
 *
 * Architecture:
 *   data/index.json          — catalog (metadata only, no content)
 *   data/<slug>.json   — individual work (content loaded on demand)
 *
 * To add a new work:
 *   1. Add an entry to data/index.json
 *   2. Create data/<slug>.json with the content
 *   That's it. No touching app.js or index.html.
 *
 * Inline links: within a content line or footnote you may write a
 * markdown-style link, e.g. [Asfi](#/work/tias) for an internal work
 * page or [text](https://example.com) for an external link. All other
 * text is HTML-escaped.
 */
(function () {
  'use strict';

  /* ---- DOM refs ---- */
  const itemPage  = document.getElementById('itemPage');
  const mainView  = document.getElementById('mainView');
  const mainNav   = document.getElementById('mainNav');
  const mainContent = document.getElementById('mainContent');

  /* ---- In-memory caches ---- */
  let catalog   = null;   // parsed data/index.json
  let workMap   = {};     // slug -> metadata entry
  let flatList  = [];     // ordered list of all routable works
  let contentCache = {}; // slug -> fetched JSON work object

  /* ---- Helpers ---- */
  function esc(v) {
    return String(v)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  /* Escape, then linkify markdown-style [label](href) where href is an
   * internal work route (#/work/slug) or an http(s) URL. Everything is
   * escaped first, so this stays XSS-safe. */
  function fmt(v) {
    return esc(v).replace(
      /\[([^\]]+)\]\((#\/work\/[A-Za-z0-9\-]+|https?:\/\/[^\s)]+)\)/g,
      function (m, label, href) {
        const external = href.charAt(0) !== '#';
        const attrs = external ? ' target="_blank" rel="noopener"' : '';
        return '<a href="' + href + '"' + attrs + '>' + label + '</a>';
      }
    );
  }

  function slugify(v) {
    return String(v).trim().toLowerCase()
      .replace(/['"`]/g,'')
      .replace(/[^a-z0-9]+/g,'-')
      .replace(/^-+|-+$/g,'');
  }

  /* ---- Fetch helpers (with in-memory cache) ---- */
  async function fetchCatalog() {
    if (catalog) return catalog;
    const res = await fetch('./data/index.json');
    if (!res.ok) throw new Error('Could not load catalog');
    catalog = await res.json();
    return catalog;
  }

  async function fetchWork(slug) {
    if (contentCache[slug]) return contentCache[slug];
    const res = await fetch('./data/' + slug + '.json');
    if (!res.ok) throw new Error('Work not found: ' + slug);
    const data = await res.json();
    contentCache[slug] = data;
    return data;
  }

  /* ---- Build lookup maps from catalog ---- */
  function buildLookups(cat) {
    let idx = 0;
    for (const [category, subsections] of Object.entries(cat)) {
      for (const [subsection, works] of Object.entries(subsections)) {
        works.forEach(function(work) {
          if (work.shortname) {
            const entry = Object.assign({}, work, { category, subsection, index: idx });
            workMap[work.shortname] = entry;
            flatList.push(entry);
            idx++;
          }
        });
      }
    }
  }

  /* ---- Render: main navigation ---- */
  function renderNav(cat) {
    const keys = Object.keys(cat);
    mainNav.innerHTML = keys.map(function(cat, i) {
      const id = slugify(cat);
      const sep = i < keys.length - 1 ? ' | ' : '';
      return '<a href="#' + id + '">' + esc(cat) + '</a>' + sep;
    }).join('');
  }

  /* ---- Render: main listing ---- */
  function renderListing(cat) {
    let html = '';
    for (const [category, subsections] of Object.entries(cat)) {
      const catId = slugify(category);
      html += '<section id="' + catId + '">';
      html += '<h2 class="category-heading">' + esc(category) + '</h2>';
      for (const [subsection, works] of Object.entries(subsections)) {
        html += '<div class="subsection">';
        if (subsection) html += '<h3 class="subsection-title">' + esc(subsection) + '</h3>';
        html += '<ul class="work-list">';
        works.forEach(function(work) {
          html += '<li class="work-item">';
          if (work.externalUrl) {
            html += '<a href="' + esc(work.externalUrl) + '" target="_blank" rel="noopener">' + esc(work.name) + '</a>';
          } else if (work.shortname) {
            html += '<a href="#/work/' + esc(work.shortname) + '">' + esc(work.name) + '</a>';
          } else {
            html += '<span>' + esc(work.name) + '</span>';
          }
          if (work.year) html += '<span class="work-year">' + esc(work.year) + '</span>';
          html += '</li>';
        });
        html += '</ul></div>';
      }
      html += '</section>';
    }
    mainContent.setAttribute('aria-busy', 'false');
    mainContent.innerHTML = html;
  }

  /* ---- Render: individual work page ---- */
  function renderWork(meta, data) {
    const { category, subsection, index } = meta;
    const prev = index > 0 ? flatList[index - 1] : null;
    const next = index < flatList.length - 1 ? flatList[index + 1] : null;
    const catId = slugify(category);

    let contentHTML = '';
    if (Array.isArray(data.content)) {
      if (category === 'Poems') {
        contentHTML = data.content.map(function(line) {
          return line === '' ? '<br>' : '<p class="poem-line">' + fmt(line) + '</p>';
        }).join('');
      } else {
        contentHTML = data.content.map(function(para) {
          return '<p>' + fmt(para) + '</p>';
        }).join('');
      }
    }

    const dateHTML    = data.subtext  ? '<p class="item-date">'    + esc(data.subtext) + '</p>' : '';
    const headingHTML = data.heading  ? '<p class="item-meta"><em>' + esc(data.heading) + '</em></p>' : '';

    let footnotesHTML = '';
    if (data.footnotes && data.footnotes.length) {
      footnotesHTML = '<div class="footnotes"><h4>Notes</h4>';
      data.footnotes.forEach(function(n) {
        footnotesHTML += '<p class="footnote">' + fmt(n) + '</p>';
      });
      footnotesHTML += '</div>';
    }

    let publicationHTML = '';
    if (data.publication && data.publication.text && data.publication.url) {
      publicationHTML = '<div class="publication">As seen in <a href="' + esc(data.publication.url) + '" target="_blank">' + esc(data.publication.text) + '</a></div>';
    }

    const prevLink = prev
      ? '<a href="#/work/' + esc(prev.shortname) + '" class="item-page-nav-link">&larr; ' + esc(prev.name) + '</a>'
      : '<span class="nav-placeholder"></span>';
    const nextLink = next
      ? '<a href="#/work/' + esc(next.shortname) + '" class="item-page-nav-link">' + esc(next.name) + ' &rarr;</a>'
      : '<span class="nav-placeholder"></span>';

    document.title = data.name + ' (Not Name)';

    itemPage.innerHTML =
      '<a href="#' + catId + '" class="back-link">&larr; Back to ' + esc(category) + '</a>' +
      '<h2 class="item-title">' + esc(data.name) + '</h2>' +
      dateHTML +
      '<div class="item-content">' + contentHTML + '</div>' +
      '<div class="item-metadata-section">' +
        headingHTML +
        '<p class="item-meta">Year: ' + esc(data.year) + '</p>' +
        '<p class="item-meta">Category: ' + esc(category) + '</p>' +
        (subsection ? '<p class="item-meta">Collection: ' + esc(subsection) + '</p>' : '') +
      '</div>' +
      footnotesHTML +
      publicationHTML +
      '<nav class="item-page-nav" aria-label="Work navigation">' +
        prevLink +
        '<a href="#' + catId + '" class="back-link">&larr; Back</a>' +
        nextLink +
      '</nav>';

    itemPage.classList.add('active');
    mainView.classList.add('hidden');
    window.scrollTo(0, 0);
  }

  function showNotFound(slug) {
    document.title = 'Not found (Not Name)';
    itemPage.innerHTML =
      '<a href="#" class="back-link">&larr; Back</a>' +
      '<h2 class="item-title">Work not found</h2>' +
      '<p>No work with id &ldquo;' + esc(slug) + '&rdquo; exists in this collection yet.</p>';
    itemPage.classList.add('active');
    mainView.classList.add('hidden');
    window.scrollTo(0, 0);
  }

  function showMain(hash) {
    itemPage.classList.remove('active');
    mainView.classList.remove('hidden');
    document.title = 'Not Name';
    if (hash && hash.length > 1) {
      const el = document.getElementById(hash.substring(1));
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }

  /* ---- Router ---- */
  async function route() {
    const hash = window.location.hash || '';

    if (hash.startsWith('#/work/')) {
      const slug = hash.substring(7);
      const meta = workMap[slug];
      if (!meta) { showNotFound(slug); return; }
      try {
        const data = await fetchWork(slug);
        renderWork(meta, Object.assign({}, meta, data));
      } catch(e) {
        showNotFound(slug);
      }
    } else {
      showMain(hash);
    }
  }

  /* ---- Boot ---- */
  async function init() {
    try {
      const cat = await fetchCatalog();
      buildLookups(cat);
      renderNav(cat);
      renderListing(cat);
    } catch(e) {
      mainContent.innerHTML = '<p class="loading">Failed to load catalog. Please refresh.</p>';
      console.error(e);
      return;
    }
    route();
  }

  window.addEventListener('hashchange', route);
  init();
})();
