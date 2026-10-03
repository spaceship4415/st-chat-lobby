import { eventSource, event_types } from '../../../../../script.js';
import { accountStorage } from '../../../../util/AccountStorage.js';
import { LOG_PREFIX } from './constants.js';

/**
 * ST 최근 채팅의 '고정(핀)'을 같이 쓴다.
 *
 * ST(welcome-screen.js PinnedChatsManager)는 고정 목록을 accountStorage 'pinnedChats' 에
 * { [키]: { group, avatar, file_name } } 로 저장한다. 키는 'group_<id>_<파일>.jsonl' / 'char_<아바타>_<파일>.jsonl'.
 *
 * 주의: ST 는 이 목록을 메모리에 캐시해 두고, 채팅 이름이 바뀔 때(CHAT_RENAMED) 그 캐시로 저장소를 통째로 덮어쓴다.
 * 캐시를 다시 읽게 할 방법이 없으므로(내보내지 않음), 이 확장에서 바꾼 것(고정·해제)을 기록해 두었다가
 * ST 가 덮어쓴 뒤에 다시 얹는다.
 */

const STORAGE_KEY = 'pinnedChats';

/** @typedef {{ group?: string, avatar?: string, file_name: string }} PinnedChat */

/**
 * 이 확장에서 바꾼 고정 상태(키 → 고정이면 항목, 해제면 null). ST 가 옛 캐시로 덮어쓸 때 다시 얹는다
 * @type {Map<string, PinnedChat | null>}
 */
const changes = new Map();

/**
 * @param {{ groupId: string, avatar: string, fileName: string }} chat
 * @returns {PinnedChat}
 */
function toEntry(chat) {
    return { group: chat.groupId || '', avatar: chat.groupId ? '' : chat.avatar, file_name: `${chat.fileName}.jsonl` };
}

/**
 * ST 와 같은 키
 * @param {PinnedChat} entry
 */
function entryKey(entry) {
    return `${entry.group ? 'group_' + entry.group : ''}${entry.avatar ? 'char_' + entry.avatar : ''}_${entry.file_name}`;
}

/** @returns {Record<string, PinnedChat>} */
function readPins() {
    try {
        const value = accountStorage.getItem(STORAGE_KEY);
        const parsed = value ? JSON.parse(value) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.warn(LOG_PREFIX, 'failed to read pinned chats', error);
        return {};
    }
}

/** @param {Record<string, PinnedChat>} state */
function writePins(state) {
    accountStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** 저장소 상태에 이 확장에서 바꾼 것을 얹는다 */
function applyChanges(state) {
    for (const [key, entry] of changes) {
        if (entry) state[key] = entry;
        else delete state[key];
    }
    return state;
}

/**
 * 지금 고정된 채팅의 키 모음. 그릴 때마다 한 번 읽는다(작은 JSON)
 * @returns {Set<string>}
 */
export function getPinnedKeys() {
    return new Set(Object.keys(applyChanges(readPins())));
}

/**
 * @param {{ groupId: string, avatar: string, fileName: string }} chat
 * @param {Set<string>} [keys] getPinnedKeys() 결과(여러 채팅을 볼 때 한 번만 읽도록)
 */
export function isPinned(chat, keys = getPinnedKeys()) {
    return keys.has(entryKey(toEntry(chat)));
}

/**
 * 서버(/api/chats/recent)에 넘길 고정 목록. 서버는 이것들을 개수 제한과 상관없이 맨 앞에 넣어 준다
 * @returns {PinnedChat[]}
 */
export function getPinnedEntries() {
    return Object.values(applyChanges(readPins()));
}

/**
 * 고정하거나 푼다.
 * @param {{ groupId: string, avatar: string, fileName: string }} chat
 * @param {boolean} pinned
 */
export function setPinned(chat, pinned) {
    const entry = toEntry(chat);
    const key = entryKey(entry);
    changes.set(key, pinned ? entry : null);
    writePins(applyChanges(readPins()));
}

/**
 * ST 의 CHAT_RENAMED 처리(옛 캐시로 저장소를 덮어씀)가 끝난 뒤, 이 확장에서 바꾼 것을 새 이름으로 옮겨 다시 얹는다.
 * 리스너 등록 순서에 기대지 않도록, 이벤트 처리가 모두 끝난 다음 차례(setTimeout)에 얹는다.
 */
export function installPinSync() {
    eventSource.on(event_types.CHAT_RENAMED, ({ avatarId, groupId, oldFileName, newFileName } = {}) => {
        if (typeof oldFileName !== 'string' || typeof newFileName !== 'string') return;
        const oldEntry = { group: groupId || '', avatar: groupId ? '' : (avatarId || ''), file_name: oldFileName };
        const oldKey = entryKey(oldEntry);
        if (changes.has(oldKey)) {
            const value = changes.get(oldKey);
            // 옛 이름은 풀린 것으로(ST 캐시가 옛 이름을 되살리지 않도록), 고정이었으면 새 이름으로 고정
            changes.set(oldKey, null);
            if (value) {
                const newEntry = { ...oldEntry, file_name: newFileName };
                changes.set(entryKey(newEntry), newEntry);
            }
        }
        if (changes.size) setTimeout(() => writePins(applyChanges(readPins())), 0);
    });
}
