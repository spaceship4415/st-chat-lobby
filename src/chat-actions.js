import {
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    is_send_press,
    isChatSaving,
    openCharacterChat,
    reloadCurrentChat,
    saveSettingsDebounced,
    selectCharacterById,
    setActiveCharacter,
    setActiveGroup,
    this_chid,
    unshallowCharacter,
    updateRemoteChatName,
} from '../../../../../script.js';
import {
    editGroup,
    groups,
    is_group_generating,
    openGroupById,
    openGroupChat,
    renameGroupChat,
    selected_group,
} from '../../../../group-chats.js';
import { humanizedDateTime, isMobile } from '../../../../RossAscends-mods.js';
import { LOG_PREFIX } from './constants.js';
import { getCharacterChatNames, getLatestCharacterChat } from './data-source.js';
import { tr } from './i18n.js';

/**
 * 채팅 열기·이름 바꾸기·삭제.
 *
 * ST 의 renameGroupOrCharacterChat / deleteCharacterChatByName / deleteGroupChatByName 은 실패해도 알려 주지 않고
 * (오류 팝업·토스트만 띄움) 지금 채팅이 아니어도 현재 채팅을 다시 불러오므로, 같은 서버 API 를 직접 부르고
 * 뒤처리(마지막 채팅 기록, 그룹 정보, 이벤트)만 ST 와 맞춘다.
 */

/** @typedef {import('./data-source.js').LobbyChat} LobbyChat */

/** 여는 중 중복 실행 방지 */
let isOpening = false;

/** @param {string} avatar */
function findCharacterId(avatar) {
    return characters.findIndex(c => c.avatar === avatar);
}

/** @param {string} groupId */
function findGroup(groupId) {
    return groups.find(g => g.id === groupId);
}

/** 응답 생성·저장 중이면 채팅을 바꾸거나 열린 채팅 파일을 건드리지 않는다 */
export function isChatBusy() {
    return !!is_send_press || !!isChatSaving || !!is_group_generating;
}

/**
 * 지금 화면에 열려 있는 채팅인지
 * @param {LobbyChat} chat
 */
export function isOpenChat(chat) {
    const current = getCurrentChatId();
    if (current === undefined || current !== chat.fileName) return false;
    if (chat.groupId) return selected_group === chat.groupId;
    return !selected_group && this_chid !== undefined && characters[Number(this_chid)]?.avatar === chat.avatar;
}

/**
 * 열린 뒤 채팅이 보이게 한다. 휴대폰에서는 오른쪽 패널이 화면 전체를 덮는데,
 * ST 는 다른 캐릭터를 선택하면 패널을 캐릭터 편집 화면으로 바꾼 채 열어 둔다. 고정(pin)된 패널은 건드리지 않는다.
 */
function revealChat() {
    const panel = $('#right-nav-panel');
    const isNarrow = isMobile() || window.matchMedia('(max-width: 1000px)').matches;
    if (isNarrow && panel.hasClass('openDrawer') && !panel.hasClass('pinnedOpen')) {
        $('#rightNavDrawerIcon').trigger('click');
    }
}

/**
 * 채팅을 연다.
 * @param {LobbyChat} chat
 * @returns {Promise<boolean>} 원하는 채팅이 열렸으면 true
 */
export async function openLobbyChat(chat) {
    if (isOpening) return false;
    if (isOpenChat(chat)) return true;
    if (isChatBusy()) {
        toastr.info(tr('busy', 'Please wait until the reply is finished and the chat is saved.'));
        return false;
    }

    isOpening = true;
    try {
        const opened = chat.groupId ? await openGroupFile(chat) : await openCharacterFile(chat);
        if (opened) {
            saveSettingsDebounced();
            revealChat();
        }
        return opened;
    } catch (error) {
        console.error(LOG_PREFIX, 'failed to open chat', error);
        toastr.error(tr('open_failed', 'Could not open the chat.'));
        return false;
    } finally {
        isOpening = false;
    }
}

/**
 * 캐릭터 채팅을 연다.
 *
 * ST 는 '채팅 진입 = characters[id].chat 에 파일 이름을 넣고 getChat()' 구조라서,
 * 다른 캐릭터면 selectCharacterById 직전에 chat 을 바꿔 두어 마지막 채팅을 거치지 않고 한 번에 연다.
 * (ST 첫 화면의 최근 채팅은 선택 → openCharacterChat 으로 두 번 불러온다)
 * @param {LobbyChat} chat
 */
