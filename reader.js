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

    // ==================== Получение URL главы ====================

    const params = new URLSearchParams(window.location.search);
    const chapterUrl = params.get('url');

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

    // ==================== Главная логика ====================

    async function loadChapter() {
        if (!chapterUrl) {
            showError('Нет ссылки', 'URL главы не передан');
            return;
        }

        if (!isAllowedUrl(chapterUrl)) {
            showError('Недопустимая ссылка',
                'Поддерживаются только Telegraph и Teletype. Попробуйте открыть в браузере.');
            $openBtn.hidden = false;
            return;
        }

        showLoader();

        try {
            var hostname = new URL(chapterUrl).hostname.toLowerCase();

            if (hostname === 'telegra.ph' || hostname.endsWith('.telegra.ph')) {
                await loadTelegraph(chapterUrl);
            } else if (hostname === 'teletype.in' || hostname.endsWith('.teletype.in')) {
                await loadTeletype(chapterUrl);
            } else {
                throw new Error('Неизвестный источник');
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
