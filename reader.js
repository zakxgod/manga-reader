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
    const $error = document.getElementById('error');
    const $errorTitle = document.getElementById('error-title');
    const $errorDesc = document.getElementById('error-desc');
    const $retryBtn = document.getElementById('retry-btn');
    const $openBtn = document.getElementById('open-browser-btn');

    // ==================== Инициализация Telegram ====================

    let tg;
    try {
        tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();

        // Применяем цвета темы Telegram
        document.body.style.backgroundColor = 'var(--tg-theme-bg-color, #ffffff)';
        document.body.style.color = 'var(--tg-theme-text-color, #000000)';

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
        if (title) {
            $title.textContent = title;
            document.title = title;
        }
        $loader.hidden = true;
        $error.hidden = true;
        $reader.hidden = false;
    }

    function showError(title, desc) {
        $errorTitle.textContent = title;
        $errorDesc.textContent = desc;
        $loader.hidden = true;
        $reader.hidden = true;
        $error.hidden = false;
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
                    // Если картинка не с доверенного домена, заменяем на заглушку или игнорим
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


    /**
     * Преобразует DOM-дерево Telegraph API в HTML-строку для нашего санитайзера.
     */
    function telegraphNodeToHtml(node) {
        if (typeof node === 'string') {
            // Экранируем текст
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

        // Убираем первый слэш
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

        // Конвертируем ноды Telegraph в HTML-строку
        var htmlContent = '';
        if (page.content) {
            htmlContent = page.content.map(telegraphNodeToHtml).join('');
        }

        // Очищаем контейнер
        $content.textContent = '';

        // Безопасный рендеринг
        var safeContent = sanitizeHtml(htmlContent);
        $content.appendChild(safeContent);

        // Исправляем относительные пути картинок Telegraph
        var images = $content.querySelectorAll('img');
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
        // Из-за CORS напрямую загрузить не получится.
        // Используем публичный прокси.
        // ВАЖНО: Для production лучше настроить свой прокси на бекенде бота.
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

        // Ищем контейнер с контентом (зависит от верстки Teletype)
        var article = doc.querySelector('article') || doc.querySelector('.editor-content');
        if (!article) {
            throw new Error('Не удалось найти контент на странице Teletype');
        }

        // Очищаем контейнер
        $content.textContent = '';

        // Безопасный рендеринг
        var safeContent = sanitizeHtml(article.innerHTML);
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

    // ==================== Загрузка локальных глав (GitHub Pages) ====================

    /**
     * Загружает главу из JSON-файла на том же домене.
     * Файл: chapters/{slug}.json
     * Картинки: images/{slug}/img_001.webp (относительные пути)
     */
    async function loadLocalChapter(slug) {
        // Валидация slug (только буквы, цифры, дефис)
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

        // Очищаем контейнер
        $content.textContent = '';

        // Безопасный рендеринг через sanitizeHtml
        var safeContent = sanitizeHtml(htmlContent);
        $content.appendChild(safeContent);

        showContent(title);
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
