# st-chat-lobby — 채팅 로비 설계

> 대상: SillyTavern `staging` @ `bc81b9f7e` (2026-10-03). 라인 번호는 이 커밋 기준.

## 0. 한 줄 요약

시작 화면(`.welcomePanel`)이 `#chat`에 붙을 때마다 ST 최근 채팅 목록을 **숨기고**(지우지 않음) 그 자리에
전체 채팅 목록을 넣는다. 같은 목록을 마법봉 메뉴의 창(`POPUP_TYPE.DISPLAY`)으로도 연다.
목록은 `/api/chats/recent`를 **개수 제한(`max`)**으로 한 번 불러오고, 검색·필터·정렬은 클라이언트에서 한다.

## 1. 참고한 확장

| | Chat_list (IllIlIlIlllIII) | ChatPlus2 (SoFizzticated) |
|---|---|---|
| 가져온 것 | 시작 화면 자리 교체, 날짜 묶음 제목, 메시지 수·용량 | 이름·내용까지 검색, 선택 모드 일괄 삭제, 아바타 키(배열 번호 X), 열기 전 존재 확인 |
| 피한 것 | 그룹 삭제가 없는 경로(`DELETE /api/chats/group`) 호출, 캐릭터마다 요청 2번, 30px 버튼 | 캐릭터 메시지 수 필드 오류(`chat_size`), 그룹 채팅 파일 전체 내려받기, 무제한 병렬 요청 |

두 확장 모두 그룹 채팅 삭제 뒤 `group.chats`/`editGroup`을 갱신하지 않는다 → 여기서는 갱신한다.

## 2. 데이터

- `POST /api/chats/recent { max, pinned: [] }` (`src/endpoints/chats.js:1054`)
  - 서버는 캐릭터 폴더·그룹 정의·채팅 폴더 루트의 `.jsonl`을 **stat 만** 해서 수정 시각 순으로 정렬 → 앞의 `max`개만 `getChatInfo`(파일을 끝까지 읽어 줄 수·마지막 메시지)
  - 그래서 `max`가 서버 비용과 화면 비용을 함께 줄인다. 전체 개수는 돌려주지 않으므로 `limit + 1`개를 요청해 '더 있음'을 판단
  - 응답: `{ file_name, file_size, chat_items, mes, last_mes, avatar | group }`. 빈 채팅의 `mes`는 `'[The chat is empty]'` → `chat_items === 0`이면 미리보기를 비운다
  - 주인 없는 채팅(루트 파일, 삭제된 캐릭터)은 ST 시작 화면처럼 뺀다
- 정렬은 `last_mes` 기준(ST 시작 화면과 같음). 서버의 자르기는 파일 수정 시각 기준이라 둘이 다를 수 있지만 거의 같다
- 검색·필터·정렬은 **불러온 채팅 안에서만**. 일부만 불러온 상태면 안내 문구 + [모든 채팅에서 검색](`max` 없이 다시 요청)

## 3. 동작 (`src/chat-actions.js`)

| 동작 | 캐릭터 | 그룹 |
|---|---|---|
| 열기 | 존재 확인(`/api/characters/chats simple`) → `unshallowCharacter` → 다른 캐릭터면 `characters[chid].chat = file` 후 `selectCharacterById` 한 번(+ `updateRemoteChatName`), 같은 캐릭터면 `openCharacterChat` → `setActiveCharacter(avatar)` | `group.chats` 포함 확인 → 다른 그룹이면 `chat_id`·`date_last_chat` 저장(`editGroup(…, false)`) 후 `openGroupById` 한 번, 같은 그룹이면 `openGroupChat` → `setActiveGroup` |
| 이름 바꾸기 | `/api/chats/rename` → 마지막 채팅이면 `updateRemoteChatName`(+ 현재 캐릭터면 `#selected_chat_pole`) → 열린 채팅이면 `reloadCurrentChat` → `CHAT_RENAMED` | `/api/chats/rename {is_group}` → `renameGroupChat` → 열려 있으면 다시 불러오기 → `CHAT_RENAMED` |
| 이름 겹침 | 그 캐릭터 폴더 기준 | **모든 그룹** 기준(그룹 채팅 파일은 한 폴더 공유) |
| 삭제 | `/api/chats/delete` → 마지막 채팅이었으면 목록의 같은 캐릭터 남은 채팅 중 최근 것, 없으면 서버에 물어 최근 것, 그것도 없으면 새 이름 → `CHAT_DELETED` | `/api/chats/group/delete` **성공 뒤에** `group.chats`에서 빼고 `chat_id` 옮김 → `editGroup(…, true)` → `GROUP_CHAT_DELETED` |

