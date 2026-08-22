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

    /** CORS proxy для Teletype */
    const CORS_PROXY = 'https://api.allorigins.win/get?url=';

    /** Разрешённые HTML теги (базовая защита от XSS) */
    const SAFE_TAGS = [
        'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
        'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'hr', 'figure', 'figcaption'
    ];

    /** Безопасные домены для картинок */
    const SAFE_IMAGE_DOMAINS = [
        'telegra.ph', 'teletype.in', 'imagedelivery.net',
        'vk.com', 'userapi.com', 'imgur.com', 'discordapp.com', 'discordapp.net'
    ];

    // ==================== Элементы DOM ====================

    const $title = document.getElementById('title');
    const $content = document.getElementById('content');
    const $loader = document.getElementById('loader');
    const $reader = document.getElementById('reader');
    const $error = document.getElementById('error-screen') || document.getElementById('error');
    const $errorTitle = document.getElementById('error-title');
    const $errorMsg = document.getElementById('error-message') || document.getElementById('error-desc');
    const $retryBtn = document.getElementById('retry-btn');
    const $openBtn = document.getElementById('open-external-btn') || document.getElementById('open-browser-btn');

    // ==================== Инициализация Telegram ====================

    let tg;
    try {
        tg = window.Telegram && window.Telegram.WebApp;
        if (tg) {
            tg.ready();
            tg.expand();
            // Применяем цвета темы Telegram
            document.body.style.backgroundColor = 'var(--tg-theme-bg-color, #ffffff)';
            document.body.style.color = 'var(--tg-theme-text-color, #000000)';
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
        // Разрешаем base64 картинки (Google Docs иногда их так отдаёт)
        if (src.startsWith('data:image/')) return true;
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
        if ($loader) $loader.hidden = false;
        if ($reader) $reader.hidden = true;
        if ($error) $error.hidden = true;
    }

    function showContent(title) {
        if (title && $title) {
            $title.textContent = title;
            document.title = title;
        }
        if ($loader) $loader.hidden = true;
        if ($error) $error.hidden = true;
        if ($reader) $reader.hidden = false;
    }

    function showError(title, desc) {
        if ($errorTitle) $errorTitle.textContent = title;
        if ($errorMsg) $errorMsg.textContent = desc;
        if ($loader) $loader.hidden = true;
        if ($reader) $reader.hidden = true;
        if ($error) $error.hidden = false;
    }

    // ==================== Рендеринг HTML (Анти-XSS) ====================

    /**
     * Безопасно преобразует строку HTML в DOM элементы.
     * Игнорирует все скрипты, on-события и опасные теги.
     */
    function sanitizeHtml(htmlString) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlString, 'text/html');
        var fragment = document.createDocumentFragment();

        function cleanNode(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                return document.createTextNode(node.textContent);
            }

            if (node.nodeType !== Node.ELEMENT_NODE) {
                return null;
            }

            var tagName = node.tagName.toLowerCase();

            // Пропускаем запрещенные теги
            if (SAFE_TAGS.indexOf(tagName) === -1) {
                // Если тег не разрешен, пытаемся вытащить его текст
                var textNode = document.createTextNode(node.textContent);
                return textNode;
            }

            var el = document.createElement(tagName);

            // Обработка разрешенных атрибутов
            if (tagName === 'a') {
                var href = node.getAttribute('href');
                if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                    el.setAttribute('href', href);
                    el.setAttribute('target', '_blank');
                    el.setAttribute('rel', 'noopener noreferrer');
                }
            } else if (tagName === 'img') {
                var src = node.getAttribute('src');
                if (isSafeImageSrc(src)) {
                    el.setAttribute('src', src);
                    el.setAttribute('loading', 'lazy');
                } else {
                    return document.createTextNode('[Картинка заблокирована]');
                }
            }

            // Копируем дочерние элементы рекурсивно
            var child = node.firstChild;
            while (child) {
                var safeChild = cleanNode(child);
                if (safeChild) {
                    el.appendChild(safeChild);
                }
                child = child.nextSibling;
            }

            return el;
        }

        var child = doc.body.firstChild;
        while (child) {
            var safeChild = cleanNode(child);
            if (safeChild) {
                fragment.appendChild(safeChild);
            }
            child = child.nextSibling;
        }

        return fragment;
    }


    function telegraphNodeToHtml(node) {
        if (typeof node === 'string') {
            return node
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }
        if (!node.tag) return '';

        var html = '<' + node.tag;
        if (node.attrs) {
            for (var key in node.attrs) {
                html += ' ' + key + '="' + node.attrs[key].replace(/"/g, '&quot;') + '"';
            }
        }
        html += '>';

        if (node.children) {
            html += node.children.map(telegraphNodeToHtml).join('');
        }

        html += '</' + node.tag + '>';
        return html;
    }

    // ==================== Загрузка Telegraph ====================

    async function loadTelegraph(url) {
        var pathname = new URL(url).pathname;
        if (!pathname || pathname === '/') {
            throw new Error('Некорректная ссылка Telegraph');
        }

        var path = pathname.substring(1);

        var response = await fetch(TELEGRAPH_API + path + '?return_content=true');
        if (!response.ok) {
            throw new Error('Ошибка сети при загрузке Telegraph');
        }

        var data = await response.json();
        if (!data.ok) {
            throw new Error(data.error || 'Ошибка API Telegraph');
        }

        var page = data.result;
        var title = page.title || '';

        var htmlContent = '';
        if (page.content) {
            htmlContent = page.content.map(telegraphNodeToHtml).join('');
        }

        if ($content) $content.textContent = '';

        var safeContent = sanitizeHtml(htmlContent);
        if ($content) $content.appendChild(safeContent);

        var images = $content ? $content.querySelectorAll('img') : [];
        images.forEach(function (img) {
            var src = img.getAttribute('src');
            if (src && src.startsWith('/')) {
                img.setAttribute('src', 'https://telegra.ph' + src);
            }
        });

        showContent(title);
    }

    // ==================== Загрузка Teletype ====================

    async function loadTeletype(url) {
        var proxyUrl = CORS_PROXY + encodeURIComponent(url);

        var response = await fetch(proxyUrl);
        if (!response.ok) {
            throw new Error('Не удалось загрузить страницу Teletype через прокси');
        }

        var data = await response.json();
        if (!data.contents) {
            throw new Error('Пустой ответ от прокси');
        }

        var rawHtml = data.contents;
        var parser = new DOMParser();
        var doc = parser.parseFromString(rawHtml, 'text/html');

        var title = '';
        var titleTag = doc.querySelector('title');
        if (titleTag) {
            title = titleTag.textContent.replace(' — Teletype', '');
        }

        var article = doc.querySelector('article') || doc.querySelector('.editor-content');
        if (!article) {
            throw new Error('Не удалось найти контент на странице Teletype');
        }

        if ($content) $content.textContent = '';

        var safeContent = sanitizeHtml(article.innerHTML);
        if ($content) $content.appendChild(safeContent);

        var images = $content ? $content.querySelectorAll('img') : [];
        images.forEach(function (img) {
            var src = img.getAttribute('src');
            if (src && src.startsWith('/')) {
                img.setAttribute('src', 'https://teletype.in' + src);
            }
        });

        showContent(title);
    }

    // ==================== Загрузка локальных глав (GitHub Pages) ====================

    async function loadLocalChapter(slug) {
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

        var data = await response.json();
        var title = data.title || '';
        var htmlContent = data.content || '';

        if ($content) $content.textContent = '';

        var safeContent = sanitizeHtml(htmlContent);
        if ($content) $content.appendChild(safeContent);

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
                    showError('Недопустимая ссылка',
                        'Поддерживаются только Telegraph и Teletype.');
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
            console.error('Ошибка загрузки:', err);
            showError(
                'Не удалось загрузить главу',
                (err.message || 'Попробуйте снова или откройте в браузере')
            );
        }
    }

    // ==================== Обработчики событий ====================

    if ($retryBtn) {
        $retryBtn.addEventListener('click', function () {
            loadChapter();
        });
    }

    if ($openBtn) {
        $openBtn.addEventListener('click', function () {
            if (chapterUrl) {
                window.open(chapterUrl, '_blank');
            }
        });
    }

    // ==================== Запуск ====================

    loadChapter();

})();
