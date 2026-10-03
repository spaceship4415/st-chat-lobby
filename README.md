# Chat Lobby

[한국어](README.ko.md)

A SillyTavern extension that shows **every character and group chat** on the start screen, in place of the Recent Chats list.
Open a chat with one tap, rename it, delete it, or select several and delete them at once. Built for phones first.

## Install

Extensions (puzzle icon) → **Install Extension** → paste:

```text
https://github.com/spaceship4415/st-chat-lobby
```

## Where to find it

- **Start screen**: the Recent Chats list is replaced by **All Chats**.
- **While chatting**: **Wand menu → All Chats** opens the same list in a window.

## Using the list

- **Tap a chat** to open it.
- **Search** looks in character/group names, chat names and the **last message** only (not earlier messages). Several words must all match.
  Results are grouped by where they matched (character/group name, chat name, last message) and the matched text is highlighted.
- **Collapse groups**: tap a heading (date, character or match place) to collapse or expand it. Headings stick to the top while scrolling. *Select all* skips collapsed groups.
- **Search conversations too**: a separate card at the top of the search results. It searches every message of every chat (all characters and groups) and lists matches under **Conversation**, previewing the matched message.
  It reads whole chat files, so it can be slow; progress is shown and you can **Stop** anytime. Changing the search text discards the results.
- **Character picker**: pick a character or group (👥) to see **all of its chats**, regardless of how many are loaded. Search and conversation search then stay within it; if nothing matches, **Search all characters** widens it. The picker resets each time; Sort is remembered.
- **Sort**: Recent / Oldest / Name / Most messages / By character.
  Recent and Oldest are grouped under Today, Yesterday, This week, This month and month headings.
- **⟳ Refresh** reloads the list.
- **Rename (✎)** refuses names that already exist (ignoring case). **Delete (🗑)** asks first and cannot be undone.
  The chat that is open right now cannot be deleted.
- **Select mode (☑)**: pick chats or *Select all* (visible chats), then **Delete**.

### How many chats are loaded

Loading every chat can be slow, so only the most recent ones are loaded at first (50 by default).
Use **Load more** at the bottom for the rest. The title shows **(50+)** while more remain.
Search, filters and sorting apply to the loaded chats; **Search all chats** loads everything and searches again.

## Settings

Extensions → **Chat Lobby**

| Setting | Description |
|---|---|
| Show all chats instead of recent chats on the start screen | Turn off to get SillyTavern's Recent Chats back. The wand menu still works |
| Chats to load at once | 20 / 50 / 100 / 200 / All |

## Notes

- While enabled, the pin markers of SillyTavern's Recent Chats are not shown (pins are kept; turn the setting off to see them).
- Chats without an owner (files directly in the chats folder) are skipped, as in SillyTavern.
- Opening a chat follows SillyTavern's own flow. Chats opened from this list skip the [Chat Setup](https://github.com/spaceship4415/st-chat-setup) entry dialog.
