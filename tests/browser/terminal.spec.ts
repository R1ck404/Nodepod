import { expect, test, type Page } from "@playwright/test";

// Terminal behaviour, typed with real key events into xterm (terminal.html):
// terminal size (#26), Ctrl+C (#62, #66), TUIs waiting on raw input (#34),
// child process output (#21), readline, interactive create-vite and the
// SvelteKit flow through sv, Ctrl+C on a Vite dev server. The scenarios
// share one terminal session, in order. The npm ones need network access to
// the npm registry.

const PROMPT = /nodepod:\/home[^\n]*\$\s*$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let page: Page;
let mark = 0;

const screen = (): Promise<string> =>
  page.evaluate(() => (window as unknown as { __text: () => string }).__text());
const since = async (): Promise<string> => (await screen()).slice(mark);

async function type(text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 15 });
}

async function run(command: string): Promise<void> {
  mark = (await screen()).length;
  await type(command);
  await page.keyboard.press("Enter");
}

// output since the command matches `re` (and the shell prompt is back)
async function waitFor(re: RegExp, { prompt = false, timeout = 20_000 } = {}): Promise<RegExpMatchArray> {
  const end = Date.now() + timeout;
  let text = "";
  while (Date.now() < end) {
    text = await since();
    const match = text.match(re);
    if (match && (!prompt || (text.includes("\n") && PROMPT.test(text)))) return match;
    await sleep(200);
  }
  throw new Error(`wanted ${re}${prompt ? " and the prompt" : ""}, got:\n${text.split("\n").slice(-12).join("\n")}`);
}

async function waitForPrompt(timeout = 10_000): Promise<void> {
  await waitFor(/[\s\S]*/, { prompt: true, timeout });
}

// answer the active clack question: move to the option matching `label`
// (or keep the default) and confirm
async function answer(question: RegExp, label: RegExp | null, timeout = 90_000): Promise<void> {
  const end = Date.now() + timeout;
  let block = "";
  while (Date.now() < end && !block) {
    const text = await since();
    const at = text.lastIndexOf("◆");
    if (at >= 0 && question.test(text.slice(at).split("\n")[0]!)) block = text.slice(at);
    else await sleep(200);
  }
  if (!block) throw new Error(`no question ${question}:\n${(await since()).split("\n").slice(-12).join("\n")}`);
  await sleep(300);
  if (label) {
    const options = block.split("\n").slice(1).filter((l) => /[●○◼◻]/.test(l));
    const current = Math.max(options.findIndex((l) => /●|›/.test(l)), 0);
    const target = options.findIndex((l) => label.test(l));
    expect(target, `option ${label} in ${options.join(" / ")}`).toBeGreaterThanOrEqual(0);
    const steps = target - current;
    for (let i = 0; i < Math.abs(steps); i++) await page.keyboard.press(steps > 0 ? "ArrowDown" : "ArrowUp");
    await sleep(150);
  }
  await page.keyboard.press("Enter");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto("/tests/browser/terminal.html");
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean; __text?: () => string }).__ready === true
      && /nodepod:\/home/.test((window as unknown as { __text: () => string }).__text()),
    undefined,
    { timeout: 60_000 },
  );
  await page.click("#box");
});

test.afterAll(async () => {
  await page?.close();
});

// leave a clean prompt when a scenario fails part way
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    await page.keyboard.press("Control+c");
    await sleep(500);
  }
});

test("runs a command and shows the prompt again", async () => {
  await run("echo hello-term");
  await waitFor(/hello-term/, { prompt: true });
});

test("#26 the terminal size reaches process.stdout", async () => {
  await run(`node -e "console.log('TTY', process.stdout.isTTY, process.stdout.columns, process.stdout.rows)"`);
  const [, cols, rows] = await waitFor(/TTY true (\d+) (\d+)/, { prompt: true });
  const size = await page.evaluate(() => {
    const term = (window as unknown as { __xterm: { cols: number; rows: number } }).__xterm;
    return [term.cols, term.rows];
  });
  expect([Number(cols), Number(rows)]).toEqual(size);
});

test("#26 a resize reaches later processes", async () => {
  await page.setViewportSize({ width: 700, height: 500 });
  await page.evaluate(() => {
    document.getElementById("box")!.style.width = "600px";
    window.dispatchEvent(new Event("resize"));
  });
  await sleep(800);
  await run(`node -e "console.log('COLS', process.stdout.columns)"`);
  const [, cols] = await waitFor(/COLS (\d+)/, { prompt: true });
  const termCols = await page.evaluate(() => (window as unknown as { __xterm: { cols: number } }).__xterm.cols);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    document.getElementById("box")!.style.width = "960px";
    window.dispatchEvent(new Event("resize"));
  });
  await sleep(500);
  expect(Number(cols)).toBe(termCols);
});

test("#62 #66 Ctrl+C stops a process with a running interval", async () => {
  await run(`node -e "setInterval(() => console.log('tick'), 150)"`);
  await waitFor(/tick[\s\S]*tick[\s\S]*tick/);
  await page.keyboard.press("Control+c");
  await waitForPrompt(5000);
  const ticks = (await since()).split("tick").length;
  await sleep(800);
  expect((await since()).split("tick").length).toBe(ticks);
});

test("#62 Ctrl+C stops a listening server", async () => {
  await run("node index.js");
  await waitFor(/server listening on port 3000/);
  await page.keyboard.press("Control+c");
  await waitForPrompt(5000);
});

