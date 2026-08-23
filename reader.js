/**
 * MangaBot WebApp Reader
 * Читалка глав из Telegraph и Teletype внутри Telegram Mini App.
 *
 * Безопасность:
 * - Валидация доменов URL (только telegra.ph и teletype.in)
 * - DOM-рендеринг без innerHTML (защита от XSS)
 * - Content Security Policy в HTML
 * - Белый список тегов и атрибутов
 */

(function () {
    'use strict';

    // ==================== Конфигурация ====================

    /** Домены, с которых разрешена загрузка контента */
    const ALLOWED_DOMAINS = ['telegra.ph', 'teletype.in'];

    /** API Telegraph для получения контента страниц */
    const TELEGRAPH_API = 'https://api.telegra.ph/getPage/';

    /** CORS-прокси для Teletype (не имеет публичного API) */
    const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

    /** Разрешённые HTML-теги при рендеринге (защита от XSS) */
    const SAFE_TAGS = new Set([
        'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'pre', 'code',
        'ul', 'ol', 'li',
        'figure', 'figcaption', 'img',
        'hr', 'div', 'span', 'aside',
        'iframe', 'video', 'source'
    ]);

    /** Разрешённые атрибуты HTML-тегов */
    const SAFE_ATTRS = new Set([
        'src', 'href', 'alt', 'title', 'class',
        'target', 'rel', 'width', 'height',
        'type', 'controls', 'autoplay', 'muted'
    ]);

    /** Домены, с которых разрешена загрузка картинок */
    const SAFE_IMAGE_DOMAINS = [
        'telegra.ph', 'teletype.in', 'leonardo.osnova.io',
        'cdn.leonardo.osnova.io', 'imgur.com', 'i.imgur.com'
    ];

    // ==================== DOM-элементы ====================

    const $loader = document.getElementById('loader');
    const $reader = document.getElementById('reader');
    const $title = document.getElementById('chapter-title');
    const $content = document.getElementById('chapter-content');
    const $error = document.getElementById('error-screen');
    const $errorTitle = document.getElementById('error-title');
    const $errorMsg = document.getElementById('error-message');
    const $retryBtn = document.getElementById('retry-btn');
    const $openBtn = document.getElementById('open-external-btn');

    // ==================== Telegram WebApp ====================

    let tg = null;
    try {
        tg = window.Telegram && window.Telegram.WebApp;
        if (tg) {
            tg.ready();
            tg.expand();
            // Кнопка «Назад» для закрытия
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

    // ==================== Получение параметров ====================

    const params = new URLSearchParams(window.location.search);
    const chapterSlug = params.get('chapter');  // Локальная глава (из Google Docs)
    const chapterUrl = params.get('url');       // Внешняя ссылка (Telegraph/Teletype)

    // ==================== Валидация URL ====================

    /**
     * Проверяет, что URL принадлежит разрешённому домену.
     * Защита от загрузки произвольных страниц через наш webapp.
     */
    function isAllowedUrl(url) {
        try {
            var parsed = new URL(url);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                return false;
            }
            var hostname = parsed.hostname.toLowerCase();
            return ALLOWED_DOMAINS.some(function (d) {
                return hostname === d || hostname.endsWith('.' + d);
            });
        } catch (e) {
            return false;
        }
    }

    /**
     * Проверяет, безопасен ли URL для картинки.
     */
    function isSafeImageSrc(src) {
        if (!src) return false;
        // Встроенные Base64-картинки из зашифрованных глав
        if (src.startsWith('data:image/webp;base64,')) return true;
        // Локальные главы (импорт из Google Docs)
        if (src.startsWith('images/')) return true;
        // Относительные пути Telegraph
        if (src.startsWith('/file/') || src.startsWith('/upload/')) return true;
        try {
            var parsed = new URL(src);
            var hostname = parsed.hostname.toLowerCase();
            return SAFE_IMAGE_DOMAINS.some(function (d) {
                return hostname === d || hostname.endsWith('.' + d);
            });
        } catch (e) {
            return false;
        }
    }

    // ==================== UI-функции ====================

    function showLoader() {
        $loader.hidden = false;
        $reader.hidden = true;
        $error.hidden = true;
    }

    function showContent(title) {
        $loader.hidden = true;
        $reader.hidden = false;
        $error.hidden = true;
        if (title) $title.textContent = title;
        if (typeof postProcessContent === 'function') postProcessContent();
    }

    function showError(title, message) {
        $loader.hidden = true;
        $reader.hidden = true;
        $error.hidden = false;
        $errorTitle.textContent = title || 'Ошибка';
        $errorMsg.textContent = message || '';
    }

    // ==================== Telegraph: рендеринг контента ====================

    /**
     * Безопасно рендерит дерево нод Telegraph в DOM-элементы.
     * Не использует innerHTML — все элементы создаются через DOM API.
     */
    function renderTelegraphNode(node) {
        // Текстовая нода
        if (typeof node === 'string') {
            return document.createTextNode(node);
        }

        if (!node || !node.tag) {
            return document.createTextNode('');
        }

        var tagName = node.tag.toLowerCase();

        // Проверка белого списка тегов
        if (!SAFE_TAGS.has(tagName)) {
            // Неизвестный тег — рендерим только детей
            var fragment = document.createDocumentFragment();
            if (node.children) {
                node.children.forEach(function (child) {
                    fragment.appendChild(renderTelegraphNode(child));
                });
            }
            return fragment;
        }

        var el = document.createElement(tagName);

        // Безопасная установка атрибутов
        if (node.attrs) {
            Object.keys(node.attrs).forEach(function (key) {
                var attrName = key.toLowerCase();
                var value = node.attrs[key];

                if (!SAFE_ATTRS.has(attrName)) return;

                // Обработка src для картинок
                if (attrName === 'src') {
                    if (tagName === 'img') {
                        // Относительный путь → абсолютный URL telegra.ph
                        if (value.startsWith('/')) {
                            value = 'https://telegra.ph' + value;
                        }
                        if (!isSafeImageSrc(value)) return;
                    } else if (tagName === 'iframe') {
                        // Iframe — разрешаем только известные видео-хосты
                        try {
                            var iframeHost = new URL(value).hostname;
                            var safeVideoHosts = ['youtube.com', 'www.youtube.com', 'youtu.be',
                                                   'player.vimeo.com', 'vimeo.com'];
                            if (!safeVideoHosts.some(function(h) { return iframeHost === h; })) return;
                        } catch (e) { return; }
                    }
                }

                // Обработка href для ссылок
                if (attrName === 'href') {
                    // Блокируем javascript: и data: ссылки
                    if (value.match(/^\s*(javascript|data|vbscript):/i)) return;
                    // Внешние ссылки открываем в новой вкладке
                    el.setAttribute('target', '_blank');
                    el.setAttribute('rel', 'noopener noreferrer');
                }

                el.setAttribute(attrName, value);
            });
        }

        // Lazy loading для картинок
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
                el.style.minHeight = '40px';
                el.style.textAlign = 'center';
                el.style.padding = '12px';
                el.style.fontSize = '14px';
            });
        }

        // Iframe — оборачиваем для адаптивного видео
        if (tagName === 'iframe') {
            var wrapper = document.createElement('div');
            wrapper.className = 'iframe-wrapper';
            wrapper.appendChild(el);
            return wrapper;
        }

        // Рекурсивный рендеринг детей
        if (node.children) {
            node.children.forEach(function (child) {
                el.appendChild(renderTelegraphNode(child));
            });
        }

        return el;
    }

    // ==================== Загрузка Telegraph ====================

    async function loadTelegraph(url) {
        var path = new URL(url).pathname.replace(/^\//, '');
        if (!path) throw new Error('Некорректная ссылка Telegraph');

        var apiUrl = TELEGRAPH_API + encodeURIComponent(path) + '?return_content=true';
        var response = await fetch(apiUrl);

        if (!response.ok) {
            throw new Error('Telegraph API вернул ошибку: ' + response.status);
        }

        var data = await response.json();

        if (!data.ok || !data.result) {
            throw new Error('Страница не найдена на Telegraph');
        }

        var page = data.result;
        var title = page.title || '';

        // Очищаем контейнер
        $content.textContent = '';

        // Рендерим дерево нод
        if (page.content && Array.isArray(page.content)) {
            var fragment = document.createDocumentFragment();
            page.content.forEach(function (node) {
                fragment.appendChild(renderTelegraphNode(node));
            });
            $content.appendChild(fragment);
        }

        showContent(title);
    }

    // ==================== Загрузка Teletype ====================

    /**
     * Безопасная очистка HTML-строки.
     * Парсит через DOMParser и оставляет только безопасные теги/атрибуты.
     */
    function sanitizeHtml(htmlString) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlString, 'text/html');
        var fragment = document.createDocumentFragment();

        function processNode(sourceNode) {
            // Текстовая нода
            if (sourceNode.nodeType === Node.TEXT_NODE) {
                return document.createTextNode(sourceNode.textContent);
            }

            // Элемент
            if (sourceNode.nodeType === Node.ELEMENT_NODE) {
                var tagName = sourceNode.tagName.toLowerCase();

                // BR — пропускаем без проверки детей
                if (tagName === 'br') {
                    return document.createElement('br');
                }

                if (!SAFE_TAGS.has(tagName)) {
                    // Небезопасный тег — рендерим только содержимое
                    var frag = document.createDocumentFragment();
                    var children = sourceNode.childNodes;
                    for (var i = 0; i < children.length; i++) {
                        var processed = processNode(children[i]);
                        if (processed) frag.appendChild(processed);
                    }
                    return frag;
                }

                var el = document.createElement(tagName);

                // Копируем только безопасные атрибуты
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

                // Lazy loading для картинок
                if (tagName === 'img') {
                    el.loading = 'lazy';
                    el.decoding = 'async';
                    el.classList.add('loading');
                    el.addEventListener('load', function () {
                        el.classList.remove('loading');
                        el.classList.add('loaded');
                    });
                }

                // Рекурсивно обрабатываем детей
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

    async function loadTeletype(url) {
        // Teletype не имеет публичного API, используем CORS-прокси
        var proxyUrl = CORS_PROXY + encodeURIComponent(url);
        var response = await fetch(proxyUrl);

        if (!response.ok) {
            throw new Error('Не удалось загрузить страницу Teletype');
        }

        var html = await response.text();

        // Парсим HTML для извлечения статьи
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');

        // Заголовок
        var titleEl = doc.querySelector('h1') || doc.querySelector('.content-title');
        var title = titleEl ? titleEl.textContent.trim() : '';

        // Контент статьи (Teletype хранит его в .content-inner или article)
        var articleEl = doc.querySelector('.content-inner')
                     || doc.querySelector('article .block-text')
                     || doc.querySelector('article');

        if (!articleEl) {
            throw new Error('Не удалось извлечь контент из страницы Teletype');
        }

        // Очищаем контейнер
        $content.textContent = '';

        // Безопасный рендеринг
        var safeContent = sanitizeHtml(articleEl.innerHTML);
        $content.appendChild(safeContent);

        // Исправляем относительные пути картинок
        var images = $content.querySelectorAll('img');
        images.forEach(function (img) {
            var src = img.getAttribute('src');
            if (src && src.startsWith('/')) {
                img.setAttribute('src', 'https://teletype.in' + src);
            }
        });

        showContent(title);
    }

    // ==================== XOR-расшифровка зашифрованных глав ====================

    /**
     * Расшифровывает данные, зашифрованные XOR + Base64.
     * Ключ повторяется циклически до длины данных.
     */
    function xorDecrypt(base64Ciphertext, key) {
        var raw = atob(base64Ciphertext);
        var keyLen = key.length;
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) {
            bytes[i] = raw.charCodeAt(i) ^ key.charCodeAt(i % keyLen);
        }
        return new TextDecoder('utf-8').decode(bytes);
    }

    // ==================== Загрузка локальных глав (GitHub Pages) ====================

    /**
     * Загружает главу из JSON-файла на том же домене.
     * Файл: chapters/{slug}.json
     * Если в URL передан ?key= — расшифровывает содержимое (XOR + Base64).
     * Без ключа — парсит как обычный JSON (обратная совместимость).
     */
    async function loadLocalChapter(slug) {
        // Валидация slug (только буквы, цифры, дефис, подчёркивание)
        if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
            throw new Error('Некорректный идентификатор главы');
        }

        var response = await fetch('chapters/' + slug + '.json');
        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Глава не найдена. Возможно, GitHub Pages ещё обновляется (1-2 минуты).');
            }
            throw new Error('Ошибка загрузки: HTTP ' + response.status);
        }

        var encryptedText = await response.text();
        var encKey = params.get('key');
        var data;

        if (encKey) {
            // Зашифрованная глава — расшифровываем XOR
            var jsonStr = xorDecrypt(encryptedText, encKey);
            data = JSON.parse(jsonStr);
        } else {
            // Незашифрованная глава (обратная совместимость)
            data = JSON.parse(encryptedText);
        }

        var title = data.title || '';
        var htmlContent = data.content || '';

        // Очищаем контейнер
        $content.textContent = '';

        // Безопасный рендеринг через sanitizeHtml
        var safeContent = sanitizeHtml(htmlContent);
        $content.appendChild(safeContent);

        showContent(title);
    }

    // ==================== Интерактив (Сноски, Закладки, Защита) ====================

    let footnotes = {};
    let bookmarkBar = null;
    let longPressTimer = null;

    function injectUI() {
        if (!document.getElementById('bookmark-bar')) {
            bookmarkBar = document.createElement('div');
            bookmarkBar.id = 'bookmark-bar';
            bookmarkBar.hidden = true;
            bookmarkBar.innerHTML = `
                <div class="bookmark-label" id="bookmark-label">Параграф X</div>
                <button class="bookmark-save" id="bookmark-save-btn">🔖 Сохранить закладку</button>
            `;
            document.body.appendChild(bookmarkBar);
        }
    }

    function showFootnoteModal(title, text) {
        var overlay = document.createElement('div');
        overlay.className = 'footnote-overlay';
        var card = document.createElement('div');
        card.className = 'footnote-card';
        
        var titleEl = document.createElement('div');
        titleEl.className = 'footnote-title';
        titleEl.textContent = title;
        
        var bodyEl = document.createElement('div');
        bodyEl.className = 'footnote-body';
        bodyEl.textContent = text;
        
        var closeBtn = document.createElement('button');
        closeBtn.className = 'btn footnote-close';
        closeBtn.textContent = 'Закрыть';
        
        card.appendChild(titleEl);
        card.appendChild(bodyEl);
        card.appendChild(closeBtn);
        overlay.appendChild(card);
        
        document.body.appendChild(overlay);
        
        function close() {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
        
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) close();
        });
    }

    function processFootnotes() {
        footnotes = {};
        var elements = $content.querySelectorAll('p, div, h1, h2, h3, h4, li');
        
        // 1. Ищем расшифровки сносок в конце текста
        elements.forEach(function(el) {
            var text = el.textContent.trim();
            var match = text.match(/^\[(\d+)\]:\s*(.+)$/);
            if (match) {
                footnotes[match[1]] = match[2];
                el.style.display = 'none'; // Прячем параграф-пояснение
            }
        });

        // 2. Ищем [N] в тексте и заменяем на ссылки
        function replaceTextNodes(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                var text = node.textContent;
                var regex = /\[(\d+)\]/g;
                if (regex.test(text)) {
                    var fragment = document.createDocumentFragment();
                    var lastIndex = 0;
                    text.replace(regex, function(match, p1, index) {
                        if (index > lastIndex) {
                            fragment.appendChild(document.createTextNode(text.substring(lastIndex, index)));
                        }
                        var span = document.createElement('span');
                        span.className = 'footnote-ref';
                        span.textContent = match;
                        span.dataset.fn = p1;
                        span.addEventListener('click', function(e) {
                            e.stopPropagation(); // Отключаем долгое нажатие для закладки
                            var fnText = footnotes[p1] || 'Пояснение не найдено';
                            showFootnoteModal('Пояснение ' + p1, fnText);
                        });
                        fragment.appendChild(span);
                        lastIndex = index + match.length;
                    });
                    if (lastIndex < text.length) {
                        fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
                    }
                    node.parentNode.replaceChild(fragment, node);
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE' && node.className !== 'footnote-ref') {
                    Array.from(node.childNodes).forEach(replaceTextNodes);
                }
            }
        }
        replaceTextNodes($content);
    }

    function setupBookmarks() {
        var paras = $content.querySelectorAll('p');
        var currentSlug = chapterSlug || chapterUrl;
        
        paras.forEach(function(p, index) {
            var pNum = index + 1;
            p.dataset.paraIdx = pNum;
            p.id = 'para-' + pNum;
            
            function startPress(e) {
                if (e.target.closest('.footnote-ref')) return;
                clearTimeout(longPressTimer);
                longPressTimer = setTimeout(function() {
                    showBookmarkBar(pNum, currentSlug);
                }, 600); // 600мс для вызова меню закладки
            }
            
            function cancelPress() {
                clearTimeout(longPressTimer);
            }

            p.addEventListener('touchstart', startPress, {passive: true});
            p.addEventListener('touchend', cancelPress);
            p.addEventListener('touchmove', cancelPress);
            p.addEventListener('mousedown', startPress);
            p.addEventListener('mouseup', cancelPress);
            p.addEventListener('mouseleave', cancelPress);
        });
        
        // Клик мимо скрывает плашку
        document.addEventListener('click', function(e) {
            if (bookmarkBar && !bookmarkBar.contains(e.target) && !e.target.closest('p')) {
                bookmarkBar.hidden = true;
            }
        });

        // Загрузка сохранённой закладки
        if (currentSlug) {
            var savedPara = localStorage.getItem('manga_bookmark_' + currentSlug);
            if (savedPara) {
                setTimeout(function() {
                    var target = document.getElementById('para-' + savedPara);
                    if (target) {
                        target.scrollIntoView({behavior: 'smooth', block: 'center'});
                    }
                }, 300);
            }
        }
    }

    function showBookmarkBar(pNum, slug) {
        if (!bookmarkBar) return;
        var label = bookmarkBar.querySelector('#bookmark-label');
        var btn = bookmarkBar.querySelector('#bookmark-save-btn');
        
        label.textContent = 'Параграф ' + pNum;
        bookmarkBar.hidden = false;
        
        var newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        
        newBtn.addEventListener('click', function() {
            if (slug) {
                localStorage.setItem('manga_bookmark_' + slug, pNum);
                var originalText = newBtn.textContent;
                newBtn.textContent = '✅ Сохранено!';
                newBtn.style.background = '#4CAF50';
                setTimeout(function() {
                    bookmarkBar.hidden = true;
                    newBtn.textContent = originalText;
                    newBtn.style.background = '';
                }, 1500);
            }
        });
    }

    function setupCopyProtection() {
        $content.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });
        $content.addEventListener('dragstart', function(e) {
            e.preventDefault();
        });
        document.addEventListener('copy', function(e) {
            e.preventDefault();
        });
    }

    function postProcessContent() {
        injectUI();
        processFootnotes();
        setupBookmarks();
        setupCopyProtection();
    }

    // ==================== Главная логика ====================

    async function loadChapter() {
        // Приоритет: локальная глава (?chapter=slug) → внешняя ссылка (?url=...)
        if (!chapterSlug && !chapterUrl) {
            showError('Нет ссылки', 'URL главы не передан');
            return;
        }

        showLoader();

        try {
            if (chapterSlug) {
                // Локальная глава из GitHub Pages
                await loadLocalChapter(chapterSlug);
            } else if (chapterUrl) {
                // Внешняя ссылка
                if (!isAllowedUrl(chapterUrl)) {
                    showError('Недопустимая ссылка',
                        'Поддерживаются только Telegraph и Teletype.');
                    $openBtn.hidden = false;
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
            console.error('Ошибка загрузки:', err);
            showError(
                'Не удалось загрузить главу',
                (err.message || 'Попробуйте снова или откройте в браузере')
            );
        }
    }

    // ==================== Обработчики событий ====================

    $retryBtn.addEventListener('click', function () {
        loadChapter();
    });

    $openBtn.addEventListener('click', function () {
        if (chapterUrl) {
            window.open(chapterUrl, '_blank');
        }
    });

    // ==================== Запуск ====================

    loadChapter();

})();
