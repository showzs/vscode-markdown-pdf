'use strict';
var vscode = require('vscode');
var path = require('path');
var fs = require('fs');
var url = require('url');
var os = require('os');
const {
  install: installBrowser,
  Browser,
  detectBrowserPlatform,
  resolveBuildId,
  getInstalledBrowsers
} = require('@puppeteer/browsers');

const DEFAULT_PUPPETEER_VARIANT = 'modern';
const DEFAULT_BROWSER_CACHE_DIR = path.join(os.homedir(), '.cache', 'markdown-pdf-m');
const DEFAULT_MODERN_BROWSER_NAME = Browser.CHROME;
const DEFAULT_LEGACY_BROWSER_NAME = Browser.CHROMIUM;
let cachedBrowserEnvironment = null;
let pendingBrowserEnvironment = null;

async function activate(context) {
  await init();

  var commands = [
    vscode.commands.registerCommand('extension.markdown-pdf.settings', async function () { await markdownPdf('settings'); }),
    vscode.commands.registerCommand('extension.markdown-pdf.pdf', async function () { await markdownPdf('pdf'); }),
    vscode.commands.registerCommand('extension.markdown-pdf.html', async function () { await markdownPdf('html'); }),
    vscode.commands.registerCommand('extension.markdown-pdf.png', async function () { await markdownPdf('png'); }),
    vscode.commands.registerCommand('extension.markdown-pdf.jpeg', async function () { await markdownPdf('jpeg'); }),
    vscode.commands.registerCommand('extension.markdown-pdf.all', async function () { await markdownPdf('all'); }),
    vscode.commands.registerCommand('extension.markdown-pdf.installBrowser', async function () { await installConfiguredBrowser(); })
  ];
  commands.forEach(function (command) {
    context.subscriptions.push(command);
  });

  var isConvertOnSave = vscode.workspace.getConfiguration('markdown-pdf')['convertOnSave'];
  if (isConvertOnSave) {
    var disposable_onsave = vscode.workspace.onDidSaveTextDocument(function () { markdownPdfOnSave(); });
    context.subscriptions.push(disposable_onsave);
  }
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}
exports.deactivate = deactivate;

const PUPPETEER_VARIANTS = {
  modern: {
    id: 'modern',
    label: 'puppeteer-core@^24.26.1',
    requireModule: () => require('puppeteer-core'),
    requireRevisions: () => require('puppeteer-core/lib/cjs/puppeteer/revisions.js').PUPPETEER_REVISIONS
  },
  'legacy-v2': {
    id: 'legacy-v2',
    label: 'puppeteer-core@2.1.1',
    requireModule: () => require('puppeteer-core-v2'),
    requireRevisions: () => {
      const pkg = require('puppeteer-core-v2/package.json');
      const revision = pkg && pkg.puppeteer && pkg.puppeteer.chromium_revision;
      if (!revision) {
        return {};
      }
      return {
        chromium: revision,
        chrome: revision,
        'chrome-headless-shell': revision
      };
    }
  }
};

function safeTrim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = safeTrim(value);
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return '';
}

function resolvePuppeteerVariant(markdownPdfConfig) {
  const config = markdownPdfConfig || vscode.workspace.getConfiguration('markdown-pdf');
  const configPreference = safeTrim(config.get('browser.puppeteerCore'));
  const preference = pickFirstNonEmptyString(configPreference, DEFAULT_PUPPETEER_VARIANT);
  const key = Object.prototype.hasOwnProperty.call(PUPPETEER_VARIANTS, preference) ? preference : DEFAULT_PUPPETEER_VARIANT;
  const variant = PUPPETEER_VARIANTS[key];
  if (!variant.module) {
    variant.module = variant.requireModule();
  }
  if (!variant.revisions) {
    variant.revisions = variant.requireRevisions();
  }
  return variant;
}

function mapBrowserNameToEnum(name) {
  const normalized = (name || '').toLowerCase();
  switch (normalized) {
    case 'chrome':
    case 'google-chrome':
      return Browser.CHROME;
    case 'chromium':
      return Browser.CHROMIUM;
    case 'chrome-headless-shell':
    case 'chrome_headless_shell':
    case 'headless-shell':
      return Browser.CHROMEHEADLESSSHELL;
    default:
      throw new Error(`Unsupported browser configured: ${name}. Supported values are "chrome", "chromium", or "chrome-headless-shell".`);
  }
}