async function openCharacterFile(chat) {
    const chid = findCharacterId(chat.avatar);
    if (chid === -1) {
        toastr.warning(tr('owner_missing', 'The character or group of this chat no longer exists.'));
        return false;
    }
    // 없는 이름을 열면 ST 가 그 이름으로 빈 채팅을 새로 만든다. 목록을 불러온 뒤 다른 곳에서 지워졌을 수 있다
    const names = await getCharacterChatNames(chat.avatar);
    if (!names.includes(chat.fileName)) {
        toastr.warning(tr('chat_missing', 'This chat no longer exists. Refresh the list.'));
        return false;
    }

    // 꼭 먼저: getChat() 이 가벼운(shallow) 캐릭터를 서버 데이터로 통째로 교체하므로,
    // 그 전에 받아 두지 않으면 아래에서 넣은 chat 값이 서버의 옛 값으로 되돌아간다
    await unshallowCharacter(chid);
    const character = characters[chid];

    const isCurrentCharacter = !selected_group && this_chid !== undefined && String(this_chid) === String(chid);
    if (isCurrentCharacter) {
        // 같은 캐릭터: ST 의 채팅 전환과 같은 경로. 카드의 chat 필드 저장까지 해 준다
        await openCharacterChat(chat.fileName);
    } else {
        const previousChat = character.chat;
        character.chat = chat.fileName;
        await selectCharacterById(chid);

        if (getCurrentChatId() === chat.fileName) {
            // 새로고침 후에도 이 채팅이 '마지막 채팅'이 되도록 카드에 기록 (openCharacterChat 이 하는 일과 같은 효과).
            // 채팅은 이미 열렸으므로 기록 실패는 열기 실패로 보지 않는다
            try {
                await updateRemoteChatName(chid, chat.fileName);
            } catch (error) {
                console.warn(LOG_PREFIX, 'failed to remember the last chat on the card', error);
            }
        } else if (characters[chid]?.chat === chat.fileName) {
            // 열지 못했으면 메모리 속 '마지막 채팅'을 되돌린다. 안 그러면 다음 선택 때 이 이름으로 빈 채팅이 생긴다
            characters[chid].chat = previousChat;
        }
    }

    if (getCurrentChatId() !== chat.fileName) {
        console.warn(LOG_PREFIX, 'chat was not opened as requested', { chat, current: getCurrentChatId() });
        toastr.warning(tr('open_failed', 'Could not open the chat.'));
        return false;
    }
    // 새로고침 시 자동으로 다시 열 캐릭터 (ST 첫 화면의 최근 채팅과 같이)
    setActiveCharacter(chat.avatar);
    return true;
}

/**
 * 그룹 채팅을 연다. 다른 그룹이면 그룹의 '마지막 채팅'을 먼저 바꿔 두고 그룹을 열어 한 번에 불러온다.
 * @param {LobbyChat} chat
 */
async function openGroupFile(chat) {
    const group = findGroup(chat.groupId);
    if (!group) {
        toastr.warning(tr('owner_missing', 'The character or group of this chat no longer exists.'));
        return false;
    }
    if (!Array.isArray(group.chats) || !group.chats.includes(chat.fileName)) {
        toastr.warning(tr('chat_missing', 'This chat no longer exists. Refresh the list.'));
        return false;
    }

    if (selected_group === chat.groupId) {
        await openGroupChat(chat.groupId, chat.fileName);
    } else {
        // openGroupChat 과 같은 기록(마지막 채팅·날짜)을 저장한 뒤 그룹을 연다
        group.chat_id = chat.fileName;
        group.date_last_chat = Date.now();
        await editGroup(chat.groupId, true, false);
        await openGroupById(chat.groupId);
    }

    if (selected_group !== chat.groupId || getCurrentChatId() !== chat.fileName) {
        console.warn(LOG_PREFIX, 'group chat was not opened as requested', { chat, current: getCurrentChatId() });
        toastr.warning(tr('open_failed', 'Could not open the chat.'));
        return false;
    }
    setActiveGroup(chat.groupId);
    return true;
}

/**
 * 같은 이름의 채팅이 이미 있는 곳의 이름들. 그룹 채팅 파일은 모든 그룹이 한 폴더를 같이 쓰므로 전체 그룹 기준.
 * @param {LobbyChat} chat
 * @returns {Promise<string[]>}
 */
export async function getSiblingChatNames(chat) {
    if (chat.groupId) {
        return groups.flatMap(g => Array.isArray(g.chats) ? g.chats.map(String) : []);
    }
    return getCharacterChatNames(chat.avatar);
}

/**
 * 채팅 파일 이름을 바꾼다. 같은 이름이 있으면 서버가 거절한다(덮어쓰지 않음).
 * 열려 있는 채팅이면 화면도 새 이름으로 다시 불러온다.
 * @param {LobbyChat} chat
 * @param {string} newName 정리된 새 이름
 * @returns {Promise<string>} 서버가 정리한 실제 새 이름
 */
