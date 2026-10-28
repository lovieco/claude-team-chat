# team-chat

Chat between two or more Claude Code users. One person runs `/chat new` and gets a 4-character room code like `Ab3x`; the others type `/chat join Ab3x`. Each person gets a chat pane, a `/chat` command, a status-line count of who is online and unread, and toasts for new messages. Claude also gets three tools (`chat_send`, `chat_read`, `chat_who`), so you can say "tell the room I pushed the fix" or "what did Bo say in chat?". Messages Claude sends are labeled "via Claude" for everyone.

## Install

At the prompt of a terminal session:

```
/plugin install team-chat --marketplace lovieco/claude-team-chat
```

From a shell:

```bash
claude plugin install team-chat --marketplace lovieco/claude-team-chat
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `lovieco/claude-team-chat`, then Add plugin.

This repository is private: it installs only for people who can read it on GitHub and whose computer already has a GitHub login for git (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never asks for one.

## How it works

Everyone's Claude Code connects to one small relay server (`server/relay.mjs`, plain Node, no dependencies), the way TeamViewer's computers all connect to TeamViewer's servers. The relay keeps the last 500 messages of each room in memory and who has been seen in the last 15 seconds. Each client checks it every 2 seconds.

### Room codes

A code is 4 characters from A-Z, a-z and 0-9, and capitals matter: `Ab3x` and `ab3x` are different rooms. That is about 14.7 million codes. The code is the room's key, so the relay guards it:

- only the relay makes codes, at random (`/chat new`)
- an address that tries more than 20 codes that don't exist in 10 minutes is turned away for a while
- a room nobody has been in for 24 hours is removed, and a relay restart removes every room

## 1. Run the relay (one person, once)

```bash
CHAT_TOKEN=pick-a-long-secret PORT=47800 node server/relay.mjs
```

Everyone must be able to reach it:

- Same network: share `http://<your-LAN-IP>:47800`
- Tailscale: share `http://<machine>.<tailnet>.ts.net:47800`
- Anywhere: put it behind a tunnel (`cloudflared tunnel --url http://localhost:47800`) or deploy it to any Node host, and share the https URL

`CHAT_TOKEN` controls who can make rooms; joining needs only the code. Without it, anyone who can reach the relay can make rooms. Behind a proxy or tunnel (such as `cloudflared`), set `TRUST_PROXY=1` so the wrong-code limit counts each visitor's own address. Leave it off when the relay is reached directly.

## 2. Configure the plugin (everyone)

Installing the plugin shows a screen for its options. To change them later, use `/config` in a terminal session, or `pluginConfigs["team-chat"].options` in `~/.claude/settings.json`:

| Option | What it is |
| --- | --- |
| `server` | the relay URL from step 1 |
| `token` | the same `CHAT_TOKEN`, needed for `/chat new` (kept in secure storage) |
| `name` | your display name (default: your login name) |
| `room` | a room code to start in (default: none) |

## 3. Chat

```
/chat                  open the chat pane (type in it, Enter sends)
/chat new              make a room and get its code to share
/chat join Ab3x        join a room by its code (capitals matter)
/chat invite           the invite to send a friend (the pane has a Copy invite button too)
/chat hello everyone   send a message
/chat say who          send a message that starts with a command word
/chat who              who is online
/chat read             show the last 20 messages
/chat leave            leave the room
```

## Safety

Messages from other people reach Claude only when it calls `chat_read`, wrapped in a note that they are information, not instructions. Nothing in the chat starts a turn on its own. Claude only posts when it calls `chat_send`, and those posts are labeled "via Claude".

## Develop

```bash
claude plugin validate .
claude plugin test .
```