function normalizeBrowserOptions(markdownPdfConfig, puppeteerVariant) {
  const config = markdownPdfConfig || vscode.workspace.getConfiguration('markdown-pdf');
  const defaultName = puppeteerVariant && puppeteerVariant.id === 'legacy-v2' ? DEFAULT_LEGACY_BROWSER_NAME : DEFAULT_MODERN_BROWSER_NAME;
  const nameInput = pickFirstNonEmptyString(config.get('browser.name'), defaultName);
  const versionTag = pickFirstNonEmptyString(config.get('browser.version'));
  const channelTag = pickFirstNonEmptyString(config.get('browser.channel'));
  const requestedTag = pickFirstNonEmptyString(versionTag, channelTag);
  const cacheDirConfig = pickFirstNonEmptyString(config.get('browser.cacheDir'));
  const explicitExecutable = pickFirstNonEmptyString(config.get('executablePath'));

  let browserEnum;
  let browserName = nameInput || defaultName;
  try {
    browserEnum = mapBrowserNameToEnum(browserName);
  } catch (error) {
    showErrorMessage(error.message);
    browserName = defaultName;
    browserEnum = mapBrowserNameToEnum(browserName);
  }

  return {
    browser: browserEnum,
    browserName,
    requestedTag,
    cacheDir: cacheDirConfig || DEFAULT_BROWSER_CACHE_DIR,
    explicitExecutable,
    variantId: (puppeteerVariant && puppeteerVariant.id) || DEFAULT_PUPPETEER_VARIANT,
    revisions: (puppeteerVariant && puppeteerVariant.revisions) || {}
  };
}

function buildBrowserEnvironmentKey(options, variant) {
  return JSON.stringify({
    variant: variant.id,
    browser: options.browser,
    requestedTag: options.requestedTag,
    cacheDir: options.cacheDir,
    explicitExecutable: options.explicitExecutable
  });
}

async function ensureBrowserEnvironment(markdownPdfConfig, ensureOptions) {
  const options = ensureOptions || {};
  const silent = options.silent === true;
  const variant = resolvePuppeteerVariant(markdownPdfConfig);
  const browserOptions = normalizeBrowserOptions(markdownPdfConfig, variant);
  const cacheKey = buildBrowserEnvironmentKey(browserOptions, variant);

  if (cachedBrowserEnvironment && cachedBrowserEnvironment.key === cacheKey && isExistsPath(cachedBrowserEnvironment.environment.executablePath)) {
    return cachedBrowserEnvironment.environment;
  }

  if (pendingBrowserEnvironment && pendingBrowserEnvironment.key === cacheKey) {
    return pendingBrowserEnvironment.promise;
  }

  const runner = (async () => {
    try {
      const executablePath = await resolveExecutablePathForVariant(browserOptions, variant);
      const environment = {
        module: variant.module,
        executablePath,
        variantId: variant.id,
        browserName: browserOptions.browserName
      };
      cachedBrowserEnvironment = { key: cacheKey, environment };
      return environment;
    } finally {
      if (pendingBrowserEnvironment && pendingBrowserEnvironment.key === cacheKey) {
        pendingBrowserEnvironment = null;
      }
    }
  })();

  pendingBrowserEnvironment = { key: cacheKey, promise: runner };

  try {
    return await runner;
  } catch (error) {
    if (!silent) {
      throw error;
    }
    console.warn('[Markdown PDF] Browser preparation deferred:', error);
    return {
      module: variant.module,
      executablePath: null,
      variantId: variant.id,
      browserName: browserOptions.browserName
    };
  }
}

async function resolveExecutablePathForVariant(browserOptions, variant) {
  const explicit = browserOptions.explicitExecutable;
  if (explicit) {
    if (!isExistsPath(explicit)) {
      throw new Error(`Configured executablePath does not exist: ${explicit}`);
    }
    return explicit;
  }

  if (!variant.module) {
    variant.module = variant.requireModule();
  }

  if (variant.id === 'legacy-v2') {
    return await ensureLegacyBrowserExecutable(browserOptions, variant);
  }

  return await ensureModernBrowserExecutable(browserOptions, variant);
}

async function ensureLegacyBrowserExecutable(browserOptions, variant) {
  const requestedRevision = browserOptions.requestedTag;
  if (requestedRevision && !/^[0-9]+$/.test(requestedRevision)) {
    throw new Error('Legacy puppeteer-core only supports numeric Chromium revisions. Please switch to the modern variant to request versions or channels.');
  }

  const revisions = browserOptions.revisions || {};
  const fallbackRevision = revisions.chromium || revisions.chrome || revisions['chrome-headless-shell'];
  const revision = requestedRevision || fallbackRevision;
  if (!revision) {
    throw new Error('Unable to determine a Chromium revision for the legacy puppeteer-core variant.');
  }

  const puppeteerModule = variant.module;
  if (typeof puppeteerModule.createBrowserFetcher !== 'function') {
    throw new Error('The legacy puppeteer-core variant does not expose createBrowserFetcher().');
  }

  const legacyCacheRoot = path.join(browserOptions.cacheDir, 'legacy-v2');
  mkdir(legacyCacheRoot);
  const fetcher = puppeteerModule.createBrowserFetcher({ path: legacyCacheRoot });
  const revisionInfo = fetcher.revisionInfo(revision);
  if (!revisionInfo.local || !isExistsPath(revisionInfo.executablePath)) {
    setProxy();
    await fetcher.download(revision);
  }
  return revisionInfo.executablePath;
}