export async function renameLobbyChat(chat, newName) {
    const oldName = chat.fileName;
    const wasOpen = isOpenChat(chat);
    const chid = chat.groupId ? -1 : findCharacterId(chat.avatar);
    if (!chat.groupId && chid === -1) throw new Error('Character not found');
    if (chat.groupId && !findGroup(chat.groupId)) throw new Error('Group not found');

    const body = {
        is_group: !!chat.groupId,
        avatar_url: chat.groupId ? undefined : chat.avatar,
        original_file: `${oldName}.jsonl`,
        renamed_file: `${newName}.jsonl`,
    };
    const response = await fetch('/api/chats/rename', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.error) throw new Error(`Rename failed (HTTP ${response.status})`);
    const actualName = typeof data?.sanitizedFileName === 'string' && data.sanitizedFileName ? data.sanitizedFileName : newName;

    if (chat.groupId) {
        // 그룹의 채팅 목록과 '마지막 채팅'을 새 이름으로 바꿔 저장한다
        await renameGroupChat(chat.groupId, oldName, actualName);
    } else if (characters[chid]?.chat === oldName) {
        // 캐릭터가 '마지막으로 연 채팅'으로 기억하던 파일이면 그 기록도 새 이름으로.
        // 지금 캐릭터면 편집 폼의 숨은 칸도 맞춘다(나중에 폼이 저장될 때 옛 이름을 되쓰지 않도록)
        await updateRemoteChatName(chid, actualName);
        if (String(this_chid) === String(chid)) $('#selected_chat_pole').val(actualName);
    }
    if (wasOpen) await reloadCurrentChat();

    await eventSource.emit(event_types.CHAT_RENAMED, {
        avatarId: chat.groupId ? undefined : chat.avatar,
        groupId: chat.groupId || undefined,
        oldFileName: body.original_file,
        newFileName: `${actualName}.jsonl`,
    });
    return actualName;
}

/**
 * 채팅 파일을 지운다(되돌릴 수 없음). 열려 있는 채팅은 지우지 않는다.
 * @param {LobbyChat} chat
 * @param {string[]} [knownRemaining] 같은 캐릭터의 남는 채팅 이름(최근 순)을 이미 알면 넘긴다.
 *  마지막으로 연 채팅을 지웠을 때 옮겨 갈 곳. 비어 있으면 서버에 물어본다
 */
export async function deleteLobbyChat(chat, knownRemaining = []) {
    if (isOpenChat(chat)) throw new Error('Refusing to delete the open chat');
    if (chat.groupId) {
        await deleteGroupChatFile(chat);
    } else {
        await deleteCharacterChatFile(chat, knownRemaining);
    }
}

/**
 * @param {LobbyChat} chat
 * @param {string[]} knownRemaining
 */
async function deleteCharacterChatFile(chat, knownRemaining) {
    const chid = findCharacterId(chat.avatar);
    if (chid === -1) throw new Error('Character not found');

    const response = await fetch('/api/chats/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ chatfile: `${chat.fileName}.jsonl`, avatar_url: chat.avatar }),
    });
    if (!response.ok) throw new Error(`Delete failed (HTTP ${response.status})`);

    // ST(deleteCharacterChatByName)와 같이: 마지막으로 연 채팅을 지웠으면 가장 최근 채팅으로, 없으면 새 이름으로.
    // 목록은 전체 중 최근 것만 불러오므로, 그 캐릭터의 남은 채팅이 목록에 없으면 서버에 물어본다
    const character = characters[chid];
    if (character?.chat === chat.fileName) {
        let next = knownRemaining.find(name => name !== chat.fileName) ?? '';
        if (!next) {
            try {
                next = await getLatestCharacterChat(chat.avatar);
            } catch (error) {
                console.warn(LOG_PREFIX, 'failed to find the latest chat', error);
            }
        }
        await updateRemoteChatName(chid, next || `${character.name} - ${humanizedDateTime()}`);
    }
    await eventSource.emit(event_types.CHAT_DELETED, chat.fileName);
}

/** @param {LobbyChat} chat */
async function deleteGroupChatFile(chat) {
    const group = findGroup(chat.groupId);
    if (!group) throw new Error('Group not found');

    const response = await fetch('/api/chats/group/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chat.fileName }),
    });
    if (!response.ok) throw new Error(`Delete failed (HTTP ${response.status})`);

    // ST(deleteGroupChatByName)와 같이 그룹의 채팅 목록에서 빼고, 마지막 채팅이었으면 남은 마지막 채팅으로 옮긴다.
    // 파일 삭제가 성공한 뒤에만 고친다(ST 는 실패해도 목록에서 먼저 빼 버린다)
    if (Array.isArray(group.chats)) {
        const index = group.chats.indexOf(chat.fileName);
        if (index !== -1) group.chats.splice(index, 1);
    }
    if (group.chat_id === chat.fileName) {
        group.chat_id = group.chats?.length ? group.chats[group.chats.length - 1] : humanizedDateTime();
    }
    await editGroup(chat.groupId, true, true);
    await eventSource.emit(event_types.GROUP_CHAT_DELETED, chat.fileName);
}
