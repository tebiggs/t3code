// Termux:API-style commands for agents in the phone's runtime. The app copies this into
// the guest with a /usr/local/bin wrapper per command that passes the command's name
// first, and AndroidBridge.kt answers the requests.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ENDPOINT = process.env.T3_ANDROID_BRIDGE_ENDPOINT ?? "/run/t3-android/endpoint";
const NOT_RUNNING =
  "T3 Code's Android bridge isn't running. It runs with the T3 Code server on this phone.";
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

class UsageError extends Error {}

/**
 * Splits leading options from the arguments after them, as getopts does: options end at
 * the first argument that isn't one, or after "--". `valued` and `switches` map flags
 * such as "-t" and "--title" to option names.
 */
function parseOptions(input, valued = {}, switches = {}) {
  const options = {};
  let args = input;
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
    if (!valued[flag] && !arg.startsWith("--") && arg.length > 2) {
      // Bundled short options, as getopts reads "-rv" and "-n5".
      const letters = Array.from(arg.slice(1), (letter) => `-${letter}`);
      const valuedAt = letters.findIndex((letter) => valued[letter]);
      const flags = valuedAt < 0 ? letters : letters.slice(0, valuedAt + 1);
      const value = valuedAt < 0 ? "" : arg.slice(valuedAt + 2);
      if (flags.every((letter) => switches[letter] || valued[letter])) {
        const expanded = value === "" ? flags : [...flags, value];
        args = [...args.slice(0, index), ...expanded, ...args.slice(index + 1)];
        continue;
      }
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

function wholeNumber(value, flag) {
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} takes a whole number`);
  return Number(value);
}

function oneOf(value, flag, allowed) {
  if (!allowed.includes(value)) throw new UsageError(`${flag} takes one of ${allowed.join(", ")}`);
  return value;
}

// The app maps guest paths to its own, so paths go over with the guest's symlinks resolved.
function existingFile(path) {
  let real;
  try {
    real = NodeFS.realpathSync(path);
  } catch {
    throw new UsageError(`no such file: ${path}`);
  }
  if (!NodeFS.statSync(real).isFile()) throw new UsageError(`not a file: ${path}`);
  return real;
}

/** Where a command should write `path`: in its directory, which has to exist. */
function outputPath(path) {
  const directory = NodePath.dirname(NodePath.resolve(path));
  try {
    return NodePath.join(NodeFS.realpathSync(directory), NodePath.basename(path));
  } catch {
    throw new UsageError(`no such directory: ${directory}`);
  }
}

function printJson(value) {
  if (value !== null && value !== undefined) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

function printLine(text) {
  process.stdout.write(`${text}\n`);
}

const jsonCommand = (path) => ({
  usage: "",
  request: (args) => (noArguments(args), { path, body: {} }),
  print: printJson,
});

const openUrl = (args) => ({ path: "open-url", body: { url: oneArgument(args, "URL") } });

const open = {
  usage: "[--send | --view] [--chooser] [--content-type type] <path-or-url>",
  request: (args) => {
    const { options, rest } = parseOptions(
      args,
      { "--content-type": "contentType" },
      { "--send": "send", "--view": "view", "--chooser": "chooser" },
    );
    if (rest.length !== 1) throw new UsageError("expected one path or URL");
    const [target] = rest;
    const flags = {
      send: options.send === true,
      chooser: options.chooser === true,
      contentType: options.contentType,
    };
    if (target.startsWith("file:")) {
      return {
        path: "open",
        body: { path: existingFile(NodeURL.fileURLToPath(target)), ...flags },
      };
    }
    if (URL_SCHEME.test(target) && !NodeFS.existsSync(target)) {
      return { path: "open", body: { url: target, ...flags } };
    }
    return { path: "open", body: { path: existingFile(target), ...flags } };
  },
};

const VOLUME_STREAMS = ["alarm", "music", "notification", "ring", "system", "call"];
const SPEECH_STREAMS = ["ALARM", "MUSIC", "NOTIFICATION", "RING", "SYSTEM", "VOICE_CALL"];
const SMS_TYPES = ["all", "inbox", "sent", "draft", "outbox", "failed", "queued"];
const ENCODERS = ["aac", "amr_wb", "amr_nb", "opus"];

/** termux-sensor polls: each reading is a request, `delay` ms apart, `limit` times. */
async function runSensor(args) {
  if (args.length === 0) throw new UsageError("No arguments supplied!");
  const { options, rest } = parseOptions(
    args,
    { "-s": "sensors", "-d": "delay", "-n": "limit" },
    { "-a": "all", "-c": "cleanup", "-l": "list" },
  );
  if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0]}`);
  const given = Object.keys(options);
  for (const sole of ["cleanup", "list"]) {
    if (options[sole] && given.length > 1) {
      throw new UsageError(`No other options should be specified with -${sole[0]} ${sole}!`);
    }
  }
  // Each reading registers and releases its own listeners, so there's nothing to clean up.
  if (options.cleanup) return printLine("Sensor cleanup unnecessary");
  if (options.list) return printJson(await call("sensor-list", {}));
  if (options.all && options.sensors !== undefined) {
    throw new UsageError("Listed sensors will be ignored with -a all option!");
  }
  if (!options.all && options.sensors === undefined) {
    throw new UsageError("Use -s <sensors> or -a to choose sensors!");
  }
  const delay = options.delay === undefined ? 1000 : wholeNumber(options.delay, "-d");
  const limit = options.limit === undefined ? Infinity : wholeNumber(options.limit, "-n");
  const body = { all: options.all === true, sensors: options.sensors?.split(",") };
  for (let count = 0; count < limit; count += 1) {
    if (count > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    printJson(await call("sensor", body));
  }
}

const COMMANDS = {
  "termux-open-url": { usage: "<url>", request: openUrl },
  "termux-open": open,
  "xdg-open": open,
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
  "termux-notification-list": jsonCommand("notification-list"),
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
          `only text can be shared; to share the file: termux-open --send ${rest[0]}`,
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
  "termux-battery-status": jsonCommand("battery-status"),
  "termux-download": {
    usage: "[-d description] [-t title] [-p path] <url>",
    request: (args) => {
      const { options, rest } = parseOptions(args, {
        "-d": "description",
        "-t": "title",
        "-p": "path",
      });
      if (rest.length !== 1)
        throw new UsageError(rest.length === 0 ? "no url specified" : "too many arguments");
      const path = options.path === undefined ? undefined : outputPath(options.path);
      return { path: "download", body: { ...options, path, url: rest[0] } };
    },
  },
  "termux-media-scan": {
    usage: "[-v] [-r] <file> [file...]",
    request: (args) => {
      const { options, rest } = parseOptions(args, {}, { "-r": "recursive", "-v": "verbose" });
      if (rest.length === 0) throw new UsageError("missing file argument");
      // A path that's gone is scanned too: that takes it out of the media store.
      const paths = rest.map((path) =>
        NodeFS.existsSync(path) ? NodeFS.realpathSync(path) : NodePath.resolve(path),
      );
      return {
        path: "media-scan",
        body: { paths, recursive: options.recursive === true },
        print: ({ files }) => {
          if (options.verbose) for (const file of files) printLine(file);
          printLine(`Finished scanning ${files.length} file(s)`);
        },
      };
    },
  },
  "termux-torch": {
    usage: "[on | off]",
    request: (args) => {
      if (args.length !== 1) throw new UsageError("Illegal param count");
      oneOf(args[0], "termux-torch", ["on", "off"]);
      return { path: "torch", body: { enabled: args[0] === "on" } };
    },
  },
  "termux-tts-speak": {
    usage:
      "[-e engine] [-l language] [-n region] [-v variant] [-p pitch] [-r rate] [-s stream] [text]",
    request: async (args) => {
      const { options, rest } = parseOptions(args, {
        "-e": "engine",
        "-l": "language",
        "-n": "region",
        "-v": "variant",
        "-p": "pitch",
        "-r": "rate",
        "-s": "stream",
      });
      for (const [key, flag] of [
        ["pitch", "-p"],
        ["rate", "-r"],
      ]) {
        if (options[key] !== undefined && !(Number(options[key]) > 0)) {
          throw new UsageError(`${flag} takes a positive number`);
        }
      }
      const stream = options.stream && oneOf(options.stream.toUpperCase(), "-s", SPEECH_STREAMS);
      const text = await textArgument(rest);
      if (text.trim() === "") throw new UsageError("no text to speak");
      const pitch = options.pitch && Number(options.pitch);
      const rate = options.rate && Number(options.rate);
      return { path: "tts-speak", body: { ...options, pitch, rate, stream, text } };
    },
  },
  "termux-tts-engines": jsonCommand("tts-engines"),
  "termux-volume": {
    usage: "[stream volume]",
    request: (args) => {
      if (args.length === 0) return { path: "volume", body: {} };
      if (args.length !== 2) throw new UsageError("Invalid argument count");
      const stream = oneOf(args[0], "stream", VOLUME_STREAMS);
      return { path: "volume", body: { stream, volume: wholeNumber(args[1], "volume") } };
    },
    print: printJson,
  },
  "termux-sensor": { usage: "-l | -c | (-a | -s sensors) [-d ms] [-n count]", run: runSensor },
  "termux-wallpaper": {
    usage: "[-l] (-f file | -u url)",
    request: (args) => {
      const { options, rest } = parseOptions(
        args,
        { "-f": "file", "-u": "url" },
        { "-l": "lockscreen" },
      );
      if (rest.length > 0) throw new UsageError("too many arguments");
      if (options.file === undefined && options.url === undefined) {
        throw new UsageError("you must specify either -f or -u");
      }
      if (options.file !== undefined && options.url !== undefined) {
        throw new UsageError("you must specify either -f or -u, but not both");
      }
      const file = options.file === undefined ? undefined : existingFile(options.file);
      return {
        path: "wallpaper",
        body: { file, url: options.url, lockscreen: options.lockscreen === true },
      };
    },
    print: () => printLine("Wallpaper set successfully!"),
  },
  "termux-wifi-connectioninfo": {
    ...jsonCommand("wifi-connectioninfo"),
    print: (result) => {
      printJson(result);
      // Android redacts these without Location; say so, so agents don't guess at the cause.
      if (result?.ssid === "<unknown ssid>") {
        process.stderr.write(
          `${COMMAND}: Android hides the network name and BSSID until T3 Code has Location: allow it in Settings > Agent access > Location, and turn Location on.\n`,
        );
      }
    },
  },
  "termux-camera-info": jsonCommand("camera-info"),
  "termux-camera-photo": {
    usage: "[-c camera-id] <output-file>",
    request: (args) => {
      const { options, rest } = parseOptions(args, { "-c": "camera" });
      if (rest.length === 0) throw new UsageError("missing file argument");
      if (rest.length > 1) throw new UsageError("too many arguments");
      return {
        path: "camera-photo",
        body: { camera: options.camera ?? "0", file: outputPath(rest[0]) },
      };
    },
  },
  "termux-microphone-record": {
    usage: "-d | -f file [-l seconds] [-e encoder] [-b kbps] [-r hz] [-c channels] | -i | -q",
    request: (args) => {
      const { options, rest } = parseOptions(
        args,
        {
          "-f": "file",
          "-l": "limit",
          "-e": "encoder",
          "-b": "bitrate",
          "-r": "rate",
          "-c": "channels",
        },
        { "-d": "defaults", "-i": "info", "-q": "quit" },
      );
      if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0]}`);
      const given = Object.keys(options);
      if (given.length === 0) throw new UsageError("expected -d, -f, -i or -q");
      for (const sole of ["info", "quit"]) {
        if (!options[sole]) continue;
        if (given.length > 1)
          throw new UsageError(`No other options should be specified with -${sole[0]}!`);
        return { path: "microphone-record", body: { action: sole } };
      }
      const number = (key, flag, scale = 1) =>
        options[key] === undefined ? undefined : wholeNumber(options[key], flag) * scale;
      return {
        path: "microphone-record",
        body: {
          action: "record",
          file: options.file === undefined ? undefined : outputPath(options.file),
          // Termux takes seconds and kbps; Android takes milliseconds and bps.
          limit: number("limit", "-l", 1000),
          encoder: options.encoder && oneOf(options.encoder.toLowerCase(), "-e", ENCODERS),
          bitrate: number("bitrate", "-b", 1000),
          rate: number("rate", "-r"),
          channels: number("channels", "-c"),
        },
      };
    },
    print: (result) => (typeof result === "string" ? printLine(result) : printJson(result)),
  },
  "termux-location": {
    usage: "[-p provider] [-r request]",
    request: (args) => {
      const { options, rest } = parseOptions(args, { "-p": "provider", "-r": "request" });
      if (rest.length > 0) throw new UsageError("too many arguments");
      return {
        path: "location",
        body: {
          provider: oneOf(options.provider ?? "gps", "-p", ["gps", "network", "passive"]),
          request: oneOf(options.request ?? "once", "-r", ["once", "last", "updates"]),
        },
      };
    },
    print: printJson,
  },
  "termux-contact-list": jsonCommand("contact-list"),
  "termux-sms-list": {
    usage: "[-c] [-f address] [-l limit] [-o offset] [-t type]",
    request: (args) => {
      const { options, rest } = parseOptions(
        args,
        { "-f": "from", "-l": "limit", "-o": "offset", "-t": "type" },
        // -d and -n are older Termux flags; dates and numbers are always listed.
        { "-c": "conversations", "-d": "dates", "-n": "numbers" },
      );
      if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0]}`);
      return {
        path: "sms-list",
        body: {
          limit: wholeNumber(options.limit ?? "10", "-l"),
          offset: wholeNumber(options.offset ?? "0", "-o"),
          type: oneOf(options.type ?? "all", "-t", SMS_TYPES),
          from: options.from,
          conversations: options.conversations === true,
        },
      };
    },
    print: printJson,
  },
  "termux-sms-send": {
    usage: "-n number[,number...] [-s slot] [text]",
    request: async (args) => {
      const { options, rest } = parseOptions(args, { "-n": "numbers", "-s": "slot" });
      const recipients = (options.numbers ?? "").split(",").map((number) => number.trim());
      if (recipients.every((number) => number === ""))
        throw new UsageError("no recipient number given");
      const slot = options.slot === undefined ? undefined : wholeNumber(options.slot, "-s");
      const text = await textArgument(rest);
      if (text === "") throw new UsageError("no text to send");
      return {
        path: "sms-send",
        body: { recipients: recipients.filter((number) => number !== ""), slot, text },
      };
    },
  },
  "termux-call-log": {
    usage: "[-l limit] [-o offset]",
    request: (args) => {
      const { options, rest } = parseOptions(args, { "-l": "limit", "-o": "offset" });
      if (rest.length > 0) throw new UsageError("too many arguments");
      return {
        path: "call-log",
        body: {
          limit: wholeNumber(options.limit ?? "10", "-l"),
          offset: wholeNumber(options.offset ?? "0", "-o"),
        },
      };
    },
    print: printJson,
  },
  "termux-telephony-call": {
    usage: "<number>",
    request: (args) => ({ path: "telephony-call", body: { number: oneArgument(args, "number") } }),
  },
  "termux-telephony-deviceinfo": jsonCommand("telephony-deviceinfo"),
  "termux-telephony-cellinfo": jsonCommand("telephony-cellinfo"),
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
    if (command.run) {
      await command.run(ARGS);
    } else {
      const request = await command.request(ARGS);
      const result = await call(request.path, request.body);
      const print = request.print ?? command.print;
      if (print) print(result);
      // Android held back an activity start and posted a notification instead.
      else if (typeof result?.message === "string") process.stderr.write(`${result.message}\n`);
    }
  } catch (error) {
    const usage = error instanceof UsageError ? `\n${USAGE}` : "";
    process.stderr.write(`${COMMAND}: ${error.message}${usage}\n`);
    process.exitCode = 1;
  }
}
