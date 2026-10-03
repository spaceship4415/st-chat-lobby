import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { DEFAULT_SETTINGS, LOAD_COUNTS, MODULE_NAME, SORTS } from './constants.js';

/**
 * 저장된 설정을 읽어 빠진 값을 기본값으로 채운다.
 * 설정 파일이 손상돼 있어도 확장이 통째로 죽지 않도록 타입이나 값이 맞지 않으면 기본값으로 되돌린다.
 */
export function loadSettings() {
    const stored = extension_settings[MODULE_NAME];
    const settings = (stored && typeof stored === 'object') ? stored : {};

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (typeof settings[key] !== typeof value) {
            settings[key] = value;
        }
    }
    if (!LOAD_COUNTS.includes(settings.loadCount)) settings.loadCount = DEFAULT_SETTINGS.loadCount;
    if (!SORTS.includes(settings.sort)) settings.sort = DEFAULT_SETTINGS.sort;
    // 0.1.0 이 저장하던 보기 필터. 다시 열 때 걸러진 채로 남아 검색이 안 되는 것처럼 보여서 기억하지 않게 했다
    delete settings.filter;

    extension_settings[MODULE_NAME] = settings;
    return settings;
}

/** @returns {typeof DEFAULT_SETTINGS} */
export function getSettings() {
    return extension_settings[MODULE_NAME] ?? loadSettings();
}

/**
 * @param {keyof typeof DEFAULT_SETTINGS} key
 * @param {any} value
 */
export function setSetting(key, value) {
    getSettings()[key] = value;
    saveSettingsDebounced();
}
