// Termux:API-style commands for agents in the phone's runtime. The app copies this into
// the guest with a /usr/local/bin wrapper per command that passes the command's name
// first, and AndroidBridge.kt answers the requests.
import * as NodeFS from "node:fs";

const ENDPOINT = process.env.T3_ANDROID_BRIDGE_ENDPOINT ?? "/run/t3-android/endpoint";
const NOT_RUNNING =
  "T3 Code's Android bridge isn't running. It runs with the T3 Code server on this phone.";

class UsageError extends Error {}

/**
 * Splits leading options from the arguments after them, as getopts does: options end at
 * the first argument that isn't one, or after "--". `valued` and `switches` map flags
 * such as "-t" and "--title" to option names.
 */
function parseOptions(args, valued = {}, switches = {}) {
  const options = {};
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") return { options, rest: args.slice(index + 1) };
    if (!arg.startsWith("-") || arg === "-") break;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const inline = equals > 0 ? arg.slice(equals + 1) : undefined;
    if (switches[flag] && inline === undefined) {
      options[switches[flag]] = true;
      index += 1;
      continue;
    }
    if (!valued[flag]) throw new UsageError(`unknown option ${arg}`);
    const value = inline ?? args[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    options[valued[flag]] = value;
    index += inline === undefined ? 2 : 1;
  }
  return { options, rest: args.slice(index) };
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** The arguments joined, or stdin when there are none. */
async function textArgument(rest, { keepNewlines = false } = {}) {
  const text = rest.length > 0 ? rest.join(" ") : await readStdin();
  return keepNewlines ? text : text.replace(/\n+$/, "");
}

function noArguments(args) {
  if (args.length > 0) throw new UsageError("takes no arguments");
}

function oneArgument(args, what) {
  const { rest } = parseOptions(args);
  if (rest.length !== 1) throw new UsageError(`expected one ${what}`);
  return rest[0];
}

const openUrl = (args) => ({ path: "open-url", body: { url: oneArgument(args, "URL") } });

const COMMANDS = {
  "termux-open-url": { usage: "<url>", request: openUrl },
  "xdg-open": { usage: "<url>", request: openUrl },
  "termux-clipboard-get": {
    usage: "",
    request: (args) => (noArguments(args), { path: "clipboard-get", body: {} }),
    print: (text) => process.stdout.write(text),
  },
  "termux-clipboard-set": {
    usage: "[text]",
    request: async (args) => ({
      path: "clipboard-set",
      body: { text: await textArgument(parseOptions(args).rest, { keepNewlines: true }) },
    }),
  },
  "termux-notification": {
    usage: "[-i id] [-t title] [-c content]",
    request: async (args) => {
      const { options, rest } = parseOptions(args, {
        "-i": "id",
        "--id": "id",
        "-t": "title",
        "--title": "title",
        "-c": "content",
        "--content": "content",
      });
      if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0]}`);
      // A terminal has nothing to pipe, so a notification there is just its title.
      const content = options.content ?? (process.stdin.isTTY ? undefined : await textArgument([]));
      return { path: "notification", body: { ...options, content } };
    },
  },
  "termux-notification-remove": {
    usage: "<id>",
    request: (args) => ({ path: "notification-remove", body: { id: oneArgument(args, "id") } }),
  },
  "termux-toast": {
    usage: "[-s] [text]",
    request: async (args) => {
      const { options, rest } = parseOptions(args, {}, { "-s": "short" });
      const text = await textArgument(rest);
      if (text === "") throw new UsageError("no text to show");
      return { path: "toast", body: { text, short: options.short === true } };
    },
  },
  "termux-share": {
    usage: "[-a send] [text]",
    request: async (args) => {
      const { options, rest } = parseOptions(args, { "-a": "action" });
      if (options.action !== undefined && options.action !== "send") {
        throw new UsageError("only -a send is supported");
      }
      if (rest.length === 1 && NodeFS.existsSync(rest[0])) {
        throw new UsageError(
          `only text can be shared; to share the file's text: termux-share < ${rest[0]}`,
        );
      }
      const text = await textArgument(rest);
      if (text === "") throw new UsageError("no text to share");
      return { path: "share", body: { text } };
    },
  },
  "termux-vibrate": {
    usage: "[-d ms]",
    request: (args) => {
      const { options, rest } = parseOptions(args, { "-d": "duration" });
      if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0]}`);
      const duration = options.duration ?? "1000";
      if (!/^\d+$/.test(duration)) throw new UsageError("-d takes milliseconds");
      return { path: "vibrate", body: { duration: Number(duration) } };
    },
  },
  "termux-battery-status": {
    usage: "",
    request: (args) => (noArguments(args), { path: "battery-status", body: {} }),
    print: (status) => process.stdout.write(`${JSON.stringify(status, null, 2)}\n`),
  },
};

async function call(path, body) {
  let port;
  let token;
  try {
    [port, token] = NodeFS.readFileSync(ENDPOINT, "utf8").trim().split(" ");
  } catch {
    throw new Error(NOT_RUNNING);
  }
  const response = await fetch(`http://127.0.0.1:${port}/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new Error(NOT_RUNNING);
  });
  const reply = await response.json().catch(() => ({}));
  if (reply.ok !== true)
    throw new Error(reply.error ?? `The bridge answered HTTP ${response.status}.`);
  return reply.result;
}

const [COMMAND = "", ...ARGS] = process.argv.slice(2);
const command = COMMANDS[COMMAND];
const USAGE = `Usage: ${COMMAND} ${command?.usage ?? ""}`.trimEnd();
if (command === undefined) {
  process.stderr.write(
    `Unknown command "${COMMAND}". Commands: ${Object.keys(COMMANDS).join(", ")}\n`,
  );
  process.exitCode = 1;
} else if (ARGS[0] === "-h" || ARGS[0] === "--help") {
  process.stdout.write(`${USAGE}\n`);
} else {
  try {
    const { path, body } = await command.request(ARGS);
    const result = await call(path, body);
    if (command.print) command.print(result);
    // Android held back an activity start and posted a notification instead.
    else if (typeof result?.message === "string") process.stderr.write(`${result.message}\n`);
  } catch (error) {
    const usage = error instanceof UsageError ? `\n${USAGE}` : "";
    process.stderr.write(`${COMMAND}: ${error.message}${usage}\n`);
    process.exitCode = 1;
  }
}