- ST의 `renameGroupOrCharacterChat`/`deleteCharacterChatByName`/`deleteGroupChatByName`은 실패를 돌려주지 않거나(팝업·토스트만) 실패해도 `group.chats`를 먼저 고치므로 쓰지 않는다
- 열린 채팅은 삭제 불가(선택 모드에서도 체크 불가), 생성·저장 중(`is_send_press`, `isChatSaving`, `is_group_generating`)이면 열기·열린 채팅 이름 바꾸기 막음
- 일괄 삭제는 순차 실행(그룹 정보 저장이 겹치지 않도록), 결과를 '삭제 N, 실패 M'으로 알림

## 4. 시작 화면 끼워 넣기 (`src/welcome.js`)

- ST `openWelcomeScreen`은 `CHAT_CHANGED`·`APP_READY`마다 `.welcomePanel`을 새로 만들어 `#chat`에 append (`welcome-screen.js:226, 315`)
- `#chat`에 `childList` MutationObserver(하위 트리 X) → 붙은 `.welcomePanel`에 `data-st-lobby` 표시 후 끼워 넣기
- ST 목록(`.welcomeRecent > .recentChatList`)과 최근 채팅 설정(톱니)은 CSS로 숨김. ST의 접기(`recentHidden`)는 `.welcomeRecent`째 숨기므로 그대로 동작
- 제목 `.recentChatsTitle`은 `data-i18n="Recent Chats"`라 ST 번역 옵저버가 되돌림 → 속성을 지우고 자식 span에 `chat_lobby.title` 키
- 설정을 바꾸면 시작 화면이 떠 있을 때만 `openWelcomeScreen({ force: true })`로 다시 그림

## 5. 모바일

- 모바일 기본 CSS + `@media (min-width: 768px)` 보정. 터치 대상 44px(검색·필터·정렬·아이콘·줄 버튼·선택 막대·더 불러오기)
- 검색칸 16px(iOS 확대 방지), Enter = 키보드 닫기(한글 조합 중 Enter 무시), 입력 150ms 디바운스
- 날짜 제목 `position: sticky` — 시작 화면은 `#chat`, 창은 `.popup-content`가 스크롤 조상
- 아바타 `loading="lazy"`

## 6. 확인한 것 (2026-10-03, 375×812)

- 시작 화면 교체·제목 개수 / 설정 끄면 ST 최근 채팅, 켜면 다시 교체 / 불러올 개수 20·50 저장(숫자형)
- 개수 제한 4(임시): (4+) → 더 불러오기 (8+) → 검색 결과 없음 + 일부 안내 + [모든 채팅에서 검색] → (11), 버튼 사라짐
- 여러 낱말 검색, 캐릭터별 묶기 제목, 날짜 제목(오늘 / 2026년 9월), 그룹 필터, 그룹 콜라주 아바타, 미리보기 꾸밈 기호 제거
- 삭제(실제 탭) / 이름 겹침 거절 / 그룹 채팅 이름 바꾸기(`?` 제거, `group.chats`·`chat_id` 갱신) / 그룹 채팅 열기(한 번에) / 창에서 열린 채팅 표시·삭제 막기 / 선택 모드(열린 채팅 체크 불가) 일괄 삭제 2개 → 그룹 정보 갱신 / 그룹 → 캐릭터 채팅 열기(창 닫힘, 카드 `chat` 저장) / 마지막 채팅 삭제 → 그 캐릭터의 최근 채팅으로 이동
- 실기기(가상 키보드, 네이티브 드롭다운)는 미확인
