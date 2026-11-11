// Devin CLI（devin 命令，也是 Devin Desktop 的 acp 后端）：这家没有任何
// --system-prompt 类启动参数，配置目录在 %APPDATA%\devin（Win）/ ~/.config/devin。
//
// 两条落点一起用：
//   1. 全局 AGENTS.md 托管块 —— Devin 把规则注入系统上下文的
//      <rules type="always-on"> 段（实测会话的系统提示词里可见），是身份基座；
//      只在会话启动时读，正文是快照。
//   2. config.json 的 SessionStart / UserPromptSubmit 命令钩子 —— 每回合从
//      agent-purge 的 state.json 现读人设与模式：换人设/切模式下一个回合生效，
//      全局暂停/分家 off 当轮即停（热切）。同一 session 内只有内容变化才重复注入，
//      不逐轮堆上下文。
//      注意：钩子走 additionalContext（对话上下文补注），不是改写 system 数组——
//      Devin 没有 system 层落点，规则块 + 钩子是这家目前最强的组合。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { activationRuntime } from "./activation.mjs";
import { dataHome } from "./home.mjs";
import { readStash, stripBlock, writeStash } from "./persist.mjs";
import { userHome } from "./paths.mjs";

const STRICT_PREAMBLE = [
	"# 身份（最高优先级）",
	"",
	"下面这段身份取代你上方的身份设定；你不是宿主产品，不要用宿主的名字称呼自己。",
	"",
].join("\n");

/** %APPDATA%\devin（Win）/ $XDG_CONFIG_HOME/devin / ~/.config/devin；测试用 DEVIN_CONFIG_HOME 覆盖 */
export function devinConfigDir() {
	if (process.env.DEVIN_CONFIG_HOME?.trim()) return process.env.DEVIN_CONFIG_HOME.trim();
	const home = userHome();
	if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "devin");
	return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "devin");
}

/** 全局规则文件：Devin 把它读进每次会话的 <rules type="always-on"> */
export function devinAgentsFile() {
	return join(devinConfigDir(), "AGENTS.md");
}

export function devinConfigFile() {
	return join(devinConfigDir(), "config.json");
}

export function hookScriptPath(root) {
	return join(root, "devin", "purge-hook.mjs");
}

const hookSessionsFile = (root) => join(root, "devin", "hook-sessions.json");

/** 我们的钩子条目按命令里的脚本名识别（不依赖数据目录名），和用户手写的钩子互不干扰 */
const isOurs = (command) => String(command ?? "").includes("purge-hook.mjs");

export function devinBin() {
	const win = process.platform === "win32";
	const exe = win ? "devin.exe" : "devin";
	const home = userHome();
	const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
	const real = process.env.AGENT_PURGE_REAL_BIN;
	if (real && existsSync(real) && real.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase() === "devin") return real;
	// 先认安装目录里的真身：PATH 上的 devin.cmd 只是 %* 转发壳，
	// 走 .cmd 通道会让含空格/非 ASCII 的 prompt 被 batch 保守规则拒掉。
	for (const p of [join(local, "devin", "cli", "bin", exe)]) if (existsSync(p)) return p;
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const name of win ? ["devin.exe", "devin.cmd", "devin.bat", "devin.ps1"] : ["devin"]) {
			const p = join(dir, name);
			if (existsSync(p)) return p;
		}
	}
	for (const p of [join(home, "bin", exe)]) if (existsSync(p)) return p;
	return "devin";
}