async function ensureModernBrowserExecutable(browserOptions, variant) {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('Unable to detect a supported browser platform for this system.');
  }

  const cacheDir = browserOptions.cacheDir || DEFAULT_BROWSER_CACHE_DIR;
  const requestedTag = browserOptions.requestedTag;
  let buildId;
  if (requestedTag) {
    if (/^[0-9]+$/.test(requestedTag)) {
      buildId = requestedTag;
    } else {
      buildId = await resolveBuildId(browserOptions.browser, platform, requestedTag);
    }
  } else {
    const revisions = browserOptions.revisions || {};
    const revisionKey = browserOptions.browserName.toLowerCase();
    buildId = revisions[revisionKey] || revisions[browserOptions.browser] || revisions[DEFAULT_MODERN_BROWSER_NAME] || '';
    if (!buildId) {
      const fallbackTag = browserOptions.browser === Browser.CHROME ? 'stable' : 'latest';
      buildId = await resolveBuildId(browserOptions.browser, platform, fallbackTag);
    }
  }

  const installedBrowsers = await getInstalledBrowsers({ cacheDir });
  const existing = installedBrowsers.find((entry) => {
    return entry.browser === browserOptions.browser && entry.platform === platform && entry.buildId === buildId;
  });
  if (existing && isExistsPath(existing.executablePath)) {
    return existing.executablePath;
  }

  const progress = createStatusBarProgress(`[Markdown PDF] Downloading ${browserOptions.browserName}`);
  try {
    setProxy();
    const installed = await installBrowser({
      cacheDir,
      browser: browserOptions.browser,
      buildId,
      buildIdAlias: requestedTag && requestedTag !== buildId ? requestedTag : undefined,
      platform,
      downloadProgressCallback: (downloadedBytes, totalBytes) => {
        progress.report(downloadedBytes, totalBytes);
      }
    });
    progress.complete(`[Markdown PDF] Downloaded ${browserOptions.browserName} (${buildId})`);
    return installed.executablePath;
  } finally {
    progress.dispose();
  }
}

function createStatusBarProgress(label) {
  let disposable;
  let lastPercent = -1;
  const setMessage = (message, timeout) => {
    if (disposable) {
      disposable.dispose();
    }
    if (typeof timeout === 'number') {
      disposable = vscode.window.setStatusBarMessage(message, timeout);
    } else {
      disposable = vscode.window.setStatusBarMessage(message);
    }
  };
  return {
    report(downloadedBytes, totalBytes) {
      if (!totalBytes) {
        setMessage(label);
        return;
      }
      const percent = Math.floor((downloadedBytes / totalBytes) * 100);
      if (percent === lastPercent) {
        return;
      }
      lastPercent = percent;
      setMessage(`${label} ${percent}%`);
    },
    complete(message) {
      if (message) {
        setMessage(message, 5000);
      }
    },
    dispose() {
      if (disposable) {
        disposable.dispose();
        disposable = undefined;
      }
    }
  };
}

async function markdownPdf(option_type) {

  try {

    // check active window
    var editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active Editor!');
      return;
    }

    // check markdown mode
    var mode = editor.document.languageId;
    if (mode != 'markdown') {
      vscode.window.showWarningMessage('It is not a markdown mode!');
      return;
    }

    var uri = editor.document.uri;
    var mdfilename = uri.fsPath;
    var ext = path.extname(mdfilename);
    if (!isExistsPath(mdfilename)) {
      if (editor.document.isUntitled) {
        vscode.window.showWarningMessage('Please save the file!');
        return;
      }
      vscode.window.showWarningMessage('File name does not get!');
      return;
    }

    var types_format = ['html', 'pdf', 'png', 'jpeg'];
    var filename = '';
    var types = [];
    if (types_format.indexOf(option_type) >= 0) {
      types[0] = option_type;
    } else if (option_type === 'settings') {
      var types_tmp = vscode.workspace.getConfiguration('markdown-pdf')['type'] || 'pdf';
      if (types_tmp && !Array.isArray(types_tmp)) {
          types[0] = types_tmp;
      } else {
        types = vscode.workspace.getConfiguration('markdown-pdf')['type'] || 'pdf';
      }
    } else if (option_type === 'all') {
      types = types_format;
    } else {
      showErrorMessage('markdownPdf().1 Supported formats: html, pdf, png, jpeg.');
      return;
    }

    // convert and export markdown to pdf, html, png, jpeg
    if (types && Array.isArray(types) && types.length > 0) {
      for (var i = 0; i < types.length; i++) {
        var type = types[i];
        if (types_format.indexOf(type) >= 0) {
          filename = mdfilename.replace(ext, '.' + type);
          var text = editor.document.getText();
          var content = convertMarkdownToHtml(mdfilename, type, text);
          var html = makeHtml(content, uri);
          await exportPdf(html, filename, type, uri);
        } else {
          showErrorMessage('markdownPdf().2 Supported formats: html, pdf, png, jpeg.');
          return;
        }
      }
    } else {
      showErrorMessage('markdownPdf().3 Supported formats: html, pdf, png, jpeg.');
      return;
    }
  } catch (error) {
    showErrorMessage('markdownPdf()', error);
  }
}

function markdownPdfOnSave() {
  try {
    var editor = vscode.window.activeTextEditor;
    var mode = editor.document.languageId;
    if (mode != 'markdown') {
      return;
    }
    if (!isMarkdownPdfOnSaveExclude()) {
      markdownPdf('settings');
    }
  } catch (error) {
    showErrorMessage('markdownPdfOnSave()', error);
  }
}

