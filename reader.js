/**
 * MangaBot WebApp Reader
 */

(function () {
    'use strict';

    const ALLOWED_DOMAINS = ['telegra.ph', 'teletype.in'];
    const TELEGRAPH_API = 'https://api.telegra.ph/getPage/';
    const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

    const SAFE_TAGS = new Set([
        'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'pre', 'code',
        'ul', 'ol', 'li',
        'figure', 'figcaption', 'img',
        'hr', 'div', 'span', 'aside',
        'iframe', 'video', 'source'
    ]);

    const SAFE_ATTRS = new Set([
        'src', 'href', 'alt', 'title', 'class',
        'target', 'rel', 'width', 'height',
        'type', 'controls', 'autoplay', 'muted', 'style'
    ]);

    const SAFE_IMAGE_DOMAINS = [
        'telegra.ph', 'teletype.in', 'leonardo.osnova.io',
        'cdn.leonardo.osnova.io', 'imgur.com', 'i.imgur.com'
    ];

    // ==================== DOM-элементы ====================

    const $loader = document.getElementById('loader');
    const $reader = document.getElementById('reader');
    const $title = document.getElementById('chapter-title') || document.getElementById('title');
    const $content = document.getElementById('chapter-content') || document.getElementById('content');
    const $error = document.getElementById('error-screen') || document.getElementById('error');
    const $errorTitle = document.getElementById('error-title');
    const $errorMsg = document.getElementById('error-message') || document.getElementById('error-desc');
    const $retryBtn = document.getElementById('retry-btn');
    const $openBtn = document.getElementById('open-external-btn') || document.getElementById('open-browser-btn');
    
    // Элементы закладок
    const $bookmarkMenu = document.getElementById('bookmark-menu');
    const $bookmarkOverlay = document.getElementById('bookmark-overlay');
    const $bookmarkTitle = document.getElementById('bookmark-title');
    const $btnAddBookmark = document.getElementById('btn-add-bookmark');
    const $bookmarkBtnText = document.getElementById('bookmark-btn-text');
    let activeParagraph = null;
    
    // Элементы пояснений
    const $footnoteModal = document.getElementById('footnote-modal');
    const $footnoteTitle = document.getElementById('footnote-title');
    const $footnoteText = document.getElementById('footnote-text');
    const $footnoteClose = document.getElementById('footnote-close');
    const footnotes = {};

    // ==================== Telegram WebApp ====================

    let tg = null;
    try {
        tg = window.Telegram && window.Telegram.WebApp;
        if (tg) {
            tg.ready();
            tg.expand();
            if (tg.BackButton) {
                tg.BackButton.show();
                tg.BackButton.onClick(function () {
                    tg.close();
                });
            }
        }
    } catch (e) {
        console.warn('Telegram WebApp SDK недоступен:', e);
    }

    const params = new URLSearchParams(window.location.search);
    const chapterSlug = params.get('chapter');
    const chapterUrl = params.get('url');

    // ==================== Валидация URL ====================

    function isAllowedUrl(url) {
        try {
            var parsed = new URL(url);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
            var hostname = parsed.hostname.toLowerCase();
            return ALLOWED_DOMAINS.some(function(d) { return hostname === d || hostname.endsWith('.' + d); });
        } catch (e) { return false; }
    }

    function isSafeImageSrc(src) {
        if (!src) return false;
        if (src.startsWith('data:image/')) return true;
        if (src.startsWith('images/')) return true;
        if (src.startsWith('/file/') || src.startsWith('/upload/')) return true;
        try {
            var parsed = new URL(src);
            var hostname = parsed.hostname.toLowerCase();
            return SAFE_IMAGE_DOMAINS.some(function(d) { return hostname === d || hostname.endsWith('.' + d); });
        } catch (e) { return false; }
    }

    // ==================== UI-функции ====================

    function showLoader() {
        if ($loader) $loader.hidden = false;
        if ($reader) $reader.hidden = true;
        if ($error) $error.hidden = true;
    }

    function showContent(title) {
        if ($loader) $loader.hidden = true;
        if ($error) $error.hidden = true;
        if ($reader) $reader.hidden = false;
        if (title && $title) $title.textContent = title;
    }

    function showError(title, message) {
        if ($loader) $loader.hidden = true;
        if ($reader) $reader.hidden = true;
        if ($error) $error.hidden = false;
        if ($errorTitle) $errorTitle.textContent = title || 'Ошибка';
        if ($errorMsg) $errorMsg.textContent = message || '';
    }

    // ==================== Безопасный парсер ====================

    function sanitizeHtml(htmlString) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlString, 'text/html');
        var fragment = document.createDocumentFragment();

        function processNode(sourceNode) {
            if (sourceNode.nodeType === Node.TEXT_NODE) {
                return document.createTextNode(sourceNode.textContent);
            }

            if (sourceNode.nodeType === Node.ELEMENT_NODE) {
                var tagName = sourceNode.tagName.toLowerCase();

                if (tagName === 'br') return document.createElement('br');

                if (!SAFE_TAGS.has(tagName)) {
                    var frag = document.createDocumentFragment();
                    var children = sourceNode.childNodes;
                    for (var i = 0; i < children.length; i++) {
                        var processed = processNode(children[i]);
                        if (processed) frag.appendChild(processed);
                    }
                    return frag;
                }

                var el = document.createElement(tagName);
                var attrs = sourceNode.attributes;
                for (var j = 0; j < attrs.length; j++) {
                    var attr = attrs[j];
                    var attrName = attr.name.toLowerCase();
                    var value = attr.value;

                    if (!SAFE_ATTRS.has(attrName)) continue;
                    if (attrName === 'src' && tagName === 'img') {
                        if (!isSafeImageSrc(value)) continue;
                    }
                    if (attrName === 'href') {
                        if (value.match(/^\s*(javascript|data|vbscript):/i)) continue;
                        el.setAttribute('target', '_blank');
                        el.setAttribute('rel', 'noopener noreferrer');
                    }

                    el.setAttribute(attrName, value);
                }

                if (tagName === 'img') {
                    el.loading = 'lazy';
                    el.decoding = 'async';
                    el.classList.add('loading');
                    el.addEventListener('load', function () {
                        el.classList.remove('loading');
                        el.classList.add('loaded');
                    });
                    el.addEventListener('error', function () {
                        el.classList.remove('loading');
                        el.alt = '⚠️ Не удалось загрузить картинку';
                    });
                }

                var childNodes = sourceNode.childNodes;
                for (var k = 0; k < childNodes.length; k++) {
                    var child = processNode(childNodes[k]);
                    if (child) el.appendChild(child);
                }
                return el;
            }
            return null;
        }

        var bodyChildren = doc.body.childNodes;
        for (var i = 0; i < bodyChildren.length; i++) {
            var result = processNode(bodyChildren[i]);
            if (result) fragment.appendChild(result);
        }

        return fragment;
    }

    // ==================== Загрузки ====================

    async function loadTeletype(url) {
        var proxyUrl = CORS_PROXY + encodeURIComponent(url);
        var response = await fetch(proxyUrl);
        if (!response.ok) throw new Error('Не удалось загрузить страницу Teletype');

        var html = await response.text();
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');

        var titleEl = doc.querySelector('h1') || doc.querySelector('.content-title');
        var title = titleEl ? titleEl.textContent.trim() : '';

        var articleEl = doc.querySelector('.content-inner')
                     || doc.querySelector('article .block-text')
                     || doc.querySelector('article');

        if (!articleEl) throw new Error('Не удалось извлечь контент Teletype');

        if ($content) $content.textContent = '';
        var safeContent = sanitizeHtml(articleEl.innerHTML);
        if ($content) $content.appendChild(safeContent);

        var images = $content ? $content.querySelectorAll('img') : [];
        images.forEach(function(img) {
            var src = img.getAttribute('src');
            if (src && src.startsWith('/')) img.setAttribute('src', 'https://teletype.in' + src);
        });

        // Инициализация пояснений (footnotes)
        var allParagraphs = $content ? Array.from($content.querySelectorAll('p')) : [];
        allParagraphs.forEach(function(p) {
            var text = p.textContent.trim();
            var match = text.match(/^\[(\d+)\]:\s*(.*)/);
            if (match) {
                var fnId = match[1];
                
                function removePrefix(node) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        var regex = /\[\d+\]:\s*/;
                        if (regex.test(node.textContent)) {
                            node.textContent = node.textContent.replace(regex, '');
                            return true;
                        }
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        for (var i = 0; i < node.childNodes.length; i++) {
                            if (removePrefix(node.childNodes[i])) return true;
                        }
                    }
                    return false;
                }
                removePrefix(p);
                
                footnotes[fnId] = p.innerHTML;
                p.parentNode.removeChild(p);
            }
        });

        function replaceFootnoteRefs(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                var regex = /\[(\d+)\]/g;
                if (regex.test(node.textContent)) {
                    var span = document.createElement('span');
                    span.innerHTML = node.textContent.replace(regex, '<span class="footnote-ref" data-fn="$1">[$1]</span>');
                    node.parentNode.replaceChild(span, node);
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.classList && node.classList.contains('footnote-ref')) return;
                Array.from(node.childNodes).forEach(replaceFootnoteRefs);
            }
        }
        if ($content) replaceFootnoteRefs($content);

        // Инициализация закладок
        var paragraphs = $content ? $content.querySelectorAll('p') : [];
        var chapterKey = chapterSlug || chapterUrl || 'unknown';
        var savedIdx = localStorage.getItem('bookmark_' + chapterKey);
        
        paragraphs.forEach(function(p, index) {
            p.dataset.index = index;
            if (savedIdx !== null && index.toString() === savedIdx) {
                p.classList.add('bookmarked');
                setTimeout(function() {
                    p.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 500);
            }
            p.addEventListener('click', function() {
                if ($bookmarkMenu) {
                    activeParagraph = p;
                    paragraphs.forEach(function(el) { el.classList.remove('active-paragraph'); });
                    p.classList.add('active-paragraph');
                    
                    var isSaved = p.classList.contains('bookmarked');
                    $bookmarkTitle.textContent = 'Параграф ' + (index + 1);
                    $bookmarkBtnText.textContent = isSaved ? 'Удалить закладку' : 'Сохранить закладку';
                    
                    $bookmarkMenu.classList.add('open');
                    if ($bookmarkOverlay) $bookmarkOverlay.classList.add('open');
                }
            });
        });
        
        showContent(title);
    }

    async function loadLocalChapter(slug) {
        if (!/^[a-zA-Z0-9_-]+$/.test(slug)) throw new Error('Некорректный ID главы');

        var response = await fetch('chapters/' + slug + '.json');
        if (!response.ok) {
            if (response.status === 404) throw new Error('Глава не найдена. GitHub Pages ещё обновляется (1-2 мин).');
            throw new Error('Ошибка HTTP ' + response.status);
        }

        var data = await response.json();
        var title = data.title || '';
        var htmlContent = data.content || '';

        if ($content) $content.textContent = '';
        var safeContent = sanitizeHtml(htmlContent);
        if ($content) $content.appendChild(safeContent);

        // Инициализация пояснений (footnotes)
        var allParagraphs = $content ? Array.from($content.querySelectorAll('p')) : [];
        allParagraphs.forEach(function(p) {
            var text = p.textContent.trim();
            var match = text.match(/^\[(\d+)\]:\s*(.*)/);
            if (match) {
                var fnId = match[1];
                
                function removePrefix(node) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        var regex = /\[\d+\]:\s*/;
                        if (regex.test(node.textContent)) {
                            node.textContent = node.textContent.replace(regex, '');
                            return true;
                        }
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        for (var i = 0; i < node.childNodes.length; i++) {
                            if (removePrefix(node.childNodes[i])) return true;
                        }
                    }
                    return false;
                }
                removePrefix(p);
                
                footnotes[fnId] = p.innerHTML;
                p.parentNode.removeChild(p);
            }
        });

        function replaceFootnoteRefs(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                var regex = /\[(\d+)\]/g;
                if (regex.test(node.textContent)) {
                    var span = document.createElement('span');
                    span.innerHTML = node.textContent.replace(regex, '<span class="footnote-ref" data-fn="$1">[$1]</span>');
                    node.parentNode.replaceChild(span, node);
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.classList && node.classList.contains('footnote-ref')) return;
                Array.from(node.childNodes).forEach(replaceFootnoteRefs);
            }
        }
        if ($content) replaceFootnoteRefs($content);

        // Инициализация закладок
        var paragraphs = $content ? $content.querySelectorAll('p') : [];
        var chapterKey = chapterSlug || chapterUrl || 'unknown';
        var savedIdx = localStorage.getItem('bookmark_' + chapterKey);
        
        paragraphs.forEach(function(p, index) {
            p.dataset.index = index;
            if (savedIdx !== null && index.toString() === savedIdx) {
                p.classList.add('bookmarked');
                setTimeout(function() {
                    p.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 500);
            }
            p.addEventListener('click', function() {
                if ($bookmarkMenu) {
                    activeParagraph = p;
                    paragraphs.forEach(function(el) { el.classList.remove('active-paragraph'); });
                    p.classList.add('active-paragraph');
                    
                    var isSaved = p.classList.contains('bookmarked');
                    $bookmarkTitle.textContent = 'Параграф ' + (index + 1);
                    $bookmarkBtnText.textContent = isSaved ? 'Удалить закладку' : 'Сохранить закладку';
                    
                    $bookmarkMenu.classList.add('open');
                    if ($bookmarkOverlay) $bookmarkOverlay.classList.add('open');
                }
            });
        });
        
        showContent(title);
    }

    async function loadTelegraph(url) {
        var path = new URL(url).pathname.replace(/^\//, '');
        if (!path) throw new Error('Некорректная ссылка Telegraph');

        var apiUrl = TELEGRAPH_API + encodeURIComponent(path) + '?return_content=true';
        var response = await fetch(apiUrl);
        if (!response.ok) throw new Error('Telegraph API ошибка ' + response.status);

        var data = await response.json();
        if (!data.ok || !data.result) throw new Error('Страница не найдена на Telegraph');

        var page = data.result;
        var title = page.title || '';

        function nodeToHtml(node) {
            if (typeof node === 'string') {
                return node.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }
            if (!node.tag) return '';
            var html = '<' + node.tag;
            if (node.attrs) {
                for (var key in node.attrs) {
                    html += ' ' + key + '="' + node.attrs[key].replace(/"/g, '&quot;') + '"';
                }
            }
            html += '>';
            if (node.children) html += node.children.map(nodeToHtml).join('');
            html += '</' + node.tag + '>';
            return html;
        }

        var htmlContent = page.content ? page.content.map(nodeToHtml).join('') : '';

        if ($content) $content.textContent = '';
        var safeContent = sanitizeHtml(htmlContent);
        if ($content) $content.appendChild(safeContent);

        var images = $content ? $content.querySelectorAll('img') : [];
        images.forEach(function(img) {
            var src = img.getAttribute('src');
            if (src && src.startsWith('/')) img.setAttribute('src', 'https://telegra.ph' + src);
        });

        // Инициализация пояснений (footnotes)
        var allParagraphs = $content ? Array.from($content.querySelectorAll('p')) : [];
        allParagraphs.forEach(function(p) {
            var text = p.textContent.trim();
            var match = text.match(/^\[(\d+)\]:\s*(.*)/);
            if (match) {
                var fnId = match[1];
                
                function removePrefix(node) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        var regex = /\[\d+\]:\s*/;
                        if (regex.test(node.textContent)) {
                            node.textContent = node.textContent.replace(regex, '');
                            return true;
                        }
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        for (var i = 0; i < node.childNodes.length; i++) {
                            if (removePrefix(node.childNodes[i])) return true;
                        }
                    }
                    return false;
                }
                removePrefix(p);
                
                footnotes[fnId] = p.innerHTML;
                p.parentNode.removeChild(p);
            }
        });

        function replaceFootnoteRefs(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                var regex = /\[(\d+)\]/g;
                if (regex.test(node.textContent)) {
                    var span = document.createElement('span');
                    span.innerHTML = node.textContent.replace(regex, '<span class="footnote-ref" data-fn="$1">[$1]</span>');
                    node.parentNode.replaceChild(span, node);
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.classList && node.classList.contains('footnote-ref')) return;
                Array.from(node.childNodes).forEach(replaceFootnoteRefs);
            }
        }
        if ($content) replaceFootnoteRefs($content);

        // Инициализация закладок
        var paragraphs = $content ? $content.querySelectorAll('p') : [];
        var chapterKey = chapterSlug || chapterUrl || 'unknown';
        var savedIdx = localStorage.getItem('bookmark_' + chapterKey);
        
        paragraphs.forEach(function(p, index) {
            p.dataset.index = index;
            if (savedIdx !== null && index.toString() === savedIdx) {
                p.classList.add('bookmarked');
                setTimeout(function() {
                    p.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 500);
            }
            p.addEventListener('click', function() {
                if ($bookmarkMenu) {
                    activeParagraph = p;
                    paragraphs.forEach(function(el) { el.classList.remove('active-paragraph'); });
                    p.classList.add('active-paragraph');
                    
                    var isSaved = p.classList.contains('bookmarked');
                    $bookmarkTitle.textContent = 'Параграф ' + (index + 1);
                    $bookmarkBtnText.textContent = isSaved ? 'Удалить закладку' : 'Сохранить закладку';
                    
                    $bookmarkMenu.classList.add('open');
                    if ($bookmarkOverlay) $bookmarkOverlay.classList.add('open');
                }
            });
        });
        
        showContent(title);
    }

    // ==================== Главная логика ====================

    async function loadChapter() {
        if (!chapterSlug && !chapterUrl) {
            showError('Нет ссылки', 'URL главы не передан');
            return;
        }

        showLoader();

        try {
            if (chapterSlug) {
                await loadLocalChapter(chapterSlug);
            } else if (chapterUrl) {
                if (!isAllowedUrl(chapterUrl)) {
                    showError('Недопустимая ссылка', 'Только Telegraph и Teletype.');
                    if ($openBtn) $openBtn.hidden = false;
                    return;
                }

                var hostname = new URL(chapterUrl).hostname.toLowerCase();
                if (hostname === 'telegra.ph' || hostname.endsWith('.telegra.ph')) {
                    await loadTelegraph(chapterUrl);
                } else if (hostname === 'teletype.in' || hostname.endsWith('.teletype.in')) {
                    await loadTeletype(chapterUrl);
                } else {
                    throw new Error('Неизвестный источник');
                }
            }
        } catch (err) {
            console.error('Ошибка:', err);
            showError('Ошибка загрузки', err.message || 'Попробуйте снова');
        }
    }

    // ==================== Обработчики событий ====================

    if ($retryBtn) {
        $retryBtn.addEventListener('click', function() { loadChapter(); });
    }
    
    if ($openBtn) {
        $openBtn.addEventListener('click', function() {
            if (chapterUrl) window.open(chapterUrl, '_blank');
        });
    }

    if ($bookmarkOverlay) {
        $bookmarkOverlay.addEventListener('click', function() {
            if ($bookmarkMenu) $bookmarkMenu.classList.remove('open');
            $bookmarkOverlay.classList.remove('open');
            if (activeParagraph) activeParagraph.classList.remove('active-paragraph');
        });
    }

    if ($btnAddBookmark) {
        $btnAddBookmark.addEventListener('click', function() {
            if (activeParagraph) {
                var chapterKey = chapterSlug || chapterUrl || 'unknown';
                var idx = activeParagraph.dataset.index;
                
                if (activeParagraph.classList.contains('bookmarked')) {
                    // Удалить закладку
                    activeParagraph.classList.remove('bookmarked');
                    localStorage.removeItem('bookmark_' + chapterKey);
                } else {
                    // Снять старые закладки
                    var allP = $content.querySelectorAll('p');
                    allP.forEach(function(p) { p.classList.remove('bookmarked'); });
                    
                    // Установить новую
                    activeParagraph.classList.add('bookmarked');
                    localStorage.setItem('bookmark_' + chapterKey, idx);
                }
                
                if ($bookmarkMenu) $bookmarkMenu.classList.remove('open');
                if ($bookmarkOverlay) $bookmarkOverlay.classList.remove('open');
                activeParagraph.classList.remove('active-paragraph');
            }
        });
    }

    if ($content) {
        $content.addEventListener('click', function(e) {
            var target = e.target;
            // Проверяем, не кликнули ли мы на саму закладку или её потомка
            while (target && target !== $content) {
                if (target.classList && target.classList.contains('footnote-ref')) {
                    e.stopPropagation(); // Не открывать меню параграфа!
                    var fnId = target.getAttribute('data-fn');
                    if (footnotes[fnId]) {
                        if ($footnoteTitle) $footnoteTitle.textContent = 'Пояснение ' + fnId;
                        if ($footnoteText) $footnoteText.innerHTML = footnotes[fnId];
                        if ($footnoteModal) $footnoteModal.classList.add('open');
                    }
                    return;
                }
                target = target.parentNode;
            }
        });
    }

    if ($footnoteClose) {
        $footnoteClose.addEventListener('click', function() {
            if ($footnoteModal) $footnoteModal.classList.remove('open');
        });
    }
    
    if ($footnoteModal) {
        $footnoteModal.addEventListener('click', function(e) {
            if (e.target === this) this.classList.remove('open');
        });
    }

    loadChapter();

})();