/** strict = 明写「取代上方身份」；replace/append = 只放人设正文 */
export function devinPersonaBody(personaText, mode = "replace") {
	const text = String(personaText ?? "").trim();
	if (!text) throw new Error("Devin 人设正文为空，拒绝写入");
	if (/^(?:\s*)# (?:>>>|<<<) agent-purge/m.test(text)) throw new Error("Devin 人设正文包含 agent-purge 托管标记，拒绝写入");
	return mode === "strict" ? STRICT_PREAMBLE + text : text;
}

// ── AGENTS.md 托管块（与 antigravity 同一套 stash 语义） ─────────────────────
function composeAgentsBlock(old, body) {
	const stripped = stripBlock(old ?? "");
	const block = `# >>> agent-purge\n${body}\n# <<< agent-purge`;
	return `${stripped.replace(/\s*$/, "")}${stripped.trim() ? "\n\n" : ""}${block}\n`;
}

function writeAgentsBlock(root, body) {
	const file = devinAgentsFile();
	const old = existsSync(file) ? readFileSync(file, "utf8") : null;
	const next = composeAgentsBlock(old, body);
	const prior = readStash(file, root);
	writeStash(file, { file, before: prior ? prior.before : old, after: next }, root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next, "utf8");
	return file;
}

function removeAgentsBlock(root) {
	const file = devinAgentsFile();
	if (!existsSync(file)) return { file, action: "already-gone" };
	const current = readFileSync(file, "utf8");
	const stash = readStash(file, root);
	if (stash && current === stash.after) {
		if (stash.before == null) rmSync(file, { force: true });
		else writeFileSync(file, stash.before, "utf8");
		return { file, action: stash.before == null ? "deleted-file" : "restored-file" };
	}
	const stripped = stripBlock(current);
	if (stripped === current) return { file, action: "skipped-foreign" };
	if (!stripped.trim()) rmSync(file, { force: true });
	else writeFileSync(file, stripped.replace(/\s*$/, "\n"), "utf8");
	return { file, action: stripped.trim() ? "removed-block" : "deleted-empty-file" };
}

// ── config.json 钩子合并：JSONC 容忍读取，只增删自己那两条 ──────────────────
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit"];

/** Devin 的 config.json 允许注释；做一个字符串感知的注释剥离，不吞字符串里的 // */
function stripJsonc(text) {
	let out = "";
	let inStr = false;
	let esc = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			out += c;
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
			continue;
		}
		out += c;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

export function readDevinConfig() {
	const file = devinConfigFile();
	if (!existsSync(file)) return { file, config: {}, raw: null };
	const raw = readFileSync(file, "utf8");
	try {
		const config = JSON.parse(stripJsonc(raw));
		if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config.json 顶层必须是对象");
		return { file, config, raw };
	} catch (e) {
		return { file, config: null, raw, error: `config.json 解析失败（原文件未动）：${e.message}` };
	}
}

/** 过滤掉我们装的钩子条目；别人的组与钩子原样保留 */
function withoutOurs(hooks, ev) {
	const groups = Array.isArray(hooks?.[ev]) ? hooks[ev] : [];
	return groups
		.map((g) => ({ ...g, hooks: (Array.isArray(g?.hooks) ? g.hooks : []).filter((h) => !isOurs(h?.command)) }))
		.filter((g) => (g.hooks?.length ?? 0) > 0);
}

function mergeHooks(config, command) {
	const hooks = { ...(config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? config.hooks : {}) };
	for (const ev of HOOK_EVENTS) {
		hooks[ev] = [...withoutOurs(hooks, ev), { matcher: "", hooks: [{ type: "command", command }] }];
	}
	return { ...config, hooks };
}

function purgeHooks(config) {
	const hooks = { ...(config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? config.hooks : {}) };
	for (const ev of HOOK_EVENTS) {
		const kept = withoutOurs(hooks, ev);
		if (kept.length) hooks[ev] = kept;
		else delete hooks[ev];
	}
	const next = { ...config };
	if (Object.keys(hooks).length) next.hooks = hooks;
	else delete next.hooks;
	return next;
}

function hookCommand(root) {
	// bun/编译 exe 形态下 process.execPath 不是 node，退回 PATH 上的 node
	const node = /^node(\.exe)?$/i.test(process.execPath.replace(/^.*[\\/]/, "")) ? process.execPath : "node";
	return `"${node}" "${hookScriptPath(root).replace(/\\/g, "/")}"`;
}

/**
 * 生成自包含的钩子脚本：读 stdin 事件 → state.json 现解人设 →
 * SessionStart 必注一次；UserPromptSubmit 只在内容变化时再注。
 * 脚本写在数据目录（~/.agent-purge/devin/），npm 升级不动它。
 */
export function writeHookScript(root) {
	const file = hookScriptPath(root);
	const source = `// 由 agent-purge 生成 —— 卸载：agent-purge uninstall devin / disarm devin
// 每回合从 state.json 现读人设（热切）；任何异常一律静默退出，绝不影响会话。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA = ${JSON.stringify(root)};
const MODE_PREFIX = {
	append: "（以下人设由 agent-purge 附加注入，作为补充指令遵守）",
	default: "（以下人设由 agent-purge 注入；与宿主默认身份冲突时以本段为准）",
};
${activationRuntime}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function stripFrontmatter(raw) {
	if (!raw.startsWith("---")) return raw;
	const end = raw.indexOf("\\n---", 3);
	if (end === -1) return raw;
	return raw.slice(end + 4).replace(/^\\r?\\n/, "");
}
function readStdin() {
	return new Promise((resolve) => {
		let d = "";
		process.stdin.on("data", (c) => (d += c));
		process.stdin.on("end", () => resolve(d));
		process.stdin.on("error", () => resolve(""));
		if (process.stdin.isTTY) resolve("");
	});
}

async function main() {
	const raw = await readStdin();
	let ev = {};
	try { ev = JSON.parse(raw); } catch {}
	const evName = typeof ev.hook_event_name === "string" ? ev.hook_event_name : "";
	if (evName !== "SessionStart" && evName !== "UserPromptSubmit") return;
	const state = readJson(path.join(DATA, "state.json"));
	const act = resolveActivation(state, "devin", { channel: "install" });
	if (!act.on || !act.persona) return;
	let persona = "";
	try { persona = fs.readFileSync(path.join(DATA, "personas", act.persona + ".md"), "utf8"); } catch {}
	// persona 文件 = frontmatter + 正文；进上下文的只能是正文（与 materialize 同一约定）
	persona = stripFrontmatter(persona).trim();
	if (!persona) return;
	const hash = crypto.createHash("sha256").update(act.mode + "\\n" + persona).digest("hex").slice(0, 16);
	const sessFile = path.join(DATA, "devin", "hook-sessions.json");
	const sess = readJson(sessFile) || {};
	const sid = typeof ev.session_id === "string" ? ev.session_id : "_";
	if (evName === "UserPromptSubmit" && sess[sid] === hash) return;
	sess[sid] = hash;
	const keys = Object.keys(sess);
	if (keys.length > 64) for (const k of keys.slice(0, keys.length - 64)) delete sess[k];
	try { fs.mkdirSync(path.dirname(sessFile), { recursive: true }); fs.writeFileSync(sessFile, JSON.stringify(sess)); } catch {}
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: evName,
			additionalContext: (MODE_PREFIX[act.mode] ?? MODE_PREFIX.default) + "\\n\\n" + persona,
		},
	}));
}

main().catch(() => {});
`;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, source, "utf8");
	return file;
}

