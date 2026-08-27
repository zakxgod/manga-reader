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

    /**
     * Элементы, для которых разрешено сохранить только text-align.
     * Остальные inline CSS-свойства из HTML игнорируются.
     */
    const ALIGNABLE_TAGS = new Set([
        'p', 'div',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
    ]);

    const SAFE_TEXT_ALIGNS = new Set([
        'left',
        'center',
        'right',
        'justify'
    ]);

    /** Домены, с которых разрешена загрузка картинок */
    const SAFE_IMAGE_DOMAINS = [
        'telegra.ph', 'teletype.in', 'leonardo.osnova.io',
        'cdn.leonardo.osnova.io', 'imgur.com', 'i.imgur.com'
    ];

    // ==================== DOM-элементы ====================

    const $loader = document.getElementById('loader');
    const $readerProgressBar = document.getElementById('reader-progress-bar');
    function updateReadingProgress() {
        if (!$readerProgressBar) return;
        
        if (($reader && $reader.hidden) || maxScroll <= 50) {
            $readerProgressBar.style.transform = 'scaleX(0)';
            $readerProgressBar.style.display = 'none';
        } else {
            $readerProgressBar.style.display = 'block';
            const ratio = Math.min(Math.max(window.scrollY / maxScroll, 0), 1);
            $readerProgressBar.style.transform = 'scaleX(' + ratio + ')';
        }
    }
    let maxScroll = 0;
    const $reader = document.getElementById('reader');
    const $title = document.getElementById('chapter-title');
    const $content = document.getElementById('chapter-content');
    const $error = document.getElementById('error-screen');
    const $errorTitle = document.getElementById('error-title');
    const $errorMsg = document.getElementById('error-message');
    const $retryBtn = document.getElementById('retry-btn');
    const $openBtn = document.getElementById('open-external-btn');

    const $readerSettingsButton =
        document.getElementById(
            'reader-settings-button'
        );

    const $readerSettingsOverlay =
        document.getElementById(
            'reader-settings-overlay'
        );

    const $readerSettingsMenu =
        document.getElementById(
            'reader-settings-menu'
        );

    const $readerSettingsHandle =
        document.querySelector(
            '.reader-settings-handle'
        );

    const $readerFont =
        document.getElementById(
            'reader-font'
        );

    const $readerFontSize =
        document.getElementById(
            'reader-font-size'
        );

    const $readerFontSizeValue =
        document.getElementById(
            'reader-font-size-value'
        );

    const $readerLineHeight =
        document.getElementById(
            'reader-line-height'
        );

    const $readerLineHeightValue =
        document.getElementById(
            'reader-line-height-value'
        );

    const $readerIndent =
        document.getElementById(
            'reader-indent'
        );

    const $readerThemeButtons =
        document.querySelectorAll(
            '.reader-theme-button'
        );

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

    // ==================== Настройки чтения ====================

    const READER_SETTINGS_KEY =
        'manga_reader_settings_v1';

    const READER_FONT_MAP = {
        system: '',
        georgia:
            'Georgia, "Times New Roman", serif',
        times:
            '"Times New Roman", Times, serif',
        arial:
            'Arial, Helvetica, sans-serif'
    };

    const READER_THEMES = {
        light: {
            '--tg-theme-bg-color': '#ffffff',
            '--tg-theme-secondary-bg-color': '#f2f3f5',
            '--tg-theme-text-color': '#1d1d1f',
            '--tg-theme-hint-color': '#7b8088',
            '--tg-theme-link-color': '#2678d9',
            '--tg-theme-button-color': '#2678d9',
            '--tg-theme-button-text-color': '#ffffff',

            '--bg': '#ffffff',
            '--secondary-bg': '#f2f3f5',
            '--text': '#1d1d1f',
            '--link': '#2678d9',
            '--reader-scrollbar-track': 'rgba(0, 0, 0, 0.05)',
            '--reader-scrollbar-thumb': 'rgba(0, 0, 0, 0.25)',
            '--reader-scrollbar-thumb-active': 'rgba(0, 0, 0, 0.45)'
        },

        dark: {
            '--tg-theme-bg-color': '#111318',
            '--tg-theme-secondary-bg-color': '#1d2027',
            '--tg-theme-text-color': '#e8eaed',
            '--tg-theme-hint-color': '#8c929b',
            '--tg-theme-link-color': '#63a8ff',
            '--tg-theme-button-color': '#2d7ff9',
            '--tg-theme-button-text-color': '#ffffff',

            '--bg': '#111318',
            '--secondary-bg': '#1d2027',
            '--text': '#e8eaed',
            '--link': '#63a8ff',
            '--reader-scrollbar-track': 'rgba(255, 255, 255, 0.05)',
            '--reader-scrollbar-thumb': 'rgba(255, 255, 255, 0.25)',
            '--reader-scrollbar-thumb-active': 'rgba(255, 255, 255, 0.45)'
        },

        sepia: {
            '--tg-theme-bg-color': '#f4ecd8',
            '--tg-theme-secondary-bg-color': '#e9dec4',
            '--tg-theme-text-color': '#3b3226',
            '--tg-theme-hint-color': '#887966',
            '--tg-theme-link-color': '#8b5a2b',
            '--tg-theme-button-color': '#8b5a2b',
            '--tg-theme-button-text-color': '#ffffff',

            '--bg': '#f4ecd8',
            '--secondary-bg': '#e9dec4',
            '--text': '#3b3226',
            '--link': '#8b5a2b',
            '--reader-scrollbar-track': 'rgba(139, 90, 43, 0.08)',
            '--reader-scrollbar-thumb': 'rgba(139, 90, 43, 0.3)',
            '--reader-scrollbar-thumb-active': 'rgba(139, 90, 43, 0.5)'
        }
    };

    let readerSettings = {};


    function readReaderSettings() {
        try {
            var raw =
                localStorage.getItem(
                    READER_SETTINGS_KEY
                );

            if (!raw) {
                return {};
            }

            var parsed = JSON.parse(raw);

            if (
                !parsed
                || typeof parsed !== 'object'
                || Array.isArray(parsed)
            ) {
                return {};
            }

            return parsed;

        } catch (e) {
            console.warn(
                'Не удалось прочитать настройки:',
                e
            );

            return {};
        }
    }


    function saveReaderSettings() {
        try {
            localStorage.setItem(
                READER_SETTINGS_KEY,
                JSON.stringify(readerSettings)
            );
        } catch (e) {
            console.warn(
                'Не удалось сохранить настройки:',
                e
            );
        }
    }


    function setReaderSetting(
        key,
        value
    ) {
        readerSettings[key] = value;

        saveReaderSettings();
    }


    function getCurrentReaderFontSize() {
        if (!$content) {
            return 17;
        }

        var value = parseFloat(
            getComputedStyle(
                $content
            ).fontSize
        );

        if (
            !Number.isFinite(value)
            || value <= 0
        ) {
            return 17;
        }

        return Math.round(value);
    }


    function getCurrentReaderLineHeight() {
        if (!$content) {
            return 1.7;
        }

        var style =
            getComputedStyle($content);

        var fontSize =
            parseFloat(style.fontSize);

        var lineHeight =
            parseFloat(style.lineHeight);

        if (
            Number.isFinite(lineHeight)
            && Number.isFinite(fontSize)
            && fontSize > 0
        ) {
            var relative =
                lineHeight / fontSize;

            return Math.min(
                2.2,
                Math.max(
                    1.3,
                    Math.round(
                        relative * 10
                    ) / 10
                )
            );
        }

        return 1.7;
    }


    function getCurrentThemeForControls() {
        if (
            readerSettings.theme
            && READER_THEMES[
                readerSettings.theme
            ]
        ) {
            return readerSettings.theme;
        }

        if (
            tg
            && tg.colorScheme === 'light'
        ) {
            return 'light';
        }

        return 'dark';
    }


    function applyReaderFont(fontKey) {
        if (
            !READER_FONT_MAP.hasOwnProperty(
                fontKey
            )
        ) {
            return;
        }

        var fontValue =
            READER_FONT_MAP[fontKey];

        if ($content) {
            $content.style.fontFamily =
                fontValue;
        }

        if ($title) {
            $title.style.fontFamily =
                fontValue;
        }
    }


    function applyReaderFontSize(value) {
        var size = Number(value);

        if (
            !Number.isFinite(size)
            || size < 14
            || size > 28
        ) {
            return;
        }

        if ($content) {
            $content.style.fontSize =
                size + 'px';
        }
    }


    function applyReaderLineHeight(value) {
        var lineHeight = Number(value);

        if (
            !Number.isFinite(lineHeight)
            || lineHeight < 1.3
            || lineHeight > 2.2
        ) {
            return;
        }

        if ($content) {
            $content.style.lineHeight =
                String(lineHeight);
        }
    }


    function applyReaderIndent(enabled) {
        if (!$content) {
            return;
        }

        $content.classList.toggle(
            'reader-indent',
            enabled === true
        );
    }


    function applyReaderTheme(themeName) {
        var palette =
            READER_THEMES[themeName];

        if (!palette) {
            return;
        }

        var root =
            document.documentElement;

        Object.keys(
            palette
        ).forEach(function (name) {
            root.style.setProperty(
                name,
                palette[name]
            );
        });

        root.dataset.readerTheme =
            themeName;

        root.style.colorScheme =
            themeName === 'dark'
                ? 'dark'
                : 'light';

        document.body.style.backgroundColor =
            palette[
                '--tg-theme-bg-color'
            ];

        document.body.style.color =
            palette[
                '--tg-theme-text-color'
            ];

        updateThemeButtons(
            themeName
        );
    }


    function updateThemeButtons(
        selectedTheme
    ) {
        $readerThemeButtons.forEach(
            function (button) {
                button.classList.toggle(
                    'active',
                    button.dataset.readerTheme
                        === selectedTheme
                );
            }
        );
    }


    function syncReaderSettingsControls() {
        if ($readerFont) {
            $readerFont.value =
                readerSettings.font
                || 'system';
        }

        var fontSize =
            readerSettings.fontSize
            || getCurrentReaderFontSize();

        if ($readerFontSize) {
            $readerFontSize.value =
                String(fontSize);
        }

        if ($readerFontSizeValue) {
            $readerFontSizeValue.textContent =
                fontSize + ' px';
        }

        var lineHeight =
            readerSettings.lineHeight
            || getCurrentReaderLineHeight();

        if ($readerLineHeight) {
            $readerLineHeight.value =
                String(lineHeight);
        }

        if ($readerLineHeightValue) {
            $readerLineHeightValue.textContent =
                Number(
                    lineHeight
                ).toFixed(1);
        }

        if ($readerIndent) {
            $readerIndent.checked =
                readerSettings.indent === true;
        }

        updateThemeButtons(
            getCurrentThemeForControls()
        );
    }


    function applyStoredReaderSettings() {
        /*
            КРИТИЧЕСКИ ВАЖНО:

            Применяем ТОЛЬКО реально сохранённые свойства.

            Если настройки нет в localStorage,
            текущий внешний вид не переопределяем.
        */

        if (
            Object.prototype.hasOwnProperty.call(
                readerSettings,
                'font'
            )
        ) {
            applyReaderFont(
                readerSettings.font
            );
        }

        if (
            Object.prototype.hasOwnProperty.call(
                readerSettings,
                'fontSize'
            )
        ) {
            applyReaderFontSize(
                readerSettings.fontSize
            );
        }

        if (
            Object.prototype.hasOwnProperty.call(
                readerSettings,
                'lineHeight'
            )
        ) {
            applyReaderLineHeight(
                readerSettings.lineHeight
            );
        }

        if (
            Object.prototype.hasOwnProperty.call(
                readerSettings,
                'indent'
            )
        ) {
            applyReaderIndent(
                readerSettings.indent
            );
        }

        if (
            Object.prototype.hasOwnProperty.call(
                readerSettings,
                'theme'
            )
            && READER_THEMES[
                readerSettings.theme
            ]
        ) {
            applyReaderTheme(
                readerSettings.theme
            );
        }
    }


    let readerSettingsSavedScrollY = 0;
    let readerSettingsScrollLocked = false;

    function lockReaderSettingsScroll() {
        if (readerSettingsScrollLocked) {
            return;
        }

        readerSettingsSavedScrollY =
            window.scrollY
            || window.pageYOffset
            || 0;

        document.body.style.position = 'fixed';
        document.body.style.top =
            '-' + readerSettingsSavedScrollY + 'px';
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.width = '100%';
        document.body.style.overflow = 'hidden';

        document.documentElement
            .classList
            .add('reader-settings-open');

        document.body
            .classList
            .add('reader-settings-open');

        readerSettingsScrollLocked = true;
    }

    function unlockReaderSettingsScroll() {
        if (!readerSettingsScrollLocked) {
            return;
        }

        document.documentElement
            .classList
            .remove('reader-settings-open');

        document.body
            .classList
            .remove('reader-settings-open');

        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.width = '';
        document.body.style.overflow = '';

        window.scrollTo(
            0,
            readerSettingsSavedScrollY
        );

        readerSettingsScrollLocked = false;
    }


    

    let readerSettingsPointerId = null;
    let readerSettingsPointerStartY = 0;
    let readerSettingsPointerDeltaY = 0;
    let readerSettingsPointerDragging = false;

    function resetReaderSettingsDrag() {
        readerSettingsPointerId = null;
        readerSettingsPointerStartY = 0;
        readerSettingsPointerDeltaY = 0;
        readerSettingsPointerDragging = false;

        if ($readerSettingsMenu) {
            $readerSettingsMenu
                .classList
                .remove('dragging');

            $readerSettingsMenu.style.transform = '';
            $readerSettingsMenu.style.transition = '';
        }

        if ($readerSettingsOverlay) {
            $readerSettingsOverlay.style.opacity = '';
        }
    }


    function openReaderSettings() {
        if (
            !$readerSettingsMenu
            || !$readerSettingsOverlay
        ) {
            return;
        }

        if (
            $readerSettingsMenu
                .classList
                .contains('open')
        ) {
            return;
        }

        syncReaderSettingsControls();

        $readerSettingsMenu
            .classList
            .add('open');

        $readerSettingsOverlay
            .classList
            .add('open');

        $readerSettingsMenu
            .setAttribute(
                'aria-hidden',
                'false'
            );

        lockReaderSettingsScroll();
    }


    function closeReaderSettings() {
        if (
            !$readerSettingsMenu
            || !$readerSettingsMenu
                .classList
                .contains('open')
        ) {
            return;
        }

        resetReaderSettingsDrag();

        $readerSettingsMenu
            .classList
            .remove('open');

        $readerSettingsMenu
            .setAttribute(
                'aria-hidden',
                'true'
            );

        if ($readerSettingsOverlay) {
            $readerSettingsOverlay
                .classList
                .remove('open');
        }

        unlockReaderSettingsScroll();
    }


    function initReaderSettings() {
        readerSettings =
            readReaderSettings();

        applyStoredReaderSettings();

        syncReaderSettingsControls();


        if ($readerSettingsButton) {
            $readerSettingsButton
                .addEventListener(
                    'click',
                    function () {
                        if (
                            $readerSettingsMenu
                            && $readerSettingsMenu
                                .classList
                                .contains('open')
                        ) {
                            closeReaderSettings();
                        } else {
                            openReaderSettings();
                        }
                    }
                );
        }


        if ($readerSettingsOverlay) {
            $readerSettingsOverlay
                .addEventListener(
                    'click',
                    closeReaderSettings
                );
        }


        if ($readerSettingsHandle) {
            $readerSettingsHandle.addEventListener(
                'pointerdown',
                function (event) {
                    if (
                        !$readerSettingsMenu
                        || !$readerSettingsMenu
                            .classList
                            .contains('open')
                    ) {
                        return;
                    }

                    /*
                        Только primary pointer.
                    */
                    if (
                        event.isPrimary === false
                    ) {
                        return;
                    }

                    readerSettingsPointerId =
                        event.pointerId;

                    readerSettingsPointerStartY =
                        event.clientY;

                    readerSettingsPointerDeltaY = 0;
                    readerSettingsPointerDragging = true;

                    $readerSettingsMenu
                        .classList
                        .add('dragging');

                    try {
                        $readerSettingsHandle
                            .setPointerCapture(
                                event.pointerId
                            );
                    } catch (e) {
                        // Не критично.
                    }

                    event.preventDefault();
                }
            );

            $readerSettingsHandle.addEventListener(
                'pointermove',
                function (event) {
                    if (
                        !readerSettingsPointerDragging
                        || event.pointerId
                            !== readerSettingsPointerId
                    ) {
                        return;
                    }

                    var deltaY =
                        event.clientY
                        - readerSettingsPointerStartY;

                    /*
                        Вверх не тянем.
                    */
                    if (deltaY < 0) {
                        deltaY = 0;
                    }

                    readerSettingsPointerDeltaY =
                        deltaY;

                    if ($readerSettingsMenu) {
                        $readerSettingsMenu
                            .style.transform =
                            'translate3d(0, '
                            + deltaY
                            + 'px, 0)';
                    }

                    if ($readerSettingsOverlay) {
                        var progress =
                            Math.min(
                                deltaY / 260,
                                1
                            );

                        /*
                            У открытого overlay фактическая
                            прозрачность задаётся CSS.
                            Здесь уменьшаем её по мере drag.
                        */
                        $readerSettingsOverlay
                            .style.opacity =
                            String(
                                Math.max(
                                    0,
                                    1 - progress
                                )
                            );
                    }

                    event.preventDefault();
                }
            );


            function finishReaderSettingsPointerDrag(
                shouldCancel
            ) {
                if (!readerSettingsPointerDragging) {
                    return;
                }

                var shouldClose =
                    !shouldCancel
                    && readerSettingsPointerDeltaY >= 90;

                if (shouldClose) {
                    /*
                        Сначала сбрасываем drag inline styles,
                        потом закрываем обычным механизмом.
                    */
                    resetReaderSettingsDrag();
                    closeReaderSettings();
                    return;
                }

                /*
                    Если свайп недостаточный —
                    плавно вернуть панель назад.
                */
                if ($readerSettingsMenu) {
                    $readerSettingsMenu
                        .classList
                        .remove('dragging');

                    $readerSettingsMenu
                        .style.transition =
                        'transform 0.2s ease';

                    $readerSettingsMenu
                        .style.transform =
                        'translate3d(0, 0, 0)';
                }

                if ($readerSettingsOverlay) {
                    $readerSettingsOverlay
                        .style.transition =
                        'opacity 0.2s ease';

                    $readerSettingsOverlay
                        .style.opacity = '';
                }

                window.setTimeout(
                    function () {
                        if ($readerSettingsOverlay) {
                            $readerSettingsOverlay
                                .style.transition = '';
                        }

                        resetReaderSettingsDrag();
                    },
                    210
                );
            }


            $readerSettingsHandle.addEventListener(
                'pointerup',
                function (event) {
                    if (
                        event.pointerId
                        !== readerSettingsPointerId
                    ) {
                        return;
                    }

                    try {
                        $readerSettingsHandle
                            .releasePointerCapture(
                                event.pointerId
                            );
                    } catch (e) {
                        // Не критично.
                    }

                    finishReaderSettingsPointerDrag(
                        false
                    );
                }
            );


            $readerSettingsHandle.addEventListener(
                'pointercancel',
                function (event) {
                    if (
                        event.pointerId
                        !== readerSettingsPointerId
                    ) {
                        return;
                    }

                    finishReaderSettingsPointerDrag(
                        true
                    );
                }
            );
        }


        if ($readerFont) {
            $readerFont.addEventListener(
                'change',
                function () {
                    var value =
                        $readerFont.value;

                    setReaderSetting(
                        'font',
                        value
                    );

                    applyReaderFont(
                        value
                    );
                }
            );
        }


        if ($readerFontSize) {
            $readerFontSize.addEventListener(
                'input',
                function () {
                    var value =
                        Number(
                            $readerFontSize.value
                        );

                    if (
                        $readerFontSizeValue
                    ) {
                        $readerFontSizeValue
                            .textContent =
                            value + ' px';
                    }

                    setReaderSetting(
                        'fontSize',
                        value
                    );

                    applyReaderFontSize(
                        value
                    );
                }
            );
        }


        if ($readerLineHeight) {
            $readerLineHeight.addEventListener(
                'input',
                function () {
                    var value =
                        Number(
                            $readerLineHeight.value
                        );

                    if (
                        $readerLineHeightValue
                    ) {
                        $readerLineHeightValue
                            .textContent =
                            value.toFixed(1);
                    }

                    setReaderSetting(
                        'lineHeight',
                        value
                    );

                    applyReaderLineHeight(
                        value
                    );
                }
            );
        }


        if ($readerIndent) {
            $readerIndent.addEventListener(
                'change',
                function () {
                    var value =
                        $readerIndent.checked;

                    setReaderSetting(
                        'indent',
                        value
                    );

                    applyReaderIndent(
                        value
                    );
                }
            );
        }


        $readerThemeButtons.forEach(
            function (button) {
                button.addEventListener(
                    'click',
                    function () {
                        var theme =
                            button.dataset
                                .readerTheme;

                        if (
                            !READER_THEMES[
                                theme
                            ]
                        ) {
                            return;
                        }

                        setReaderSetting(
                            'theme',
                            theme
                        );

                        applyReaderTheme(
                            theme
                        );
                    }
                );
            }
        );


        document.addEventListener(
            'keydown',
            function (event) {
                if (
                    event.key === 'Escape'
                ) {
                    if (typeof closeReaderImageLightbox === 'function' && document.getElementById('reader-image-lightbox') && !document.getElementById('reader-image-lightbox').hidden) {
                        closeReaderImageLightbox();
                    } else {
                        closeReaderSettings();
                    }
                }
            }
        );
    }

    initReaderSettings();

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
        if (typeof updateReadingProgress === 'function') updateReadingProgress();
        $error.hidden = true;

        if ($readerSettingsButton) {
            $readerSettingsButton.hidden = true;
        }

        closeReaderSettings();
    }

    function showContent(title) {
        $loader.hidden = true;
        $reader.hidden = false;
        if (typeof updateReadingProgress === 'function') updateReadingProgress();
        $error.hidden = true;
        if (title) $title.textContent = title;

        if ($readerSettingsButton) {
            $readerSettingsButton.hidden = false;
        }
    }

    function showError(title, message) {
        $loader.hidden = true;
        $reader.hidden = true;
        if (typeof updateReadingProgress === 'function') updateReadingProgress();
        $error.hidden = false;
        $errorTitle.textContent = title || 'Ошибка';
        $errorMsg.textContent = message || '';

        if ($readerSettingsButton) {
            $readerSettingsButton.hidden = true;
        }

        closeReaderSettings();
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

                // Сохраняем из inline CSS ТОЛЬКО безопасное выравнивание текста.
                // Полный style намеренно не копируется.
                if (ALIGNABLE_TAGS.has(tagName)) {
                    var textAlign = '';

                    if (sourceNode.style && sourceNode.style.textAlign) {
                        textAlign = sourceNode.style.textAlign
                            .toLowerCase()
                            .trim();
                    }

                    if (SAFE_TEXT_ALIGNS.has(textAlign)) {
                        el.style.textAlign = textAlign;
                    }
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

    let bookmarkMenu = null;
    let bookmarkOverlay = null;
    let bookmarkTitle = null;
    let bookmarkButton = null;
    let bookmarkButtonText = null;

    let footnoteModal = null;
    let footnoteTitle = null;
    let footnoteText = null;
    let footnoteClose = null;

    let pendingBookmark = null;
    let longPressTimer = null;

    let copyProtectionReady = false;

    function injectUI() {
        bookmarkMenu =
            document.getElementById('bookmark-menu');

        bookmarkOverlay =
            document.getElementById('bookmark-overlay');

        bookmarkTitle =
            document.getElementById('bookmark-title');

        bookmarkButton =
            document.getElementById('btn-add-bookmark');

        bookmarkButtonText =
            document.getElementById('bookmark-btn-text');

        footnoteModal =
            document.getElementById('footnote-modal');

        footnoteTitle =
            document.getElementById('footnote-title');

        footnoteText =
            document.getElementById('footnote-text');

        footnoteClose =
            document.getElementById('footnote-close');

        if (
            !bookmarkMenu
            || !bookmarkOverlay
            || !bookmarkButton
        ) {
            console.warn(
                'UI закладок не найден в index.html'
            );
        }

        if (
            !footnoteModal
            || !footnoteTitle
            || !footnoteText
            || !footnoteClose
        ) {
            console.warn(
                'UI сносок не найден в index.html'
            );
        }

        if (bookmarkOverlay) {
            bookmarkOverlay.onclick =
                closeBookmarkMenu;
        }

        if (bookmarkButton) {
            bookmarkButton.onclick =
                savePendingBookmark;
        }

        if (footnoteClose) {
            footnoteClose.onclick =
                closeFootnoteModal;
        }

        if (footnoteModal) {
            footnoteModal.onclick =
                function (e) {
                    if (e.target === footnoteModal) {
                        closeFootnoteModal();
                    }
                };
        }
    }

    function showFootnoteModal(title, text) {
        if (
            !footnoteModal
            || !footnoteTitle
            || !footnoteText
        ) {
            return;
        }

        footnoteTitle.textContent = title;
        footnoteText.textContent = text;

        footnoteModal.classList.add('open');

        footnoteModal.setAttribute(
            'aria-hidden',
            'false'
        );
    }

    function closeFootnoteModal() {
        if (!footnoteModal) return;

        footnoteModal.classList.remove('open');

        footnoteModal.setAttribute(
            'aria-hidden',
            'true'
        );
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
        var paras =
            $content.querySelectorAll('p');

        var currentSlug =
            chapterSlug || chapterUrl;

        paras.forEach(function (p, index) {
            var pNum = index + 1;

            p.dataset.paraIdx = pNum;
            p.id = 'para-' + pNum;

            function startPress(e) {
                if (
                    e.target
                    && e.target.closest
                    && e.target.closest('.footnote-ref')
                ) {
                    return;
                }

                clearTimeout(longPressTimer);

                p.classList.add(
                    'active-paragraph'
                );

                longPressTimer =
                    setTimeout(function () {
                        p.classList.remove(
                            'active-paragraph'
                        );

                        showBookmarkMenu(
                            pNum,
                            currentSlug,
                            p
                        );
                    }, 600);
            }

            function cancelPress() {
                clearTimeout(longPressTimer);

                p.classList.remove(
                    'active-paragraph'
                );
            }

            p.addEventListener(
                'touchstart',
                startPress,
                { passive: true }
            );

            p.addEventListener(
                'touchend',
                cancelPress
            );

            p.addEventListener(
                'touchmove',
                cancelPress,
                { passive: true }
            );

            p.addEventListener(
                'touchcancel',
                cancelPress
            );

            p.addEventListener(
                'mousedown',
                startPress
            );

            p.addEventListener(
                'mouseup',
                cancelPress
            );

            p.addEventListener(
                'mouseleave',
                cancelPress
            );
        });

        // Восстанавливаем сохранённую закладку
        if (currentSlug) {
            var savedPara =
                localStorage.getItem(
                    'manga_bookmark_' + currentSlug
                );

            if (savedPara) {
                var target =
                    document.getElementById(
                        'para-' + savedPara
                    );

                if (target) {
                    target.classList.add(
                        'bookmarked'
                    );

                    setTimeout(function () {
                        var bookmarkRestoreUserInteracted = false;

                        function interactionHandler() {
                            bookmarkRestoreUserInteracted = true;
                        }

                        document.addEventListener('wheel', interactionHandler, { passive: true });
                        document.addEventListener('touchstart', interactionHandler, { passive: true });
                        document.addEventListener('pointerdown', interactionHandler, { passive: true });

                        function centerRestoredBookmark(tgt) {
                            if (!tgt || !tgt.isConnected) return;
                            var rect = tgt.getBoundingClientRect();
                            var targetCenter = rect.top + (rect.height / 2);
                            var viewportCenter = window.innerHeight / 2;
                            var delta = targetCenter - viewportCenter;

                            if (Math.abs(delta) > 4) {
                                var previousScrollBehavior = document.documentElement.style.scrollBehavior;
                                document.documentElement.style.scrollBehavior = 'auto';
                                window.scrollBy(0, delta);
                                document.documentElement.style.scrollBehavior = previousScrollBehavior;
                            }
                        }

                        var previousScrollBehavior = document.documentElement.style.scrollBehavior;
                        document.documentElement.style.scrollBehavior = 'auto';
                        target.scrollIntoView({ behavior: 'auto', block: 'center' });
                        document.documentElement.style.scrollBehavior = previousScrollBehavior;

                        window.requestAnimationFrame(function () {
                            window.requestAnimationFrame(function () {
                                if (!bookmarkRestoreUserInteracted) {
                                    centerRestoredBookmark(target);
                                }
                            });
                        });

                        setTimeout(function () {
                            if (!bookmarkRestoreUserInteracted) {
                                centerRestoredBookmark(target);
                            }
                            document.removeEventListener('wheel', interactionHandler);
                            document.removeEventListener('touchstart', interactionHandler);
                            document.removeEventListener('pointerdown', interactionHandler);
                        }, 700);

                    }, 300);
                }
            }
        }
    }

    function showBookmarkMenu(
        pNum,
        slug,
        paragraph
    ) {
        if (
            !bookmarkMenu
            || !bookmarkOverlay
        ) {
            return;
        }

        var key =
            'manga_bookmark_' + slug;

        var savedPara =
            localStorage.getItem(key);

        var isBookmarked =
            savedPara === String(pNum);

        pendingBookmark = {
            pNum: pNum,
            slug: slug,
            paragraph: paragraph,
            isBookmarked: isBookmarked
        };

        if (bookmarkTitle) {
            bookmarkTitle.textContent =
                'Параграф ' + pNum;
        }

        if (bookmarkButtonText) {
            bookmarkButtonText.textContent =
                isBookmarked
                    ? 'Удалить закладку'
                    : 'Сохранить закладку';
        }

        bookmarkMenu.classList.add('open');
        bookmarkOverlay.classList.add('open');
    }

    function closeBookmarkMenu() {
        if (bookmarkMenu) {
            bookmarkMenu.classList.remove(
                'open'
            );
        }

        if (bookmarkOverlay) {
            bookmarkOverlay.classList.remove(
                'open'
            );
        }

        pendingBookmark = null;
    }

    function savePendingBookmark(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        if (
            !pendingBookmark
            || !pendingBookmark.slug
        ) {
            closeBookmarkMenu();
            return;
        }

        var key =
            'manga_bookmark_'
            + pendingBookmark.slug;

        // ========================================
        // УДАЛЕНИЕ существующей закладки
        // ========================================

        if (pendingBookmark.isBookmarked) {
            localStorage.removeItem(key);

            if (pendingBookmark.paragraph) {
                pendingBookmark.paragraph
                    .classList.remove('bookmarked');
            }

            if (bookmarkButtonText) {
                bookmarkButtonText.textContent =
                    '✅ Закладка удалена';
            }

            setTimeout(function () {
                closeBookmarkMenu();
            }, 650);

            return;
        }

        // ========================================
        // ДОБАВЛЕНИЕ / ПЕРЕНОС закладки
        // ========================================

        localStorage.setItem(
            key,
            String(pendingBookmark.pNum)
        );

        // Убираем визуальное выделение
        // со старой закладки, если она была.
        var previous =
            $content.querySelector(
                'p.bookmarked'
            );

        if (previous) {
            previous.classList.remove(
                'bookmarked'
            );
        }

        // Подсвечиваем новый параграф.
        if (pendingBookmark.paragraph) {
            pendingBookmark.paragraph
                .classList.add('bookmarked');
        }

        if (bookmarkButtonText) {
            bookmarkButtonText.textContent =
                '✅ Закладка добавлена';
        }

        setTimeout(function () {
            closeBookmarkMenu();
        }, 650);
    }

    function setupCopyProtection() {
        if (copyProtectionReady) {
            return;
        }

        copyProtectionReady = true;

        $content.addEventListener(
            'contextmenu',
            function (e) {
                e.preventDefault();
            }
        );

        $content.addEventListener(
            'dragstart',
            function (e) {
                e.preventDefault();
            }
        );

        document.addEventListener(
            'copy',
            function (e) {
                e.preventDefault();
            }
        );
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

            // Контент уже загружен и отрисован.
            // Теперь включаем сноски, закладки и защиту.
            postProcessContent();

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


    // ==================== Reader Quick Scrollbar ====================

    const $scrollbar = document.getElementById('reader-scrollbar');
    const $scrollbarTrack = document.getElementById('reader-scrollbar-track');
    const $scrollbarThumb = document.getElementById('reader-scrollbar-thumb');

    let scrollbarVisible = false;
    let trackHeight = 0;
    let thumbHeight = 0;
    let thumbTravel = 0;
    
    let isDraggingThumb = false;
    let dragStartY = 0;
    let dragStartThumbY = 0;
    
    let hideScrollbarTimeout = null;

    function updateReaderScrollbarMetrics() {
        maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (typeof updateReadingProgress === 'function') updateReadingProgress();
        if (!$scrollbar || !$scrollbarTrack || !$scrollbarThumb) return;
        
        if (maxScroll <= 50) {
            $scrollbar.hidden = true;
            scrollbarVisible = false;
            return;
        }

        const isSettingsOpen = document.documentElement.classList.contains('reader-settings-open');
        const isLoaderVisible = $loader && !$loader.hidden;
        const isErrorVisible = $error && !$error.hidden;
        const isFootnoteOpen = footnoteModal && footnoteModal.classList.contains('open');

        if (isSettingsOpen || isLoaderVisible || isErrorVisible || isFootnoteOpen) {
            $scrollbar.hidden = true;
            scrollbarVisible = false;
        } else {
            $scrollbar.hidden = false;
            scrollbarVisible = true;
        }

        if (scrollbarVisible) {
            trackHeight = $scrollbarTrack.clientHeight;
            
            let rawThumbHeight = (window.innerHeight / document.documentElement.scrollHeight) * trackHeight;
            thumbHeight = Math.max(36, Math.min(rawThumbHeight, trackHeight)); 
            
            $scrollbarThumb.style.height = thumbHeight + 'px';
            thumbTravel = trackHeight - thumbHeight;
            
            updateReaderScrollbarPosition();
        }
    }

    function updateReaderScrollbarPosition() {
        if (!scrollbarVisible) return;
        if (maxScroll <= 0) return;
        
        let scrollRatio = window.scrollY / maxScroll;
        scrollRatio = Math.max(0, Math.min(1, scrollRatio));
        
        let thumbY = scrollRatio * thumbTravel;
        $scrollbarThumb.style.transform = `translate(-50%, ${thumbY}px)`;
    }

    function wakeUpScrollbar() {
        if (!scrollbarVisible) return;
        $scrollbar.classList.add('active');
        clearTimeout(hideScrollbarTimeout);
        if (!isDraggingThumb) {
            hideScrollbarTimeout = setTimeout(() => {
                $scrollbar.classList.remove('active');
            }, 1500);
        }
    }

    if ($scrollbar) {
        $scrollbar.addEventListener('pointerdown', function(e) {
            wakeUpScrollbar();
            
            const thumbRect = $scrollbarThumb.getBoundingClientRect();
            if (e.clientY >= thumbRect.top && e.clientY <= thumbRect.bottom) {
                isDraggingThumb = true;
                dragStartY = e.clientY - thumbRect.top;
                
                $scrollbarThumb.setPointerCapture(e.pointerId);
                $scrollbar.classList.add('active');
                e.preventDefault();
            } else {
                const trackRect = $scrollbarTrack.getBoundingClientRect();
                let clickY = e.clientY - trackRect.top;
                let newThumbY = clickY - (thumbHeight / 2);
                newThumbY = Math.max(0, Math.min(thumbTravel, newThumbY));
                
                let scrollRatio = thumbTravel > 0 ? newThumbY / thumbTravel : 0;
                window.scrollTo({
                    top: scrollRatio * maxScroll,
                    behavior: 'auto'
                });
                updateReaderScrollbarPosition();
            }
        });

        $scrollbar.addEventListener('pointermove', function(e) {
            if (!isDraggingThumb) return;
            
            const trackRect = $scrollbarTrack.getBoundingClientRect();
            let newThumbY = e.clientY - trackRect.top - dragStartY;
            newThumbY = Math.max(0, Math.min(thumbTravel, newThumbY));
            
            if (thumbTravel > 0) {
                let scrollRatio = newThumbY / thumbTravel;
                window.scrollTo({
                    top: scrollRatio * maxScroll,
                    behavior: 'auto'
                });
                updateReaderScrollbarPosition();
            }
        });

        const endDrag = function(e) {
            if (isDraggingThumb) {
                isDraggingThumb = false;
                $scrollbarThumb.releasePointerCapture(e.pointerId);
                wakeUpScrollbar();
                updateReaderScrollbarPosition();
            }
        };

        $scrollbar.addEventListener('pointerup', endDrag);
        $scrollbar.addEventListener('pointercancel', endDrag);
    }

    let readerScrollRafPending = false;
    window.addEventListener('scroll', function() {
        if (readerScrollRafPending) {
            return;
        }
        readerScrollRafPending = true;
        window.requestAnimationFrame(function() {
            readerScrollRafPending = false;
            updateReaderScrollbarPosition();
            if (typeof updateReadingProgress === 'function') {
                updateReadingProgress();
            }
        });
    }, { passive: true });

    window.addEventListener('resize', function() {
        window.requestAnimationFrame(updateReaderScrollbarMetrics);
    });

    if (window.ResizeObserver && $content) {
        const ro = new ResizeObserver(() => {
            window.requestAnimationFrame(updateReaderScrollbarMetrics);
        });
        ro.observe($content);
    }

    const htmlObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.attributeName === 'class' || mutation.attributeName === 'style') {
                updateReaderScrollbarMetrics();
            }
        });
    });
    htmlObserver.observe(document.documentElement, { attributes: true });
    htmlObserver.observe(document.body, { attributes: true });
    
    const fModal = document.getElementById('footnote-modal');
    if (fModal) {
        htmlObserver.observe(fModal, { attributes: true });
    }

    loadChapter();

    // ==================== IMAGE LIGHTBOX ====================
    const $readerImageLightbox = document.getElementById('reader-image-lightbox');
    const $readerImageLightboxImage = document.getElementById('reader-image-lightbox-image');
    const $readerImageLightboxClose = document.getElementById('reader-image-lightbox-close');
    const $readerImageLightboxBackdrop = $readerImageLightbox ? $readerImageLightbox.querySelector('.reader-image-lightbox-backdrop') : null;

    let imageLightboxSavedScrollY = 0;
    let imageLightboxScrollLocked = false;

    function closeReaderImageLightbox() {
        if (!$readerImageLightbox || $readerImageLightbox.hidden) return;
        
        $readerImageLightbox.hidden = true;
        $readerImageLightbox.setAttribute('aria-hidden', 'true');
        if ($readerImageLightboxImage) {
            $readerImageLightboxImage.src = '';
        }
        
        if (imageLightboxScrollLocked) {
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.left = '';
            document.body.style.right = '';
            document.body.style.width = '';
            document.body.style.overflow = '';
            window.scrollTo(0, imageLightboxSavedScrollY);
            imageLightboxScrollLocked = false;
        }
    }

    if ($readerImageLightboxClose) {
        $readerImageLightboxClose.addEventListener('click', closeReaderImageLightbox);
    }
    if ($readerImageLightboxBackdrop) {
        $readerImageLightboxBackdrop.addEventListener('click', closeReaderImageLightbox);
    }
    if ($readerImageLightboxImage) {
        $readerImageLightboxImage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        $readerImageLightboxImage.addEventListener('dragstart', function (e) { e.preventDefault(); });
    }

    if ($content) {
        $content.addEventListener('click', function (event) {
            const image = event.target.closest('img');
            if (!image || !$content.contains(image)) return;
            
            if (typeof $readerSettingsMenu !== 'undefined' && $readerSettingsMenu && $readerSettingsMenu.classList.contains('open')) return;
            if (typeof footnoteModal !== 'undefined' && footnoteModal && footnoteModal.classList.contains('open')) return;
            if (typeof bookmarkMenu !== 'undefined' && bookmarkMenu && bookmarkMenu.classList.contains('open')) return;
            
            event.preventDefault();
            event.stopPropagation();
            
            const src = image.currentSrc || image.src || image.getAttribute('src');
            if (!src) return;
            
            if ($readerImageLightbox && $readerImageLightboxImage) {
                $readerImageLightboxImage.src = src;
                if (image.alt) {
                    $readerImageLightboxImage.alt = image.alt;
                }
                
                if (!imageLightboxScrollLocked) {
                    imageLightboxSavedScrollY = window.scrollY || window.pageYOffset || 0;
                    document.body.style.position = 'fixed';
                    document.body.style.top = '-' + imageLightboxSavedScrollY + 'px';
                    document.body.style.left = '0';
                    document.body.style.right = '0';
                    document.body.style.width = '100%';
                    document.body.style.overflow = 'hidden';
                    imageLightboxScrollLocked = true;
                }
                
                $readerImageLightbox.hidden = false;
                $readerImageLightbox.setAttribute('aria-hidden', 'false');
            }
        });
    }

})();
