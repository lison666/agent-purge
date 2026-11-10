import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	devinAgentsFile,
	devinConfigDir,
	devinConfigFile,
	hookScriptPath,
	installDevin,
	probeDevin,
	temporaryDevin,
	uninstallDevin,
} from "../lib/devin.mjs";

/** 同时隔离 Devin 配置目录与 agent-purge 数据目录 */
function withEnv(fn) {
	const cfg = mkdtempSync(join(tmpdir(), "ap-devin-cfg-"));
	const data = mkdtempSync(join(tmpdir(), "ap-devin-data-"));
	const prev = { DEVIN_CONFIG_HOME: process.env.DEVIN_CONFIG_HOME, AGENT_PURGE_HOME: process.env.AGENT_PURGE_HOME };
	process.env.DEVIN_CONFIG_HOME = cfg;
	process.env.AGENT_PURGE_HOME = data;
	try {
		return fn({ cfg, data });
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(cfg, { recursive: true, force: true });
		rmSync(data, { recursive: true, force: true });
	}
}

const PERSONA = "DEVIN_TEST_PERSONA_人设";

test("devin: config dir honors DEVIN_CONFIG_HOME", () => {
	withEnv(({ cfg }) => {
		assert.equal(devinConfigDir(), cfg);
		assert.equal(devinAgentsFile(), join(cfg, "AGENTS.md"));
		assert.equal(devinConfigFile(), join(cfg, "config.json"));
	});
});

test("devin: install writes AGENTS.md block + config hooks + hook script", () => {
	withEnv(({ data }) => {
		const r = installDevin(data, { personaText: PERSONA, mode: "replace" });
		assert.equal(r.status, "installed");

		const agents = readFileSync(devinAgentsFile(), "utf8");
		assert.match(agents, /# >>> agent-purge/);
		assert.match(agents, /DEVIN_TEST_PERSONA_人设/);

		const config = JSON.parse(readFileSync(devinConfigFile(), "utf8"));
		for (const ev of ["SessionStart", "UserPromptSubmit"]) {
			const cmds = config.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command));
			assert.equal(cmds.length, 1, `${ev} 应只有我们一条`);
			assert.match(cmds[0], /purge-hook\.mjs/);
		}
		assert.equal(existsSync(hookScriptPath(data)), true);
		assert.equal(probeDevin(), true);
	});
});

test("devin: strict mode prepends identity-supersede preamble", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA, mode: "strict" });
		assert.match(readFileSync(devinAgentsFile(), "utf8"), /取代你上方的身份设定/);
	});
});

test("devin: append mode has no strict preamble", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA, mode: "append" });
		assert.doesNotMatch(readFileSync(devinAgentsFile(), "utf8"), /取代你上方的身份设定/);
	});
});

test("devin: empty persona and marker-injection are refused", () => {
	withEnv(({ data }) => {
		assert.throws(() => installDevin(data, { personaText: "   " }), /人设正文为空/);
		assert.throws(() => installDevin(data, { personaText: "x\n# >>> agent-purge\ny" }), /托管标记/);
		assert.equal(existsSync(devinAgentsFile()), false);
	});
});

test("devin: reinstall is idempotent — single block, single hook entry", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA, mode: "replace" });
		installDevin(data, { personaText: "PERSONA_V2", mode: "strict" });
		const agents = readFileSync(devinAgentsFile(), "utf8");
		assert.equal(agents.match(/# >>> agent-purge/g).length, 1);
		assert.match(agents, /PERSONA_V2/);
		const config = JSON.parse(readFileSync(devinConfigFile(), "utf8"));
		assert.equal(config.hooks.SessionStart.length, 1);
		assert.equal(config.hooks.UserPromptSubmit.length, 1);
	});
});

