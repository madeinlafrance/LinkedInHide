(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  //
  // LinkedIn's feed is server-driven UI (data-sdui-screen =
  // com.linkedin.sdui.flagshipnav.feed.MainFeed). Every class name is a build
  // hash (`d1f0e118`, `_849cef98`) and rotates, so nothing here keys off class.
  // We anchor on accessibility affordances instead, which are stable because
  // screen readers depend on them:
  //   - each post contains <h2>Feed post</h2>
  //   - the author block carries aria-label "<Name> [Verified Profile] <degree>"
  // ---------------------------------------------------------------------------

  const STATE_ATTR = 'data-lih';
  const ARMING_CLASS = 'lih-arming';
  const ARM_TIMEOUT_MS = 4000;

  const FEED_LIST_SELECTORS = [
    '[componentkey="container-update-list_mainFeed-lazy-container"]',
    '[componentkey*="mainFeed"]'
  ];

  const POST_HEADING_RE = /^feed post$/i;
  const DEGREE_RE = /(1st|2nd|3rd\+?)\s*$/i;
  // "Wendell Keuneman Verified Profile 1st" -> name + degree
  const ACTOR_LABEL_RE =
    /^(.*?)\s*(?:(?:Verified|Premium|Influencer)\s+Profile\s*)?(1st|2nd|3rd\+?)$/i;
  const PROMOTED_RE = /^promoted$/i;
  const SUGGESTED_RE = /^(suggested|recommended for you)$/i;
  const FOLLOW_OFFER_RE = /^Follow\b/i;

  const onHomeFeed = () => /^\/(feed\/?)?$/.test(location.pathname);

  // ---------------------------------------------------------------------------
  // Finding posts
  // ---------------------------------------------------------------------------

  function findFeedList(headings) {
    for (const sel of FEED_LIST_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Fallback if componentkey changes: the nearest ancestor of the first post
    // heading that also contains a second post heading is the list.
    if (headings.length >= 2) {
      for (let el = headings[0].parentElement; el; el = el.parentElement) {
        if (el.contains(headings[1])) return el;
      }
    }
    return null;
  }

  function findPosts() {
    const headings = [...document.querySelectorAll('h2')].filter((h) =>
      POST_HEADING_RE.test((h.textContent || '').trim())
    );
    if (!headings.length) return { list: null, posts: [] };

    const list = findFeedList(headings);
    if (!list) return { list: null, posts: [] };

    // A post is the direct child of the list that owns the heading.
    const posts = new Set();
    for (const h of headings) {
      let el = h;
      while (el.parentElement && el.parentElement !== list) el = el.parentElement;
      if (el.parentElement === list) posts.add(el);
    }
    return { list, posts: [...posts] };
  }

  // ---------------------------------------------------------------------------
  // Reading the author
  // ---------------------------------------------------------------------------

  function describe(post) {
    const labels = [...post.querySelectorAll('[aria-label]')].map(
      (el) => el.getAttribute('aria-label') || ''
    );
    const pick = (re) => {
      for (const l of labels) {
        const m = l.match(re);
        if (m) return m[1].trim();
      }
      return '';
    };

    // Deliberately NOT the first a[href*="/in/"] or "View X's profile": on a
    // reshare those name whoever reacted ("Sasha Pilch likes this"), not the
    // author. The control-menu label always names the actual author, and unlike
    // the degree label it also works for company/page actors, which have no
    // degree at all.
    let name = pick(/^Open control menu for post by\s+(.+)$/i) ||
               pick(/^Hide post by\s+(.+)$/i);

    const degreeLabel = labels.find((l) => DEGREE_RE.test(l));
    let degree = '';
    if (degreeLabel) {
      const m = degreeLabel.match(ACTOR_LABEL_RE);
      if (m) {
        degree = m[2].toLowerCase();
        if (!name) name = m[1].trim();
      }
    }

    const leaves = [...post.querySelectorAll('span, div')].filter(
      (el) => el.children.length === 0
    );
    const hasLeaf = (re) => leaves.some((el) => re.test((el.textContent || '').trim()));

    const promoted = hasLeaf(PROMOTED_RE);
    const isFirst = degree === '1st' && !promoted;

    // LinkedIn offers "Follow <name>" only when you are NOT already following.
    // Its absence is therefore the follow signal — inferred, not stated: it also
    // covers your own posts, which have no Follow button either.
    const followOffer = labels.some((l) => FOLLOW_OFFER_RE.test(l));
    const following = !promoted && !followOffer && !isFirst;

    let tag;
    if (promoted) tag = 'Promoted';
    else if (isFirst) tag = '1st';
    else if (following) tag = 'Following';
    else if (degree) tag = degree === '3rd' ? '3rd+' : degree;
    else if (hasLeaf(SUGGESTED_RE)) tag = 'Suggested';
    else tag = 'Page';

    return { name, tag, showName: !!name && (isFirst || following) };
  }

  // ---------------------------------------------------------------------------
  // Collapsed card
  // ---------------------------------------------------------------------------

  function setState(post, state) {
    post.setAttribute(STATE_ATTR, state);
    const btn = post.querySelector(':scope > .lih-bar > .lih-btn');
    if (btn) btn.textContent = state === 'open' ? 'Hide' : 'Reveal';
  }

  function buildBar(post, info) {
    const bar = document.createElement('div');
    bar.className = 'lih-bar';

    const label = document.createElement('span');
    label.className = 'lih-label';
    // textContent, never innerHTML: display names are attacker-controlled.
    label.textContent = info.showName ? info.name : 'Post';

    const tag = document.createElement('span');
    tag.className = 'lih-tag';
    tag.dataset.kind = info.tag.toLowerCase();
    tag.textContent = info.tag;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lih-btn';
    btn.textContent = 'Reveal';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setState(post, post.getAttribute(STATE_ATTR) === 'open' ? 'collapsed' : 'open');
      syncRevealAll();
    });

    bar.append(label, tag, btn);
    return bar;
  }

  function process(post) {
    // The feed lazy-mounts and recycles rows, so a post we already handled can
    // come back stripped of our bar while keeping its state attribute.
    if (post.querySelector(':scope > .lih-bar')) return;
    const info = describe(post);
    post.insertBefore(buildBar(post, info), post.firstChild);
    setState(post, post.getAttribute(STATE_ATTR) === 'open' ? 'open' : 'collapsed');
  }

  // ---------------------------------------------------------------------------
  // Floating "Reveal all"
  // ---------------------------------------------------------------------------

  let revealAllBtn = null;

  function syncRevealAll() {
    if (!revealAllBtn) return;
    const total = document.querySelectorAll(`[${STATE_ATTR}]`).length;
    revealAllBtn.hidden = total === 0;
    const anyCollapsed = !!document.querySelector(`[${STATE_ATTR}="collapsed"]`);
    revealAllBtn.textContent = anyCollapsed ? 'Reveal all' : 'Collapse all';
    revealAllBtn.dataset.action = anyCollapsed ? 'open' : 'collapsed';
  }

  function ensureRevealAll() {
    if (revealAllBtn && revealAllBtn.isConnected) return;
    revealAllBtn = document.createElement('button');
    revealAllBtn.type = 'button';
    revealAllBtn.className = 'lih-reveal-all';
    revealAllBtn.hidden = true;
    revealAllBtn.addEventListener('click', () => {
      const next = revealAllBtn.dataset.action === 'open' ? 'open' : 'collapsed';
      document.querySelectorAll(`[${STATE_ATTR}]`).forEach((p) => setState(p, next));
      syncRevealAll();
    });
    document.body.appendChild(revealAllBtn);
  }

  function removeRevealAll() {
    if (revealAllBtn) revealAllBtn.remove();
    revealAllBtn = null;
  }

  // ---------------------------------------------------------------------------
  // Scan loop
  // ---------------------------------------------------------------------------

  let armed = true;
  let enabled = true;

  function disarm() {
    if (!armed) return;
    armed = false;
    document.documentElement.classList.remove(ARMING_CLASS);
  }

  // Undo everything, restoring LinkedIn's own rendering. Removing the state
  // attribute is what releases the collapse CSS.
  function teardown() {
    document.querySelectorAll('.lih-bar').forEach((b) => b.remove());
    document
      .querySelectorAll(`[${STATE_ATTR}]`)
      .forEach((p) => p.removeAttribute(STATE_ATTR));
    removeRevealAll();
    disarm();
  }

  function scan() {
    if (!document.body) return;
    if (!enabled) {
      disarm();
      return;
    }
    if (!onHomeFeed()) {
      removeRevealAll();
      disarm();
      return;
    }

    ensureRevealAll();
    const { list, posts } = findPosts();
    posts.forEach(process);

    // Disarm once the list exists, even with zero posts, so an empty or
    // unrecognised feed is never left hidden.
    if (list) disarm();
    syncRevealAll();
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  document.documentElement.classList.add(ARMING_CLASS);
  setTimeout(disarm, ARM_TIMEOUT_MS);

  // The toolbar icon toggles a boolean in storage. Reading it is async, so we
  // arm first and correct within a frame or two if we turn out to be disabled.
  // Watching storage means a toggle applies to every open tab with no reload.
  function watchEnabledState() {
    try {
      chrome.storage.local.get('enabled').then(({ enabled: stored }) => {
        enabled = stored === undefined ? true : stored;
        if (!enabled) teardown();
        else schedule();
      });

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.enabled) return;
        enabled = changes.enabled.newValue !== false;
        if (enabled) schedule();
        else teardown();
      });
    } catch {
      // Extension context invalidated (e.g. reloaded while the tab is open).
      // Leave the feed in LinkedIn's own hands rather than half-collapsed.
      enabled = false;
      teardown();
    }
  }

  function start() {
    watchEnabledState();
    scan();
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true
    });

    // LinkedIn is an SPA, so navigation never reloads the content script. The
    // observer covers it: route changes swap the feed, which fires mutations,
    // and scan() re-reads location.pathname every pass. Back/forward is the one
    // case that can leave the DOM untouched, so listen for it too.
    //
    // Deliberately NOT patching history.pushState: content scripts run in an
    // isolated world, so it would never intercept the page's own calls, and
    // reaching the page's world would mean injecting a script into it — no
    // isolation, for a signal the observer already gives us.
    window.addEventListener('popstate', schedule);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
