export const MODULE_NAME = 'st_chat_lobby';
export const EXTENSION_NAME = 'third-party/st-chat-lobby';
export const LOG_PREFIX = '[ChatLobby]';

// ST 마크업에 의존하는 셀렉터는 업스트림이 바뀌면 여기만 고치면 되도록 모아 둔다
export const SELECTORS = Object.freeze({
    chat: '#chat',
    welcomePanel: '.welcomePanel',
    welcomeRecent: '.welcomeRecent',
    recentChatList: '.recentChatList',
    recentChatsTitle: '.recentChatsTitle',
    wandMenu: '#extensionsMenu',
});

/** 한 번에 불러올 채팅 수 선택지. 0 = 전부 */
export const LOAD_COUNTS = Object.freeze([20, 50, 100, 200, 0]);

export const SORTS = Object.freeze(['recent', 'oldest', 'name', 'messages', 'owner']);
export const FILTERS = Object.freeze(['all', 'character', 'group']);

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    // 시작 화면의 '최근 채팅' 자리를 전체 채팅 목록으로 바꾼다. 끄면 ST 원래 화면
    replaceWelcome: true,
    // 한 번에 불러올 채팅 수(LOAD_COUNTS). 서버는 이 개수만큼만 채팅 파일을 읽는다
    loadCount: 50,
    // 마지막으로 고른 정렬을 기억한다(보기 필터는 기억하지 않는다)
    sort: 'recent',
});
