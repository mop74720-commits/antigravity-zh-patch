'use strict';

// Antigravity 2.0 桌面端主进程中文注入加载器（纯渲染层 DOM + 安全本地菜单翻译）
// 绝不修改任何网络请求、OAuth 凭据、gRPC 通信或语言服务二进制。
(function initAntigravityZhLoader() {
  if (globalThis.__AGY_ZH_LOADER_ACTIVE__) {
    return;
  }
  globalThis.__AGY_ZH_LOADER_ACTIVE__ = true;

  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const electron = require('electron');

    const EMBEDDED_DATA_DIR = '__AGY_ZH_EMBEDDED_DATA_DIR__';
    const DEFAULT_EMBEDDED_DIR =
      EMBEDDED_DATA_DIR && EMBEDDED_DATA_DIR !== '__AGY_ZH_' + 'EMBEDDED_DATA_DIR__' ? EMBEDDED_DATA_DIR : '';
    const DATA_DIR = process.env.ANTIGRAVITY_ZH_HOME || DEFAULT_EMBEDDED_DIR || path.join(os.homedir(), '.antigravity-zh');
    const DICTS_DIR = path.join(DATA_DIR, 'dicts');
    const RUNTIME_JS_PATH = path.join(DATA_DIR, 'runtime', 'dom_translator.js');
    const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
    const UNTRANSLATED_PATH = path.join(DATA_DIR, 'untranslated.json');

    // dist/menu.js 通过英文名定位一级菜单与 check-for-updates，这些标识符必须保持原样
    const RESERVED_TOP_MENU_LABELS = new Set(['File', 'Edit', 'View', 'Window', 'Help']);
    const RESERVED_UPDATER_LABELS = new Set([
      'Check for Updates',
      'Checking for Updates...',
      'Downloading Update...',
      'Restart to Update',
    ]);
    const HUB_URL_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/|$)/i;
    const COLLECT_PREFIX = '__AGY_ZH_COLLECT__';

    function safeReadJson(filePath, fallback) {
      try {
        if (!fs.existsSync(filePath)) return fallback;
        const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(text);
      } catch (_err) {
        return fallback;
      }
    }

    function loadConfig() {
      const cfg = safeReadJson(CONFIG_PATH, {});
      return {
        enabled: cfg.enabled !== false,
        translateMenus: cfg.translateMenus !== false,
        collectUntranslated: Boolean(cfg.collectUntranslated),
      };
    }

    const MAX_UNTRANSLATED_KEYS = 2000;
    const MAX_UNTRANSLATED_TEXT_LEN = 200;
    const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

    function compileMenuRules(rawRules) {
      const compiled = [];
      if (!Array.isArray(rawRules)) return compiled;
      for (const r of rawRules) {
        if (!r || typeof r.pattern !== 'string' || typeof r.replace !== 'string') continue;
        try {
          compiled.push({
            re: new RegExp(r.pattern, typeof r.flags === 'string' ? r.flags : ''),
            replace: r.replace,
          });
        } catch (_err) {}
      }
      return compiled;
    }

    function loadMenuDictionaries() {
      const menusTray = safeReadJson(path.join(DICTS_DIR, 'menus_tray.json'), { exact: {}, regexRules: [] });
      const titlebarMenus = safeReadJson(path.join(DICTS_DIR, 'titlebar_menus.json'), {});
      const mergedMenuExact = Object.create(null);
      if (titlebarMenus && typeof titlebarMenus === 'object' && !Array.isArray(titlebarMenus)) {
        for (const [k, v] of Object.entries(titlebarMenus)) {
          if (typeof v !== 'string' || !v || FORBIDDEN_KEYS.has(k)) continue;
          if (RESERVED_TOP_MENU_LABELS.has(k) || RESERVED_UPDATER_LABELS.has(k)) continue;
          mergedMenuExact[k] = v;
        }
      }
      if (menusTray && menusTray.exact && typeof menusTray.exact === 'object' && !Array.isArray(menusTray.exact)) {
        for (const [k, v] of Object.entries(menusTray.exact)) {
          if (typeof v === 'string' && v && !FORBIDDEN_KEYS.has(k)) {
            mergedMenuExact[k] = v;
          }
        }
      }
      return {
        exact: mergedMenuExact,
        compiledRegexRules: compileMenuRules(menusTray && menusTray.regexRules),
      };
    }

    function loadDictionaries() {
      const exact = Object.create(null);
      if (fs.existsSync(DICTS_DIR)) {
        const files = fs
          .readdirSync(DICTS_DIR)
          .filter((name) => name.endsWith('.json') && name !== 'regex_rules.json' && name !== 'menus_tray.json' && name !== 'custom.json')
          .sort();
        for (const file of files) {
          const obj = safeReadJson(path.join(DICTS_DIR, file), {});
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            for (const [k, v] of Object.entries(obj)) {
              if (typeof v === 'string' && v && !FORBIDDEN_KEYS.has(k)) {
                exact[k] = v;
              }
            }
          }
        }
        // custom.json 最后加载，确保用户自定义翻译始终优先生效
        const customObj = safeReadJson(path.join(DICTS_DIR, 'custom.json'), {});
        if (customObj && typeof customObj === 'object' && !Array.isArray(customObj)) {
          for (const [k, v] of Object.entries(customObj)) {
            if (typeof v === 'string' && v && !FORBIDDEN_KEYS.has(k)) {
              exact[k] = v;
            }
          }
        }
      }

      const rawRegex = safeReadJson(path.join(DICTS_DIR, 'regex_rules.json'), []);
      const regexRules = Array.isArray(rawRegex) ? rawRegex : [];

      return {
        exact,
        regexRules,
      };
    }

    function translateMenuLabel(label, menusTray) {
      if (typeof label !== 'string' || !label) return label;
      const exact = menusTray && menusTray.exact ? menusTray.exact : {};
      if (Object.prototype.hasOwnProperty.call(exact, label)) {
        return exact[label];
      }
      const compiled = Array.isArray(menusTray && menusTray.compiledRegexRules) ? menusTray.compiledRegexRules : null;
      if (compiled) {
        for (const r of compiled) {
          if (r.re.test(label)) {
            return label.replace(r.re, r.replace);
          }
        }
        return label;
      }
      const rules = Array.isArray(menusTray && menusTray.regexRules) ? menusTray.regexRules : [];
      for (const r of rules) {
        if (!r || typeof r.pattern !== 'string' || typeof r.replace !== 'string') continue;
        try {
          const re = new RegExp(r.pattern);
          if (re.test(label)) {
            return label.replace(re, r.replace);
          }
        } catch (_err) {}
      }
      return label;
    }

    function translateTemplateItems(template, menusTray, isTopLevel) {
      if (!Array.isArray(template)) return template;
      return template.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const cloned = { ...item };
        const skipTop = isTopLevel && RESERVED_TOP_MENU_LABELS.has(cloned.label);
        const skipUpdateId = cloned.id === 'check-for-updates';
        if (!skipTop && !skipUpdateId && typeof cloned.label === 'string') {
          cloned.label = translateMenuLabel(cloned.label, menusTray);
        }
        if (Array.isArray(cloned.submenu)) {
          cloned.submenu = translateTemplateItems(cloned.submenu, menusTray, false);
        }
        return cloned;
      });
    }

    function installMenuAndTrayWrappers() {
      const cfg = loadConfig();
      if (!cfg.enabled || !cfg.translateMenus) return;

      if (electron.Menu && typeof electron.Menu.buildFromTemplate === 'function' && !electron.Menu.__agyZhPatched) {
        const origBuildFromTemplate = electron.Menu.buildFromTemplate.bind(electron.Menu);
        electron.Menu.buildFromTemplate = function patchedBuildFromTemplate(template) {
          try {
            const menusTray = loadMenuDictionaries();
            const translated = translateTemplateItems(template, menusTray, true);
            return origBuildFromTemplate(translated);
          } catch (_err) {
            return origBuildFromTemplate(template);
          }
        };
        electron.Menu.__agyZhPatched = true;
      }

      if (electron.Tray && electron.Tray.prototype && typeof electron.Tray.prototype.setContextMenu === 'function' && !electron.Tray.prototype.__agyZhPatched) {
        const origSetContextMenu = electron.Tray.prototype.setContextMenu;
        electron.Tray.prototype.setContextMenu = function patchedSetContextMenu(menu) {
          try {
            if (menu && Array.isArray(menu.items)) {
              const menusTray = loadMenuDictionaries();
              for (const item of menu.items) {
                if (item && item.id === 'running-agents' && typeof item.label === 'string') {
                  item.label = translateMenuLabel(item.label, menusTray);
                }
              }
            }
          } catch (_err) {}
          return origSetContextMenu.call(this, menu);
        };
        electron.Tray.prototype.__agyZhPatched = true;
      }
    }

    function appendUntranslated(items) {
      if (!Array.isArray(items) || items.length === 0) return;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const existing = safeReadJson(UNTRANSLATED_PATH, {});
        const map = Object.create(null);
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
          for (const [k, v] of Object.entries(existing)) {
            if (!FORBIDDEN_KEYS.has(k) && typeof v === 'string') {
              map[k] = v;
            }
          }
        }
        let count = Object.keys(map).length;
        let changed = false;
        for (const text of items) {
          if (count >= MAX_UNTRANSLATED_KEYS) break;
          if (
            typeof text === 'string' &&
            text.length > 0 &&
            text.length <= MAX_UNTRANSLATED_TEXT_LEN &&
            !FORBIDDEN_KEYS.has(text) &&
            !Object.prototype.hasOwnProperty.call(map, text)
          ) {
            map[text] = '';
            count++;
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(UNTRANSLATED_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
        }
      } catch (_err) {}
    }

    function buildInjectedScript() {
      if (!fs.existsSync(RUNTIME_JS_PATH)) return null;
      const runtimeCode = fs.readFileSync(RUNTIME_JS_PATH, 'utf8');
      const cfg = loadConfig();
      const { exact, regexRules } = loadDictionaries();
      const payload = {
        enabled: cfg.enabled,
        collectUntranslated: cfg.collectUntranslated,
        exact,
        regexRules,
      };
      const serialized = JSON.stringify(payload)
        .replace(/<\/script/gi, '<\\/script')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

      return (
        '(function(){\n' +
        runtimeCode +
        '\ntry {\n' +
        '  var api = globalThis.__AGY_ZH_TRANSLATOR__;\n' +
        '  if (api && typeof api.installDomTranslator === "function") {\n' +
        '    api.installDomTranslator(' + serialized + ');\n' +
        '  }\n' +
        '} catch (_e) {}\n' +
        '})();'
      );
    }

    if (electron.app && typeof electron.app.on === 'function') {
      installMenuAndTrayWrappers();

      electron.app.on('web-contents-created', (_event, contents) => {
        try {
          if (!contents || (typeof contents.getType === 'function' && contents.getType() === 'webview')) {
            return;
          }

          let lastInjectedUrl = '';
          contents.on('did-start-navigation', (_navEvent, _url, isInPlace, isMainFrame) => {
            if (isMainFrame !== false && !isInPlace) {
              lastInjectedUrl = '';
            }
          });

          const inject = () => {
            try {
              const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
              if (!HUB_URL_RE.test(url)) return;
              if (lastInjectedUrl === url) return;
              const script = buildInjectedScript();
              if (!script) return;
              lastInjectedUrl = url;
              Promise.resolve(contents.executeJavaScript(script, true)).catch(() => {
                if (lastInjectedUrl === url) {
                  lastInjectedUrl = '';
                }
              });
            } catch (_err) {}
          };

          contents.on('dom-ready', inject);
          contents.on('did-finish-load', inject);
          contents.on('console-message', (event, _level, legacyMessage) => {
            const message = event && typeof event.message === 'string' ? event.message : legacyMessage;
            if (typeof message !== 'string' || !message.startsWith(COLLECT_PREFIX)) return;
            const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
            if (!HUB_URL_RE.test(url)) return;
            const cfg = loadConfig();
            if (!cfg.collectUntranslated) return;
            try {
              const batch = JSON.parse(message.slice(COLLECT_PREFIX.length));
              appendUntranslated(batch);
            } catch (_err) {}
          });
        } catch (_err) {}
      });
    }
  } catch (_err) {
    // 绝不抛出未捕获异常影响 Antigravity 主进程启动
  }
})();
