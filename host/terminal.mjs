// Opens a terminal window in a folder and types a command into the user's own shell there, for
// the chat panel's "Continue in terminal" (docs/chat-panel.md, "Terminal handoff"). Also ends
// the Claude Code a handoff started, when the chat goes back to the sidebar.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Single quotes for a POSIX shell, only where needed.
export const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// argv 1 is the folder, argv 2 the command. Typed into the shell rather than run in its place, so
// the user's PATH and aliases apply and the window stays open when the command ends.
const MAC_APPS = {
  ghostty: {
    app: "Ghostty",
    script: `on run argv
  tell application "Ghostty"
    activate
    set cfg to new surface configuration
    set initial working directory of cfg to (item 1 of argv)
    set initial input of cfg to (item 2 of argv) & linefeed
    new window with configuration cfg
  end tell
end run`,
  },
  iterm: {
    app: "iTerm",
    script: `on run argv
  tell application "iTerm"
    activate
    set w to (create window with default profile)
    tell current session of w to write text ("cd " & quoted form of (item 1 of argv) & " && " & (item 2 of argv))
  end tell
end run`,
  },
  terminal: {
    app: "Terminal",
    script: `on run argv
  tell application "Terminal"
    activate
    do script ("cd " & quoted form of (item 1 of argv) & " && " & (item 2 of argv))
  end tell
end run`,
  },
};

const installed = (app, home) => app === "Terminal" || ["/Applications", path.join(home, "Applications")].some((d) => fs.existsSync(path.join(d, `${app}.app`)));

const run = (file, args, timeout = 20_000) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr).trim().split("\n").at(-1) || err.message)) : resolve(stdout)));
  });

// `app` is the user's choice ("ghostty", "iterm", "terminal"); without one, the first installed.
// Rejects when no window could be opened: the caller then hands the command to the user.
export async function openTerminal({ cwd, command, app = null, platform = process.platform, home = os.homedir() }) {
  if (platform === "darwin") {
    const order = [app, "ghostty", "iterm", "terminal"].filter((k, i, a) => MAC_APPS[k] && a.indexOf(k) === i && installed(MAC_APPS[k].app, home));
    let last = new Error("No terminal app found.");
    for (const k of order) {
      try {
        await run("osascript", ["-e", MAC_APPS[k].script, cwd, command]);
        return MAC_APPS[k].app;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }
  const shell = `cd ${shq(cwd)} && ${command}; exec "\${SHELL:-sh}"`;
  const child = spawn(app || "x-terminal-emulator", ["-e", "sh", "-c", shell], { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return app || "x-terminal-emulator";
}

// Ends every process whose command line holds `token` (the handoff's own --mcp-config file, so
// only the Claude Code it started), and waits until they are gone.
export async function endProcesses(token) {
  const alive = () => run("pgrep", ["-f", token]).then(() => true, () => false);
  if (!(await alive())) return;
  await run("pkill", ["-TERM", "-f", token]).catch(() => {});
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (!(await alive())) return;
  }
  await run("pkill", ["-KILL", "-f", token]).catch(() => {});
}
