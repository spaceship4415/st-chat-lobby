import { getCurrentChatId } from '../../../../../script.js';
import { openWelcomeScreen } from '../../../../welcome-screen.js';
import { createLobbyList } from './chat-list.js';
import { LOG_PREFIX, SELECTORS } from './constants.js';
import { tr } from './i18n.js';
import { getSettings } from './settings.js';

/**
 * 시작 화면의 '최근 채팅' 자리를 전체 채팅 목록으로 바꾼다.
 *
 * ST 는 채팅을 고르거나 닫을 때마다 시작 화면(.welcomePanel)을 새로 만들어 #chat 에 붙인다.
 * 그래서 #chat 에 붙는 시작 화면을 지켜보다가 그때마다 끼워 넣는다.
 * ST 의 최근 채팅 목록은 지우지 않고 숨기기만 한다(설정을 끄면 바로 원래대로 보이도록).
 */

const MOUNTED_ATTR = 'data-st-lobby';

export function installWelcome() {
    const chat = document.querySelector(SELECTORS.chat);
    if (!chat) {
        console.warn(LOG_PREFIX, '#chat not found; the welcome screen list is not installed');
        return;
    }

    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLElement && node.matches(SELECTORS.welcomePanel)) {
                    mount(node);
                }
            }
        }
    });
    // 시작 화면은 #chat 바로 아래에 붙는다. 메시지 안쪽까지 지켜볼 필요는 없다
    observer.observe(chat, { childList: true });

    // 확장이 늦게 불러와져 이미 떠 있는 시작 화면
    chat.querySelectorAll(`:scope > ${SELECTORS.welcomePanel}`).forEach(panel => mount(/** @type {HTMLElement} */ (panel)));
}

/**
 * 설정을 바꾼 뒤 시작 화면이 떠 있으면 다시 그린다(켜면 전체 채팅, 끄면 ST 최근 채팅).
 */
export async function refreshWelcome() {
    if (getCurrentChatId() !== undefined) return;
    if (!document.querySelector(`${SELECTORS.chat} > ${SELECTORS.welcomePanel}`)) return;
    try {
        await openWelcomeScreen({ force: true });
    } catch (error) {
        console.error(LOG_PREFIX, 'failed to refresh the welcome screen', error);
    }
}

/** @param {HTMLElement} panel */
function mount(panel) {
    if (!getSettings().replaceWelcome) return;
    if (panel.hasAttribute(MOUNTED_ATTR)) return;
    const recent = panel.querySelector(SELECTORS.welcomeRecent);
    if (!(recent instanceof HTMLElement)) return;
    panel.setAttribute(MOUNTED_ATTR, '');
    panel.classList.add('st-lobby-welcome');

    // 제목 '최근 채팅' → '전체 채팅 (N)'. ST 는 data-i18n 이 달린 요소를 다시 번역하므로 키째 바꾼다
    const count = document.createElement('span');
    count.className = 'st-lobby-title-count';
    const title = panel.querySelector(SELECTORS.recentChatsTitle);
    if (title) {
        const label = document.createElement('span');
        label.setAttribute('data-i18n', 'chat_lobby.title');
        label.textContent = tr('title', 'All Chats');
        title.removeAttribute('data-i18n');
        title.replaceChildren(label, ' ', count);
    }

    const host = document.createElement('div');
    host.className = 'st-lobby-welcome-host';
    recent.append(host);

    createLobbyList(host, {
        onCount: (text) => { count.textContent = text ? `(${text})` : ''; },
    }).catch(error => {
        console.error(LOG_PREFIX, 'failed to show the chat list', error);
        // 실패하면 ST 최근 채팅을 다시 보여 준다
        panel.classList.remove('st-lobby-welcome');
        host.remove();
    });
}
