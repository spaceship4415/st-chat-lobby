import { translate } from '../../../../i18n.js';

/**
 * 확장 전용 번역.
 *
 * ST 기본 번역에 이미 있는 키는 확장이 덮어쓸 수 없고(addLocaleData), 반대로 ST 쪽 번역이 비어 있으면
 * 영어 그대로 나온다. 그래서 확장 문구는 모두 `chat_lobby.` 으로 시작하는 고유 키를 쓰고,
 * 번역이 없으면 영어 원문을 보여 준다. 템플릿에서는 data-i18n="chat_lobby.xxx" + 영어 본문으로 같은 효과를 낸다.
 * @param {string} key `chat_lobby.` 뒤에 붙는 키
 * @param {string} english 번역이 없을 때 보여 줄 영어 문구
 * @returns {string}
 */
export function tr(key, english) {
    return translate(english, `chat_lobby.${key}`);
}
