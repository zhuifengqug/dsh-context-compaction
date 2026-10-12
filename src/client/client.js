// @gjs27/dsh-context-compaction client bundle: registers the "上下文压缩" settings
// section, a card of numeric fields that tune when auto-compaction triggers.
//
// Hand-written __ModuleLoader__ factory (no build step), following the shipped
// third-party pattern of dsh-global-rules. The only external require is react,
// which the loader module table provides.
//
// Data path: fetch("/api/context-compaction") -> the host half's Connection
// Fetch route. The official config editor cannot serve this card because its
// entries() filter only accepts rows whose parent fiber entry id is "include",
// and an engine row inside a preset-* group has a preset parent.
window.__ModuleLoader__.load({ id: "@gjs27/dsh-context-compaction", factory: (require) => {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback } = react;

		const NS = "context-compaction";
		const inject = ["slots", "locale"];
		const API_PATH = "/api/context-compaction";

		const DICTS = {
			zh: {
				label: "上下文压缩",
				desc: "调整自动压缩的触发时机。保存后重启 DSH 生效：预设的插件树在进程内按版本共享挂载，重启前已挂载的预设仍用旧值。",
				loading: "加载中…",
				save: "保存",
				saving: "保存中…",
				saved: "已保存。重启 DSH 后按新阈值生效。",
				saveError: "保存失败: {error}",
				readError: "读取失败: {error}",
				unknownError: "未知错误",
				authFailed: "会话未通过鉴权，请刷新页面后重试",
				sourceStored: "当前来源：你保存的设置",
				sourceDefaults: "当前来源：官方默认值（尚未保存过）",
				officialDefaults: "官方默认",
				presets: "快捷档位",
				presetAggressive: "激进（约 50% 触发）",
				presetBalanced: "温和（约 65% 触发）",
				presetConservative: "保守（官方默认 80%）",
				thresholdRatio: "触发阈值比例",
				thresholdRatioHint: "上下文占模型窗口的比例达到它就开始压缩。官方默认 0.8（80%）；调低 = 更早压缩 = 续航更长，但摘要调用更频繁。",
				headroomTokens: "预留 token",
				headroomTokensHint: "在比例预算之外再额外预留的 token 数，防止输出被挤掉。官方默认 65536。",
				retainRatio: "保留尾部比例",
				retainRatioHint: "压缩时原样保留最近对话的比例。官方默认 0.16。",
				retainTokens: "保留尾部 token（0 = 用比例）",
				retainTokensHint: "填正数则覆盖上面的比例，直接指定保留多少 token；0 表示沿用比例。",
				rangeHint: "取值范围 {min} – {max}",
				advanced: "高级",
				showAdvanced: "显示高级字段",
				hideAdvanced: "收起高级字段",
				effective: "生效值",
			},
			en: {
				label: "Context Compaction",
				desc: "Tune when auto-compaction triggers. Restart DSH after saving: preset plugin trees are mounted once per revision and shared for the process lifetime, so a preset already mounted keeps its previous values.",
				loading: "Loading…",
				save: "Save",
				saving: "Saving…",
				saved: "Saved. Restart DSH to apply the new thresholds.",
				saveError: "Failed to save: {error}",
				readError: "Failed to read: {error}",
				unknownError: "Unknown error",
				authFailed: "Session authentication failed, please refresh the page and try again",
				sourceStored: "Current source: your saved settings",
				sourceDefaults: "Current source: official defaults (nothing saved yet)",
				officialDefaults: "official default",
				presets: "Quick presets",
				presetAggressive: "Aggressive (trigger near 50%)",
				presetBalanced: "Balanced (trigger near 65%)",
				presetConservative: "Conservative (official 80%)",
				thresholdRatio: "Trigger ratio",
				thresholdRatioHint: "Share of the model window at which compaction arms. Official default 0.8 (80%); lower = earlier compaction = longer sessions, but more frequent summarization calls.",
				headroomTokens: "Reserved tokens",
				headroomTokensHint: "Extra tokens held back beyond the ratio budget so the response never gets squeezed out. Official default 65536.",
				retainRatio: "Verbatim tail ratio",
				retainRatioHint: "Share of the most recent conversation kept verbatim when compacting. Official default 0.16.",
				retainTokens: "Verbatim tail tokens (0 = use ratio)",
				retainTokensHint: "A positive value overrides the ratio above and pins an exact token count; 0 keeps the ratio in effect.",
				rangeHint: "Range {min} – {max}",
				advanced: "Advanced",
				showAdvanced: "Show advanced fields",
				hideAdvanced: "Hide advanced fields",
				effective: "Effective value",
			},
		};

		/** Turn an expired session into a refresh hint rather than a status code. */
		function failureCode(res) {
			return (res.status === 401 || res.status === 403) ? "authFailed" : ("HTTP " + res.status);
		}

		const CARD_STYLE = { maxWidth: "720px" };
		const DESC_STYLE = { marginTop: 0, opacity: 0.75, fontSize: "13px" };
		const FIELD_STYLE = { marginTop: "18px" };
		const LABEL_STYLE = { display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "2px" };
		const HINT_STYLE = { fontSize: "12px", opacity: 0.7, margin: "0 0 6px" };
		const INPUT_STYLE = {
			width: "160px",
			boxSizing: "border-box",
			fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
			fontSize: "13px",
			padding: "6px 8px",
			background: "transparent",
			color: "inherit",
			border: "1px solid rgba(128, 128, 128, 0.35)",
			borderRadius: "6px",
		};
		const RANGE_STYLE = { width: "320px", verticalAlign: "middle", marginLeft: "10px" };
		const BADGE_STYLE = {
			display: "inline-block",
			marginLeft: "8px",
			padding: "1px 6px",
			borderRadius: "4px",
			fontSize: "11px",
			border: "1px solid rgba(128, 128, 128, 0.4)",
			opacity: 0.75,
		};
		const ROW_STYLE = { display: "flex", alignItems: "center", gap: "10px", marginTop: "18px" };
		const BUTTON_STYLE = { padding: "6px 16px", borderRadius: "6px", border: "none", cursor: "pointer", fontSize: "13px" };
		const GHOST_BUTTON_STYLE = {
			padding: "5px 12px",
			borderRadius: "6px",
			cursor: "pointer",
			fontSize: "12px",
			background: "transparent",
			color: "inherit",
			border: "1px solid rgba(128, 128, 128, 0.4)",
		};
		const PRESET_ROW_STYLE = { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" };

		/** One numeric field with a synced slider for the ratio-shaped keys. */
		function Field(props) {
			const { t, spec, value, onChange, disabled } = props;
			const slider = spec.fractional;
			const step = slider ? 0.01 : 1024;
			const invalid = !Number.isFinite(value) || value < spec.min || value > spec.max;
			return h("div", { style: FIELD_STYLE },
				h("label", { style: LABEL_STYLE, htmlFor: "cc-" + spec.key },
					t(spec.key),
					h("span", { style: BADGE_STYLE }, t("officialDefaults") + " " + spec.officialDefault)),
				h("p", { style: HINT_STYLE }, t(spec.key + "Hint")),
				h("input", {
					id: "cc-" + spec.key,
					type: "number",
					style: Object.assign({}, INPUT_STYLE, invalid ? { borderColor: "#e5484d" } : null),
					value: value === undefined || value === null ? "" : String(value),
					min: spec.min,
					max: spec.max,
					step: step,
					disabled: disabled,
					onChange: (event) => onChange(event.target.value),
				}),
				slider ? h("input", {
					type: "range",
					style: RANGE_STYLE,
					min: spec.min,
					max: spec.max,
					step: step,
					value: Number.isFinite(value) ? value : spec.officialDefault,
					disabled: disabled,
					onChange: (event) => onChange(event.target.value),
				}) : null,
				h("div", { style: { fontSize: "12px", opacity: 0.6, marginTop: "4px" } },
					t("rangeHint", { min: spec.min, max: spec.max })));
		}

		function ContextCompactionSection(props) {
			const t = props.t;
			const [state, setState] = useState(null);
			const [values, setValues] = useState({});
			const [loaded, setLoaded] = useState(false);
			const [saving, setSaving] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle" });
			const [advanced, setAdvanced] = useState(false);

			const applyState = useCallback((data) => {
				setState(data);
				setValues({
					thresholdRatio: data.policy.thresholdRatio,
					headroomTokens: data.policy.headroomTokens,
					retainRatio: data.policy.retainRatio,
					retainTokens: data.policy.retainTokens,
				});
			}, []);

			useEffect(() => {
				let cancelled = false;
				fetch(API_PATH, { cache: "no-store" })
					.then((res) => {
						if (!res.ok) throw new Error(failureCode(res));
						return res.json();
					})
					.then((data) => {
						if (cancelled) return;
						applyState(data);
						setLoaded(true);
					})
					.catch((error) => {
						if (cancelled) return;
						setNotice({ kind: "error", key: "readError", errorParam: error.message });
						setLoaded(true);
					});
				return () => { cancelled = true; };
			}, [applyState]);

			const save = useCallback(() => {
				setSaving(true);
				setNotice({ kind: "idle" });
				fetch(API_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ settings: values }),
				})
					.then(async (res) => {
						const data = await res.json().catch(() => ({}));
						if (!res.ok) throw new Error(data.error || failureCode(res));
						return data;
					})
					.then((data) => {
						if (data.ok) {
							applyState(data);
							setNotice({ kind: "ok", key: "saved" });
						} else {
							setNotice({ kind: "error", key: "saveError", errorParam: data.error });
						}
					})
					.catch((error) => {
						setNotice({ kind: "error", key: "saveError", errorParam: error.message });
					})
					.finally(() => setSaving(false));
			}, [values, applyState]);

			const setField = useCallback((key, raw) => {
				setValues((prev) => Object.assign({}, prev, { [key]: raw === "" ? "" : Number(raw) }));
			}, []);

			const applyPreset = useCallback((preset) => {
				setValues(Object.assign({}, preset));
				setNotice({ kind: "idle" });
			}, []);

			const resolveErrorText = (param) => {
				if (!param) return t("unknownError");
				return param === "authFailed" ? t("authFailed") : param;
			};

			const fields = (state && state.fields) || [];
			const basicKeys = ["thresholdRatio", "headroomTokens"];
			const visible = advanced ? fields : fields.filter((f) => basicKeys.indexOf(f.key) >= 0);

			return h("div", { style: CARD_STYLE },
				h("p", { style: DESC_STYLE }, t("desc")),
				!loaded ? h("p", { style: { opacity: 0.6 } }, t("loading")) : null,
				state ? h("p", { style: { fontSize: "12px", opacity: 0.75 } },
					state.source === "stored" ? t("sourceStored") : t("sourceDefaults")) : null,
				state ? h("div", null,
					h("div", { style: { fontSize: "13px", fontWeight: 600, marginTop: "16px" } }, t("presets")),
					h("div", { style: PRESET_ROW_STYLE },
						["aggressive", "balanced", "conservative"].map((name) =>
							h("button", {
								key: name,
								type: "button",
								style: GHOST_BUTTON_STYLE,
								disabled: saving,
								onClick: () => applyPreset(state.presets[name]),
							}, t("preset" + name.charAt(0).toUpperCase() + name.slice(1)))))) : null,
				state ? visible.map((spec) => h(Field, {
					key: spec.key,
					t: t,
					spec: spec,
					value: values[spec.key],
					onChange: (raw) => setField(spec.key, raw),
					disabled: saving,
				})) : null,
				state ? h("div", { style: { marginTop: "14px" } },
					h("button", {
						type: "button",
						style: GHOST_BUTTON_STYLE,
						onClick: () => setAdvanced((prev) => !prev),
					}, advanced ? t("hideAdvanced") : t("showAdvanced"))) : null,
				state ? h("div", { style: ROW_STYLE },
					h("button", {
						type: "button",
						style: Object.assign({}, BUTTON_STYLE, {
							background: "var(--accent, #2f81f7)",
							color: "#fff",
							opacity: saving ? 0.6 : 1,
						}),
						disabled: saving,
						onClick: save,
					}, saving ? t("saving") : t("save")),
					notice.kind === "ok"
						? h("span", { style: { fontSize: "13px", opacity: 0.85 } }, t(notice.key))
						: notice.kind === "error"
							? h("span", { style: { fontSize: "13px", color: "#e5484d" } },
								t(notice.key, { error: resolveErrorText(notice.errorParam) }))
							: null) : null,
				state && state.note ? h("p", { style: { fontSize: "12px", opacity: 0.6, marginTop: "16px" } }, state.note) : null);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, DICTS), "context-compaction: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "context-compaction",
				order: 45,
				locale: NS,
				label: () => t("label"),
			}, ContextCompactionSection));
		}

		exports.name = NS;
		exports.inject = inject;
		exports.apply = apply;
		exports.DICTS = DICTS;
		return module.exports;
	}
});
