import { spawn } from "node:child_process";

const observers = new Set();

export function observeProcesses(listener) {
  observers.add(listener);
  return () => observers.delete(listener);
}

export function runProcess(command, args, { cwd, timeoutMs = null, onData, env } = {}) {
  const childEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GH_NO_UPDATE_NOTIFIER: "1",
    ...env,
  };
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] == null) delete childEnv[key];
  }
  for (const listener of observers) {
    listener({ command, args, cwd, env: childEnv });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: childEnv,
    });
    const stdoutChunks = [];
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    const finish = (handler, value) => {
      if (timer) clearTimeout(timer);
      handler(value);
    };
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      const text = chunk.toString();
      stdout += text;
      onData?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onData?.(text);
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) =>
      finish(resolve, { code, signal, stdout, stderr, stdoutBuffer: Buffer.concat(stdoutChunks) }),
    );
  });
}
