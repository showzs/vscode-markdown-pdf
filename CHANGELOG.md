# Change Log

## 0.2.0(2025/XX/XX)
* merge https://github.com/yzane/vscode-markdown-pdf release 1.5.0


## 0.1.1 (2023/08/22)
* fix edit HTML_block depending update cheerio
* marge https://github.com/yzane/vscode-markdown-pdf/pull/266   
  Avoid TimeoutError: Navigation timeout of 30000 ms exceeded and TimeoutError: waiting for Page.printToPDF failed: timeout 30000ms exceeded

## 0.1.0 (2023/08/14)

based on https://github.com/yzane/vscode-markdown-pdf/releases/tag/1.4.4

* Audit fix, and package update
* Preserve the HTML_block  if no editing is needed

## Change Log from upstream

### 1.5.0 (2023/09/08)
* Improve: The default date format for headers and footers has been changed to the ISO-based format (YYYY-MM-DD).
  * Support different date formats in templates [#197](https://github.com/yzane/vscode-markdown-pdf/pull/197)
* Improve: Avoid TimeoutError: Navigation timeout of 30000 ms exceeded and TimeoutError: waiting for Page.printToPDF failed: timeout 30000ms exceeded [#266](https://github.com/yzane/vscode-markdown-pdf/pull/266)
* Fix: Fix description of outputDirectoryRelativePathFile [#238](https://github.com/yzane/vscode-markdown-pdf/pull/238)
* README
  * Add: Specification Changes
  * Fix: Broken link

### 1.4.4 (2020/03/19)
* Change: mermaid javascript reads from URL instead of from local file
  * Add: `markdown-pdf.mermaidServer` option
  * add an option to disable mermaid [#175](https://github.com/yzane/vscode-markdown-pdf/issues/175)
* Add: `markdown-pdf.plantumlServer` option
  * support configuration of plantUML server [#139](https://github.com/yzane/vscode-markdown-pdf/issues/139)
* Add: configuration scope
  * extend setting 'headerTemplate' with scope\.\.\. [#184](https://github.com/yzane/vscode-markdown-pdf/pull/184)
* Update: [slug](https://github.com/yzane/vscode-markdown-pdf/commit/3f4aeaa724999c46fc37423d4b188fd7ce72ffce) for markdown-it-named-headers
* Update: markdown.css, markdown-pdf.css
* Update: dependent packages
* Fix: Fix for issue \#186 [#187](https://github.com/yzane/vscode-markdown-pdf/pull/187)
* Fix: move the Meiryo font to the end of the font-family setting
  * Meiryo font causing \\ to show as ¥ [#83](https://github.com/yzane/vscode-markdown-pdf/issues/83)
  * Backslash false encoded [#124](https://github.com/yzane/vscode-markdown-pdf/issues/124)
  * Errors in which 한글\(korean word\) is not properly printed [#148](https://github.com/yzane/vscode-markdown-pdf/issues/148)
* Fix: Improve the configuration schema of package.json
  * Some settings can now be set from the settings editor.