test("readline question gets typed input", async () => {
  await run(
    `node -e "const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question('name? ', (a) => { console.log('hi ' + a); rl.close(); })"`,
  );
  await waitFor(/name\? /);
  await sleep(300);
  await type("bob");
  await page.keyboard.press("Enter");
  await waitFor(/hi bob/, { prompt: true });
});

test("for await over readline, then break", async () => {
  await run(
    `node -e "(async () => { const rl = require('readline').createInterface({ input: process.stdin }); console.log('ready'); for await (const l of rl) { console.log('got ' + l); if (l === 'q') break; } console.log('done'); })()"`,
  );
  await waitFor(/ready/);
  await sleep(300);
  await type("a");
  await page.keyboard.press("Enter");
  await waitFor(/got a/);
  await type("q");
  await page.keyboard.press("Enter");
  await waitFor(/got q[\s\S]*done/, { prompt: true });
});

test("#34 a raw-mode TUI keeps running until a key", async () => {
  await run(
    `node -e "process.stdin.setRawMode(true); process.stdin.resume(); console.log('waiting'); process.stdin.on('data', (d) => { if (String(d) === 'x') { console.log('bye'); process.exit(0); } })"`,
  );
  await waitFor(/waiting/);
  await sleep(3500);
  expect(PROMPT.test(await since()), "exited on its own").toBe(false);
  await type("x");
  await waitFor(/bye/, { prompt: true });
});

test("#21 a spawned child's stdout and stderr reach the parent", async () => {
  await run(
    `node -e "const c = require('child_process').spawn('node', ['-e', 'console.log(1); console.error(2)']); c.stdout.on('data', (d) => process.stdout.write('OUT' + d)); c.stderr.on('data', (d) => process.stdout.write('ERR' + d)); c.on('close', (code) => console.log('closed', code))"`,
  );
  await waitFor(/(OUT1[\s\S]*ERR2|ERR2[\s\S]*OUT1)[\s\S]*closed 0/, { prompt: true });
});

test("a child with stdio inherit has the terminal, a piped one does not", async () => {
  await run(
    `node -e "const cp = require('child_process'); cp.spawnSync('node', ['-e', 'console.log(process.stdout.isTTY ? \\'inherit-tty\\' : \\'inherit-pipe\\')'], { stdio: 'inherit' }); console.log(cp.execSync('node -e \\'console.log(process.stdout.isTTY ? 1 : 0)\\'').toString().trim() === '0' ? 'piped-no-tty' : 'piped-tty')"`,
  );
  await waitFor(/inherit-tty[\s\S]*piped-no-tty/, { prompt: true });
});

test("shell pipes", async () => {
  await run("echo pipe-through | cat");
  await waitFor(/pipe-through/, { prompt: true });
});

test("unicode output", async () => {
  await run(`node -e "console.log('h\\u00e9llo \\u{1F600} done')"`);
  await waitFor(/héllo .*done/, { prompt: true });
});

test("Ctrl+C at the prompt drops the line", async () => {
  await type("partial-command");
  await page.keyboard.press("Control+c");
  await sleep(400);
  await run("echo after-ctrl-c");
  await waitFor(/after-ctrl-c/, { prompt: true });
});

test("npm install shows its outcome", async () => {
  await run("npm install is-number");
  await waitFor(/added 1 package/, { prompt: true, timeout: 60_000 });
});

test("interactive npm create vite (arrow keys)", async () => {
  test.setTimeout(180_000);
  await run("npm create vite@latest myapp");
  await answer(/Select a framework/, /React/);
  await answer(/Select a variant/, /TypeScript/);
  // later questions: defaults, but don't install and start now
  for (let i = 0; i < 6; i++) {
    await sleep(1200);
    const text = await since();
    if (PROMPT.test(text)) break;
    const pending = text.slice(text.lastIndexOf("◆"));
    if (!pending.startsWith("◆")) continue;
    if (/start now|Install with/i.test(pending)) await type("n");
    await sleep(150);
    await page.keyboard.press("Enter");
  }
  await waitForPrompt(30_000);
  await run("cat myapp/package.json");
  await waitFor(/"react"/, { prompt: true });
});

test("interactive create vite -> SvelteKit through sv -> npm run dev -> Ctrl+C", async () => {
  test.setTimeout(420_000);
  await run("npm create vite@latest skapp");
  await answer(/Select a framework/, /Svelte\b/);
  await answer(/Select a variant/, /SvelteKit/);
  await answer(/Which template/, /demo/i);
  await answer(/type checking/i, null);
  await answer(/What would you like to add/i, null);
  await answer(/package manager/i, /npm/);
  await waitFor(/Successfully installed dependencies|all set/i, { prompt: true, timeout: 240_000 });
  await run("cd skapp && npm run dev");
  await waitFor(/ready in|Local:/, { timeout: 120_000 });
  await sleep(500);
  await page.keyboard.press("Control+c");
  await waitForPrompt(10_000);
});

test("Ctrl+C stops npm run dev (vite)", async () => {
  test.setTimeout(300_000);
  await run("cd /home && npm create vite@latest ctrlc -- --template vanilla --no-interactive --no-immediate && cd ctrlc && npm install");
  await waitFor(/added \d+ packages?/, { prompt: true, timeout: 180_000 });
  await run("npm run dev");
  await waitFor(/ready in|Local:/, { timeout: 120_000 });
  await sleep(500);
  await page.keyboard.press("Control+c");
  await waitForPrompt(10_000);
});
