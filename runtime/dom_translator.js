// 前置依赖零导入：纯渲染层 DOM 汉化引擎，同时支持在浏览器注入与 Node 单元测试中加载
(function (root) {
  'use strict';

  var HARD_SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'SVG',
    'PATH',
    'CODE',
    'PRE',
    'KBD',
    'SAMP',
    'VAR',
    'CANVAS',
    'IFRAME',
    'WEBVIEW',
  ]);

  var SKIP_CLOSEST_SELECTOR = [
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    '[data-lexical-editor]',
    '.monaco-editor',
    '.cm-editor',
    '.cm-line',
    '.view-lines',
    '.view-line',
    '.code-line',
    '.line-content',
    '.code-block',
    '[data-line-tokens]',
    '.xterm',
    '.terminal',
    '.hljs',
    '.shiki',
    '.prism-code',
    '[data-zh-ignore="true"]',
    '[data-ag-localization-skip]',
    '[translate="no"]',
    '.notranslate',
    '[role="tree"]',
    '[role="treeitem"]',
    'nav[aria-label="File path breadcrumbs"]',
    '[aria-label="File Viewer"]',
    '[data-file-uri]',
    '[data-uri]',
    '[data-testid="file-title-name"]',
    '[data-testid="entity-pill"]',
    '[data-project-card="true"]',
    '[data-testid="project-name"]',
    '[data-testid="project-title"]',
    '[data-testid="conversation-row-sidebar"] span.truncate',
    '.context-scope-mention',
    '[data-quotable-inline="true"]',
    '[data-testid="user-input-step"] [data-quotable="true"]',
    '[data-testid="user-input-step"] .whitespace-pre-wrap',
    '[data-testid="planner-response-text"]',
    '[data-testid="thinking-collapsible-trigger"] ~ div',
  ].join(',');

  var ICON_FONT_CLASS_RE = /(?:^|\s)(?:google-symbols|material-symbols(?:-[a-z]+)?|material-icons(?:-[a-z]+)?|codicon(?:-[a-z0-9-]+)?)(?:\s|$)/i;

  var PROJECT_LIST_CONTROL_LABELS = new Set([
    'projects',
    '项目',
    'show all',
    '显示全部',
    'show less',
    '收起',
    'add project',
    '添加项目',
    'new project',
    '新建项目',
    'manage projects',
    '管理项目',
    'create project',
    '创建项目',
    'all projects',
    '所有项目',
    'no projects',
    '暂无项目',
  ]);

  var SHORTCUT_SUFFIX_RE = /^(.+?)\s*\(((?:Ctrl|Cmd|Alt|Shift|Meta|⌘|⌥|⇧|⌃)(?:\s*\+\s*[^)]+)?|Enter|Escape|Esc|Space|Tab|Backspace|Delete|⏎|←|→|↑|↓)\)$/i;

  var COLLECT_SELECTOR = [
    'button',
    '[role="button"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="option"]',
    'label',
    'nav',
    'aside',
    'header',
    '[role="dialog"]',
    'h1',
    'h2',
    'h3',
    'h4',
  ].join(',');

  var UI_CONTROL_SELECTOR = [
    'button',
    '[role="button"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="switch"]',
    'label',
    'th',
    'legend',
    'summary',
    'nav',
    'aside',
    'header',
  ].join(',');

  var CJK_RE = /[\u4e00-\u9fff]/;
  var LATIN_WORD_RE = /[A-Za-z]/;
  var SHORT_ASCII_WORD_RE = /^[A-Za-z]{1,4}$/;
  var WHITESPACE_SPLIT_RE = /^(\s*)([\s\S]*?)(\s*)$/;
  var ATTRS = ['placeholder', 'title', 'aria-label'];

  function compileRegexRules(rawRules) {
    var list = [];
    if (!Array.isArray(rawRules)) return list;
    for (var i = 0; i < rawRules.length; i++) {
      var r = rawRules[i];
      if (!r || typeof r.pattern !== 'string' || typeof r.replace !== 'string') continue;
      try {
        list.push({
          re: new RegExp(r.pattern, r.flags || ''),
          replace: r.replace,
        });
      } catch (_err) {
        // 忽略无效正则，避免影响主界面
      }
    }
    return list;
  }

  function normalizeLookupKey(str) {
    return str
      .replace(/\u2026/g, '...')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, ' ');
  }

  function buildExactMaps(rawExact) {
    var exactMap = new Map();
    var lowerExactMap = new Map();
    var entries = Object.entries(rawExact || {});
    for (var i = 0; i < entries.length; i++) {
      var key = entries[i][0];
      var val = entries[i][1];
      if (typeof key !== 'string' || typeof val !== 'string' || !val) continue;
      exactMap.set(key, val);
      var norm = normalizeLookupKey(key);
      if (norm !== key && !exactMap.has(norm)) {
        exactMap.set(norm, val);
      }
      if (norm.includes(' ')) {
        var low = norm.toLowerCase();
        if (!lowerExactMap.has(low)) {
          lowerExactMap.set(low, val);
        }
      }
    }
    return { exactMap: exactMap, lowerExactMap: lowerExactMap };
  }

  function buildLowerExactMap(exactMap) {
    var map = new Map();
    exactMap.forEach(function (val, key) {
      if (typeof key !== 'string' || typeof val !== 'string' || !val) return;
      if (!key.includes(' ')) return;
      var norm = normalizeLookupKey(key).toLowerCase();
      if (!map.has(norm)) {
        map.set(norm, val);
      }
    });
    return map;
  }

  function lookupExactOnly(rawStr, normStr, exactMap, lowerExactMap) {
    var hit = exactMap.get(rawStr);
    if (typeof hit !== 'string' && normStr !== rawStr) {
      hit = exactMap.get(normStr);
    }
    if (typeof hit !== 'string' && lowerExactMap && normStr.includes(' ')) {
      hit = lowerExactMap.get(normStr.toLowerCase());
    }
    return typeof hit === 'string' && hit.length > 0 ? hit : null;
  }

  function isShortUiWord(core) {
    return typeof core === 'string' && core.length <= 4 && SHORT_ASCII_WORD_RE.test(core);
  }

  function translateText(raw, exactMap, regexRules, lowerExactMap, options) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    var m = WHITESPACE_SPLIT_RE.exec(raw);
    if (!m) return null;
    var lead = m[1];
    var core = m[2];
    var trail = m[3];
    if (!core || !LATIN_WORD_RE.test(core)) return null;
    if (CJK_RE.test(core)) return null;

    var normCore = normalizeLookupKey(core);
    if (options && options.allowShortWord === false && isShortUiWord(normCore)) {
      return null;
    }

    var hit = lookupExactOnly(core, normCore, exactMap, lowerExactMap);
    if (hit !== null) {
      return lead + hit + trail;
    }

    var sm = SHORTCUT_SUFFIX_RE.exec(normCore);
    if (sm) {
      var prefixRaw = sm[1].trim();
      var prefixNorm = normalizeLookupKey(prefixRaw);
      var prefixHit = lookupExactOnly(prefixRaw, prefixNorm, exactMap, lowerExactMap);
      if (prefixHit !== null) {
        return lead + prefixHit + ' (' + sm[2] + ')' + trail;
      }
    }

    if (normCore.length <= 240 && regexRules.length > 0) {
      for (var i = 0; i < regexRules.length; i++) {
        var rule = regexRules[i];
        rule.re.lastIndex = 0;
        if (rule.re.test(normCore)) {
          rule.re.lastIndex = 0;
          var replaced = normCore.replace(rule.re, rule.replace);
          if (replaced !== normCore) {
            return lead + replaced + trail;
          }
        }
      }
    }
    return null;
  }

  function isIconFontElement(el) {
    if (!el || el.nodeType !== 1) return false;
    var cls = typeof el.className === 'string'
      ? el.className
      : (typeof el.getAttribute === 'function' ? el.getAttribute('class') : '');
    return typeof cls === 'string' && ICON_FONT_CLASS_RE.test(cls);
  }

  function isProjectListFolderItem(el) {
    try {
      if (!el || el.nodeType !== 1) return false;
      var inSidebar = typeof el.closest === 'function' && Boolean(el.closest('aside, nav'));
      if (!inSidebar) return false;
      var ownText = String(el.textContent || '').trim().toLowerCase();
      if (!ownText || PROJECT_LIST_CONTROL_LABELS.has(ownText)) return false;

      var ancestor = el.parentElement;
      for (var depth = 0; depth < 3 && ancestor; depth++) {
        var children = ancestor.children;
        if (children && children.length > 1) {
          var firstHeader = null;
          for (var i = 0; i < children.length; i++) {
            var ch = children[i];
            if (!ch) continue;
            var chText = String(ch.textContent || '').trim();
            if (chText) {
              firstHeader = ch;
              break;
            }
          }
          if (firstHeader) {
            var headerLower = String(firstHeader.textContent || '').trim().toLowerCase();
            if (headerLower === 'projects' || headerLower === '项目') {
              if (firstHeader === el || (typeof firstHeader.contains === 'function' && firstHeader.contains(el))) {
                return false;
              }
              return true;
            }
          }
        }
        ancestor = ancestor.parentElement;
      }
      return false;
    } catch (_err) {
      return false;
    }
  }

  function isSkippedElement(el, forAttribute, skipCache) {
    try {
      if (!el || el.nodeType !== 1) return true;
      if (!forAttribute && skipCache && skipCache.has(el)) {
        return skipCache.get(el);
      }

      var result = false;
      if (HARD_SKIP_TAGS.has(el.tagName)) {
        result = true;
      } else {
        var isFormField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
        if (isFormField && !forAttribute) {
          result = true;
        } else if (!forAttribute && el.tagName === 'OPTION' && typeof el.hasAttribute === 'function' && !el.hasAttribute('value')) {
          result = true;
        }
      }

      if (!result && !forAttribute && typeof document !== 'undefined') {
        var active = document.activeElement;
        if (
          active &&
          (active.isContentEditable ||
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            (typeof active.getAttribute === 'function' && active.getAttribute('data-lexical-editor') === 'true')) &&
          (active === el || (typeof active.contains === 'function' && active.contains(el)))
        ) {
          result = true;
        }
      }

      if (!result) {
        var cur = el;
        var isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
        while (cur) {
          if (isIconFontElement(cur)) {
            result = true;
            break;
          }
          if (!(forAttribute && isField && cur === el) && cur.isContentEditable) {
            result = true;
            break;
          }
          if (typeof cur.closest === 'function' && cur.closest(SKIP_CLOSEST_SELECTOR)) {
            result = true;
            break;
          }
          var rootNode = typeof cur.getRootNode === 'function' ? cur.getRootNode() : null;
          cur = rootNode && rootNode.host ? rootNode.host : null;
        }
      }

      if (!result && !forAttribute && isProjectListFolderItem(el)) {
        result = true;
      }

      if (!forAttribute && skipCache) {
        skipCache.set(el, result);
      }
      return result;
    } catch (_err) {
      return true;
    }
  }

  function shouldCollectText(el, core) {
    if (!core || core.length < 2 || core.length > 80) return false;
    if (!LATIN_WORD_RE.test(core) || CJK_RE.test(core)) return false;
    if (!el || typeof el.closest !== 'function') return false;
    if (/^[a-z0-9_./:-]+$/.test(core) && !core.includes(' ')) return false;
    return Boolean(el.closest(COLLECT_SELECTOR));
  }

  function installDomTranslator(payload) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    // 严格仅限 Antigravity 2.0 Hub 渲染进程，绝不侵入用户本地开发服务或普通网页
    if (
      typeof window.electronNative === 'undefined' &&
      typeof window.nativeStorage === 'undefined'
    ) {
      return;
    }

    var state = window.__AGY_ZH_STATE__;
    if (!state) {
      state = {
        enabled: true,
        exactMap: new Map(),
        lowerExactMap: new Map(),
        regexRules: [],
        origTextMap: new WeakMap(),
        unchangedTextMap: new WeakMap(),
        origAttrMap: new WeakMap(),
        translatedTexts: new Set(),
        translatedAttrs: new Set(),
        pendingNodes: new Set(),
        rafScheduled: false,
        observer: null,
        hotkeyInstalled: false,
        collectUntranslated: false,
        collectedSet: new Set(),
        collectQueue: [],
        collectTimer: null,
      };
      window.__AGY_ZH_STATE__ = state;
    }

    state.enabled = payload && payload.enabled !== false;
    state.collectUntranslated = Boolean(payload && payload.collectUntranslated);
    var built = buildExactMaps((payload && payload.exact) || {});
    state.exactMap = built.exactMap;
    state.lowerExactMap = built.lowerExactMap;
    state.regexRules = compileRegexRules((payload && payload.regexRules) || []);
    state.unchangedTextMap = new WeakMap();

    function queueUntranslated(core) {
      if (!state.collectUntranslated) return;
      if (state.collectedSet.has(core)) return;
      state.collectedSet.add(core);
      state.collectQueue.push(core);
      if (!state.collectTimer) {
        state.collectTimer = setTimeout(function () {
          state.collectTimer = null;
          if (state.collectQueue.length > 0) {
            var batch = state.collectQueue.splice(0, 100);
            try {
              console.debug('__AGY_ZH_COLLECT__' + JSON.stringify(batch));
            } catch (_e) {}
          }
        }, 1200);
      }
    }

    function processTextNode(textNode, skipCache) {
      if (!textNode || textNode.nodeType !== 3) return;
      var parent = textNode.parentElement;
      if (isSkippedElement(parent, false, skipCache)) return;

      var current = textNode.nodeValue || '';
      var orig = state.origTextMap.get(textNode);

      if (!state.enabled) {
        if (typeof orig === 'string' && current !== orig) {
          textNode.nodeValue = orig;
        }
        return;
      }

      if (typeof orig !== 'string' && state.unchangedTextMap.get(textNode) === current) {
        return;
      }

      var allowShortWord = Boolean(parent && typeof parent.closest === 'function' && parent.closest(UI_CONTROL_SELECTOR));
      var txOpts = { allowShortWord: allowShortWord };

      if (typeof orig === 'string') {
        var expectedZh = translateText(orig, state.exactMap, state.regexRules, state.lowerExactMap, txOpts);
        if (current !== orig && current !== expectedZh) {
          // React 更新了此文本节点的英文原文，同步刷新原值记录
          orig = current;
          state.origTextMap.set(textNode, orig);
        }
      } else {
        orig = current;
      }

      var translated = translateText(orig, state.exactMap, state.regexRules, state.lowerExactMap, txOpts);
      if (translated !== null) {
        if (!state.origTextMap.has(textNode)) {
          state.origTextMap.set(textNode, orig);
        }
        state.translatedTexts.add(textNode);
        if (current !== translated) {
          textNode.nodeValue = translated;
        }
      } else {
        state.unchangedTextMap.set(textNode, current);
        if (state.collectUntranslated) {
          var m = WHITESPACE_SPLIT_RE.exec(orig);
          if (m && shouldCollectText(parent, m[2])) {
            queueUntranslated(m[2]);
          }
        }
      }
    }

    function processElementAttrs(el) {
      if (isSkippedElement(el, true)) return;
      var rec = state.origAttrMap.get(el);
      var attrTxOpts = { allowShortWord: true };

      if (!state.enabled) {
        if (rec) {
          for (var k = 0; k < ATTRS.length; k++) {
            var attrOff = ATTRS[k];
            if (Object.prototype.hasOwnProperty.call(rec, attrOff)) {
              if (el.getAttribute(attrOff) !== rec[attrOff]) {
                el.setAttribute(attrOff, rec[attrOff]);
              }
            }
          }
        }
        return;
      }

      for (var i = 0; i < ATTRS.length; i++) {
        var attr = ATTRS[i];
        var val = el.getAttribute(attr);
        if (!val) continue;
        var origAttr = rec && Object.prototype.hasOwnProperty.call(rec, attr) ? rec[attr] : null;
        if (origAttr !== null) {
          var expected = translateText(origAttr, state.exactMap, state.regexRules, state.lowerExactMap, attrTxOpts);
          if (val !== origAttr && val !== expected) {
            origAttr = val;
            rec[attr] = origAttr;
          }
        } else {
          origAttr = val;
        }

        var next = translateText(origAttr, state.exactMap, state.regexRules, state.lowerExactMap, attrTxOpts);
        if (next !== null) {
          if (!rec) {
            rec = {};
            state.origAttrMap.set(el, rec);
          }
          rec[attr] = origAttr;
          state.translatedAttrs.add(el);
          if (val !== next) {
            el.setAttribute(attr, next);
          }
        }
      }
    }

    function walkSubtree(rootNode, skipCache) {
      if (!rootNode) return;
      var cache = skipCache || new WeakMap();
      if (rootNode.nodeType === 3) {
        processTextNode(rootNode, cache);
        return;
      }
      if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9) return;
      var startEl = rootNode.nodeType === 9 ? rootNode.documentElement : rootNode;
      if (!startEl) return;
      if (isSkippedElement(startEl, true)) return;

      processElementAttrs(startEl);

      var walker = document.createTreeWalker(startEl, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
        acceptNode: function (node) {
          if (node.nodeType === 1 && isSkippedElement(node, true)) {
            return 2; /* FILTER_REJECT */
          }
          return 1; /* FILTER_ACCEPT */
        },
      });
      var cur = walker.nextNode();
      while (cur) {
        if (cur.nodeType === 3) {
          processTextNode(cur, cache);
        } else if (cur.nodeType === 1) {
          processElementAttrs(cur);
        }
        cur = walker.nextNode();
      }
    }

    function pruneDisconnectedNodes() {
      if (state.translatedTexts.size > 500) {
        state.translatedTexts.forEach(function (n) {
          if (!n.isConnected) state.translatedTexts.delete(n);
        });
      }
      if (state.translatedAttrs.size > 300) {
        state.translatedAttrs.forEach(function (el) {
          if (!el.isConnected) state.translatedAttrs.delete(el);
        });
      }
    }

    function restoreAllToOriginal() {
      state.translatedTexts.forEach(function (textNode) {
        if (!textNode.isConnected) {
          state.translatedTexts.delete(textNode);
          return;
        }
        var orig = state.origTextMap.get(textNode);
        if (typeof orig === 'string' && textNode.nodeValue !== orig) {
          textNode.nodeValue = orig;
        }
      });
      state.translatedAttrs.forEach(function (el) {
        if (!el.isConnected) {
          state.translatedAttrs.delete(el);
          return;
        }
        var rec = state.origAttrMap.get(el);
        if (!rec) return;
        for (var i = 0; i < ATTRS.length; i++) {
          var attr = ATTRS[i];
          if (Object.prototype.hasOwnProperty.call(rec, attr)) {
            if (el.getAttribute(attr) !== rec[attr]) {
              el.setAttribute(attr, rec[attr]);
            }
          }
        }
      });
    }

    function flushPending() {
      state.rafScheduled = false;
      if (state.pendingNodes.size === 0) return;
      var nodes = Array.from(state.pendingNodes);
      state.pendingNodes.clear();
      var skipCache = new WeakMap();
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n || !n.isConnected) continue;
        walkSubtree(n, skipCache);
      }
      pruneDisconnectedNodes();
    }

    function scheduleWalk(node) {
      if (!node) return;
      state.pendingNodes.add(node);
      if (!state.rafScheduled) {
        state.rafScheduled = true;
        var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
        raf(flushPending);
      }
    }

    function showToggleToast(text) {
      try {
        var existing = document.getElementById('__agy_zh_toast__');
        if (existing) existing.remove();
        var toast = document.createElement('div');
        toast.id = '__agy_zh_toast__';
        toast.setAttribute('data-zh-ignore', 'true');
        toast.textContent = text;
        toast.style.cssText = [
          'position:fixed',
          'right:16px',
          'bottom:16px',
          'z-index:2147483647',
          'padding:7px 12px',
          'border-radius:8px',
          'font-size:12px',
          'font-family:"Microsoft YaHei UI",system-ui,sans-serif',
          'background:rgba(24,24,27,0.92)',
          'color:#f4f4f5',
          'border:1px solid rgba(255,255,255,0.16)',
          'box-shadow:0 4px 16px rgba(0,0,0,0.28)',
          'pointer-events:none',
        ].join(';');
        (document.body || document.documentElement).appendChild(toast);
        setTimeout(function () {
          if (toast.isConnected) toast.remove();
        }, 1600);
      } catch (_e) {}
    }

    if (!state.observer) {
      state.observer = new MutationObserver(function (mutations) {
        if (!state.enabled) return;
        for (var i = 0; i < mutations.length; i++) {
          var mut = mutations[i];
          if (mut.type === 'characterData') {
            scheduleWalk(mut.target);
          } else if (mut.type === 'attributes') {
            scheduleWalk(mut.target);
          } else if (mut.type === 'childList') {
            for (var j = 0; j < mut.addedNodes.length; j++) {
              scheduleWalk(mut.addedNodes[j]);
            }
          }
        }
      });
      if (document.documentElement) {
        state.observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ATTRS,
        });
      }
    }

    if (!state.hotkeyInstalled) {
      state.hotkeyInstalled = true;
      window.addEventListener(
        'keydown',
        function (e) {
          if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
            e.preventDefault();
            state.enabled = !state.enabled;
            state.unchangedTextMap = new WeakMap();
            if (state.enabled) {
              if (document.documentElement) walkSubtree(document.documentElement);
              showToggleToast('中文界面已开启（Ctrl+Alt+L 可随时切换英文）');
            } else {
              restoreAllToOriginal();
              showToggleToast('已切换回原版英文（Ctrl+Alt+L 可恢复中文）');
            }
          }
        },
        true
      );
    }

    if (state.enabled) {
      if (document.documentElement) {
        walkSubtree(document.documentElement);
      }
    } else {
      restoreAllToOriginal();
    }
  }

  var api = {
    buildExactMaps: buildExactMaps,
    buildLowerExactMap: buildLowerExactMap,
    compileRegexRules: compileRegexRules,
    isSkippedElement: isSkippedElement,
    translateText: translateText,
    installDomTranslator: installDomTranslator,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.__AGY_ZH_TRANSLATOR__ = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
