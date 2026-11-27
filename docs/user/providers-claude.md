# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Multiple accounts and presets

Isolate separate Claude accounts or router presets with distinct `CLAUDE_CONFIG_DIR` directories:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add a second Claude instance in **Settings → Providers** (or **Add Claude account** on mobile) pointing **CLAUDE_CONFIG_DIR path** to `~/.claude_personal` (leave empty for the default directory). Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

- Existing threads can only switch between Claude instances sharing the same config directory.
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

## Run Claude Code on an Android phone

The Android app can run Claude Code on the phone itself, so agents can work with the
phone's files without another computer. In **Settings > Environments**, add an
environment and choose **Run agents on this phone**, then follow the checklist. It needs a
64-bit phone and about 1.1 GB of storage; setup downloads about 400 MB and takes a few
minutes. Claude Code and a T3 Code server run in an Ubuntu system inside T3 Code, and the
phone becomes an environment named after the device.

- Setup and Claude sign-in keep going if you leave the app, with a notification. **Sign
  in** opens your browser; if it shows a code instead of returning, paste the code into
  the app.
- Allow **Phone storage** in the checklist's **Keep it running** section so agents can
  reach your files at `/sdcard`. Phone storage keeps no file permissions or symlinks, so
  keep git repositories in Ubuntu's home folder.
- The server shows a notification while it runs and keeps the phone awake. The app starts
  it when you open it, unless you stopped it.
- The phone's server doesn't update itself. **Update T3 Code and Claude Code** on the
  phone's environment page in **Settings > Environments** updates both.
- **Remove from this phone** in the checklist deletes Ubuntu, including the threads stored
  on the phone.
- Agents reach Android through Termux:API's commands, flags and output, such as
  `termux-open` (also `xdg-open`), `termux-clipboard-get`, `termux-notification`,
  `termux-share`, `termux-download`, `termux-tts-speak`, `termux-location` and
  `termux-camera-photo`. While T3 Code isn't on screen, links, files and calls arrive as a
  notification to tap, and the clipboard, camera, microphone and location can't be used.
- Agents can open other apps and send them intents with Android's `am start` and
  `am broadcast`, and list apps with `pm list packages`.
- Commands that reach your location, camera, microphone, contacts, SMS, call log, phone,
  notifications or other apps ask you first on the phone, even with full access. The
  first time, Android also asks you to give T3 Code the permission. In **Settings > Agent
  access** you can set each to **Always allow** or **Never**. If you installed T3 Code from
  an APK file, Android may block notification access until you turn on **Allow restricted
  settings** in T3 Code's App info.

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** (`100000`–`1000000` tokens) in the Claude instance settings to trigger summarization earlier without changing the model's context window.
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

## Skills and MCP sign-in

- **Skills**: Loaded from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills` (config dir wins on name collisions), and enabled Claude plugins (e.g. `plugin:review`). Invoke via `$`. Send `disable-model-invocation` skills one per message.
- **MCP OAuth**: When a Claude MCP server needs sign-in, click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into T3 Code (**Finish sign-in**). Connectors added on `claude.ai` authenticate there instead.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
