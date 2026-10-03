import { Popup, POPUP_TYPE, PopupUtils } from '../../../../popup.js';
import { tr } from './i18n.js';

/**
 * 이름(로어북·채팅)을 묻는 입력 창.
 *
 * 기본 이름(채팅 이름 등)이 길면 한 줄 입력칸에서는 휴대폰에서 잘려 보이므로 여러 줄로 보여 준다.
 * 이름에 줄바꿈은 필요 없으니 Enter 는 줄바꿈 대신 바로 확인으로 처리하고(ST 는 여러 줄 입력칸에서
 * Ctrl+Enter 만 제출로 본다), 붙여넣기로 들어온 줄바꿈은 공백으로 바꾼다.
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.text
 * @param {string} options.defaultName 입력칸에 미리 채울 이름
 * @param {string} options.okButton
 * @returns {Promise<string>} 정리된 이름. 취소하면 빈 문자열
 */
export async function askName({ title, text, defaultName, okButton }) {
    const content = PopupUtils.BuildTextWithHeader(title, text);
    const popup = new Popup(content, POPUP_TYPE.INPUT, defaultName, {
        rows: 3,
        okButton,
        cancelButton: tr('cancel', 'Cancel'),
    });
    popup.dlg.classList.add('st-lobby-popup', 'st-lobby-name-popup');

    const input = /** @type {HTMLTextAreaElement} */ (popup.mainInput);
    input.addEventListener('keydown', (event) => {
        // 한글 조합 중의 Enter 는 글자 확정이다
        if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        popup.completeAffirmative();
    });

    const value = await popup.show();
    return typeof value === 'string' ? value.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
}