function isMarkdownPdfOnSaveExclude() {
  try{
    var editor = vscode.window.activeTextEditor;
    var filename = path.basename(editor.document.fileName);
    var patterns = vscode.workspace.getConfiguration('markdown-pdf')['convertOnSaveExclude'] || '';
    var pattern;
    var i;
    if (patterns && Array.isArray(patterns) && patterns.length > 0) {
      for (i = 0; i < patterns.length; i++) {
        pattern = patterns[i];
        var re = new RegExp(pattern);
        if (re.test(filename)) {
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    showErrorMessage('isMarkdownPdfOnSaveExclude()', error);
  }
}

/*
 * convert markdown to html (markdown-it)
 */
function convertMarkdownToHtml(filename, type, text) {
  var grayMatter = require("gray-matter");
  var matterParts = grayMatter(text);

  try {
    try {
      var statusbarmessage = vscode.window.setStatusBarMessage('$(markdown) Converting (convertMarkdownToHtml) ...');
      var hljs = require('highlight.js');
      var breaks = setBooleanValue(matterParts.data.breaks, vscode.workspace.getConfiguration('markdown-pdf')['breaks']);
      var md = require('markdown-it')({
        html: true,
        breaks: breaks,
        highlight: function (str, lang) {

          if (lang && lang.match(/\bmermaid\b/i)) {
            return `<div class="mermaid">${str}</div>`;
          }

          if (lang && hljs.getLanguage(lang)) {
            try {
              str = hljs.highlight(lang, str, true).value;
            } catch (error) {
              str = md.utils.escapeHtml(str);

              showErrorMessage('markdown-it:highlight', error);
            }
          } else {
            str = md.utils.escapeHtml(str);
          }
          return '<pre class="hljs"><code><div>' + str + '</div></code></pre>';
        }
      });
    } catch (error) {
      statusbarmessage.dispose();
      showErrorMessage('require(\'markdown-it\')', error);
    }

  // convert the img src of the markdown
  var cheerio = require('cheerio');
  var defaultRender = md.renderer.rules.image;
  md.renderer.rules.image = function (tokens, idx, options, env, self) {
    var token = tokens[idx];
    var href = token.attrs[token.attrIndex('src')][1];
    // console.log("original href: " + href);
    if (type === 'html') {
      href = decodeURIComponent(href).replace(/("|')/g, '');
    } else {
      href = convertImgPath(href, filename);
    }
    // console.log("converted href: " + href);
    token.attrs[token.attrIndex('src')][1] = href;
    // // pass token to default renderer.
    return defaultRender(tokens, idx, options, env, self);
  };

  if (type !== 'html') {
    // convert the img src of the html
    const defaultHtmlBlockRendarer = md.renderer.rules.html_block;
    md.renderer.rules.html_block = function (tokens, idx, options, env, self) {
      var html = tokens[idx].content;
      var $ = cheerio.load(html);
      let hasImg = false;
      $('img').each(function () {
        var src = $(this).attr('src');
        var href = convertImgPath(src, filename);
        $(this).attr('src', href);
        hasImg = true;
      });
      if (hasImg) {
        return $('body').html();
      } else {
        return defaultHtmlBlockRendarer(tokens, idx, options, env, self)
      }
    };
  }

  // checkbox
  md.use(require('markdown-it-checkbox'));

  // emoji
  var emoji_f = setBooleanValue(matterParts.data.emoji, vscode.workspace.getConfiguration('markdown-pdf')['emoji']);
  if (emoji_f) {
    var emojies_defs = require(path.join(__dirname, 'data', 'emoji.json'));
    try {
      var options = {
        defs: emojies_defs
      };
    } catch (error) {
      statusbarmessage.dispose();
      showErrorMessage('markdown-it-emoji:options', error);
    }
    md.use(require('markdown-it-emoji'), options);
    md.renderer.rules.emoji = function (token, idx) {
      var emoji = token[idx].markup;
      var emojipath = path.join(__dirname, 'node_modules', 'emoji-images', 'pngs', emoji + '.png');
      var emojidata = readFile(emojipath, null).toString('base64');
      if (emojidata) {
        return '<img class="emoji" alt="' + emoji + '" src="data:image/png;base64,' + emojidata + '" />';
      } else {
        return ':' + emoji + ':';
      }
    };
  }

  // toc
  applyHeadingIds(md, Slug);

  // markdown-it-container
  // https://github.com/markdown-it/markdown-it-container
  md.use(require('markdown-it-container'), '', {
    validate: function (name) {
      return name.trim().length;
    },
    render: function (tokens, idx) {
      if (tokens[idx].info.trim() !== '') {
        return `<div class="${tokens[idx].info.trim()}">\n`;
      } else {
        return `</div>\n`;
      }
    }
  });

  // PlantUML
  // https://github.com/gmunguia/markdown-it-plantuml
  var plantumlOptions = {
    openMarker: matterParts.data.plantumlOpenMarker || vscode.workspace.getConfiguration('markdown-pdf')['plantumlOpenMarker'] || '@startuml',
    closeMarker: matterParts.data.plantumlCloseMarker || vscode.workspace.getConfiguration('markdown-pdf')['plantumlCloseMarker'] || '@enduml',
    server: vscode.workspace.getConfiguration('markdown-pdf')['plantumlServer'] || ''
  }
  md.use(require('markdown-it-plantuml'), plantumlOptions);

  // markdown-it-include
  // https://github.com/camelaissani/markdown-it-include
  // the syntax is :[alt-text](relative-path-to-file.md)
  // https://talk.commonmark.org/t/transclusion-or-including-sub-documents-for-reuse/270/13
  if (vscode.workspace.getConfiguration('markdown-pdf')['markdown-it-include']['enable']) {
    md.use(require("markdown-it-include"), {
      root: path.dirname(filename),
      includeRe: /:\[.+\]\((.+\..+)\)/i
    });
  }

  statusbarmessage.dispose();
  return md.render(matterParts.content);

  } catch (error) {
    statusbarmessage.dispose();
    showErrorMessage('convertMarkdownToHtml()', error);
  }
}

/*
 * https://github.com/microsoft/vscode/blob/ca4ceeb87d4ff935c52a7af0671ed9779657e7bd/extensions/markdown-language-features/src/slugify.ts#L26
 */
function Slug(string) {
  try {
    var stg = encodeURI(
      string.trim()
            .toLowerCase()
            .replace(/\s+/g, '-') // Replace whitespace with -
            .replace(/[\]\[\!\'\#\$\%\&\(\)\*\+\,\.\/\:\;\<\=\>\?\@\\\^\_\{\|\}\~\`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g, '') // Remove known punctuators
            .replace(/^\-+/, '') // Remove leading -
            .replace(/\-+$/, '') // Remove trailing -
    );
    return stg;
  } catch (error) {
    showErrorMessage('Slug()', error);
  }
}

/*
 * make html
 */
function makeHtml(data, uri) {
  try {
    // read styles
    var style = '';
    style += readStyles(uri);

    // get title
    var title = path.basename(uri.fsPath);

    // read template
    var filename = path.join(__dirname, 'template', 'template.html');
    var template = readFile(filename);

    // read mermaid javascripts
    var mermaidServer = vscode.workspace.getConfiguration('markdown-pdf')['mermaidServer'] || '';
    var mermaid = '<script src=\"' + mermaidServer + '\"></script>';

    // compile template
    var mustache = require('mustache');

    var view = {
      title: title,
      style: style,
      content: data,
      mermaid: mermaid
    };
    return mustache.render(template, view);
  } catch (error) {
    showErrorMessage('makeHtml()', error);
  }
}

/*
 * export a html to a html file
 */
function exportHtml(data, filename) {
  fs.writeFile(filename, data, 'utf-8', function (error) {
    if (error) {
      showErrorMessage('exportHtml()', error);
      return;
    }
  });
}

/*
 * export a html to a pdf file (html-pdf)
 */
function exportPdf(data, filename, type, uri) {

  const markdownPdfConfig = vscode.workspace.getConfiguration('markdown-pdf', uri);
  var StatusbarMessageTimeout = markdownPdfConfig['StatusbarMessageTimeout'];
  vscode.window.setStatusBarMessage('');
  var exportFilename = getOutputDir(filename, uri);

  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '[Markdown PDF]: Exporting (' + type + ') ...'
    }, async () => {
      try {
        // export html
        if (type == 'html') {
          exportHtml(data, exportFilename);
          vscode.window.setStatusBarMessage('$(markdown) ' + exportFilename, StatusbarMessageTimeout);
          return;
        }

        const environment = await ensureBrowserEnvironment(markdownPdfConfig);
        if (!environment || !environment.executablePath) {
          throw new Error('Failed to resolve a browser executable path.');
        }
        const puppeteerModule = environment.module;
        // create temporary file
        var f = path.parse(filename);
        var tmpfilename = path.join(f.dir, f.name + '_tmp.html');
        exportHtml(data, tmpfilename);
        var options = {
          executablePath: environment.executablePath,
          args: ['--lang='+vscode.env.language, '--no-sandbox', '--disable-setuid-sandbox']
          // Setting Up Chrome Linux Sandbox
          // https://github.com/puppeteer/puppeteer/blob/master/docs/troubleshooting.md#setting-up-chrome-linux-sandbox
      };
        const browser = await puppeteerModule.launch(options);
        const page = await browser.newPage();
        await page.setDefaultTimeout(0);
        await page.goto(vscode.Uri.file(tmpfilename).toString(), { waitUntil: 'networkidle0' });
        // generate pdf
        // https://github.com/GoogleChrome/puppeteer/blob/master/docs/api.md#pagepdfoptions
        if (type == 'pdf') {
          // If width or height option is set, it overrides the format option.
          // In order to set the default value of page size to A4, we changed it from the specification of puppeteer.
          var width_option = vscode.workspace.getConfiguration('markdown-pdf', uri)['width'] || '';
          var height_option = vscode.workspace.getConfiguration('markdown-pdf', uri)['height'] || '';
          var format_option = '';
          if (!width_option && !height_option) {
            format_option = vscode.workspace.getConfiguration('markdown-pdf', uri)['format'] || 'A4';
          }
          var landscape_option;
          if (vscode.workspace.getConfiguration('markdown-pdf', uri)['orientation'] == 'landscape') {
            landscape_option = true;
          } else {
            landscape_option = false;
          }
          var options = {
            path: exportFilename,
            scale: vscode.workspace.getConfiguration('markdown-pdf', uri)['scale'],
            displayHeaderFooter: vscode.workspace.getConfiguration('markdown-pdf', uri)['displayHeaderFooter'],
            headerTemplate: transformTemplate(vscode.workspace.getConfiguration('markdown-pdf', uri)['headerTemplate'] || ''),
            footerTemplate: transformTemplate(vscode.workspace.getConfiguration('markdown-pdf', uri)['footerTemplate'] || ''),
            printBackground: vscode.workspace.getConfiguration('markdown-pdf', uri)['printBackground'],
            landscape: landscape_option,
            pageRanges: vscode.workspace.getConfiguration('markdown-pdf', uri)['pageRanges'] || '',
            format: format_option,
            width: vscode.workspace.getConfiguration('markdown-pdf', uri)['width'] || '',
            height: vscode.workspace.getConfiguration('markdown-pdf', uri)['height'] || '',
            margin: {
              top: vscode.workspace.getConfiguration('markdown-pdf', uri)['margin']['top'] || '',
              right: vscode.workspace.getConfiguration('markdown-pdf', uri)['margin']['right'] || '',
              bottom: vscode.workspace.getConfiguration('markdown-pdf', uri)['margin']['bottom'] || '',
              left: vscode.workspace.getConfiguration('markdown-pdf', uri)['margin']['left'] || ''
            },
            timeout: 0
          };
          await page.pdf(options);
        }

        // generate png and jpeg
        // https://github.com/GoogleChrome/puppeteer/blob/master/docs/api.md#pagescreenshotoptions
        if (type == 'png' || type == 'jpeg') {
          // Quality options do not apply to PNG images.
          var quality_option;
          if (type == 'png') {
            quality_option = undefined;
          }
          if (type == 'jpeg') {
            quality_option = vscode.workspace.getConfiguration('markdown-pdf')['quality'] || 100;
          }

          // screenshot size
          var clip_x_option = vscode.workspace.getConfiguration('markdown-pdf')['clip']['x'] || null;
          var clip_y_option = vscode.workspace.getConfiguration('markdown-pdf')['clip']['y'] || null;
          var clip_width_option = vscode.workspace.getConfiguration('markdown-pdf')['clip']['width'] || null;
          var clip_height_option = vscode.workspace.getConfiguration('markdown-pdf')['clip']['height'] || null;
          var options;
          if (clip_x_option !== null && clip_y_option !== null && clip_width_option !== null && clip_height_option !== null) {
            options = {
              path: exportFilename,
              quality: quality_option,
              fullPage: false,
              clip: {
                x: clip_x_option,
                y: clip_y_option,
                width: clip_width_option,
                height: clip_height_option,
              },
              omitBackground: vscode.workspace.getConfiguration('markdown-pdf')['omitBackground'],
            }
          } else {
            options = {
              path: exportFilename,
              quality: quality_option,
              fullPage: true,
              omitBackground: vscode.workspace.getConfiguration('markdown-pdf')['omitBackground'],
            }
          }
          await page.screenshot(options);
        }

        await browser.close();

        // delete temporary file
        var debug = vscode.workspace.getConfiguration('markdown-pdf')['debug'] || false;
        if (!debug) {
          if (isExistsPath(tmpfilename)) {
            deleteFile(tmpfilename);
          }
        }

        vscode.window.setStatusBarMessage('$(markdown) ' + exportFilename, StatusbarMessageTimeout);
      } catch (error) {
        showErrorMessage('exportPdf()', error);
      }
    } // async
  ); // vscode.window.withProgress
}

/**
 * Transform the text of the header or footer template, replacing the following supported placeholders:
 *
 * - `%%ISO-DATETIME%%` – For an ISO-based date and time format: `YYYY-MM-DD hh:mm:ss`
 * - `%%ISO-DATE%%` – For an ISO-based date format: `YYYY-MM-DD`
 * - `%%ISO-TIME%%` – For an ISO-based time format: `hh:mm:ss`
 */
function transformTemplate(templateText) {
  if (templateText.indexOf('%%ISO-DATETIME%%') !== -1) {
    templateText = templateText.replace('%%ISO-DATETIME%%', new Date().toISOString().substr(0, 19).replace('T', ' '));
  }
  if (templateText.indexOf('%%ISO-DATE%%') !== -1) {
    templateText = templateText.replace('%%ISO-DATE%%', new Date().toISOString().substr(0, 10));
  }
  if (templateText.indexOf('%%ISO-TIME%%') !== -1) {
    templateText = templateText.replace('%%ISO-TIME%%', new Date().toISOString().substr(11, 8));
  }

  return templateText;
}

function isExistsPath(path) {
  if (path.length === 0) {
    return false;
  }
  try {
    fs.accessSync(path);
    return true;
  } catch (error) {
    console.warn(error.message);
    return false;
  }
}

function isExistsDir(dirname) {
  if (dirname.length === 0) {
    return false;
  }
  try {
    if (fs.statSync(dirname).isDirectory()) {
      return true;
    } else {
      console.warn('Directory does not exist!') ;
      return false;
    }
  } catch (error) {
    console.warn(error.message);
    return false;
  }
}

function deleteFile (path) {
  var rimraf = require('rimraf')
  rimraf.sync(path);
}

function getOutputDir(filename, resource) {
  try {
    var outputDir;
    if (resource === undefined) {
      return filename;
    }
    var outputDirectory = vscode.workspace.getConfiguration('markdown-pdf')['outputDirectory'] || '';
    if (outputDirectory.length === 0) {
      return filename;
    }

    // Use a home directory relative path If it starts with ~.
    if (outputDirectory.indexOf('~') === 0) {
      outputDir = outputDirectory.replace(/^~/, os.homedir());
      mkdir(outputDir);
      return path.join(outputDir, path.basename(filename));
    }

    // Use path if it is absolute
    if (path.isAbsolute(outputDirectory)) {
      if (!isExistsDir(outputDirectory)) {
        showErrorMessage(`The output directory specified by the markdown-pdf.outputDirectory option does not exist.\
          Check the markdown-pdf.outputDirectory option. ` + outputDirectory);
        return;
      }
      return path.join(outputDirectory, path.basename(filename));
    }

    // Use a workspace relative path if there is a workspace and markdown-pdf.outputDirectoryRootPath = workspace
    var outputDirectoryRelativePathFile = vscode.workspace.getConfiguration('markdown-pdf')['outputDirectoryRelativePathFile'];
    let root = vscode.workspace.getWorkspaceFolder(resource);
    if (outputDirectoryRelativePathFile === false && root) {
      outputDir = path.join(root.uri.fsPath, outputDirectory);
      mkdir(outputDir);
      return path.join(outputDir, path.basename(filename));
    }

    // Otherwise look relative to the markdown file
    outputDir = path.join(path.dirname(resource.fsPath), outputDirectory);
    mkdir(outputDir);
    return path.join(outputDir, path.basename(filename));
  } catch (error) {
    showErrorMessage('getOutputDir()', error);
  }
}

function mkdir(path) {
  if (isExistsDir(path)) {
    return;
  }
  var mkdirp = require('mkdirp');
  return mkdirp.sync(path);
}

function readFile(filename, encode) {
  if (filename.length === 0) {
    return '';
  }
  if (!encode && encode !== null) {
    encode = 'utf-8';
  }
  if (filename.indexOf('file://') === 0) {
    if (process.platform === 'win32') {
      filename = filename.replace(/^file:\/\/\//, '')
                 .replace(/^file:\/\//, '');
    } else {
      filename = filename.replace(/^file:\/\//, '');
    }
  }
  if (isExistsPath(filename)) {
    return fs.readFileSync(filename, encode);
  } else {
    return '';
  }
}

function convertImgPath(src, filename) {
  try {
    var href = decodeURIComponent(src);
    href = href.replace(/("|')/g, '')
          .replace(/\\/g, '/')
          .replace(/#/g, '%23');
    var protocol = url.parse(href).protocol;
    if (protocol === 'file:' && href.indexOf('file:///') !==0) {
      return href.replace(/^file:\/\//, 'file:///');
    } else if (protocol === 'file:') {
      return href;
    } else if (!protocol || path.isAbsolute(href)) {
      href = path.resolve(path.dirname(filename), href).replace(/\\/g, '/')
                                                      .replace(/#/g, '%23');
      if (href.indexOf('//') === 0) {
        return 'file:' + href;
      } else if (href.indexOf('/') === 0) {
        return 'file://' + href;
      } else {
        return 'file:///' + href;
      }
    } else {
      return src;
    }
  } catch (error) {
    showErrorMessage('convertImgPath()', error);
  }
}

function makeCss(filename) {
  try {
    var css = readFile(filename);
    if (css) {
      return '\n<style>\n' + css + '\n</style>\n';
    } else {
      return '';
    }
  } catch (error) {
    showErrorMessage('makeCss()', error);
  }
}

function readStyles(uri) {
  try {
    var includeDefaultStyles;
    var style = '';
    var styles = '';
    var filename = '';
    var i;

    includeDefaultStyles = vscode.workspace.getConfiguration('markdown-pdf')['includeDefaultStyles'];

    // 1. read the style of the vscode.
    if (includeDefaultStyles) {
      filename = path.join(__dirname, 'styles', 'markdown.css');
      style += makeCss(filename);
    }

    // 2. read the style of the markdown.styles setting.
    if (includeDefaultStyles) {
      styles = vscode.workspace.getConfiguration('markdown')['styles'];
      if (styles && Array.isArray(styles) && styles.length > 0) {
        for (i = 0; i < styles.length; i++) {
          var href = fixHref(uri, styles[i]);
          style += '<link rel=\"stylesheet\" href=\"' + href + '\" type=\"text/css\">';
        }
      }
    }

    // 3. read the style of the highlight.js.
    var highlightStyle = vscode.workspace.getConfiguration('markdown-pdf')['highlightStyle'] || '';
    var ishighlight = vscode.workspace.getConfiguration('markdown-pdf')['highlight'];
    if (ishighlight) {
      if (highlightStyle) {
        var css = vscode.workspace.getConfiguration('markdown-pdf')['highlightStyle'] || 'github.css';
        filename = path.join(__dirname, 'node_modules', 'highlight.js', 'styles', css);
        style += makeCss(filename);
      } else {
        filename = path.join(__dirname, 'styles', 'tomorrow.css');
        style += makeCss(filename);
      }
    }

    // 4. read the style of the markdown-pdf.
    if (includeDefaultStyles) {
      filename = path.join(__dirname, 'styles', 'markdown-pdf.css');
      style += makeCss(filename);
    }

    // 5. read the style of the markdown-pdf.styles settings.
    styles = vscode.workspace.getConfiguration('markdown-pdf')['styles'] || '';
    if (styles && Array.isArray(styles) && styles.length > 0) {
      for (i = 0; i < styles.length; i++) {
        var href = fixHref(uri, styles[i]);
        style += '<link rel=\"stylesheet\" href=\"' + href + '\" type=\"text/css\">';
      }
    }

    return style;
  } catch (error) {
    showErrorMessage('readStyles()', error);
  }
}

function applyHeadingIds(md, slugify) {
  const seen = Object.create(null);
  const defaultRender = md.renderer.rules.heading_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    if (token && !token.attrGet('id')) {
      const inlineToken = tokens[idx + 1];
      let text = '';
      if (inlineToken && inlineToken.type === 'inline') {
        text = inlineToken.content || '';
        if (!text && Array.isArray(inlineToken.children)) {
          text = inlineToken.children.map((child) => child.content || '').join('');
        }
      }

      text = text.trim();
      if (text) {
        let slug = slugify(text);
        if (slug) {
          const baseSlug = slug;
          if (Object.prototype.hasOwnProperty.call(seen, baseSlug)) {
            seen[baseSlug] += 1;
            slug = `${baseSlug}-${seen[baseSlug]}`;
          } else {
            seen[baseSlug] = 0;
          }
          token.attrSet('id', slug);
        }
      }
    }
    return defaultRender(tokens, idx, options, env, self);
  };
}

/*
 * vscode/extensions/markdown-language-features/src/features/previewContentProvider.ts fixHref()
 * https://github.com/Microsoft/vscode/blob/0c47c04e85bc604288a288422f0a7db69302a323/extensions/markdown-language-features/src/features/previewContentProvider.ts#L95
 *
 * Extension Authoring: Adopting Multi Root Workspace APIs ?E Microsoft/vscode Wiki
 * https://github.com/Microsoft/vscode/wiki/Extension-Authoring:-Adopting-Multi-Root-Workspace-APIs
 */
function fixHref(resource, href) {
  try {
    if (!href) {
      return href;
    }

    // Use href if it is already an URL
    const hrefUri = vscode.Uri.parse(href);
    if (['http', 'https'].indexOf(hrefUri.scheme) >= 0) {
      return hrefUri.toString();
    }

    // Use a home directory relative path If it starts with ^.
    if (href.indexOf('~') === 0) {
      return vscode.Uri.file(href.replace(/^~/, os.homedir())).toString();
    }

    // Use href as file URI if it is absolute
    if (path.isAbsolute(href)) {
      return vscode.Uri.file(href).toString();
    }

    // Use a workspace relative path if there is a workspace and markdown-pdf.stylesRelativePathFile is false
    var stylesRelativePathFile = vscode.workspace.getConfiguration('markdown-pdf')['stylesRelativePathFile'];
    let root = vscode.workspace.getWorkspaceFolder(resource);
    if (stylesRelativePathFile === false && root) {
      return vscode.Uri.file(path.join(root.uri.fsPath, href)).toString();
    }

    // Otherwise look relative to the markdown file
    return vscode.Uri.file(path.join(path.dirname(resource.fsPath), href)).toString();
  } catch (error) {
    showErrorMessage('fixHref()', error);
  }
}

function showErrorMessage(msg, error) {
  vscode.window.showErrorMessage('ERROR: ' + msg);
  console.log('ERROR: ' + msg);
  if (error) {
    vscode.window.showErrorMessage(error.toString());
    console.log(error);
  }
}

function setProxy() {
  var https_proxy = vscode.workspace.getConfiguration('http')['proxy'] || '';
  if (https_proxy) {
    process.env.HTTPS_PROXY = https_proxy;
    process.env.HTTP_PROXY = https_proxy;
  }
}

function setBooleanValue(a, b) {
  if (a === false) {
    return false
  } else {
    return a || b
  }
}

async function init() {
  try {
    await ensureBrowserEnvironment(null, { silent: true });
  } catch (error) {
    console.warn('[Markdown PDF] Browser preflight failed:', error);
  }
}

async function installConfiguredBrowser() {
  try {
    const config = vscode.workspace.getConfiguration('markdown-pdf');
    const env = await ensureBrowserEnvironment(config, { silent: false });
    if (env && env.executablePath && isExistsPath(env.executablePath)) {
      vscode.window.showInformationMessage(`[Markdown PDF] Browser is ready: ${env.browserName} (${env.variantId})`);
    } else {
      vscode.window.showWarningMessage('[Markdown PDF] Browser install completed but executable path was not resolved');
    }
  } catch (error) {
    showErrorMessage('installConfiguredBrowser()', error);
  }
}