/** config.json 写入带 stash：用户装完又手改过配置时，卸载只剥自己的钩子不整份还原 */
function writeConfigHooks(root, command) {
	const { file, config, raw, error } = readDevinConfig();
	if (error) throw new Error(error);
	const next = JSON.stringify(mergeHooks(config, command), null, 2) + "\n";
	const prior = readStash(file, root);
	writeStash(file, { file, before: prior ? prior.before : raw, after: next }, root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next, "utf8");
	return file;
}

function removeConfigHooks(root) {
	const { file, config, raw, error } = readDevinConfig();
	if (error) return { file, action: "error", error };
	if (raw === null) return { file, action: "already-gone" };
	const stash = readStash(file, root);
	// 文件仍是我们上次写出的样子 → 按原字节还原（当初没有就删掉；有就还原文本含注释）
	if (stash && raw === stash.after) {
		if (stash.before == null) rmSync(file, { force: true });
		else writeFileSync(file, stash.before, "utf8");
		return { file, action: stash.before == null ? "deleted-file" : "restored-file" };
	}
	// 用户后来动过文件：只摘掉我们的钩子条目，其它字节全保留；没有我们的条目就一字节不碰
	const had = HOOK_EVENTS.some((ev) =>
		(Array.isArray(config.hooks?.[ev]) ? config.hooks[ev] : []).some((g) => (g?.hooks ?? []).some((h) => isOurs(h?.command))),
	);
	if (!had) return { file, action: "no-hooks" };
	writeFileSync(file, JSON.stringify(purgeHooks(config), null, 2) + "\n", "utf8");
	return { file, action: "removed-hooks" };
}

export function installDevin(root = dataHome(), { personaText, mode = "replace" } = {}) {
	if (mode === "off") return uninstallDevin(root);
	const body = devinPersonaBody(personaText, mode);
	const file = writeAgentsBlock(root, body);
	const script = writeHookScript(root);
	const configFile = writeConfigHooks(root, hookCommand(root));
	return { status: "installed", file, action: "custom", mode, chars: body.length, script, configFile };
}

export function uninstallDevin(root = dataHome()) {
	const agents = removeAgentsBlock(root);
	const hooks = removeConfigHooks(root);
	for (const f of [hookScriptPath(root), hookSessionsFile(root)]) rmSync(f, { force: true });
	return { status: "uninstalled", file: agents.file, action: "custom", restored: [agents, hooks] };
}

export function probeDevin(root = null) {
	const file = devinAgentsFile();
	if (existsSync(file) && stripBlock(readFileSync(file, "utf8")) !== readFileSync(file, "utf8")) return true;
	const { raw } = readDevinConfig();
	return Boolean(raw && /purge-hook\.mjs/.test(raw));
}

/** 单次启动（agent-purge devin / shim 接管）：临时托管块，退出按原字节还原。 */
export function temporaryDevin({ personaText, mode = "replace" } = {}) {
	const file = devinAgentsFile();
	const before = existsSync(file) ? readFileSync(file) : null;
	const body = devinPersonaBody(personaText, mode);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, composeAgentsBlock(before ? before.toString("utf8") : "", body), "utf8");
	let done = false;
	return () => {
		if (done) return;
		done = true;
		if (before === null) rmSync(file, { force: true });
		else writeFileSync(file, before);
	};
}