test("devin: uninstall restores bytes of pre-existing AGENTS.md and JSONC config", () => {
	withEnv(({ data }) => {
		mkdirSync(devinConfigDir(), { recursive: true });
		const agentsOrig = "# my devin rules\n\nKeep this.\n";
		const configOrig = `{\n  // 我自己的注释\n  "theme": "dark",\n  "hooks": {\n    "SessionStart": [\n      { "matcher": "", "hooks": [{ "type": "command", "command": "echo hi" }] }\n    ]\n  }\n}\n`;
		writeFileSync(devinAgentsFile(), agentsOrig);
		writeFileSync(devinConfigFile(), configOrig);

		installDevin(data, { personaText: PERSONA, mode: "replace" });
		const mid = JSON.parse(readFileSync(devinConfigFile(), "utf8"));
		// 用户的钩子还在，且我们追加在最后
		assert.equal(mid.hooks.SessionStart.length, 2);
		assert.equal(mid.hooks.SessionStart[0].hooks[0].command, "echo hi");
		assert.equal(mid.theme, "dark");

		uninstallDevin(data);
		assert.equal(readFileSync(devinAgentsFile(), "utf8"), agentsOrig);
		// 整份原字节还原：注释也回来
		assert.equal(readFileSync(devinConfigFile(), "utf8"), configOrig);
		assert.equal(existsSync(hookScriptPath(data)), false);
		assert.equal(probeDevin(), false);
	});
});

test("devin: uninstall is surgical when user edited config.json after install", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA, mode: "replace" });
		// 用户在安装后加了别的键和自己的钩子
		const config = JSON.parse(readFileSync(devinConfigFile(), "utf8"));
		config.theme = "light";
		config.hooks.SessionStart.push({ matcher: "", hooks: [{ type: "command", command: "user-cmd" }] });
		writeFileSync(devinConfigFile(), JSON.stringify(config, null, 2));

		uninstallDevin(data);
		const back = JSON.parse(readFileSync(devinConfigFile(), "utf8"));
		assert.equal(back.theme, "light");
		assert.deepEqual(
			back.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command)),
			["user-cmd"],
		);
		assert.equal(back.hooks.UserPromptSubmit, undefined);
	});
});

test("devin: foreign files are never touched", () => {
	withEnv(({ data }) => {
		mkdirSync(devinConfigDir(), { recursive: true });
		const agentsOrig = "# someone else's rules\n";
		const configOrig = '{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"theirs"}]}]}}';
		writeFileSync(devinAgentsFile(), agentsOrig);
		writeFileSync(devinConfigFile(), configOrig);
		uninstallDevin(data);
		assert.equal(readFileSync(devinAgentsFile(), "utf8"), agentsOrig);
		assert.equal(readFileSync(devinConfigFile(), "utf8"), configOrig);
	});
});

test("devin: broken config.json blocks install but never destroys the file", () => {
	withEnv(({ data }) => {
		mkdirSync(devinConfigDir(), { recursive: true });
		const broken = "{ this is not json";
		writeFileSync(devinConfigFile(), broken);
		assert.throws(() => installDevin(data, { personaText: PERSONA }), /解析失败/);
		assert.equal(readFileSync(devinConfigFile(), "utf8"), broken);
	});
});

test("devin: off mode removes everything", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA, mode: "replace" });
		installDevin(data, { personaText: PERSONA, mode: "off" });
		assert.equal(existsSync(devinAgentsFile()), false);
		assert.equal(existsSync(devinConfigFile()), false);
		assert.equal(existsSync(hookScriptPath(data)), false);
		assert.equal(probeDevin(), false);
	});
});

test("devin: temporary install restores bytes and keeps resident block intact", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: "PERSISTENT", mode: "replace" });
		const persistBytes = readFileSync(devinAgentsFile(), "utf8");
		const undo = temporaryDevin({ personaText: "TEMP_P", mode: "replace" });
		assert.match(readFileSync(devinAgentsFile(), "utf8"), /TEMP_P/);
		undo();
		assert.equal(readFileSync(devinAgentsFile(), "utf8"), persistBytes);
		undo(); // 幂等
		assert.equal(readFileSync(devinAgentsFile(), "utf8"), persistBytes);
	});
});

