import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../../popup.js';
import { createLobbyList } from './chat-list.js';
import { LOG_PREFIX, SELECTORS } from './constants.js';
import { tr } from './i18n.js';

/**
 * 마법봉 메뉴의 [전체 채팅]. 채팅 중에도 같은 목록을 창으로 연다.
 */

/** @type {Popup | null} */
let activePopup = null;

export function installWandMenu() {
    const menu = document.querySelector(SELECTORS.wandMenu);
    if (!menu) {
        console.warn(LOG_PREFIX, 'wand menu not found');
        return;
    }
    const item = document.createElement('div');
    item.id = 'st_chat_lobby_wand_button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    const icon = document.createElement('div');
    icon.className = 'fa-fw fa-solid fa-table-list extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.setAttribute('data-i18n', 'chat_lobby.title');
    label.textContent = tr('title', 'All Chats');
    item.append(icon, label);
    item.addEventListener('click', () => void openLobbyPopup());
    menu.append(item);
}

export async function openLobbyPopup() {
    if (activePopup) return;

    const content = document.createElement('div');
    content.className = 'st-lobby-popup-content';
    const heading = document.createElement('h3');
    heading.className = 'st-lobby-popup-title';
    const count = document.createElement('span');
    count.className = 'st-lobby-title-count';
    heading.append(tr('title', 'All Chats'), ' ', count);
    const host = document.createElement('div');
    content.append(heading, host);

    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    popup.dlg.classList.add('st-lobby-popup');
    activePopup = popup;

    createLobbyList(host, {
        onCount: (text) => { count.textContent = text ? `(${text})` : ''; },
        // 채팅을 열면 창은 닫는다(채팅이 보이도록)
        beforeOpen: () => { void popup.complete(POPUP_RESULT.CANCELLED); },
    }).catch(error => {
        console.error(LOG_PREFIX, 'failed to show the chat list', error);
        toastr.error(tr('load_failed', 'Could not load the chats.'));
    });

    try {
        await popup.show();
    } finally {
        activePopup = null;
    }
}
