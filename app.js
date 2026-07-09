/* Not Name — lazy-loading single-page app
 * (engine ported from Oeuvre v2)
 *
 * Architecture:
 *   data/index.json    — catalog (metadata only, no content)
 *   data/<slug>.json   — individual work (content loaded on demand)
 *
 * To add a new work:
 *   1. Add an entry to data/index.json
 *   2. Create data/<slug>.json with the content
 *
 * Access:
 *   The password gate lives in index.html. On a successful unlock it calls
 *   window.NN.unlock(hideList), where hideList is an array of work shortnames
 *   to hide for that password. The catalog is rendered with those works
 *   removed; any collection or section left with no visible works is dropped
 *   too. Nothing renders until a valid password is entered.
 *
 * Inline links: within a content line or footnote you may write a
 * markdown-style link, e.g. [Asfi](#/work/tias) for an internal work page
 * or [text](https://example.com) for an external link. All other text is
 * HTML-escaped.
 */
(function () {
  'use strict';

  var itemPage    = document.getElementById('itemPage');
  var mainView    = document.getElementById('mainView');
  var mainNav     = document.getElementById('mainNav');
  var mainContent = document.getElementById('mainContent');

  var catalog      = null; // raw parsed data/index.json
  var workMap      = {};   // slug -> metadata entry (visible works only)
  var flatList     = [];   // ordered list of visible routable works
  var contentCache = {};   // slug -> fetched JSON work object

  var authorized  = false;     // true after a valid unlock
  var pendingHide = undefined; // hide-list supplied before the catalog loaded

  function esc(v) {
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /* Escape, then linkify markdown-style [label](href) where href is an
   * internal work route (#/work/slug) or an http(s) URL. Escaped first,
   * so this stays XSS-safe. */
  function fmt(v) {
    return esc(v).replace(
      /\[([^\]]+)\]\((#\/work\/[A-Za-z0-9\-]+|https?:\/\/[^\s)]+)\)/g,
      function (m, label, href) {
        var external = href.charAt(0) !== '#';
        var attrs = external ? ' target="_blank" rel="noopener"' : '';
        return '<a href="' + href + '"' + attrs + '>' + label + '</a>';
      }
    );
  }

  function slugify(v) {
    return String(v).trim().toLowerCase()
      .replace(/['"`]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /* Copy of the catalog with hidden works removed. Collections and sections
   * that end up empty are dropped. */
  function filterCatalog(cat, hide) {
    var hideSet = {};
    (hide || []).forEach(function (s) { hideSet[s] = true; });
    var out = {};
    Object.keys(cat).forEach(function (category) {
      var subsections = cat[category];
      var keptSubs = {};
      Object.keys(subsections).forEach(function (subsection) {
        var kept = subsections[subsection].filter(function (w) {
          return !(w.shortname && hideSet[w.shortname]);
        });
        if (kept.length) keptSubs[subsection] = kept;
      });
      if (Object.keys(keptSubs).length) out[category] = keptSubs;
    });
    return out;
  }

  function fetchCatalog() {
    if (catalog) return Promise.resolve(catalog);
    return fetch('./data/index.json').then(function (res) {
      if (!res.ok) throw new Error('Could not load catalog');
      return res.json();
    }).then(function (json) { catalog = json; return catalog; });
  }

  function fetchWork(slug) {
    if (contentCache[slug]) return Promise.resolve(contentCache[slug]);
    return fetch('./data/' + slug + '.json').then(function (res) {
      if (!res.ok) throw new Error('Work not found: ' + slug);
      return res.json();
    }).then(function (data) { contentCache[slug] = data; return data; });
  }

  function buildLookups(cat) {
    workMap = {};
    flatList = [];
    var idx = 0;
    Object.keys(cat).forEach(function (category) {
      var subsections = cat[category];
      Object.keys(subsections).forEach(function (subsection) {
        subsections[subsection].forEach(function (work) {
          if (work.shortname) {
            var entry = Object.assign({}, work, { category: category, subsection: subsection, index: idx });
            workMap[work.shortname] = entry;
            flatList.push(entry);
            idx++;
          }
        });
      });
    });
  }

  function renderNav(cat) {
    var keys = Object.keys(cat);
    mainNav.innerHTML = keys.map(function (category, i) {
      var id = slugify(category);
      var sep = i < keys.length - 1 ? ' | ' : '';
      return '<a href="#' + id + '">' + esc(category) + '</a>' + sep;
    }).join('');
  }

  function renderListing(cat) {
    var html = '';
    Object.keys(cat).forEach(function (category) {
      var subsections = cat[category];
      var catId = slugify(category);
      html += '<section id="' + catId + '">';
      html += '<h2 class="category-heading">' + esc(category) + '</h2>';
      Object.keys(subsections).forEach(function (subsection) {
        html += '<div class="subsection">';
        if (subsection) html += '<h3 class="subsection-title">' + esc(subsection) + '</h3>';
        html += '<ul class="work-list">';
        subsections[subsection].forEach(function (work) {
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
      });
      html += '</section>';
    });
    mainContent.setAttribute('aria-busy', 'false');
    mainContent.innerHTML = html;
  }

  function renderWork(meta, data) {
    var category = meta.category, subsection = meta.subsection, index = meta.index;
    var prev = index > 0 ? flatList[index - 1] : null;
    var next = index < flatList.length - 1 ? flatList[index + 1] : null;
    var catId = slugify(category);

    var contentHTML = '';
    if (Array.isArray(data.content)) {
      if (category === 'Poems') {
        contentHTML = data.content.map(function (line) {
          return line === '' ? '<br>' : '<p class="poem-line">' + fmt(line) + '</p>';
        }).join('');
      } else {
        contentHTML = data.content.map(function (para) {
          return '<p>' + fmt(para) + '</p>';
        }).join('');
      }
    }

    if (data.footnotes && data.footnotes.length) {
      contentHTML = contentHTML.replace(/\[(\d+)\]/g, function (mm, num) {
        return '<a class="fn-ref" id="fnref' + num + '" href="#fn' + num + '">[' + num + ']</a>';
      });
    }

    var dateHTML    = data.subtext ? '<p class="item-date">' + esc(data.subtext) + '</p>' : '';
    var headingHTML = data.heading ? '<p class="item-meta"><em>' + esc(data.heading) + '</em></p>' : '';

    var footnotesHTML = '';
    if (data.footnotes && data.footnotes.length) {
      footnotesHTML = '<div class="footnotes"><h4>Notes</h4>';
      data.footnotes.forEach(function (n) {
        var fm = /^\[(\d+)\]\s*([\s\S]*)$/.exec(n);
        if (fm) {
          footnotesHTML += '<p class="footnote" id="fn' + fm[1] + '"><a href="#fnref' + fm[1] + '">[' + fm[1] + ']</a> ' + fmt(fm[2]) + '</p>';
        } else {
          footnotesHTML += '<p class="footnote">' + fmt(n) + '</p>';
        }
      });
      footnotesHTML += '</div>';
    }

    var publicationHTML = '';
    if (data.publication && data.publication.text && data.publication.url) {
      publicationHTML = '<div class="publication">As seen in <a href="' + esc(data.publication.url) + '" target="_blank">' + esc(data.publication.text) + '</a></div>';
    }

    var prevLink = prev
      ? '<a href="#/work/' + esc(prev.shortname) + '" class="item-page-nav-link">&lt; ' + esc(prev.name) + '</a>'
      : '<span class="nav-placeholder"></span>';
    var nextLink = next
      ? '<a href="#/work/' + esc(next.shortname) + '" class="item-page-nav-link">' + esc(next.name) + ' &gt;</a>'
      : '<span class="nav-placeholder"></span>';

    document.title = data.name + ' (Not Name)';

    itemPage.innerHTML =
      '<a href="#' + catId + '" class="back-link">Back to ' + esc(category) + '</a>' +
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
        '<a href="#' + catId + '" class="back-link" style="margin-bottom:0">Back to ' + esc(category) + '</a>' +
        nextLink +
      '</nav>';

    itemPage.classList.add('active');
    mainView.classList.add('hidden');
    window.scrollTo(0, 0);
  }

  function showNotFound(slug) {
    document.title = 'Not found (Not Name)';
    itemPage.innerHTML =
      '<a href="#" class="back-link">Back</a>' +
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
      var el = document.getElementById(hash.substring(1));
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function route() {
    if (!authorized) return; // nothing routable until unlocked
    var hash = window.location.hash || '';
    if (hash.indexOf('#fn') === 0) return; // footnote anchors: keep view, native scroll
    if (hash.indexOf('#/work/') === 0) {
      var slug = hash.substring(7);
      var meta = workMap[slug];
      if (!meta) { showNotFound(slug); return; } // hidden/unknown => not found
      fetchWork(slug).then(function (data) {
        renderWork(meta, Object.assign({}, data, meta));
      }).catch(function () { showNotFound(slug); });
    } else {
      showMain(hash);
    }
  }

  function applyAccess(hide) {
    if (!catalog) { pendingHide = hide || []; return; }
    authorized = true;
    var view = filterCatalog(catalog, hide || []);
    buildLookups(view);
    renderNav(view);
    renderListing(view);
    route();
  }

  /* Exposed for the gate in index.html. */
  window.NN = {
    unlock: function (hide) {
      pendingHide = hide || [];
      applyAccess(pendingHide);
    }
  };

  function init() {
    fetchCatalog().then(function () {
      if (pendingHide !== undefined) applyAccess(pendingHide);
    }).catch(function (e) {
      mainContent.innerHTML = '<p class="loading">Failed to load catalog. Please refresh.</p>';
      console.error(e);
    });
  }

  window.addEventListener('hashchange', route);
  init();
})();