// ── 钩子脚本端到端：真跑生成的 purge-hook.mjs ──────────────────────────────────
function seedState(data, { persona = "devin-persona", armed = ["install"], defaultMode = "replace" } = {}) {
	mkdirSync(join(data, "personas"), { recursive: true });
	writeFileSync(join(data, "personas", persona + ".md"), `你是 ${persona}\n第二行正文`);
	writeFileSync(
		join(data, "state.json"),
		JSON.stringify({ persona, default: { mode: defaultMode }, armed: { devin: armed }, overrides: {} }),
	);
	return persona;
}

function runHook(data, event) {
	const r = spawnSync(process.execPath, [hookScriptPath(data)], {
		input: JSON.stringify(event),
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(r.status, 0, `钩子不该失败：${r.stderr}`);
	return r.stdout.trim();
}

test("devin hook: SessionStart injects persona via additionalContext", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA });
		const persona = seedState(data);
		const out = runHook(data, { hook_event_name: "SessionStart", session_id: "s1" });
		const parsed = JSON.parse(out);
		assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
		assert.match(parsed.hookSpecificOutput.additionalContext, new RegExp(persona));
		assert.match(parsed.hookSpecificOutput.additionalContext, /以本段为准/);
	});
});

test("devin hook: UserPromptSubmit injects once, then stays quiet until change", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA });
		seedState(data);
		const first = runHook(data, { hook_event_name: "UserPromptSubmit", session_id: "s2" });
		assert.match(first, /additionalContext/);
		// 同 session、内容没变：不再注入
		assert.equal(runHook(data, { hook_event_name: "UserPromptSubmit", session_id: "s2" }), "");
		// 换 session：重新注入一次
		assert.match(runHook(data, { hook_event_name: "UserPromptSubmit", session_id: "s3" }), /additionalContext/);
	});
});

test("devin hook: persona switch mid-session reinjects (hot swap)", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA });
		seedState(data, { persona: "alpha" });
		runHook(data, { hook_event_name: "UserPromptSubmit", session_id: "s4" });
		// 用户换人设：state.json + personas 变了，下一轮钩子就注新的
		seedState(data, { persona: "beta" });
		const out = runHook(data, { hook_event_name: "UserPromptSubmit", session_id: "s4" });
		assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /beta/);
	});
});

test("devin hook: global pause stops injection immediately", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA });
		seedState(data, { defaultMode: "off" });
		assert.equal(runHook(data, { hook_event_name: "SessionStart", session_id: "s5" }), "");
		assert.equal(runHook(data, { hook_event_name: "UserPromptSubmit", session_id: "s6" }), "");
	});
});

test("devin hook: not armed = silent; garbage input = silent", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA });
		seedState(data, { armed: [] });
		assert.equal(runHook(data, { hook_event_name: "SessionStart", session_id: "s7" }), "");
		const r = spawnSync(process.execPath, [hookScriptPath(data)], { input: "not json at all", encoding: "utf8", timeout: 10000 });
		assert.equal(r.status, 0);
		assert.equal(r.stdout.trim(), "");
	});
});

test("devin hook: append mode uses supplementary prefix", () => {
	withEnv(({ data }) => {
		installDevin(data, { personaText: PERSONA });
		seedState(data);
		// mode 来自 state.json（分家 override），不是安装参数
		const state = JSON.parse(readFileSync(join(data, "state.json"), "utf8"));
		state.overrides.devin = { mode: "append" };
		writeFileSync(join(data, "state.json"), JSON.stringify(state));
		const out = JSON.parse(runHook(data, { hook_event_name: "SessionStart", session_id: "s8" }));
		assert.match(out.hookSpecificOutput.additionalContext, /补充指令遵守/);
	});
});
