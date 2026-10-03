import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { EXTENSION_NAME, LOG_PREFIX } from './src/constants.js';
import { installWandMenu } from './src/menu.js';
import { getSettings, loadSettings, setSetting } from './src/settings.js';
import { installWelcome, refreshWelcome } from './src/welcome.js';

async function mountSettingsPanel() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'templates/settings');
    const root = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    root.append(html);

    const settings = getSettings();
    $('#st_chat_lobby_settings input[type="checkbox"][data-setting]').each(function () {
        const key = this.dataset.setting;
        $(this).prop('checked', !!settings[key]);
        $(this).on('change', function () {
            setSetting(/** @type {any} */ (key), $(this).prop('checked'));
            void refreshWelcome();
        });
    });
    $('#st_chat_lobby_settings select[data-setting]').each(function () {
        const key = this.dataset.setting;
        const isNumber = this.dataset.type === 'number';
        $(this).val(String(settings[key]));
        $(this).on('change', function () {
            const value = String($(this).val());
            setSetting(/** @type {any} */ (key), isNumber ? Number(value) : value);
            void refreshWelcome();
        });
    });
}

jQuery(async () => {
    loadSettings();
    installWelcome();

    try {
        installWandMenu();
    } catch (error) {
        console.error(LOG_PREFIX, 'failed to add the wand menu item', error);
    }

    try {
        await mountSettingsPanel();
    } catch (error) {
        // 설정 패널이 실패해도 목록은 이미 동작 중이므로 확장은 계속 쓸 수 있다
        console.error(LOG_PREFIX, 'failed to mount settings panel', error);
    }
});
