import { characters, getRequestHeaders } from '../../../../../script.js';
import { groups } from '../../../../group-chats.js';
import { timestampToMoment } from '../../../../utils.js';
import { toPlainPreview } from './utils.js';

/**
 * 목록 한 줄. 캐릭터는 배열 번호가 아니라 아바타 파일 이름으로 가리킨다
 * (캐릭터가 추가·삭제되면 번호가 바뀌기 때문).
 * @typedef {Object} LobbyChat
 * @property {string} key 목록 안의 고유 키
 * @property {string} avatar 캐릭터 채팅이면 캐릭터 아바타 파일 이름, 아니면 ''
 * @property {string} groupId 그룹 채팅이면 그룹 id, 아니면 ''
 * @property {string} ownerName 캐릭터·그룹 이름
 * @property {string} fileName 확장자 없는 채팅 이름
 * @property {number} lastTime 마지막 메시지 시각(ms). 알 수 없으면 0
 * @property {string} preview 마지막 메시지 평문
 * @property {number} count 메시지 수
 * @property {string} size 파일 크기(사람이 읽는 형식)
 */

/**
 * @param {LobbyChat} chat
 */
export function chatKey(chat) {
    return chat.groupId ? `g:${chat.groupId}/${chat.fileName}` : `c:${chat.avatar}/${chat.fileName}`;
}

/**
 * 모든 캐릭터·그룹의 채팅을 최근 순으로 가져온다.
 *
 * ST 첫 화면의 '최근 채팅'과 같은 서버 API 를 쓴다. 서버는 채팅 파일을 수정 시각 순으로 늘어놓은 뒤
 * 앞에서 `max` 개만 열어 메시지 수·마지막 메시지를 읽는다. 나머지는 수정 시각만 보므로,
 * 개수를 제한하면 채팅이 많아도 빨리 끝난다.
 * 남은 채팅이 있는지 알기 위해 하나 더(limit + 1) 요청한다. 서버가 전체 개수는 알려 주지 않는다.
 * @param {number} limit 가져올 개수. 0 이면 전부
 * @returns {Promise<{ chats: LobbyChat[], hasMore: boolean }>}
 */
export async function getAllChats(limit) {
    const body = limit > 0 ? { max: limit + 1, pinned: [] } : { pinned: [] };
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!Array.isArray(data)) return { chats: [], hasMore: false };

    const hasMore = limit > 0 && data.length > limit;
    const items = hasMore ? data.slice(0, limit) : data;

    /** @type {LobbyChat[]} */
    const chats = [];
    for (const item of items) {
        if (typeof item?.file_name !== 'string') continue;
        const groupId = typeof item.group === 'string' ? item.group : '';
        const avatar = !groupId && typeof item.avatar === 'string' ? item.avatar : '';
        // ST 첫 화면처럼 주인(캐릭터·그룹)이 없는 채팅(채팅 폴더 바로 아래 파일 등)은 뺀다
        const owner = groupId ? groups.find(g => g.id === groupId) : characters.find(c => c.avatar === avatar);
        if (!owner) continue;

        const moment = timestampToMoment(item.last_mes);
        /** @type {LobbyChat} */
        const chat = {
            key: '',
            avatar,
            groupId,
            ownerName: String(owner.name ?? ''),
            fileName: item.file_name.replace(/\.jsonl$/, ''),
            lastTime: moment.isValid() ? moment.valueOf() : 0,
            preview: Number(item.chat_items) > 0 && typeof item.mes === 'string' ? toPlainPreview(item.mes) : '',
            count: Number(item.chat_items) || 0,
            size: typeof item.file_size === 'string' ? item.file_size : '',
        };
        chat.key = chatKey(chat);
        chats.push(chat);
    }

    chats.sort((a, b) => b.lastTime - a.lastTime || b.fileName.localeCompare(a.fileName));
    return { chats, hasMore };
}

/**
 * 캐릭터의 채팅 이름 목록(파일을 열지 않아 빠르다). 채팅 폴더가 없으면 빈 배열.
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
export async function getCharacterChatNames(avatar) {
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, simple: true }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // 채팅 폴더가 없으면 서버는 { error: true } 를 돌려준다 = 채팅 없음
    if (!Array.isArray(data)) return [];
    return data.map(item => String(item?.file_id ?? '')).filter(Boolean);
}

/**
 * 캐릭터의 가장 최근 채팅 이름. 없으면 ''.
 * 마지막으로 연 채팅을 지웠을 때 옮겨 갈 곳을 찾는 데 쓴다(목록에 그 캐릭터의 다른 채팅이 안 불러와져 있을 때).
 * @param {string} avatar
 */
export async function getLatestCharacterChat(avatar) {
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) return '';

    let latest = '';
    let latestTime = -Infinity;
    for (const item of data) {
        if (typeof item?.file_name !== 'string') continue;
        const moment = timestampToMoment(item.last_mes);
        const time = moment.isValid() ? moment.valueOf() : 0;
        if (time > latestTime) {
            latestTime = time;
            latest = item.file_name.replace(/\.jsonl$/, '');
        }
    }
    return latest;
}
